//! Folder-backed backup store. Lemlio only needs a folder, so Dropbox, OneDrive,
//! Google Drive for desktop, a USB drive or a network share can all carry the
//! backups with no sign-in, API key or token inside Lemlio.
//!
//! Every revision is immutable: `<uuid>.zip` plus a `<uuid>.json` sidecar that
//! holds its name and sync properties. A revision becomes visible only once both
//! files are complete, so a half-synced upload is never read.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const ROOT_NAME: &str = "Lemlio Backups";

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

type HashKey = (PathBuf, u64, u128);
fn hash_cache() -> &'static Mutex<HashMap<HashKey, String>> {
    static CACHE: OnceLock<Mutex<HashMap<HashKey, String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Hash a stored ZIP, remembering the result while its size and timestamp stay put.
fn cached_hash(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = (path.to_path_buf(), meta.len(), modified);
    if let Some(hash) = hash_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
    {
        return Ok(hash);
    }
    let hash = sha256_file(path)?;
    if let Ok(mut cache) = hash_cache().lock() {
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(key, hash.clone());
    }
    Ok(hash)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn rfc3339(seconds: u64) -> String {
    use chrono::TimeZone;
    chrono::Utc
        .timestamp_opt(seconds as i64, 0)
        .single()
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

/// Revision ids are generated UUIDs; anything else never touches the filesystem.
pub fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id)
}

pub fn root_id(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

fn zip_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.zip"))
}
fn meta_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn entry(
    root: &Path,
    id: &str,
    name: &str,
    size: u64,
    hash: &str,
    properties: &Value,
    saved: u64,
) -> Value {
    json!({
        "id": id,
        "name": name,
        "mimeType": "application/zip",
        "size": size.to_string(),
        "sha256Checksum": hash,
        "appProperties": properties,
        "modifiedTime": rfc3339(saved),
        "parents": [root_id(root)],
        "trashed": false,
    })
}

/// Complete revisions in the folder, newest first.
pub fn list(root: &Path) -> Result<Vec<Value>, String> {
    let entries = std::fs::read_dir(root).map_err(|_| "Cannot read the backup folder")?;
    let mut files: Vec<(u64, Value)> = Vec::new();
    for item in entries.filter_map(Result::ok) {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if !valid_id(&id) {
            continue;
        }
        let Ok(raw) = std::fs::read(&path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        let (Some(size), Some(name)) = (meta["size"].as_u64(), meta["name"].as_str()) else {
            continue;
        };
        if meta["schema"] != 1 {
            continue;
        }
        let zip = zip_path(root, &id);
        // A ZIP that is missing or still the wrong size has not finished syncing.
        if std::fs::metadata(&zip).map(|m| m.len()).ok() != Some(size) {
            continue;
        }
        let Ok(hash) = cached_hash(&zip) else {
            continue;
        };
        let saved = meta["savedAt"].as_u64().unwrap_or(0);
        files.push((
            saved,
            entry(root, &id, name, size, &hash, &meta["appProperties"], saved),
        ));
    }
    files.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1["id"].as_str().cmp(&a.1["id"].as_str()))
    });
    Ok(files.into_iter().map(|(_, value)| value).collect())
}

/// Store a new immutable revision. Existing revisions are never overwritten.
pub fn put(
    root: &Path,
    name: &str,
    source: &Path,
    project_key: &str,
    properties: &Value,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let zip = zip_path(root, &id);
    let outcome = (|| {
        let expected = sha256_file(source)?;
        std::fs::copy(source, &zip)
            .map_err(|e| format!("Cannot write to the backup folder: {e}"))?;
        // Windows only flushes a file that was opened for writing.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&zip)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        if sha256_file(&zip)? != expected {
            return Err("The backup ZIP was not written correctly; backup will retry".to_string());
        }
        let size = std::fs::metadata(&zip).map_err(|e| e.to_string())?.len();
        let mut merged = json!({
            "lemlioProject": project_key,
            "lemlioFormat": "zip-v2",
            "lemlioArchiveHash": expected,
        });
        if let Some(extra) = properties.as_object() {
            for (key, value) in extra {
                merged[key] = value.clone();
            }
        }
        let saved = now();
        let meta =
            json!({"schema":1,"name":name,"size":size,"savedAt":saved,"appProperties":merged});
        let mut sidecar = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
        sidecar
            .write_all(&serde_json::to_vec(&meta).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        sidecar.as_file().sync_all().map_err(|e| e.to_string())?;
        sidecar
            .persist(meta_path(root, &id))
            .map_err(|e| e.error.to_string())?;
        Ok::<_, String>(entry(root, &id, name, size, &expected, &merged, saved))
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&zip);
    }
    outcome
}

pub fn archive_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid backup revision".into());
    }
    let path = zip_path(root, id);
    if path.is_file() {
        Ok(path)
    } else {
        Err("That backup revision is not in the folder (it may still be syncing)".into())
    }
}

/// Another program (a sync client) can briefly lock a file on Windows.
fn open_with_retry(path: &Path) -> Result<std::fs::File, String> {
    let mut last = String::new();
    for attempt in 0..5u64 {
        match std::fs::File::open(path) {
            Ok(file) => return Ok(file),
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(150 * (attempt + 1)));
    }
    Err(format!("Cannot open the backup file: {last}"))
}

