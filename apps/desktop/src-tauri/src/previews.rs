use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};

static CACHE_LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    attempted: bool,
    data_url: Option<String>,
    started_at: u64,
}
fn key(path: &str) -> String {
    let path = path.replace('\\', "/").trim_end_matches('/').to_string();
    let path = if cfg!(target_os = "windows") {
        path.to_lowercase()
    } else {
        path
    };
    format!("{:x}.json", Sha256::digest(path.as_bytes()))
}
fn load(root: &Path, project: &str) -> Result<Thumbnail, String> {
    match std::fs::read(root.join(key(project))) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Thumbnail::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn save(
    root: &Path,
    project: &str,
    png: Option<Vec<u8>>,
    started_at: u64,
) -> Result<Thumbnail, String> {
    if let Some(bytes) = &png {
        if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Invalid thumbnail PNG".into());
        }
    }
    let previous = load(root, project).unwrap_or_default();
    if previous.started_at > started_at {
        return Ok(previous);
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let record = Thumbnail {
        attempted: true,
        data_url: png.map(|bytes| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        }),
        started_at,
    };
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &record).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(root.join(key(project)))
        .map_err(|e| e.to_string())?;
    Ok(record)
}
fn root() -> Result<std::path::PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("Cannot locate thumbnail storage")?
        .join("Lemlio/Thumbnails"))
}
#[tauri::command]
pub fn load_project_thumbnail(project_path: String) -> Result<Thumbnail, String> {
    let _lock = CACHE_LOCK.lock().map_err(|e| e.to_string())?;
    load(&root()?, &project_path)
}
#[tauri::command]
pub fn save_project_thumbnail(
    project_path: String,
    png: Option<Vec<u8>>,
    started_at: u64,
) -> Result<Thumbnail, String> {
    let _lock = CACHE_LOCK.lock().map_err(|e| e.to_string())?;
    save(&root()?, &project_path, png, started_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_success_and_failure_across_loads_and_rejects_stale_generation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let path = "C:/Paper";
        assert!(!load(root, path).unwrap().attempted);
        save(root, path, None, 10).unwrap();
        assert!(load(root, path).unwrap().attempted);
        let png = b"\x89PNG\r\n\x1a\nexample".to_vec();
        save(root, path, Some(png.clone()), 20).unwrap();
        assert!(load(root, path)
            .unwrap()
            .data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
        save(root, path, None, 15).unwrap();
        assert!(load(root, path).unwrap().data_url.is_some());
        assert!(save(root, path, Some(vec![1, 2]), 30).is_err());
        assert_eq!(load(root, path).unwrap().started_at, 20);
    }
}
