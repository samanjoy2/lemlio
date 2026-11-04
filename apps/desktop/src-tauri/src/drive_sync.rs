//! Portable revisions and an append-only revision graph. No clock decides a winner.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MANIFEST: &str = ".lemlio-sync.json";

pub fn content_revision(source: &Path, title: &str) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(b"Lemlio-content-v1\0");
    hash.update((title.len() as u64).to_le_bytes());
    hash.update(title.as_bytes());
    let mut entries = crate::projects::project_entries(source)?;
    entries.sort_by_key(|(path, _)| path.to_string_lossy().replace('\\', "/"));
    for (relative, directory) in entries {
        let name = relative.to_string_lossy().replace('\\', "/");
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update([u8::from(directory)]);
        if !directory {
            let mut file = std::fs::File::open(source.join(relative)).map_err(|e| e.to_string())?;
            hash.update(
                file.metadata()
                    .map_err(|e| e.to_string())?
                    .len()
                    .to_le_bytes(),
            );
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Parents are committed with the ZIP, so concurrent writers create two heads
/// instead of silently overwriting one another. Old zip-v2 archives are roots.
pub fn heads<'a>(files: &'a [Value], project: &str) -> Vec<&'a Value> {
    let files: Vec<_> = files
        .iter()
        .filter(|f| {
            f["trashed"] != true
                && f["mimeType"] == "application/zip"
                && f["appProperties"]["lemlioFormat"] == "zip-v2"
                && f["appProperties"]["lemlioProject"] == project
        })
        .collect();
    let parents: BTreeSet<_> = files
        .iter()
        .flat_map(|f| {
            (0..16).filter_map(move |i| f["appProperties"][format!("lemlioParent{i}")].as_str())
        })
        .collect();
    files
        .into_iter()
        .filter(|f| f["id"].as_str().is_some_and(|id| !parents.contains(id)))
        .collect()
}