pub fn read_archive(root: &Path, id: &str, cap: u64) -> Result<Vec<u8>, String> {
    let path = archive_path(root, id)?;
    let file = open_with_retry(&path)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > cap {
        return Err(format!(
            "Shared backup ZIP exceeds {} MB",
            cap / 1024 / 1024
        ));
    }
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Copy a stored revision out of the folder, verifying its checksum on the way.
pub fn copy_verified(
    source: &Path,
    destination: &Path,
    expected: &str,
    cap: u64,
) -> Result<(), String> {
    let mut input = open_with_retry(source)?;
    let mut output = std::fs::File::create(destination).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| "Backup copy was interrupted; local projects were kept")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > cap {
            return Err("Backup ZIP exceeds the 2 GB limit".into());
        }
        hash.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
    }
    output.sync_all().map_err(|e| e.to_string())?;
    if format!("{:x}", hash.finalize()) != expected {
        return Err("The backup ZIP changed or has not finished syncing. Refresh backups and try again; local files were kept.".into());
    }
    Ok(())
}

/// Reset moves the old folder aside. Nothing is deleted.
pub fn retire_root(root: &Path) -> Result<PathBuf, String> {
    let parent = root.parent().ok_or("Invalid backup folder")?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let mut target = parent.join(format!("{ROOT_NAME} (reset {stamp})"));
    let mut counter = 2;
    while target.exists() {
        target = parent.join(format!("{ROOT_NAME} (reset {stamp}-{counter})"));
        counter += 1;
    }
    std::fs::rename(root, &target)
        .map_err(|e| format!("Close programs using the backup folder and try again: {e}"))?;
    Ok(target)
}

/// Dropbox folders on this computer, found from Dropbox's own settings file.
pub fn detect_sync_folders() -> Vec<Value> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut settings: Vec<PathBuf> = Vec::new();
    if let Some(dir) = dirs::config_dir() {
        settings.push(dir.join("Dropbox").join("info.json"));
    }
    if let Some(dir) = dirs::data_local_dir() {
        settings.push(dir.join("Dropbox").join("info.json"));
    }
    if let Some(home) = dirs::home_dir() {
        settings.push(home.join(".dropbox").join("info.json"));
    }
    for file in settings {
        let Ok(raw) = std::fs::read(file) else {
            continue;
        };
        let Ok(info) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        for account in ["personal", "business"] {
            if let Some(path) = info[account]["path"].as_str() {
                candidates.push(PathBuf::from(path));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Dropbox"));
    }
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|path| path.is_absolute() && path.is_dir())
        .filter(|path| seen.insert(path.to_string_lossy().to_lowercase()))
        .map(|path| json!({"provider":"Dropbox","path":path.to_string_lossy()}))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(dir: &Path, content: &[u8]) -> PathBuf {
        let path = dir.join(format!("{}.zip", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn revisions_are_immutable_and_listed_with_checksums() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(ROOT_NAME);
        std::fs::create_dir(&root).unwrap();
        let source = archive(temp.path(), b"zip bytes");
        let first = put(
            &root,
            "Paper.zip",
            &source,
            "project-1",
            &json!({"lemlioContent":"c1"}),
        )
        .unwrap();
        let second = put(
            &root,
            "Paper.zip",
            &source,
            "project-1",
            &json!({"lemlioContent":"c1"}),
        )
        .unwrap();
        assert_ne!(first["id"], second["id"], "same name must never overwrite");
        let files = list(&root).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["sha256Checksum"], sha256_file(&source).unwrap());
        assert_eq!(
            files[0]["appProperties"]["lemlioArchiveHash"],
            files[0]["sha256Checksum"]
        );
        assert_eq!(files[0]["appProperties"]["lemlioProject"], "project-1");
        assert_eq!(files[0]["parents"][0], root_id(&root));
        assert_eq!(files[0]["mimeType"], "application/zip");
    }

    #[test]
    fn unfinished_or_foreign_files_are_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let source = archive(temp.path(), b"complete");
        let stored = put(&root, "A.zip", &source, "k", &json!({})).unwrap();
        let id = stored["id"].as_str().unwrap().to_string();
        // A ZIP still syncing (wrong size) disappears until it is complete.
        std::fs::write(zip_path(&root, &id), b"part").unwrap();
        assert!(list(&root).unwrap().is_empty());
        std::fs::write(zip_path(&root, &id), b"complete").unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        // Sidecars that are not generated ids, or not JSON, are ignored.
        std::fs::write(root.join("notes.json"), b"{}").unwrap();
        std::fs::write(
            meta_path(&root, &uuid::Uuid::new_v4().to_string()),
            b"not json",
        )
        .unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
    }

    #[test]
    fn ids_cannot_escape_the_backup_folder() {
        let temp = tempfile::tempdir().unwrap();
        for bad in [
            "../secret",
            "..\\secret",
            "a/b",
            "",
            "not-a-uuid",
            "ABCDEF12-3456-7890-ABCD-EF1234567890",
        ] {
            assert!(!valid_id(bad), "{bad}");
            assert!(archive_path(temp.path(), bad).is_err());
        }
        assert!(valid_id(&uuid::Uuid::new_v4().to_string()));
    }

    #[test]
    fn copies_are_verified_against_the_expected_checksum() {
        let temp = tempfile::tempdir().unwrap();
        let source = archive(temp.path(), b"payload");
        let hash = sha256_file(&source).unwrap();
        let destination = temp.path().join("out.zip");
        copy_verified(&source, &destination, &hash, 1024).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"payload");
        assert!(copy_verified(&source, &destination, "wrong", 1024).is_err());
        assert!(copy_verified(&source, &destination, &hash, 3).is_err());
    }

    #[test]
    fn reset_moves_the_folder_aside_without_deleting_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(ROOT_NAME);
        std::fs::create_dir(&root).unwrap();
        let source = archive(temp.path(), b"keep me");
        put(&root, "A.zip", &source, "k", &json!({})).unwrap();
        let moved = retire_root(&root).unwrap();
        assert!(!root.exists());
        assert!(moved.is_dir());
        assert_eq!(list(&moved).unwrap().len(), 1);
    }
}
