//! Local durable replicas and an authenticated, opaque WebSocket relay.
//! Hosting has no authority over document versions; Yjs merges on each peer.
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc, oneshot, Mutex},
};
use tokio_tungstenite::{
    accept_async_with_config, connect_async,
    tungstenite::{protocol::WebSocketConfig, Message},
};

pub const FOLDER: &str = ".lemlio-collab";
pub const LIMIT: usize = 96 * 1024 * 1024;
fn message_key(key: &str) -> Result<Aes256Gcm, String> {
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid collaboration key".into());
    }
    let mut bytes = [0u8; 32];
    for (index, item) in bytes.iter_mut().enumerate() {
        *item = u8::from_str_radix(&key[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Invalid collaboration key")?;
    }
    Aes256Gcm::new_from_slice(&bytes).map_err(|_| "Invalid collaboration key".into())
}
#[tauri::command]
pub fn collaboration_authenticate(key: String) -> Result<String, String> {
    message_key(&key)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("Lemlio collaboration auth:{key}").as_bytes())
    ))
}
#[tauri::command]
pub fn collaboration_encrypt(id: String, key: String, plaintext: String) -> Result<String, String> {
    if id.len() > 128 || plaintext.len() > 144 * 1024 * 1024 {
        return Err("Shared message exceeds the size limit".into());
    }
    let cipher = message_key(&key)?;
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let data = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext.as_bytes(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| "Cannot encrypt the shared message")?;
    Ok(json!({"schema":1,"iv":STANDARD.encode(iv),"data":STANDARD.encode(data)}).to_string())
}
#[tauri::command]
pub fn collaboration_decrypt(id: String, key: String, body: String) -> Result<String, String> {
    if id.len() > 128 || body.len() > 192 * 1024 * 1024 {
        return Err("Shared message exceeds the size limit".into());
    }
    let cipher = message_key(&key)?;
    let value: Value = serde_json::from_str(&body).map_err(|_| "Invalid encrypted message")?;
    if value["schema"] != 1 {
        return Err("Unsupported collaboration message".into());
    }
    let iv = STANDARD
        .decode(value["iv"].as_str().ok_or("Missing message nonce")?)
        .map_err(|_| "Invalid message nonce")?;
    if iv.len() != 12 {
        return Err("Invalid message nonce".into());
    }
    let data = STANDARD
        .decode(value["data"].as_str().ok_or("Missing encrypted data")?)
        .map_err(|_| "Invalid encrypted data")?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &data,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| "Shared message authentication failed")?;
    String::from_utf8(plain).map_err(|_| "Invalid shared message encoding".into())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub id: String,
    pub drive_project_id: String,
    pub title: String,
    #[serde(default)]
    pub source_hash: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct DiskFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

