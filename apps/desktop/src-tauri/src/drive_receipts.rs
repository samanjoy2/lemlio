use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};
static LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub project_key: String,
    pub archive_id: String,
    pub archive_hash: String,
    pub source_revision: String,
    pub folder_id: String,
    pub last_backup: u64,
}
fn path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("Cannot locate backup records")?
        .join("Lemlio/drive-projects.json"))
}
pub fn path_key(path: &str) -> String {
    let path = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        let path = path.to_lowercase();
        if let Some(rest) = path.strip_prefix("//?/unc/") {
            format!("//{rest}")
        } else {
            path.strip_prefix("//?/").unwrap_or(&path).to_string()
        }
    } else {
        path
    }
}
fn read() -> Result<BTreeMap<String, Receipt>, String> {
    let path = path()?;
    match std::fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn load(project: &str) -> Result<Option<Receipt>, String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read()?.remove(&path_key(project)))
}
pub fn linked_project(project_key: &str) -> Result<Option<String>, String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read()?
        .into_iter()
        .find(|(path, r)| r.project_key == project_key && std::path::Path::new(path).is_dir())
        .map(|(path, _)| path))
}
pub fn save(project: &str, record: Receipt) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut records = read()?;
    records.insert(path_key(project), record);
    let path = path()?;
    let parent = path.parent().ok_or("Invalid backup record path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &records).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn verbatim_and_ui_paths_share_one_backup_record() {
        assert_eq!(
            super::path_key(r"\\?\C:\Paper"),
            super::path_key("C:/Paper")
        );
        assert_eq!(
            super::path_key(r"\\?\UNC\server\Paper"),
            super::path_key("//server/Paper")
        );
    }
}