pub fn device() -> Result<Value, String> {
    let path = dirs::config_dir()
        .ok_or("Cannot locate device settings")?
        .join("Lemlio/sync-device.json");
    if let Ok(raw) = std::fs::read(&path) {
        let value: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        if value["id"].as_str().is_some() {
            return Ok(value);
        }
    }
    let label = if cfg!(target_os = "windows") {
        "Windows PC"
    } else if cfg!(target_os = "macos") {
        "Mac"
    } else {
        "Linux PC"
    };
    let id = uuid::Uuid::new_v4().to_string();
    let value = json!({"id":id,"name":format!("{label} {}", &id[..6])});
    let parent = path.parent().ok_or("Invalid device settings path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &value).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(value)
}

pub fn append_manifest(archive: &Path, manifest: &Value) -> Result<(), String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(archive)
        .map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new_append(file).map_err(|e| e.to_string())?;
    zip.start_file(
        MANIFEST,
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .map_err(|e| e.to_string())?;
    zip.write_all(&serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    zip.finish()
        .map_err(|e| e.to_string())?
        .sync_all()
        .map_err(|e| e.to_string())
}

/// Swap a verified staged project in place. The previous complete source is
/// retained beside it, hidden from library discovery. Never delete user data.
pub fn install_snapshot(
    source: &Path,
    staged: &Path,
    expected: &str,
    title: &str,
) -> Result<PathBuf, String> {
    if content_revision(source, title)? != expected {
        return Err("Local files changed during download; nothing was replaced".into());
    }
    let parent = source.parent().ok_or("Cannot update a filesystem root")?;
    let recovery = parent.join(format!(".lemlio-recovery-{}", uuid::Uuid::new_v4()));
    // Preserve local-only state (git, virtual environment, compiler/history caches).
    let exported: BTreeSet<_> = crate::projects::project_entries(source)?
        .into_iter()
        .filter_map(|(p, _)| p.components().next().map(|c| c.as_os_str().to_owned()))
        .collect();
    let local_only: Vec<_> = std::fs::read_dir(source)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| !exported.contains(&e.file_name()))
        .map(|e| e.file_name())
        .collect();
    std::fs::rename(source, &recovery)
        .map_err(|e| format!("Close external programs using this folder and retry: {e}"))?;
    // Recheck the parked folder: a save that raced the first check is preserved.
    if content_revision(&recovery, title).as_deref() != Ok(expected) {
        std::fs::rename(&recovery, source)
            .map_err(|e| format!("Files kept at {}: {e}", recovery.display()))?;
        return Err("Local files changed during download; nothing was replaced".into());
    }
    let mut moved = Vec::new();
    let outcome = (|| {
        for name in local_only {
            if staged.join(&name).exists() {
                return Err("Downloaded ZIP contains local-only state".to_string());
            }
            std::fs::rename(recovery.join(&name), staged.join(&name)).map_err(|e| e.to_string())?;
            moved.push(name);
        }
        std::fs::rename(staged, source).map_err(|e| e.to_string())
    })();
    if let Err(error) = outcome {
        for name in moved.iter().rev() {
            std::fs::rename(staged.join(name), recovery.join(name))
                .map_err(|e| format!("Recovery at {}: {e}", recovery.display()))?;
        }
        std::fs::rename(&recovery, source)
            .map_err(|e| format!("Files kept at {}: {e}", recovery.display()))?;
        return Err(format!(
            "Update could not be installed; local files kept: {error}"
        ));
    }
    Ok(recovery)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn revision(id: &str, parents: &[&str]) -> Value {
        let mut v = json!({"id":id,"mimeType":"application/zip","appProperties":{"lemlioProject":"paper","lemlioFormat":"zip-v2"}});
        for (i, parent) in parents.iter().enumerate() {
            v["appProperties"][format!("lemlioParent{i}")] = json!(parent);
        }
        v
    }
    #[test]
    fn concurrent_writers_are_two_heads_until_explicit_resolution() {
        let mut files = vec![
            revision("original", &[]),
            revision("pc", &["original"]),
            revision("mac", &["original"]),
        ];
        assert_eq!(heads(&files, "paper").len(), 2);
        files.push(revision("resolved", &["pc", "mac"]));
        assert_eq!(heads(&files, "paper")[0]["id"], "resolved");
        assert_eq!(files.len(), 4); // Every previous source remains recoverable.
        assert!(heads(&files, "unrelated").is_empty());
    }
    #[test]
    fn content_identity_is_portable_and_includes_names_deletions_and_titles() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("pc");
        let b = temp.path().join("mac");
        for path in [&a, &b] {
            std::fs::create_dir(path).unwrap();
            std::fs::write(path.join("main.tex"), "same content").unwrap();
        }
        let base = content_revision(&a, "Paper").unwrap();
        assert_eq!(base, content_revision(&b, "Paper").unwrap());
        std::fs::create_dir(b.join(".git")).unwrap();
        std::fs::write(b.join(".git/local"), "device only").unwrap();
        assert_eq!(base, content_revision(&b, "Paper").unwrap());
        assert_ne!(base, content_revision(&b, "Renamed paper").unwrap());
        std::fs::write(b.join("main.tex"), "edit content").unwrap();
        assert_ne!(base, content_revision(&b, "Paper").unwrap());
        std::fs::rename(b.join("main.tex"), b.join("paper.tex")).unwrap();
        assert_ne!(base, content_revision(&b, "Paper").unwrap());
    }
    #[test]
    fn fast_forward_keeps_recovery_and_local_git_and_rejects_changed_baseline() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("Paper");
        let stage = temp.path().join("staged");
        std::fs::create_dir_all(source.join(".git")).unwrap();
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(source.join("main.tex"), "old source").unwrap();
        std::fs::write(source.join("deleted.bib"), "old references").unwrap();
        std::fs::write(source.join(".git/config"), "local repository").unwrap();
        std::fs::write(stage.join("main.tex"), "new source").unwrap();
        assert!(install_snapshot(&source, &stage, "outdated-baseline", "Paper").is_err());
        assert_eq!(
            std::fs::read_to_string(source.join("main.tex")).unwrap(),
            "old source"
        );
        let base = content_revision(&source, "Paper").unwrap();
        let recovery = install_snapshot(&source, &stage, &base, "Paper").unwrap();
        assert_eq!(
            std::fs::read_to_string(source.join("main.tex")).unwrap(),
            "new source"
        );
        assert_eq!(
            std::fs::read_to_string(recovery.join("main.tex")).unwrap(),
            "old source"
        );
        assert!(!source.join("deleted.bib").exists());
        assert!(recovery.join("deleted.bib").exists());
        assert_eq!(
            std::fs::read_to_string(source.join(".git/config")).unwrap(),
            "local repository"
        );
    }
    #[test]
    fn failed_install_rolls_back_moved_local_state() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("Paper");
        let stage = temp.path().join("staged");
        for root in [&source, &stage] {
            std::fs::create_dir_all(root.join(".git")).unwrap();
            std::fs::write(root.join("main.tex"), "source").unwrap();
        }
        let base = content_revision(&source, "Paper").unwrap();
        assert!(install_snapshot(&source, &stage, &base, "Paper").is_err());
        assert!(source.join("main.tex").exists());
        assert!(source.join(".git").exists());
    }
}