pub fn manifest(root: &Path) -> Result<Option<Manifest>, String> {
    let path = root.join(FOLDER).join("project.json");
    if !path.exists() {
        if root.join(FOLDER).exists() {
            return Err("Shared project identity is missing. Restore its .lemlio-collab folder from a project backup before continuing.".into());
        }
        return Ok(None);
    }
    let m: Manifest = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if m.schema != 1 || uuid::Uuid::parse_str(&m.id).is_err() || m.drive_project_id.len() > 128 {
        return Err("Unsupported collaboration identity".into());
    }
    Ok(Some(m))
}
fn safe_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.len() > 1024
        || name.contains('\\')
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return Err("Invalid shared file path".into());
    }
    let mut destination = root.to_path_buf();
    for part in name.split('/') {
        let lower = part.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or_default();
        if part.is_empty()
            || part.starts_with('.')
            || part.ends_with(['.', ' '])
            || matches!(
                stem,
                "con" | "prn" | "aux" | "nul" | "keys" | "node_modules" | "conversations"
            )
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            || lower.starts_with("client_secret")
            || matches!(
                lower.as_str(),
                "google-drive-oauth.json" | "drive-client.json"
            )
        {
            return Err("Hidden, credential and reserved paths cannot be shared".into());
        }
        destination.push(part);
        if let Ok(metadata) = std::fs::symlink_metadata(&destination) {
            if metadata.file_type().is_symlink() {
                return Err("Shared paths cannot contain links".into());
            }
        }
    }
    Ok(destination)
}
fn canonical(root: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.is_dir() || root.parent().is_none() {
        return Err("Choose a project folder".into());
    }
    for part in [".prism", FOLDER] {
        if std::fs::symlink_metadata(root.join(part))
            .ok()
            .is_some_and(|m| m.file_type().is_symlink())
        {
            return Err("Collaboration storage cannot contain links".into());
        }
    }
    Ok(root)
}
fn bytes(file: &DiskFile) -> Result<Vec<u8>, String> {
    match (&file.text, &file.data) {
        (Some(text), None) => Ok(text.as_bytes().to_vec()),
        (None, Some(data)) => STANDARD
            .decode(data)
            .map_err(|_| "Invalid shared binary data".into()),
        _ => Err("Choose text or binary content for a shared file".into()),
    }
}
fn atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid storage path")?)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    temp.write_all(data).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn baseline_path(root: &Path) -> PathBuf {
    root.join(".prism/collaboration/materialized.json")
}
fn checkpoint_lock(root: &Path) -> Result<std::fs::File, String> {
    let path = root.join(".prism/collaboration/checkpoint.lock");
    std::fs::create_dir_all(path.parent().ok_or("Missing checkpoint directory")?)
        .map_err(|e| e.to_string())?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    fs2::FileExt::lock_exclusive(&file).map_err(|e| e.to_string())?;
    Ok(file)
}
fn local_settings(id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid shared project ID".into());
    }
    Ok(dirs::config_dir()
        .ok_or("Cannot locate local settings")?
        .join("Lemlio/collaboration")
        .join(format!("{id}.json")))
}
fn settings(id: &str) -> Value {
    local_settings(id)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(json!({}))
}
fn disk_file(name: String, data: Vec<u8>) -> DiskFile {
    let ext = Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let editable = matches!(
        ext.as_str(),
        "tex"
            | "ltx"
            | "bib"
            | "sty"
            | "cls"
            | "bst"
            | "def"
            | "cfg"
            | "fd"
            | "dtx"
            | "ins"
            | "txt"
            | "md"
            | "markdown"
            | "csv"
            | "tsv"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "py"
            | "r"
            | "jl"
            | "js"
            | "ts"
            | "css"
            | "html"
            | "sh"
            | "bat"
            | "ps1"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "qmd"
            | "rmd"
            | "ipynb"
    ) || matches!(stem.as_str(), "makefile" | "readme" | "license");
    let text = if editable {
        std::str::from_utf8(&data)
            .ok()
            .filter(|s| !s.contains('\0'))
            .map(str::to_string)
    } else {
        None
    };
    DiskFile {
        path: name,
        data: if text.is_none() {
            Some(STANDARD.encode(&data))
        } else {
            None
        },
        text,
    }
}
fn inventory(root: &Path) -> Result<Vec<DiskFile>, String> {
    let mut output = Vec::new();
    let mut total = 0;
    for (relative, directory) in crate::projects::project_entries(root)? {
        if directory {
            continue;
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        if safe_path(root, &name).is_err() {
            continue;
        }
        let data = std::fs::read(root.join(relative)).map_err(|e| e.to_string())?;
        total += data.len();
        if total > 16 * 1024 * 1024 {
            return Err("Live shared project files must total at most 16 MB. Clone a smaller project or remove generated outputs first.".into());
        }
        output.push(disk_file(name, data));
    }
    Ok(output)
}
pub fn source_hash(files: &[DiskFile]) -> Result<String, String> {
    let mut sorted: Vec<_> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hash = Sha256::new();
    hash.update(b"Lemlio-shared-files-v1\0");
    for file in sorted {
        let data = bytes(file)?;
        hash.update((file.path.len() as u64).to_le_bytes());
        hash.update(file.path.as_bytes());
        hash.update((data.len() as u64).to_le_bytes());
        hash.update(data);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn files_from_archive(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
) -> Result<Vec<DiskFile>, String> {
    let validation = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut names = BTreeSet::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        if file.is_dir() || safe_path(validation.path(), &name).is_err() {
            continue;
        }
        if !names.insert(name.clone()) {
            return Err("Duplicate shared ZIP path".into());
        }
        let mut data = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(file, (16 * 1024 * 1024 + 1) as u64),
            &mut data,
        )
        .map_err(|e| e.to_string())?;
        total += data.len();
        if total > 16 * 1024 * 1024 {
            return Err("Shared ZIP source exceeds 16 MB".into());
        }
        files.push(disk_file(name, data));
    }
    Ok(files)
}
fn read_baseline(root: &Path) -> Result<Vec<DiskFile>, String> {
    let path = baseline_path(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn collaboration_load(project_path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let root=canonical(&project_path)?;
        let Some(m)=manifest(&root)? else{return Ok(json!({"enabled":false}));};
        let state_path=root.join(FOLDER).join("state.bin");
        let data=if state_path.exists(){std::fs::read(state_path).map_err(|e|e.to_string())?}else{Vec::new()};
        if data.len()>LIMIT{return Err("Shared history exceeds 96 MB".into());}
        Ok(json!({"enabled":true,"manifest":m,"settings":settings(&m.id),"stateHash":format!("{:x}",Sha256::digest(&data)),"state":STANDARD.encode(data),"files":inventory(&root)?,"baseline":read_baseline(&root)?}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn collaboration_enable(project_path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical(&project_path)?;
        if manifest(&root)?.is_none() {
            let id = uuid::Uuid::new_v4().to_string();
            let drive_id = crate::drive_receipts::load(&project_path)?
                .map(|r| r.project_key)
                .unwrap_or_else(|| id.clone());
            let title = crate::projects::project_details(project_path.clone())?
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    root.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                });
            let m = Manifest {
                schema: 1,
                id: id.clone(),
                drive_project_id: drive_id,
                title,
                source_hash: None,
            };
            let original = inventory(&root)?;
            if original.is_empty() {
                return Err("Create a source file before sharing this project".into());
            }
            let secret = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            atomic(
                &local_settings(&id)?,
                &serde_json::to_vec(&json!({"key":secret,"projectPath":root}))
                    .map_err(|e| e.to_string())?,
            )?;
            atomic(
                &baseline_path(&root),
                &serde_json::to_vec(&original).map_err(|e| e.to_string())?,
            )?;
            atomic(
                &root.join(FOLDER).join("project.json"),
                &serde_json::to_vec(&m).map_err(|e| e.to_string())?,
            )?;
        }
        Ok(json!({"path":root}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn collaboration_configure(
    project_path: String,
    id: String,
    key: String,
    endpoint: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    let root = canonical(&project_path)?;
    if manifest(&root)?.ok_or("Enable collaboration first")?.id != id
        || key.len() != 64
        || !key.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("The invitation does not match this project".into());
    }
    if let Some(url) = &endpoint {
        validate_endpoint(url)?;
    }
    if settings(&id)["key"]
        .as_str()
        .is_some_and(|saved| saved != key)
    {
        return Err("Invitation key does not match the locally saved project".into());
    }
    atomic(&local_settings(&id)?,&serde_json::to_vec(&json!({"key":key,"endpoint":endpoint,"projectPath":root,"name":name.unwrap_or("Writer".into()).chars().take(48).collect::<String>()})).map_err(|e|e.to_string())?)
}
#[tauri::command]
pub async fn collaboration_create(
    id: String,
    key: String,
    title: String,
) -> Result<String, String> {
    if uuid::Uuid::parse_str(&id).is_err()
        || key.len() != 64
        || !key.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Invalid collaboration invitation".into());
    }
    let previous = settings(&id);
    if previous["key"].as_str().is_some_and(|saved| saved != key) {
        return Err("This project already has a different saved invitation key".into());
    }
    if let Some(path) = previous["projectPath"].as_str() {
        if Path::new(path).is_dir() && manifest(Path::new(path))?.is_some_and(|m| m.id == id) {
            return Ok(path.to_string());
        }
    }
    let library = crate::projects::library_root()?;
    let imports = library.join("Imports");
    std::fs::create_dir_all(&imports).map_err(|e| e.to_string())?;
    // Never mix a new invitation into an unrelated existing folder.
    let folder = imports.join(format!(
        "Shared project - {}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let m = Manifest {
        schema: 1,
        id: id.clone(),
        drive_project_id: id.clone(),
        title: title.chars().take(200).collect(),
        source_hash: None,
    };
    atomic(
        &folder.join(FOLDER).join("project.json"),
        &serde_json::to_vec(&m).map_err(|e| e.to_string())?,
    )?;
    atomic(
        &local_settings(&id)?,
        &serde_json::to_vec(&json!({"key":key,"projectPath":folder})).map_err(|e| e.to_string())?,
    )?;
    let path = folder.to_string_lossy().to_string();
    crate::projects::rename_project(path.clone(), m.title)?;
    Ok(path)
}
#[tauri::command]
pub async fn collaboration_inventory(project_path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical(&project_path)?;
        Ok(json!({"files":inventory(&root)?,"baseline":read_baseline(&root)?}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn collaboration_persist(
    project_path: String,
    id: String,
    state: String,
    drive_project_id: String,
    title: String,
    expected_hash: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical(&project_path)?;
        let _lock = checkpoint_lock(&root)?;
        let current=std::fs::read(root.join(FOLDER).join("state.bin")).unwrap_or_default();
        if format!("{:x}",Sha256::digest(&current))!=expected_hash{return Err("Shared history changed in another window. Save local files and reopen this project before reconnecting.".into());}
        let mut m = manifest(&root)?.ok_or("Shared identity is missing")?;
        if m.id != id || drive_project_id.len() > 128 {
            return Err("Shared identity changed".into());
        }
        let data = STANDARD
            .decode(state)
            .map_err(|_| "Invalid shared history")?;
        if data.len() > LIMIT {
            return Err("Shared history exceeds 96 MB; export a recovery copy".into());
        }
        m.drive_project_id = drive_project_id;
        let title:String=title.trim().chars().take(200).collect();
        if !title.is_empty() && m.title!=title {crate::projects::rename_project(project_path.clone(),title.clone())?;m.title=title;}
        atomic(&root.join(FOLDER).join("project.json"),&serde_json::to_vec(&m).map_err(|e| e.to_string())?)?;
        atomic(&root.join(FOLDER).join("state.bin"), &data)?;
        Ok(format!("{:x}",Sha256::digest(&data)))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Compare-and-write each managed file. Unexpected local data is never overwritten.
fn materialize(root: &Path, files: Vec<DiskFile>, protected: Vec<String>) -> Result<Value, String> {
    let baseline = read_baseline(root)?;
    let old: BTreeMap<_, _> = baseline
        .iter()
        .map(|f| (f.path.clone(), f.clone()))
        .collect();
    let mut unique = BTreeSet::new();
    let mut total = 0;
    for f in &files {
        safe_path(root, &f.path)?;
        if !unique.insert(f.path.to_lowercase()) {
            return Err("Two shared files use the same path".into());
        }
        total += bytes(f)?.len();
    }
    if total > 16 * 1024 * 1024 {
        return Err("Shared files exceed 16 MB".into());
    }
    let mut conflicts = Vec::new();
    let mut saved = Vec::new();
    let protected: BTreeSet<_> = protected.into_iter().collect();
    for f in files {
        let target = safe_path(root, &f.path)?;
        let next = bytes(&f)?;
        let current = std::fs::read(&target).ok();
        let expected = old.get(f.path.as_str()).map(|v| bytes(v)).transpose()?;
        if current.as_ref() != Some(&next) && current.is_some() && current != expected {
            conflicts.push(f.path.clone());
            if let Some(old) = old.get(f.path.as_str()) {
                saved.push(old.clone());
            }
            continue;
        }
        if current.as_ref() != Some(&next) {
            atomic(&target, &next)?;
        }
        saved.push(f);
    }
    for f in baseline {
        if unique.contains(&f.path.to_lowercase()) || protected.contains(&f.path) {
            continue;
        }
        let path = safe_path(root, &f.path)?;
        match std::fs::read(&path) {
            Ok(current) if current == bytes(&f)? => {
                // Preserve deleted source in local recovery storage before removal.
                let recovery = root
                    .join(".prism/collaboration/recovery")
                    .join(uuid::Uuid::new_v4().to_string())
                    .join(&f.path);
                atomic(&recovery, &current)?;
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            Ok(_) => {
                conflicts.push(f.path.clone());
                saved.push(f);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    // Keep blocked files in the baseline, so a conflict never looks like a new file.
    for path in &protected {
        if !saved.iter().any(|f| f.path == *path) {
            if let Some(f) = old.get(path.as_str()) {
                saved.push(f.clone());
            } else if let Ok(destination) = safe_path(root, path) {
                if destination.is_file() {
                    saved.push(disk_file(
                        path.clone(),
                        std::fs::read(destination).map_err(|e| e.to_string())?,
                    ));
                }
            }
        }
    }
    atomic(
        &baseline_path(root),
        &serde_json::to_vec(&saved).map_err(|e| e.to_string())?,
    )?;
    if conflicts.is_empty() && protected.is_empty() {
        if let Some(mut m) = manifest(root)? {
            m.source_hash = Some(source_hash(&inventory(root)?)?);
            atomic(
                &root.join(FOLDER).join("project.json"),
                &serde_json::to_vec(&m).map_err(|e| e.to_string())?,
            )?;
        }
    }
    Ok(json!({"conflicts":conflicts}))
}
#[tauri::command]
pub async fn collaboration_materialize(
    project_path: String,
    id: String,
    files: Vec<DiskFile>,
    protected: Vec<String>,
    expected_hash: String,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical(&project_path)?;
        let _lock = checkpoint_lock(&root)?;
        let current =
            std::fs::read(root.join(FOLDER).join("state.bin")).map_err(|e| e.to_string())?;
        if format!("{:x}", Sha256::digest(&current)) != expected_hash {
            return Err("Shared history changed in another window; source files were kept".into());
        }
        if manifest(&root)?.ok_or("Shared project missing")?.id != id {
            return Err("Shared identity changed".into());
        }
        materialize(&root, files, protected)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn collaboration_accept_disk(
    project_path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical(&project_path)?;
        manifest(&root)?.ok_or("This is not a shared project")?;
        let disk = inventory(&root)?;
        let mut baseline = read_baseline(&root)?;
        for name in paths {
            let path = safe_path(&root, &name)?;
            if path.is_file() {
                let recovery = root
                    .join(".prism/collaboration/recovery")
                    .join(uuid::Uuid::new_v4().to_string())
                    .join(&name);
                atomic(&recovery, &std::fs::read(&path).map_err(|e| e.to_string())?)?;
            }
            baseline.retain(|f| f.path != name);
            if let Some(file) = disk.iter().find(|f| f.path == name) {
                baseline.push(file.clone());
            }
        }
        atomic(
            &baseline_path(&root),
            &serde_json::to_vec(&baseline).map_err(|e| e.to_string())?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Host {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}
struct Connection {
    stop: oneshot::Sender<()>,
    send: mpsc::Sender<String>,
    id: String,
}
#[derive(Default)]
pub struct CollaborationNetwork {
    host: Mutex<Option<Host>>,
    client: Mutex<Option<Connection>>,
}
pub fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url =
        reqwest::Url::parse(endpoint).map_err(|_| "Enter a ws:// or wss:// server address")?;
    if !matches!(url.scheme(), "ws" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use a WebSocket host and port without credentials or a path".into());
    }
    Ok(())
}
fn valid_auth(auth: &str) -> bool {
    auth.len() == 64 && auth.bytes().all(|c| c.is_ascii_hexdigit())
}
async fn run_relay(
    listener: TcpListener,
    id: String,
    auth: String,
    mut stop: oneshot::Receiver<()>,
) {
    let (tx, _) = broadcast::channel::<(String, String)>(4);
    let peers = Arc::new(tokio::sync::Semaphore::new(12));
    let (shutdown, _) = broadcast::channel::<()>(1);
    loop {
        tokio::select! {
            _=&mut stop=>{let _=shutdown.send(());break;},
            accepted=listener.accept()=>{
                let Ok((stream,_))=accepted else{break;};
                let Ok(permit)=peers.clone().try_acquire_owned() else{continue;};
                let tx=tx.clone();let id=id.clone();let auth=auth.clone();let mut shutdown=shutdown.subscribe();
                tokio::spawn(async move{
                    let _permit=permit;
                    let config=WebSocketConfig::default().max_message_size(Some(192*1024*1024)).max_frame_size(Some(192*1024*1024));
                    let Ok(Ok(mut socket))=tokio::time::timeout(Duration::from_secs(5),accept_async_with_config(stream,Some(config))).await else{return;};
                    let Ok(Some(Ok(Message::Text(first))))=tokio::time::timeout(Duration::from_secs(5),socket.next()).await else{return;};
                    if first.len()>1024{return;}
                    let Ok(hello)=serde_json::from_str::<Value>(&first)else{return;};
                    let supplied=hello["auth"].as_str().unwrap_or_default();
                    let same=supplied.len()==auth.len() && supplied.bytes().zip(auth.bytes()).fold(0,|v,(a,b)|v|(a^b))==0;
                    if hello["project"]!=id || !same {let _=socket.close(None).await;return;}
                    let peer=uuid::Uuid::new_v4().to_string();
                    let mut rx=tx.subscribe();
                    if socket.send(Message::Text("{\"ready\":true}".into())).await.is_err(){return;}
                    let (mut writer,mut reader)=socket.split();
                    let mut count=0;let mut start=std::time::Instant::now();
                    loop{tokio::select!{
                        _=shutdown.recv()=>break,
                        message=reader.next()=>match message{
                            Some(Ok(Message::Text(body)))=>{
                                if start.elapsed()>Duration::from_secs(1){start=std::time::Instant::now();count=0;}
                                count+=1;if count>100 || body.len()>192*1024*1024{break;}
                                let _=tx.send((peer.clone(),body.to_string()));
                            },
                            Some(Ok(Message::Ping(p)))=>{if writer.send(Message::Pong(p)).await.is_err(){break;}},
                            Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                            _=>{},
                        },
                        message=rx.recv()=>match message{Ok((source,body)) if source!=peer=>{if writer.send(Message::Text(body.into())).await.is_err(){break;}},Ok(_)=>{},Err(_)=>break},
                    }}
                });
            }
        }
    }
}
#[tauri::command]
pub async fn collaboration_host(
    state: tauri::State<'_, CollaborationNetwork>,
    id: String,
    auth: String,
    port: u16,
) -> Result<Value, String> {
    if uuid::Uuid::parse_str(&id).is_err() || !valid_auth(&auth) {
        return Err("Invalid hosting identity".into());
    }
    let mut host = state.host.lock().await;
    if let Some(old) = host.take() {
        let _ = old.stop.send(());
        let _ = old.task.await;
    }
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("Cannot start collaboration server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let address = std::net::UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|s| {
            s.connect("192.0.2.1:9").ok()?;
            s.local_addr().ok()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or("127.0.0.1".into());
    let (stop, rx) = oneshot::channel();
    let task = tokio::spawn(run_relay(listener, id.clone(), auth, rx));
    *host = Some(Host { stop, task });
    Ok(json!({"port":port,"address":address}))
}
#[tauri::command]
pub async fn collaboration_stop_host(
    state: tauri::State<'_, CollaborationNetwork>,
) -> Result<(), String> {
    if let Some(host) = state.host.lock().await.take() {
        let _ = host.stop.send(());
        let _ = host.task.await;
    }
    Ok(())
}
#[tauri::command]
pub async fn collaboration_disconnect(
    state: tauri::State<'_, CollaborationNetwork>,
    connection: Option<String>,
) -> Result<(), String> {
    let mut client = state.client.lock().await;
    if connection
        .as_ref()
        .is_none_or(|id| client.as_ref().is_some_and(|c| &c.id == id))
    {
        if let Some(old) = client.take() {
            let _ = old.stop.send(());
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn collaboration_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, CollaborationNetwork>,
    id: String,
    auth: String,
    endpoint: String,
) -> Result<String, String> {
    validate_endpoint(&endpoint)?;
    if !valid_auth(&auth) {
        return Err("Invalid invitation key".into());
    }
    let mut current = state.client.lock().await;
    if let Some(old) = current.take() {
        let _ = old.stop.send(());
    }
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(8), connect_async(&endpoint))
        .await
        .map_err(|_| "Collaboration host did not respond")?
        .map_err(|_| {
            "Cannot reach the collaboration host. Check its address, firewall and private network."
        })?;
    socket
        .send(Message::Text(
            json!({"project":id,"auth":auth}).to_string().into(),
        ))
        .await
        .map_err(|_| "Cannot join this session")?;
    let first = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .map_err(|_| "The host did not accept the invitation")?;
    if !matches!(first,Some(Ok(Message::Text(ref v))) if v.as_str()=="{\"ready\":true}") {
        return Err("Invitation rejected by this host".into());
    }
    let connection = uuid::Uuid::new_v4().to_string();
    let (send, mut messages) = mpsc::channel::<String>(8);
    let (stop, mut stopped) = oneshot::channel();
    *current = Some(Connection {
        stop,
        send,
        id: connection.clone(),
    });
    let event_id = connection.clone();
    tokio::spawn(async move {
        let (mut writer, mut reader) = socket.split();
        loop {
            tokio::select! {
                _=&mut stopped=>break,
                message=messages.recv()=>match message{Some(body)=>{if writer.send(Message::Text(body.into())).await.is_err(){break;}},None=>break},
                incoming=reader.next()=>match incoming{
                    Some(Ok(Message::Text(body))) if body.len()<=192*1024*1024=>{let _=app.emit("lemlio-collaboration-message",json!({"connection":event_id,"body":body.as_str()}));},
                    Some(Ok(Message::Ping(data)))=>{let _=writer.send(Message::Pong(data)).await;},
                    Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                    _=>{},
                }
            }
        }
        let _ = writer.close().await;
        let _ = app.emit(
            "lemlio-collaboration-disconnected",
            json!({"connection":event_id}),
        );
    });
    Ok(connection)
}
#[tauri::command]
pub async fn collaboration_send(
    state: tauri::State<'_, CollaborationNetwork>,
    connection: String,
    body: String,
) -> Result<(), String> {
    if body.len() > 192 * 1024 * 1024 {
        return Err("Shared update exceeds transport limit".into());
    }
    let send = {
        let client = state.client.lock().await;
        client
            .as_ref()
            .filter(|c| c.id == connection)
            .ok_or("Session disconnected; changes remain local")?
            .send
            .clone()
    };
    tokio::time::timeout(Duration::from_secs(3), send.send(body))
        .await
        .map_err(|_| {
            "The collaboration connection is busy; reconnect to resend the saved history"
                .to_string()
        })?
        .map_err(|_| "Session disconnected; changes remain local".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn incomplete_shared_identity_cannot_be_treated_as_an_ordinary_project() {
        let root = tempfile::tempdir().unwrap();
        assert!(manifest(root.path()).unwrap().is_none());
        std::fs::create_dir(root.path().join(FOLDER)).unwrap();
        std::fs::write(root.path().join(FOLDER).join("state.bin"), b"history").unwrap();
        assert!(manifest(root.path())
            .err()
            .unwrap()
            .contains("identity is missing"));
    }
    use super::*;
    #[test]
    fn ascii_pdf_and_images_remain_binary_even_when_they_are_valid_utf8() {
        let data = b"%PDF-1.4\r\nASCII PDF bytes with byte-based offsets\r\n".to_vec();
        let file = disk_file("figs/source.pdf".into(), data.clone());
        assert!(file.text.is_none());
        assert_eq!(bytes(&file).unwrap(), data);
        let source = disk_file("main.tex".into(), b"first\r\nsecond".to_vec());
        assert_eq!(source.text.as_deref(), Some("first\r\nsecond"));
    }
    #[test]
    fn native_crypto_matches_webcrypto_and_rejects_tampering() {
        let id = "48b69ae1-ea1a-4718-8fc5-385757d4b8b5".to_string();
        let key = "12".repeat(32);
        let vector=json!({"schema":1,"iv":"AQEBAQEBAQEBAQEB","data":"evpYPvt9pN3PHWwT7n+WnwdCSiBEdCv/N/9J9RRa4vbWLeJbeQ=="}).to_string();
        assert_eq!(
            collaboration_decrypt(id.clone(), key.clone(), vector.clone()).unwrap(),
            r#"{"message":"offline"}"#
        );
        assert!(
            collaboration_decrypt("different-project".into(), key.clone(), vector.clone()).is_err()
        );
        assert!(collaboration_decrypt(id.clone(), "34".repeat(32), vector).is_err());
        let encrypted =
            collaboration_encrypt(id.clone(), key.clone(), "local recovery text".into()).unwrap();
        assert!(!encrypted.contains("local recovery text"));
        assert_eq!(
            collaboration_decrypt(id, key.clone(), encrypted).unwrap(),
            "local recovery text"
        );
        assert_eq!(
            collaboration_authenticate(key.clone()).unwrap(),
            format!(
                "{:x}",
                Sha256::digest(format!("Lemlio collaboration auth:{key}").as_bytes())
            )
        );
    }
    #[tokio::test]
    async fn stale_checkpoints_cannot_replace_another_windows_history() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_string_lossy().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let m = Manifest {
            schema: 1,
            id: id.clone(),
            title: "Paper".into(),
            drive_project_id: "drive".into(),
            source_hash: None,
        };
        atomic(
            &root.path().join(FOLDER).join("project.json"),
            &serde_json::to_vec(&m).unwrap(),
        )
        .unwrap();
        let empty = format!("{:x}", Sha256::digest([]));
        let first = collaboration_persist(
            path.clone(),
            id.clone(),
            STANDARD.encode(b"first"),
            "drive".into(),
            "Paper".into(),
            empty.clone(),
        )
        .await
        .unwrap();
        assert!(collaboration_persist(
            path.clone(),
            id.clone(),
            STANDARD.encode(b"stale"),
            "drive".into(),
            "Paper".into(),
            empty
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(root.path().join(FOLDER).join("state.bin")).unwrap(),
            b"first"
        );
        assert!(collaboration_materialize(
            path.clone(),
            id.clone(),
            vec![],
            vec![],
            "wrong-hash".into()
        )
        .await
        .is_err());
        collaboration_materialize(
            path,
            id,
            vec![DiskFile {
                path: "main.tex".into(),
                text: Some("source".into()),
                data: None,
            }],
            vec![],
            first,
        )
        .await
        .unwrap();
        assert!(manifest(root.path())
            .unwrap()
            .unwrap()
            .source_hash
            .is_some());
    }
    #[test]
    fn zip_source_hash_detects_edits_made_without_updating_shared_history() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let m = Manifest {
            schema: 1,
            id: uuid::Uuid::new_v4().to_string(),
            title: "Paper".into(),
            drive_project_id: "drive".into(),
            source_hash: None,
        };
        atomic(
            &root.join(FOLDER).join("project.json"),
            &serde_json::to_vec(&m).unwrap(),
        )
        .unwrap();
        atomic(&root.join(FOLDER).join("state.bin"), b"history").unwrap();
        materialize(
            &root,
            vec![DiskFile {
                path: "main.tex".into(),
                text: Some("known source".into()),
                data: None,
            }],
            vec![],
        )
        .unwrap();
        let saved = manifest(&root).unwrap().unwrap().source_hash.unwrap();
        let zip = temp.path().join("snapshot.zip");
        crate::projects::export_to(&root, &zip).unwrap();
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&zip).unwrap())).unwrap();
        assert_eq!(
            source_hash(&files_from_archive(&mut archive).unwrap()).unwrap(),
            saved
        );
        std::fs::write(
            root.join("main.tex"),
            "an older app edited this outside Yjs",
        )
        .unwrap();
        crate::projects::export_to(&root, &zip).unwrap();
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(std::fs::read(&zip).unwrap())).unwrap();
        assert_ne!(
            source_hash(&files_from_archive(&mut archive).unwrap()).unwrap(),
            saved
        );
    }
    #[test]
    fn deleting_a_managed_file_preserves_a_local_recovery_copy() {
        let root = tempfile::tempdir().unwrap();
        materialize(
            root.path(),
            vec![DiskFile {
                path: "main.tex".into(),
                text: Some("recover me".into()),
                data: None,
            }],
            vec![],
        )
        .unwrap();
        materialize(root.path(), vec![], vec![]).unwrap();
        assert!(!root.path().join("main.tex").exists());
        let recovery = root.path().join(".prism/collaboration/recovery");
        let copy = std::fs::read_dir(recovery)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("main.tex");
        assert_eq!(std::fs::read_to_string(copy).unwrap(), "recover me");
    }
    #[test]
    fn shared_files_cannot_escape_or_replace_external_edits() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            "../secret",
            "/absolute",
            "a/../../b",
            ".env",
            "Keys/client.json",
            "foo\\bar",
            "x:bad",
            "CON.txt",
        ] {
            assert!(safe_path(root.path(), path).is_err(), "{path}");
        }
        let file = DiskFile {
            path: "parts/main.tex".into(),
            text: Some("base".into()),
            data: None,
        };
        materialize(root.path(), vec![file.clone()], vec![]).unwrap();
        std::fs::write(root.path().join("parts/main.tex"), "external edit").unwrap();
        let changed = DiskFile {
            text: Some("remote".into()),
            ..file.clone()
        };
        let result = materialize(root.path(), vec![changed], vec![]).unwrap();
        assert_eq!(result["conflicts"], json!(["parts/main.tex"]));
        assert_eq!(
            std::fs::read_to_string(root.path().join("parts/main.tex")).unwrap(),
            "external edit"
        );
        materialize(root.path(), Vec::new(), vec![]).unwrap();
        assert!(root.path().join("parts/main.tex").exists());
    }
    #[tokio::test]
    async fn relay_authenticates_and_relays_without_becoming_a_document_authority() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let auth = "a".repeat(64);
        let (stop, rx) = oneshot::channel();
        let relay = tokio::spawn(run_relay(listener, id.clone(), auth.clone(), rx));
        let (mut a, _) = connect_async(format!("ws://{address}")).await.unwrap();
        a.send(Message::Text(
            json!({"project":id,"auth":"wrong"}).to_string().into(),
        ))
        .await
        .unwrap();
        assert!(!matches!(a.next().await, Some(Ok(Message::Text(_)))));
        let (mut a, _) = connect_async(format!("ws://{address}")).await.unwrap();
        let (mut b, _) = connect_async(format!("ws://{address}")).await.unwrap();
        for socket in [&mut a, &mut b] {
            socket
                .send(Message::Text(
                    json!({"project":id,"auth":auth}).to_string().into(),
                ))
                .await
                .unwrap();
            assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
        }
        a.send(Message::Text("encrypted-update".into()))
            .await
            .unwrap();
        assert_eq!(
            b.next().await.unwrap().unwrap().into_text().unwrap(),
            "encrypted-update"
        );
        stop.send(()).unwrap();
        relay.await.unwrap();
        assert!(validate_endpoint("ws://127.0.0.1:1234").is_ok());
        assert!(validate_endpoint("file:///private").is_err());
        assert!(validate_endpoint("ws://user:pass@host").is_err());
    }
}
