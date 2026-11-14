//! Project backups. Two interchangeable stores sit under the same sync logic:
//! Dropbox through its API (the default; sign-in with PKCE, tokens in the OS
//! credential store) and a plain folder that Dropbox, OneDrive or another sync
//! app keeps in sync (Advanced; needs no sign-in at all).
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

use crate::backup_store::{self, sha256_file, ROOT_NAME};
use crate::dropbox::{self, Dropbox};
use crate::remote::Remote;

/// A sign-in the user finishes by pasting the code Dropbox shows on its page.
struct ManualLogin {
    verifier: String,
}
#[derive(Clone, Default)]
pub struct DriveState {
    error: Arc<Mutex<Option<String>>>,
    upload: Arc<Mutex<()>>,
    pending: Arc<AtomicBool>,
    login: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    manual: Arc<Mutex<Option<ManualLogin>>>,
}
/// The Dropbox account behind the saved connection (shown in settings).
#[derive(Serialize, Deserialize, Clone, Default)]
struct DropboxAccount {
    id: String,
    name: String,
    email: String,
}
/// Where this computer backs up. Nothing secret is stored here: the Dropbox
/// tokens live in the operating system credential store.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Link {
    folder: Option<String>,
    last_backup: Option<u64>,
    /// `dropbox` or `folder`. Older settings with only a folder mean `folder`.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    dropbox: Option<DropboxAccount>,
    /// Optional Dropbox app key entered by the user (a public identifier, not a secret).
    #[serde(default)]
    app_key: Option<String>,
}
fn uses_dropbox(link: &Link) -> bool {
    link.provider.as_deref() == Some("dropbox") && link.dropbox.is_some()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn link_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("Cannot locate app settings")?
        .join("Lemlio")
        .join("backup-folder.json"))
}
#[cfg(test)]
pub(crate) static TEST_FOLDER: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
#[cfg(test)]
pub(crate) static TEST_REMOTE: std::sync::Mutex<Option<Remote>> = std::sync::Mutex::new(None);
#[cfg(test)]
fn override_folder() -> Option<String> {
    TEST_FOLDER
        .lock()
        .ok()
        .and_then(|folder| folder.clone())
        .map(|folder| folder.to_string_lossy().to_string())
}
#[cfg(not(test))]
fn override_folder() -> Option<String> {
    None
}
#[cfg(test)]
fn override_remote() -> Option<Remote> {
    TEST_REMOTE.lock().ok().and_then(|remote| remote.clone())
}
#[cfg(not(test))]
fn override_remote() -> Option<Remote> {
    None
}
fn link() -> Result<Link, String> {
    if override_remote().is_some() {
        return Ok(Link {
            provider: Some("dropbox".into()),
            dropbox: Some(DropboxAccount {
                id: "test".into(),
                ..Default::default()
            }),
            ..Default::default()
        });
    }
    if let Some(folder) = override_folder() {
        return Ok(Link {
            folder: Some(folder),
            ..Default::default()
        });
    }
    match std::fs::read(link_path()?) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|_| "Invalid backup settings".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Link::default()),
        Err(_) => Err("Cannot read the backup settings".into()),
    }
}
fn save_link(link: &Link) -> Result<(), String> {
    if override_folder().is_some() || override_remote().is_some() {
        return Ok(());
    }
    let path = link_path()?;
    let parent = path.parent().ok_or("Invalid settings folder")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create app settings")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot save the backup settings")?;
    serde_json::to_writer(&mut temporary, link).map_err(|_| "Cannot save the backup settings")?;
    temporary
        .persist(path)
        .map_err(|_| "Cannot save the backup settings")?;
    Ok(())
}
fn linked() -> Result<Link, String> {
    let link = link()?;
    if !uses_dropbox(&link) && link.folder.is_none() {
        return Err("Connect Dropbox or choose a backup folder first".into());
    }
    Ok(link)
}
const UNAVAILABLE: &str =
    "The backup folder is unavailable. Start Dropbox or choose the folder again.";
/// The backup folder, recreated if only it was deleted. A missing sync folder
/// above it is never rebuilt: that would hide backups in an unsynced place.
fn backup_root(link: &Link) -> Result<PathBuf, String> {
    let root = PathBuf::from(
        link.folder
            .as_deref()
            .ok_or("Choose your Dropbox backup folder first")?,
    );
    if root.is_dir() {
        return Ok(root);
    }
    match root.parent() {
        Some(parent) if parent.is_dir() => std::fs::create_dir(&root)
            .map(|_| root.clone())
            .map_err(|e| format!("Cannot recreate the backup folder: {e}")),
        _ => Err(UNAVAILABLE.into()),
    }
}
fn existing_backup_root(link: &Link) -> Result<Option<PathBuf>, String> {
    Ok(link
        .folder
        .as_deref()
        .map(PathBuf::from)
        .filter(|root| root.is_dir()))
}

/// One Dropbox client for the whole app, so token renewal is shared.
fn dropbox_client() -> Dropbox {
    static CLIENT: OnceLock<Dropbox> = OnceLock::new();
    CLIENT
        .get_or_init(|| Dropbox::new(Arc::new(dropbox::KeyringStore)))
        .clone()
}
/// The store for this link. With `create`, a deleted backup folder is rebuilt.
fn open_remote(link: &Link, create: bool) -> Result<Option<Remote>, String> {
    if let Some(remote) = override_remote() {
        return Ok(Some(remote));
    }
    if uses_dropbox(link) {
        let account = link
            .dropbox
            .as_ref()
            .map(|a| a.id.clone())
            .ok_or("Connect Dropbox first")?;
        return Ok(Some(Remote::Dropbox {
            client: dropbox_client(),
            account,
        }));
    }
    if create {
        return backup_root(link).map(|root| Some(Remote::Folder(root)));
    }
    Ok(existing_backup_root(link)?.map(Remote::Folder))
}

/// Choose the synced folder. `Lemlio Backups` is created inside it.
pub fn set_backup_folder(chosen: &Path) -> Result<String, String> {
    if !chosen.is_absolute() || !chosen.is_dir() {
        return Err("Choose an existing folder, for example your Dropbox folder".into());
    }
    let root = if chosen
        .file_name()
        .is_some_and(|n| n.to_string_lossy() == ROOT_NAME)
    {
        chosen.to_path_buf()
    } else {
        chosen.join(ROOT_NAME)
    };
    if !root.is_dir() {
        std::fs::create_dir(&root)
            .map_err(|e| format!("Cannot create {ROOT_NAME} in that folder: {e}"))?;
    }
    tempfile::Builder::new()
        .prefix(".lemlio-write-test")
        .tempfile_in(&root)
        .map_err(|_| "Lemlio cannot write to that folder")?;
    let text = backup_store::root_id(&root);
    let mut link = link()?;
    if link.folder.as_deref() != Some(text.as_str()) || link.provider.as_deref() == Some("dropbox")
    {
        link.last_backup = None;
    }
    // Leaving Dropbox for a folder forgets the saved Dropbox sign-in on this computer.
    if uses_dropbox(&link) {
        let _ = dropbox::TokenStore::clear(&dropbox::KeyringStore);
    }
    link.folder = Some(text.clone());
    link.provider = Some("folder".into());
    link.dropbox = None;
    save_link(&link)?;
    Ok(text)
}

pub fn clear_local_setup() -> Result<(), String> {
    let _ = dropbox::TokenStore::clear(&dropbox::KeyringStore);
    match std::fs::remove_file(link_path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot remove the backup setting".into()),
    }
}
#[tauri::command]
pub fn drive_detect_folders() -> Value {
    json!(backup_store::detect_sync_folders())
}
#[tauri::command]
pub async fn drive_set_folder(folder_path: String) -> Result<String, String> {
    set_backup_folder(Path::new(&folder_path))
}

// ---- Dropbox sign-in ----------------------------------------------------------
/// Lemlio's public Dropbox app key. An app key is a public identifier, not a secret
/// (the app secret is never used). A build can override it with LEMLIO_DROPBOX_APP_KEY.
const BUILT_IN_APP_KEY: Option<&str> = match option_env!("LEMLIO_DROPBOX_APP_KEY") {
    Some(key) => Some(key),
    None => Some("7hq6lelbqfmmavq"),
};
const NO_APP_KEY: &str = "Dropbox sign-in is not set up in this build yet. Enter your Dropbox app key under Advanced, or choose a synced folder instead.";
/// The Dropbox app key: the one the user entered, else the one built into this release.
fn app_key(link: &Link) -> Option<String> {
    link.app_key
        .clone()
        .or_else(|| BUILT_IN_APP_KEY.map(str::to_string))
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}
const SIGN_IN_SUPPORTED: bool = cfg!(any(target_os = "windows", target_os = "macos"));

/// Save the Dropbox connection after the code was exchanged.
async fn finish_login(code: &str, verifier: &str, redirect: Option<&str>) -> Result<(), String> {
    let current = link()?;
    let key = app_key(&current).ok_or(NO_APP_KEY)?;
    let client = dropbox_client();
    let tokens = client.exchange_code(&key, code, verifier, redirect).await?;
    let account = client.account().await.unwrap_or(Value::Null);
    let text = |field: &str| account[field].as_str().unwrap_or_default().to_string();
    let id = if tokens.account_id.is_empty() {
        text("id")
    } else {
        tokens.account_id.clone()
    };
    let mut link = link()?;
    if link.dropbox.as_ref().map(|a| a.id.as_str()) != Some(id.as_str()) {
        link.last_backup = None;
    }
    link.provider = Some("dropbox".into());
    link.dropbox = Some(DropboxAccount {
        id,
        name: text("name"),
        email: text("email"),
    });
    save_link(&link)
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn page(message: &str) -> String {
    let body = format!("<!doctype html><meta charset=utf-8><title>Lemlio</title><p>{message}</p>");
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}
/// Open the first free registered loopback port and wait for Dropbox to redirect to it.
async fn begin_login(state: &DriveState) -> Result<String, String> {
    if !SIGN_IN_SUPPORTED {
        return Err(
            "Dropbox sign-in is supported on Windows and macOS. Use a synced folder instead."
                .into(),
        );
    }
    let key = app_key(&link()?).ok_or(NO_APP_KEY)?;
    if let Some(task) = state.login.lock().await.take() {
        task.abort();
    }
    *state.error.lock().await = None;
    let mut bound = None;
    for port in dropbox::LOOPBACK_PORTS {
        if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            bound = Some((listener, port));
            break;
        }
    }
    let (listener, port) = bound.ok_or(
        "Lemlio could not open its local sign-in address. Close other programs using it, or use the code option.",
    )?;
    let redirect = dropbox::redirect_uri(port);
    let verifier = dropbox::new_verifier();
    let nonce = uuid::Uuid::new_v4().to_string();
    let url = dropbox::authorization_url(
        &key,
        Some(&redirect),
        &dropbox::challenge(&verifier),
        &nonce,
    )?;
    state.pending.store(true, Ordering::SeqCst);
    let current = state.clone();
    let task = tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(300), async {
            loop {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .map_err(|_| "The Dropbox callback failed".to_string())?;
                let mut buffer = vec![0; 16384];
                let count = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer))
                    .await
                    .map_err(|_| "The Dropbox callback timed out")?
                    .map_err(|_| "Cannot read the Dropbox callback")?;
                let request = String::from_utf8_lossy(&buffer[..count]);
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let Some(parameters) = dropbox::callback_parameters(target, &nonce) else {
                    let _ = stream
                        .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                    continue;
                };
                let exchange = async {
                    if let Some(problem) = parameters.get("error") {
                        let reason = parameters.get("error_description").map_or("", String::as_str);
                        return Err(dropbox::explain_sign_in_error(
                            &json!({"error": problem, "error_description": reason}),
                            Some(&redirect),
                        ));
                    }
                    let code = parameters.get("code").ok_or("Dropbox sign-in was cancelled")?;
                    finish_login(code, &verifier, Some(&redirect)).await
                }
                .await;
                let message = match &exchange {
                    Ok(()) => "Lemlio is connected to Dropbox. You can close this tab.".to_string(),
                    Err(error) => format!(
                        "Lemlio could not connect: {} Return to the app to try again.",
                        html_escape(error)
                    ),
                };
                let _ = stream.write_all(page(&message).as_bytes()).await;
                return exchange;
            }
        })
        .await;
        current.pending.store(false, Ordering::SeqCst);
        *current.error.lock().await = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("Dropbox sign-in timed out. Try Connect again.".into()),
        };
    });
    *state.login.lock().await = Some(task);
    Ok(url.to_string())
}
/// Opens in the browser: the Dropbox page that approves Lemlio's access.
#[tauri::command]
pub async fn drive_dropbox_connect(state: tauri::State<'_, DriveState>) -> Result<String, String> {
    begin_login(&state).await
}
/// For a browser or network where the local callback does not work: Dropbox shows a
/// code, which the user pastes into `drive_dropbox_submit_code`.
#[tauri::command]
pub async fn drive_dropbox_connect_manual(
    state: tauri::State<'_, DriveState>,
) -> Result<String, String> {
    if !SIGN_IN_SUPPORTED {
        return Err(
            "Dropbox sign-in is supported on Windows and macOS. Use a synced folder instead."
                .into(),
        );
    }
    let key = app_key(&link()?).ok_or(NO_APP_KEY)?;
    let verifier = dropbox::new_verifier();
    let url = dropbox::authorization_url(
        &key,
        None,
        &dropbox::challenge(&verifier),
        &uuid::Uuid::new_v4().to_string(),
    )?;
    *state.manual.lock().await = Some(ManualLogin { verifier });
    *state.error.lock().await = None;
    Ok(url.to_string())
}
#[tauri::command]
pub async fn drive_dropbox_submit_code(
    state: tauri::State<'_, DriveState>,
    code: String,
) -> Result<(), String> {
    let pending = state
        .manual
        .lock()
        .await
        .take()
        .ok_or("Press Connect with a code first, then paste the code from Dropbox")?;
    let code = code.trim().to_string();
    if code.is_empty() || code.len() > 512 || code.chars().any(char::is_whitespace) {
        *state.manual.lock().await = Some(pending);
        return Err("Paste the code exactly as Dropbox shows it".into());
    }
    finish_login(&code, &pending.verifier, None).await
}
#[tauri::command]
pub async fn drive_cancel(state: tauri::State<'_, DriveState>) -> Result<(), String> {
    if let Some(task) = state.login.lock().await.take() {
        task.abort();
    }
    *state.manual.lock().await = None;
    state.pending.store(false, Ordering::SeqCst);
    Ok(())
}
/// A Dropbox app key typed in settings. An empty value goes back to the built-in key.
#[tauri::command]
pub fn drive_set_app_key(app_key: String) -> Result<(), String> {
    let key = app_key.trim();
    // The value is never repeated in an error or logged: it may be a secret pasted by mistake.
    if !key.is_empty() && !dropbox::valid_app_key(key) {
        return Err("That does not look like a Dropbox app key. The App key is a short string of letters and digits; the App secret is not needed and must never be pasted here.".into());
    }
    let mut link = link()?;
    link.app_key = (!key.is_empty()).then(|| key.to_string());
    save_link(&link)
}

#[tauri::command]
pub async fn drive_status(state: tauri::State<'_, DriveState>) -> Result<Value, String> {
    status(&state).await
}
async fn status(state: &DriveState) -> Result<Value, String> {
    let link = link()?;
    let dropbox_mode = uses_dropbox(&link);
    let folder_ok = link
        .folder
        .as_deref()
        .is_some_and(|folder| Path::new(folder).is_dir());
    let signed_in = dropbox_mode
        && !dropbox::NEEDS_RECONNECT.load(Ordering::SeqCst)
        && (override_remote().is_some()
            || dropbox::TokenStore::load(&dropbox::KeyringStore)
                .ok()
                .flatten()
                .is_some());
    let connected = if dropbox_mode { signed_in } else { folder_ok };
    let mut error = state.error.lock().await.clone();
    if error.is_none() {
        if dropbox_mode && !signed_in {
            error = Some("Dropbox needs you to sign in again. Press Connect Dropbox.".to_string());
        } else if !dropbox_mode && link.folder.is_some() && !folder_ok {
            error = Some(UNAVAILABLE.to_string());
        }
    }
    let folder = if dropbox_mode {
        None
    } else {
        link.folder.clone()
    };
    Ok(json!({
        "provider": if dropbox_mode { json!("dropbox") } else if link.folder.is_some() { json!("folder") } else { Value::Null },
        "configured": dropbox_mode || link.folder.is_some(),
        "connected": connected,
        "pending": state.pending.load(Ordering::SeqCst),
        "needsReconnect": dropbox_mode && !signed_in,
        "error": error,
        "lastBackup": link.last_backup,
        "account": link.dropbox,
        "dropboxReady": SIGN_IN_SUPPORTED && app_key(&link).is_some(),
        "dropboxSupported": SIGN_IN_SUPPORTED,
        "appKeyConfigured": app_key(&link).is_some(),
        "builtInAppKey": BUILT_IN_APP_KEY.is_some_and(|k| !k.trim().is_empty()),
        "ownAppKey": link.app_key.is_some(),
        "redirectUris": dropbox::redirect_uris(),
        "permissions": dropbox::permissions(),
        "folderPath": folder,
        "folderUrl": folder,
        "suggestions": backup_store::detect_sync_folders(),
    }))
}
/// Forget the connection on this computer. Backups already stored are left untouched.
#[tauri::command]
pub async fn drive_disconnect(state: tauri::State<'_, DriveState>) -> Result<(), String> {
    disconnect(&state).await
}
async fn disconnect(state: &DriveState) -> Result<(), String> {
    if let Some(task) = state.login.lock().await.take() {
        task.abort();
    }
    state.pending.store(false, Ordering::SeqCst);
    *state.manual.lock().await = None;
    let current = link()?;
    if uses_dropbox(&current) {
        dropbox_client().disconnect().await?;
    }
    save_link(&Link {
        app_key: current.app_key,
        ..Default::default()
    })
}

// ---- Project identity -------------------------------------------------------
// Every project carries a stable id in `.lemlio-project.json` inside its folder.
// The id travels in each backup ZIP, so any computer holding that project (or a
// copy of its folder) recognizes the same project instead of seeing a stranger.
// Shared projects use their collaboration id. Clones and imported ZIPs drop the
// id, so they become separate projects with their own history.
fn valid_project_key(key: &str) -> bool {
    (8..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
pub(crate) fn read_project_id(source: &Path) -> Option<String> {
    let raw = std::fs::read(source.join(crate::drive_sync::PROJECT_ID)).ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    value["id"]
        .as_str()
        .filter(|id| valid_project_key(id))
        .map(str::to_string)
}
/// The project's backup identity, created on first use. `seed` carries an
/// identity the project already had (an earlier backup record).
fn ensure_project_key(source: &Path, seed: Option<&str>) -> Result<String, String> {
    if let Some(shared) = crate::collaboration::manifest(source)? {
        return Ok(shared.drive_project_id);
    }
    if let Some(id) = read_project_id(source) {
        return Ok(id);
    }
    let id = seed
        .filter(|seed| valid_project_key(seed))
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    write_project_id(source, &id)?;
    Ok(id)
}
fn write_project_id(source: &Path, id: &str) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(source).map_err(|e| e.to_string())?;
    std::io::Write::write_all(
        &mut file,
        &serde_json::to_vec_pretty(&json!({"schema":1,"id":id})).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    file.persist(source.join(crate::drive_sync::PROJECT_ID))
        .map_err(|e| e.error.to_string())?;
    Ok(())
}
/// The identity of a local project without creating one.
fn project_key_of(source: &Path) -> Option<String> {
    crate::collaboration::manifest(source)
        .ok()
        .flatten()
        .map(|shared| shared.drive_project_id)
        .or_else(|| read_project_id(source))
}

fn backup_archive_name(name: &str, key: &str) -> String {
    let safe: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .take(120)
        .collect();
    let safe = safe.trim().trim_matches('.');
    format!(
        "{}--{}.zip",
        if safe.is_empty() { "Project" } else { safe },
        &key[..key.len().min(12)]
    )
}

fn validate_backup_root(root: &Path) -> Result<(), String> {
    if root
        .file_name()
        .map(|n| n.to_string_lossy() != ROOT_NAME)
        .unwrap_or(true)
        || !root.is_dir()
    {
        return Err(
            "Reset stopped: the configured folder is not your Lemlio Backups folder".into(),
        );
    }
    Ok(())
}

/// Explicit reset only: the old folder is renamed and kept, never deleted.
pub async fn reset_backups(state: &DriveState) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let mut link = linked()?;
    let remote = open_remote(&link, false)?;
    let mut retired: Option<String> = None;
    let mut fresh: Option<String> = None;
    match remote {
        Some(Remote::Dropbox { client, .. }) => {
            retired = client.reset().await?;
        }
        _ => {
            let folder = PathBuf::from(
                link.folder
                    .clone()
                    .ok_or("Choose your Dropbox backup folder first")?,
            );
            if folder.is_dir() {
                validate_backup_root(&folder)?;
                retired = Some(
                    backup_store::retire_root(&folder)?
                        .to_string_lossy()
                        .to_string(),
                );
            }
            link.last_backup = None;
            save_link(&link)?;
            fresh = Some(backup_root(&link)?.to_string_lossy().to_string());
        }
    }
    if uses_dropbox(&link) {
        link.last_backup = None;
        save_link(&link)?;
    }
    *state.error.lock().await = None;
    Ok(
        json!({"retiredPreviousFolder":retired,"trashedPreviousFolder":retired.is_some(),"folderPath":fresh,"folderUrl":fresh}),
    )
}

#[tauri::command]
pub async fn drive_reset_backups(state: tauri::State<'_, DriveState>) -> Result<Value, String> {
    reset_backups(&state).await
}

fn project_title(source: &Path) -> String {
    crate::projects::project_details(source.to_string_lossy().to_string())
        .ok()
        .and_then(|v| v["name"].as_str().map(str::to_string))
        .unwrap_or_else(|| {
            source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
}
pub(crate) fn local_revision(source: &Path) -> Result<String, String> {
    Ok(format!(
        "content-v1:{}",
        crate::drive_sync::content_revision(source, &project_title(source))?
    ))
}
fn receipt_unchanged(
    source: &Path,
    receipt: &crate::drive_receipts::Receipt,
) -> Result<bool, String> {
    if receipt.source_revision.starts_with("content-v1:") {
        Ok(local_revision(source)? == receipt.source_revision)
    } else {
        Ok(legacy_revision(source)? == receipt.source_revision)
    }
}
fn legacy_revision(source: &Path) -> Result<String, String> {
    let mut hash = Sha256::new();
    for (relative, folder) in crate::projects::project_entries(source)? {
        hash.update(relative.to_string_lossy().as_bytes());
        hash.update([if folder { 1 } else { 0 }]);
        if !folder {
            let metadata = std::fs::metadata(source.join(relative)).map_err(|e| e.to_string())?;
            hash.update(metadata.len().to_le_bytes());
            let time = metadata
                .modified()
                .map_err(|e| e.to_string())?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            hash.update(time.to_le_bytes());
        }
    }
    let key = crate::drive_receipts::path_key(&source.to_string_lossy()).to_lowercase();
    if let Some(title) = crate::projects::project_titles()
        .as_object()
        .and_then(|titles| {
            titles
                .iter()
                .find(|(path, _)| crate::drive_receipts::path_key(path).to_lowercase() == key)
                .and_then(|(_, value)| value.as_str())
        })
    {
        hash.update(b"Lemlio-project-title-v1:");
        hash.update(title.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[tauri::command]
pub async fn drive_project_revision(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || local_revision(Path::new(&project_path)))
        .await
        .map_err(|e| e.to_string())?
}

fn choose_archive_name(
    existing: Option<&Value>,
    title: &str,
    key: &str,
    rename: bool,
    folder_name: &str,
) -> String {
    let legacy_title_pending = title != folder_name
        && existing.is_some_and(|file| file["name"] == backup_archive_name(folder_name, key));
    if !rename && !legacy_title_pending {
        if let Some(name) = existing.and_then(|file| file["name"].as_str()) {
            return name.to_string();
        }
    }
    backup_archive_name(title, key)
}
fn check_archive_conflict(
    remote: &Value,
    expected_remote_hash: Option<&str>,
    baseline: Option<&str>,
    local_hash: &str,
) -> Result<(), String> {
    let actual = remote["sha256Checksum"].as_str();
    let recorded = remote["appProperties"]["lemlioArchiveHash"].as_str();
    if actual.is_some()
        && (actual == Some(local_hash)
            || actual == expected_remote_hash
            || (actual == baseline && actual == recorded))
    {
        return Ok(());
    }
    Err(format!(
        "DRIVE_CONFLICT:{}",
        json!({"name":remote["name"],"modifiedTime":remote["modifiedTime"],"remoteHash":actual})
    ))
}

fn conflict_details(file: &Value, branches: usize) -> Value {
    json!({"name":file["name"],"modifiedTime":file["modifiedTime"],"remoteHash":file["sha256Checksum"],
        "deviceName":file["appProperties"]["lemlioDeviceName"],"branches":branches})
}
fn conflict_error(file: &Value, branches: usize) -> String {
    format!("DRIVE_CONFLICT:{}", conflict_details(file, branches))
}
fn revision_choices(heads: &[&Value]) -> Value {
    json!(heads
        .iter()
        .map(|f| conflict_details(f, heads.len()))
        .collect::<Vec<_>>())
}
/// The backup store and its complete revisions, or `None` when the folder is missing.
async fn remote_files() -> Result<Option<(Remote, Vec<Value>)>, String> {
    let link = linked()?;
    let Some(remote) = open_remote(&link, false)? else {
        return Ok(None);
    };
    let files = remote.list().await?;
    Ok(Some((remote, files)))
}

/// Link a local project to its backup history by identity when this computer has
/// no backup record for it yet (a copied folder, or a project from another PC).
/// The link is made only when the local files are exactly one stored revision of
/// that project, so the revisions after it are provably newer and may replace it.
fn adopt_receipt(
    path: &str,
    root: &str,
    files: &[Value],
) -> Result<Option<crate::drive_receipts::Receipt>, String> {
    if let Some(existing) = crate::drive_receipts::load(path)? {
        return Ok(Some(existing));
    }
    let source = Path::new(path);
    let Some(key) = project_key_of(source) else {
        return Ok(None);
    };
    let revisions: Vec<&Value> = files
        .iter()
        .filter(|f| f["appProperties"]["lemlioProject"] == key.as_str())
        .collect();
    if revisions.is_empty() {
        return Ok(None);
    }
    let heads = crate::drive_sync::heads(files, &key);
    let mut titles = vec![project_title(source)];
    for revision in &revisions {
        if let Some(title) = revision["appProperties"]["lemlioTitle"].as_str() {
            if !titles.iter().any(|t| t == title) {
                titles.push(title.to_string());
            }
        }
    }
    for title in titles {
        let content = crate::drive_sync::content_revision(source, &title)?;
        let matched = heads
            .iter()
            .copied()
            .chain(revisions.iter().copied())
            .find(|f| f["appProperties"]["lemlioContent"] == content.as_str());
        let Some(matched) = matched else {
            continue;
        };
        let (Some(id), Some(hash)) = (matched["id"].as_str(), matched["sha256Checksum"].as_str())
        else {
            continue;
        };
        let receipt = crate::drive_receipts::Receipt {
            project_key: key,
            archive_id: id.to_string(),
            archive_hash: hash.to_string(),
            source_revision: local_revision(source)?,
            content_revision: content,
            folder_id: root.to_string(),
            last_backup: now(),
        };
        crate::drive_receipts::save(path, receipt.clone())?;
        return Ok(Some(receipt));
    }
    Ok(None)
}

async fn conflict_archive(key: &str, expected: &str) -> Result<String, String> {
    let (_, files) = remote_files().await?.ok_or("No backup folder")?;
    crate::drive_sync::heads(&files, key)
        .into_iter()
        .find(|f| f["sha256Checksum"] == expected)
        .and_then(|f| f["id"].as_str().map(str::to_string))
        .ok_or("The backup revision changed again; refresh before continuing".into())
}

#[tauri::command]
pub async fn drive_sync_project(
    state: tauri::State<'_, DriveState>,
    project_path: String,
    expected_remote_hash: String,
) -> Result<Value, String> {
    sync_project(&state, project_path, expected_remote_hash).await
}
async fn sync_project(
    state: &DriveState,
    project_path: String,
    expected: String,
) -> Result<Value, String> {
    let (remote, files) = remote_files().await?.ok_or("No backup folder")?;
    let receipt = adopt_receipt(&project_path, &remote.id(), &files)?
        .ok_or("Project is not linked to a backup")?;
    if !receipt_unchanged(Path::new(&project_path), &receipt)? {
        return Err("Local files changed too. Review both versions; nothing was replaced".into());
    }
    let id = conflict_archive(&receipt.project_key, &expected).await?;
    // Only a single, genuine Lemlio revision may fast-forward automatically.
    let heads = crate::drive_sync::heads(&files, &receipt.project_key);
    if heads.len() != 1
        || heads[0]["id"] != id.as_str()
        || heads[0]["appProperties"]["lemlioSync"] != "1"
        || heads[0]["sha256Checksum"] != heads[0]["appProperties"]["lemlioArchiveHash"]
    {
        return Err(
            "The backup has competing or externally edited versions; review them first".into(),
        );
    }
    let content = crate::drive_sync::content_revision(
        Path::new(&project_path),
        &project_title(Path::new(&project_path)),
    )?;
    restore_snapshot_with_target(
        state,
        id,
        None,
        Some((project_path.clone(), expected)),
        Some((project_path, content)),
    )
    .await
}

/// The user chose the cloud version for a project whose copies both changed (or
/// that has no shared history yet). The project is replaced in place; the local
/// files are kept beside it as a recovery copy. No second project is created.
#[tauri::command]
pub async fn drive_use_cloud_version(
    state: tauri::State<'_, DriveState>,
    project_path: String,
    expected_remote_hash: String,
) -> Result<Value, String> {
    use_cloud_version(&state, project_path, expected_remote_hash).await
}
async fn use_cloud_version(
    state: &DriveState,
    project_path: String,
    expected_remote_hash: String,
) -> Result<Value, String> {
    let key = crate::drive_receipts::load(&project_path)?
        .map(|r| r.project_key)
        .or_else(|| project_key_of(Path::new(&project_path)))
        .ok_or("This project is not linked to a backup")?;
    let id = conflict_archive(&key, &expected_remote_hash).await?;
    let content = crate::drive_sync::content_revision(
        Path::new(&project_path),
        &project_title(Path::new(&project_path)),
    )?;
    restore_snapshot_with_target(
        state,
        id,
        None,
        Some((project_path.clone(), expected_remote_hash)),
        Some((project_path, content)),
    )
    .await
}

/// Confirmed by the user: this local project (which has no backup identity yet) is
/// the cloud project `archive_id`. The local folder takes over the cloud identity,
/// so later backups continue that history instead of starting a duplicate.
#[tauri::command]
pub async fn drive_link_project(
    state: tauri::State<'_, DriveState>,
    project_path: String,
    archive_id: String,
) -> Result<Value, String> {
    link_project(&state, project_path, archive_id).await
}
async fn link_project(
    state: &DriveState,
    project_path: String,
    archive_id: String,
) -> Result<Value, String> {
    let _lock = state.upload.lock().await;
    let (remote, files) = remote_files().await?.ok_or("No backup folder")?;
    let key = files
        .iter()
        .find(|f| f["id"] == archive_id.as_str())
        .and_then(|f| f["appProperties"]["lemlioProject"].as_str())
        .ok_or("Choose a project from this backup folder")?
        .to_string();
    let source = Path::new(&project_path);
    if let Some(shared) = crate::collaboration::manifest(source)? {
        if shared.drive_project_id != key {
            return Err("This shared project already has its own backup history".into());
        }
    } else if let Some(current) = read_project_id(source) {
        if current != key {
            return Err("This project already has its own backup identity".into());
        }
    } else {
        write_project_id(source, &key)?;
    }
    let adopted = adopt_receipt(&project_path, &remote.id(), &files)?;
    Ok(json!({"linked":true,"provablyRelated":adopted.is_some(),"projectKey":key}))
}

pub async fn backup_project(state: &DriveState, project_path: String) -> Result<Value, String> {
    backup_project_with_choice(state, project_path, None, false).await
}

async fn backup_project_with_choice(
    state: &DriveState,
    project_path: String,
    expected_remote_hash: Option<&str>,
    rename_backup: bool,
) -> Result<Value, String> {
    backup_project_with_collaboration(
        state,
        project_path,
        expected_remote_hash,
        rename_backup,
        None,
    )
    .await
}
async fn backup_project_with_collaboration(
    state: &DriveState,
    project_path: String,
    expected_remote_hash: Option<&str>,
    rename_backup: bool,
    collaboration_heads: Option<Vec<CollaborationHead>>,
) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let shared = crate::collaboration::manifest(Path::new(&project_path))?;
    if shared.is_some() && collaboration_heads.is_none() {
        return Err(
            "Open Lemlio to merge the shared history before backing up this project".into(),
        );
    }
    let mut link = linked()?;
    let snapshot = tokio::task::spawn_blocking(move || {
        let source = std::fs::canonicalize(&project_path).map_err(|e| e.to_string())?;
        if !source.is_dir() {
            return Err("Project folder is unavailable".to_string());
        }
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let local_path = source.to_string_lossy().to_string();
        let receipt = crate::drive_receipts::load(&local_path)?;
        // The stable project id is written first so it travels inside every revision.
        let key = ensure_project_key(&source, receipt.as_ref().map(|r| r.project_key.as_str()))?;
        let revision = local_revision(&source)?;
        let file_count = crate::projects::export_to(&source, &directory.path().join("backup.zip"))?;
        if local_revision(&source)? != revision {
            return Err("Project changed while preparing its ZIP; backup will retry".into());
        }
        let name = crate::projects::project_details(project_path)
            .ok()
            .and_then(|d| d["name"].as_str().map(str::to_string))
            .unwrap_or_else(|| {
                source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });
        Ok::<_, String>((
            directory, file_count, key, name, revision, receipt, local_path,
        ))
    })
    .await
    .map_err(|_| "Cannot prepare backup files")??;
    // A deleted backup folder is recreated without touching any old backup files.
    let remote =
        open_remote(&link, true)?.ok_or("Connect Dropbox or choose a backup folder first")?;
    let root_text = remote.id();
    let root = root_text.as_str();
    let children = remote.list().await?;
    // A project copied from another PC already carries its identity: recognize it.
    let receipt = match snapshot.5.clone() {
        Some(record) => Some(record),
        None => adopt_receipt(&snapshot.6, root, &children)?,
    };
    let heads = crate::drive_sync::heads(&children, &snapshot.2);
    if heads.len() > 16 {
        return Err(
            "Too many concurrent backup versions; export local files before resolving them"
                .into(),
        );
    }
    if let Some(reviewed) = &collaboration_heads {
        let actual: std::collections::BTreeSet<_> = heads
            .iter()
            .map(|f| {
                (
                    f["id"].as_str().unwrap_or_default().to_string(),
                    f["sha256Checksum"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let reviewed: std::collections::BTreeSet<_> = reviewed
            .iter()
            .map(|h| (h.id.clone(), h.hash.clone()))
            .collect();
        if actual != reviewed {
            return Err("Shared backup history changed during merging; backup will retry".into());
        }
    } else if heads
        .iter()
        .any(|f| f["appProperties"]["lemlioCollaboration"].is_string())
    {
        return Err("This project now has a shared history. Join the shared version before replacing its backup.".into());
    }
    let existing = heads
        .iter()
        .copied()
        .find(|f| expected_remote_hash.is_some_and(|h| f["sha256Checksum"] == h))
        .or_else(|| heads.first().copied());
    if let Some(expected) = expected_remote_hash {
        if !heads.iter().any(|f| f["sha256Checksum"] == expected) {
            return Err(existing
                .map(|f| conflict_error(f, heads.len()))
                .unwrap_or("Backup revision was removed; refresh first".into()));
        }
    }
    if heads.len() > 1 && expected_remote_hash.is_none() && collaboration_heads.is_none() {
        let mut conflict = conflict_details(existing.unwrap(), heads.len());
        conflict["versions"] = revision_choices(&heads);
        return Err(format!("DRIVE_CONFLICT:{conflict}"));
    }
    let archive = snapshot.0.path().join("backup.zip");
    let content = snapshot.4.trim_start_matches("content-v1:");
    let old_hash = sha256_file(&archive)?;
    if let Some(remote) = existing {
        let baseline = receipt
            .as_ref()
            .filter(|r| r.folder_id == root && remote["id"].as_str() == Some(r.archive_id.as_str()))
            .map(|r| r.archive_hash.as_str());
        let same_content = remote["appProperties"]["lemlioContent"] == content
            && remote["sha256Checksum"] == remote["appProperties"]["lemlioArchiveHash"];
        if !same_content && collaboration_heads.is_none() {
            check_archive_conflict(remote, expected_remote_hash, baseline, &old_hash)?;
        }
    }
    let archive_name = choose_archive_name(
        existing,
        &snapshot.3,
        &snapshot.2,
        rename_backup,
        Path::new(&snapshot.6)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&snapshot.3),
    );
    let unchanged = heads.len() == 1
        && existing.is_some_and(|f| {
            f["sha256Checksum"] == old_hash
                || (f["appProperties"]["lemlioContent"] == content
                    && f["sha256Checksum"] == f["appProperties"]["lemlioArchiveHash"])
        });
    let device = crate::drive_sync::device()?;
    let parents: Vec<_> = heads.iter().filter_map(|f| f["id"].as_str()).collect();
    let manifest = json!({"schema":1,"projectId":snapshot.2,"revision":uuid::Uuid::new_v4().to_string(),
        "parents":parents,"contentHash":content,"title":snapshot.3,"device":device,"savedAt":now()});
    let mut properties = json!({"lemlioSync":"1","lemlioContent":content,
        "lemlioDevice":device["id"],"lemlioDeviceName":device["name"],"lemlioSavedAt":now().to_string(),
        "lemlioTitle":snapshot.3});
    if let Some(shared) = shared {
        properties["lemlioCollaboration"] = json!(shared.id);
    }
    for (i, parent) in parents.iter().enumerate() {
        properties[format!("lemlioParent{i}")] = json!(parent);
    }
    crate::drive_sync::append_manifest(&archive, &manifest)?;
    let hash = sha256_file(&archive)?;
    let same_name = existing.is_some_and(|f| f["name"] == archive_name);
    let reused = unchanged && same_name;
    let archive_id = if reused {
        existing
            .and_then(|f| f["id"].as_str())
            .ok_or("Missing backup archive ID")?
            .to_string()
    } else {
        // Immutable revision: another device can never overwrite this upload.
        let result = remote
            .put(&archive_name, &archive, &snapshot.2, &properties)
            .await?;
        if result["sha256Checksum"].as_str() != Some(hash.as_str()) {
            return Err("The backup ZIP failed verification; backup will retry".into());
        }
        result["id"]
            .as_str()
            .ok_or("Missing backup archive ID")?
            .to_string()
    };
    link.last_backup = Some(now());
    save_link(&link)?;
    crate::drive_receipts::save(
        &snapshot.6,
        crate::drive_receipts::Receipt {
            project_key: snapshot.2.clone(),
            archive_id: archive_id.clone(),
            archive_hash: if reused {
                existing.unwrap()["sha256Checksum"]
                    .as_str()
                    .ok_or("Missing checksum")?
                    .to_string()
            } else {
                hash
            },
            content_revision: content.to_string(),
            source_revision: snapshot.4.clone(),
            folder_id: root.to_string(),
            last_backup: link.last_backup.unwrap_or_default(),
        },
    )?;
    Ok(
        json!({"name":snapshot.3,"format":"zip","sourceFiles":snapshot.1,"sourceRevision":snapshot.4,"uploadedFiles":if reused {0} else {1},"unchangedFiles":if reused {1} else {0},"deviceName":device["name"],"lastBackup":link.last_backup,"archiveId":archive_id,"provider":if remote.is_dropbox() {"dropbox"} else {"folder"},"folderPath":if remote.is_dropbox() {Value::Null} else {json!(root)}}),
    )
}
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct CollaborationHead {
    pub id: String,
    pub hash: String,
}

/// Read and verify CRDT history only. Never extract a remote ZIP over a local replica.
#[tauri::command]
pub async fn drive_collaboration_updates(
    state: tauri::State<'_, DriveState>,
    project_path: String,
) -> Result<Value, String> {
    let _lock = state.upload.lock().await;
    let shared = crate::collaboration::manifest(Path::new(&project_path))?
        .ok_or("This is not a shared project")?;
    let receipt = crate::drive_receipts::load(&project_path)?;
    let Some((remote, children)) = remote_files().await? else {
        return Ok(json!({"heads":[]}));
    };
    let heads = crate::drive_sync::heads(&children, &shared.drive_project_id);
    if heads.len() > 16 {
        return Err("Too many shared backup branches; export a recovery copy first".into());
    }
    let mut result = Vec::new();
    let mut total = 0usize;
    for head in heads {
        let id = head["id"].as_str().ok_or("Missing shared revision ID")?;
        let hash = head["sha256Checksum"]
            .as_str()
            .ok_or("Shared backup checksum is not ready")?;
        if head["appProperties"]["lemlioArchiveHash"] != hash {
            return Err(conflict_error(head, 1));
        }
        let bytes = remote.read(id, 160 * 1024 * 1024).await?;
        if format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err("Shared backup checksum failed; local edits were kept".into());
        }
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let has_history = archive.by_name(".lemlio-collab/project.json").is_ok();
        if !has_history {
            if receipt
                .as_ref()
                .is_some_and(|r| r.archive_id == id && r.archive_hash == hash)
            {
                result.push(json!({"id":id,"hash":hash}));
                continue;
            }
            return Err("A backup revision has no collaboration history. Restore it into a separate folder for review.".into());
        }
        let mut metadata = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(
                archive
                    .by_name(".lemlio-collab/project.json")
                    .map_err(|e| e.to_string())?,
                8192,
            ),
            &mut metadata,
        )
        .map_err(|e| e.to_string())?;
        let m: crate::collaboration::Manifest =
            serde_json::from_slice(&metadata).map_err(|_| "Invalid shared backup identity")?;
        if m.id != shared.id || m.schema != 1 {
            return Err("The backup contains history from a different shared project".into());
        }
        let source = crate::collaboration::files_from_archive(&mut archive)?;
        if m.source_hash.as_deref() != Some(crate::collaboration::source_hash(&source)?.as_str()) {
            return Err("Backup source files changed outside the shared history. Restore that ZIP separately for review; local edits were kept.".into());
        }

        let mut update = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(
                archive
                    .by_name(".lemlio-collab/state.bin")
                    .map_err(|_| "Shared backup history is missing")?,
                (crate::collaboration::LIMIT + 1) as u64,
            ),
            &mut update,
        )
        .map_err(|e| e.to_string())?;
        total += update.len();
        if update.len() > crate::collaboration::LIMIT || total > 192 * 1024 * 1024 {
            return Err("Shared history exceeds the merge limit; export a recovery copy".into());
        }
        result.push(json!({"id":id,"hash":hash,"state":STANDARD.encode(update)}));
    }
    Ok(json!({"heads":result}))
}

#[tauri::command]
pub async fn drive_backup_project(
    state: tauri::State<'_, DriveState>,
    project_path: String,
    expected_remote_hash: Option<String>,
    rename_backup: Option<bool>,
    collaboration_heads: Option<Vec<CollaborationHead>>,
) -> Result<Value, String> {
    backup_project_with_collaboration(
        &state,
        project_path,
        expected_remote_hash.as_deref(),
        rename_backup.unwrap_or(false),
        collaboration_heads,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_edits_require_the_exact_version_the_user_reviewed() {
        let mut remote = json!({"name":"Paper.zip","sha256Checksum":"original","appProperties":{"lemlioArchiveHash":"original"}});
        assert!(check_archive_conflict(&remote, None, Some("original"), "local-edit").is_ok());
        remote["sha256Checksum"] = json!("edited-in-drive");
        assert!(
            check_archive_conflict(&remote, None, Some("original"), "local-edit")
                .unwrap_err()
                .starts_with("DRIVE_CONFLICT:")
        );
        assert!(check_archive_conflict(
            &remote,
            Some("edited-in-drive"),
            Some("original"),
            "local-edit"
        )
        .is_ok());
        assert!(check_archive_conflict(
            &remote,
            Some("older-remote-version"),
            Some("original"),
            "local-edit"
        )
        .is_err());
        assert!(check_archive_conflict(
            &json!({"sha256Checksum":"unknown"}),
            None,
            None,
            "different"
        )
        .is_err());
    }
    #[test]
    fn drive_rename_is_preserved_until_the_user_renames_inside_lemlio() {
        let remote = json!({"name":"Renamed in Drive.zip"});
        assert_eq!(
            choose_archive_name(
                Some(&remote),
                "Local title",
                "key",
                false,
                "Original folder"
            ),
            "Renamed in Drive.zip"
        );
        assert_eq!(
            choose_archive_name(
                Some(&remote),
                "New app title",
                "key",
                true,
                "Original folder"
            ),
            backup_archive_name("New app title", "key")
        );
        let legacy = json!({"name":backup_archive_name("Copy of New Project", "key")});
        assert_eq!(
            choose_archive_name(
                Some(&legacy),
                "Cover Letter - MSc CRT - Saman",
                "key",
                false,
                "Copy of New Project"
            ),
            backup_archive_name("Cover Letter - MSc CRT - Saman", "key")
        );
    }
    #[test]
    fn reset_only_accepts_the_lemlio_backups_folder() {
        let temp = tempfile::tempdir().unwrap();
        let good = temp.path().join(ROOT_NAME);
        std::fs::create_dir(&good).unwrap();
        assert!(validate_backup_root(&good).is_ok());
        let other = temp.path().join("Documents");
        std::fs::create_dir(&other).unwrap();
        assert!(validate_backup_root(&other).is_err());
        assert!(validate_backup_root(&temp.path().join("missing")).is_err());
        assert!(
            backup_archive_name("A/B: Paper", "abcdef123456789").ends_with("--abcdef123456.zip")
        );
        assert!(!backup_archive_name("A/B: Paper", "key").contains('/'));
    }
    #[test]
    fn another_devices_legitimate_upload_is_still_a_conflict_for_an_old_pc_copy() {
        let remote = json!({"name":"Paper.zip","sha256Checksum":"other-device","appProperties":{"lemlioArchiveHash":"other-device"}});
        assert!(
            check_archive_conflict(&remote, None, Some("my-last-version"), "my-local-edits")
                .is_err()
        );
        assert!(check_archive_conflict(&remote, None, None, "other-device").is_ok());
        assert!(check_archive_conflict(
            &remote,
            Some("other-device"),
            Some("my-last-version"),
            "my-local-edits"
        )
        .is_ok());
    }
    #[test]
    fn zip_snapshots_are_stable_and_preserve_empty_files_and_deletions() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("Paper");
        std::fs::create_dir_all(project.join("figs")).unwrap();
        std::fs::write(project.join("main.tex"), "source").unwrap();
        std::fs::write(project.join("figs/empty.png"), []).unwrap();
        let first = temp.path().join("first.zip");
        let second = temp.path().join("second.zip");
        let revision = local_revision(&project).unwrap();
        assert_eq!(crate::projects::export_to(&project, &first).unwrap(), 2);
        crate::projects::export_to(&project, &second).unwrap();
        assert_eq!(sha256_file(&first).unwrap(), sha256_file(&second).unwrap());
        let mut archive = zip::ZipArchive::new(std::fs::File::open(first).unwrap()).unwrap();
        assert_eq!(archive.by_name("figs/empty.png").unwrap().size(), 0);
        std::fs::remove_file(project.join("figs/empty.png")).unwrap();
        assert_ne!(revision, local_revision(&project).unwrap());
        let third = temp.path().join("third.zip");
        crate::projects::export_to(&project, &third).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(third).unwrap()).unwrap();
        assert!(archive.by_name("figs/empty.png").is_err());
    }
}

fn display_archive_name(file: &Value) -> String {
    let name = file["name"]
        .as_str()
        .unwrap_or("Project.zip")
        .trim_end_matches(".zip");
    let key = file["appProperties"]["lemlioProject"]
        .as_str()
        .unwrap_or("");
    match name.rsplit_once("--") {
        Some((title, suffix)) if !suffix.is_empty() && key.starts_with(suffix) => title.to_string(),
        _ => name.to_string(),
    }
}
fn managed_archive(file: &Value, root: &str) -> bool {
    file["trashed"] != true
        && file["mimeType"] == "application/zip"
        && file["appProperties"]["lemlioFormat"] == "zip-v2"
        && file["appProperties"]["lemlioProject"].as_str().is_some()
        && file["parents"]
            .as_array()
            .is_some_and(|p| p.iter().any(|id| id == root))
}
#[tauri::command]
pub async fn drive_list_backups() -> Result<Value, String> {
    let Some((_, files)) = remote_files().await? else {
        return Ok(json!({"projects":[]}));
    };
    Ok(json!({"projects":backup_listing(&files)?}))
}
fn backup_listing(files: &[Value]) -> Result<Vec<Value>, String> {
    let mut projects = Vec::new();
    let keys: std::collections::BTreeSet<_> = files
        .iter()
        .filter_map(|f| f["appProperties"]["lemlioProject"].as_str())
        .collect();
    for file in keys
        .into_iter()
        .flat_map(|key| crate::drive_sync::heads(&files, key))
    {
        let key = file["appProperties"]["lemlioProject"]
            .as_str()
            .ok_or("Invalid backup identity")?;
        let local = crate::drive_receipts::linked_project(key)?;
        projects.push(json!({"id":file["id"],"projectId":key,"name":display_archive_name(&file),"size":file["size"],"modifiedTime":file["modifiedTime"],"localPath":local,"deviceName":file["appProperties"]["lemlioDeviceName"],"branches":crate::drive_sync::heads(&files,key).len()}));
    }
    Ok(projects)
}
#[tauri::command]
pub async fn drive_restore_project(
    state: tauri::State<'_, DriveState>,
    archive_id: String,
) -> Result<Value, String> {
    restore_project(&state, archive_id).await
}
#[tauri::command]
pub async fn drive_download_conflict(
    state: tauri::State<'_, DriveState>,
    project_path: String,
    expected_remote_hash: String,
) -> Result<Value, String> {
    let receipt = crate::drive_receipts::load(&project_path)?
        .ok_or("This project has no linked backup")?;
    let mut restored = restore_project_into_with_binding(
        &state,
        conflict_archive(&receipt.project_key, &expected_remote_hash).await?,
        None,
        Some((project_path, expected_remote_hash.clone())),
    )
    .await?;
    let path = restored["path"]
        .as_str()
        .ok_or("Missing restored folder")?
        .to_string();
    // Choosing a branch explicitly commits a child of all currently reviewed
    // heads. If offline, still return the safe downloaded folder for recovery.
    match backup_project_with_choice(&state, path, Some(&expected_remote_hash), false).await {
        Ok(result) => {
            restored["lastBackup"] = result["lastBackup"].clone();
            restored["sourceRevision"] = result["sourceRevision"].clone();
        }
        Err(error) => restored["syncError"] = json!(error),
    }
    Ok(restored)
}
pub async fn restore_project(state: &DriveState, archive_id: String) -> Result<Value, String> {
    restore_project_into(state, archive_id, None).await
}
async fn restore_project_into(
    state: &DriveState,
    archive_id: String,
    restore_root: Option<PathBuf>,
) -> Result<Value, String> {
    restore_project_into_with_binding(state, archive_id, restore_root, None).await
}
async fn restore_project_into_with_binding(
    state: &DriveState,
    archive_id: String,
    restore_root: Option<PathBuf>,
    binding: Option<(String, String)>,
) -> Result<Value, String> {
    restore_snapshot_with_target(state, archive_id, restore_root, binding, None).await
}
async fn restore_snapshot_with_target(
    state: &DriveState,
    archive_id: String,
    restore_root: Option<PathBuf>,
    binding: Option<(String, String)>,
    sync_target: Option<(String, String)>,
) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    if let Some((path, _)) = &sync_target {
        if Path::new(path).join(crate::collaboration::FOLDER).exists() {
            return Err(
                "Shared projects merge collaboration history instead of replacing local files"
                    .into(),
            );
        }
    }
    let (remote, files) = remote_files()
        .await?
        .ok_or("No backup folder was found on this computer")?;
    let root = remote.id();
    let metadata = files
        .iter()
        .find(|f| f["id"] == archive_id.as_str())
        .cloned()
        .ok_or("That backup revision is not in the folder yet (it may still be syncing)")?;
    if !managed_archive(&metadata, &root) {
        return Err("Choose a ZIP from your Lemlio backups".into());
    }
    let project_key = metadata["appProperties"]["lemlioProject"]
        .as_str()
        .ok_or("Missing project identity")?
        .to_string();
    if let Some((path, expected)) = &binding {
        // A recorded link, or an identity the project already carries, must match.
        // A project the user explicitly linked has neither and is accepted.
        let linked_key = crate::drive_receipts::load(path)?
            .map(|r| r.project_key)
            .or_else(|| project_key_of(Path::new(path)));
        if linked_key.is_some_and(|key| key != project_key) {
            return Err("Backup link changed; refresh and retry".into());
        }
        if metadata["sha256Checksum"].as_str() != Some(expected.as_str()) {
            return Err(
                "The backup version changed again. Refresh the conflict before continuing.".into(),
            );
        }
    } else if crate::drive_receipts::linked_project(&project_key)?.is_some() {
        return Err(
            "This backup is already linked to a local project. Open that local project instead."
                .into(),
        );
    }
    let expected_hash = metadata["sha256Checksum"]
        .as_str()
        .ok_or("The backup checksum is not ready yet")?
        .to_string();
    let name = display_archive_name(&metadata);
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let archive = temp.path().join(format!(
        "{}.zip",
        if safe.trim().is_empty() {
            "Project"
        } else {
            safe.trim()
        }
    ));
    remote
        .fetch(
            &archive_id,
            &archive,
            &expected_hash,
            2 * 1024 * 1024 * 1024,
        )
        .await?;
    let staging = if let Some((path, _)) = &sync_target {
        Some(
            tempfile::Builder::new()
                .prefix(".lemlio-staging-")
                .tempdir_in(Path::new(path).parent().ok_or("Invalid project path")?)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let restore_root = staging
        .as_ref()
        .map(|t| t.path().to_path_buf())
        .or(restore_root);
    let extraction_archive = archive.clone();
    let result = tokio::task::spawn_blocking(move || match restore_root {
        Some(root) => crate::projects::restore_snapshot_in(&root, &extraction_archive),
        None => crate::projects::restore_snapshot(&extraction_archive),
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut path = result.storage_path.clone();
    let title = if metadata["appProperties"]["lemlioSync"] == "1" {
        let mut zip =
            zip::ZipArchive::new(std::fs::File::open(&archive).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let entry = zip
            .by_name(crate::drive_sync::MANIFEST)
            .map_err(|_| "Missing revision manifest")?;
        if entry.size() > 64 * 1024 {
            return Err("Invalid revision manifest".into());
        }
        let manifest: Value =
            serde_json::from_reader(entry).map_err(|_| "Invalid revision manifest")?;
        if manifest["schema"] != 1
            || manifest["projectId"] != project_key
            || manifest["contentHash"] != metadata["appProperties"]["lemlioContent"]
        {
            return Err("Revision manifest does not match the backup".into());
        }
        manifest["title"]
            .as_str()
            .filter(|t| !t.trim().is_empty() && t.len() <= 200)
            .ok_or("Invalid project title in revision")?
            .to_string()
    } else {
        display_archive_name(&metadata)
    };
    let portable = crate::drive_sync::content_revision(Path::new(&path), &title)?;
    if metadata["appProperties"]["lemlioSync"] == "1"
        && metadata["appProperties"]["lemlioContent"] != portable
    {
        return Err(
            "Backup revision metadata does not match its source files; local files were kept".into(),
        );
    }
    let mut recovery = None;
    if let Some((target, expected)) = sync_target {
        recovery = Some(crate::drive_sync::install_snapshot(
            Path::new(&target),
            Path::new(&path),
            &expected,
            &project_title(Path::new(&target)),
        )?);
        path = target;
    }
    crate::projects::rename_project(path.clone(), title)?;
    let source_revision = local_revision(Path::new(&path))?;
    crate::drive_receipts::save_restored(
        &path,
        binding.as_ref().map(|(path, _)| path.as_str()),
        crate::drive_receipts::Receipt {
            project_key,
            archive_id,
            archive_hash: expected_hash,
            content_revision: portable,
            source_revision: source_revision.clone(),
            folder_id: root,
            last_backup: now(),
        },
    )?;
    Ok(
        json!({"projects":result.projects,"path":path,"lastBackup":now(),"sourceRevision":source_revision,"recoveryPath":recovery,"deviceName":metadata["appProperties"]["lemlioDeviceName"]}),
    )
}
#[tauri::command]
pub async fn drive_backup_summary(
    state: tauri::State<'_, DriveState>,
    project_paths: Vec<String>,
) -> Result<Value, String> {
    backup_summary(&state, project_paths).await
}
pub async fn backup_summary(
    state: &DriveState,
    project_paths: Vec<String>,
) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let paths: std::collections::BTreeMap<_, _> = project_paths
        .into_iter()
        .map(|p| (crate::drive_receipts::path_key(&p), p))
        .collect();
    let mut rows = Vec::new();
    for (_, path) in paths {
        let receipt = crate::drive_receipts::load(&path)?;
        let saved = receipt
            .as_ref()
            .is_some_and(|r| receipt_unchanged(Path::new(&path), r).unwrap_or(false));
        let collaboration = Path::new(&path).join(crate::collaboration::FOLDER).exists();
        rows.push(json!({"collaboration":collaboration,"path":path,"status":if saved{"saved"}else{"pending"},"lastBackup":receipt.as_ref().map(|r|r.last_backup),"sourceRevision":receipt.as_ref().map(|r|&r.source_revision),"receipt":receipt}));
    }
    let mut available_projects = Vec::new();
    let verified = async {
        let Some((store, remote)) = remote_files().await? else {
            return Err("No backup folder is available".to_string());
        };
        let root_text = store.id();
        // A project that shares its identity with a backed-up project is the same
        // project (for example a copy from another PC): link it, never duplicate it.
        for row in &mut rows {
            if !row["receipt"].is_null() {
                continue;
            }
            let Some(path) = row["path"].as_str().map(str::to_string) else {
                continue;
            };
            if let Ok(Some(adopted)) = adopt_receipt(&path, &root_text, &remote) {
                row["status"] = json!("saved");
                row["lastBackup"] = json!(adopted.last_backup);
                row["sourceRevision"] = json!(adopted.source_revision);
                row["receipt"] = json!(adopted);
            }
        }
        let identities: std::collections::BTreeSet<String> = rows
            .iter()
            .filter_map(|r| {
                r["path"]
                    .as_str()
                    .and_then(|p| project_key_of(Path::new(p)))
            })
            .collect();
        available_projects = backup_listing(&remote)?
            .into_iter()
            .filter(|p| {
                p["localPath"].is_null()
                    && !p["projectId"]
                        .as_str()
                        .is_some_and(|id| identities.contains(id))
            })
            .collect();
        // Local projects with no identity yet may be the same project: offer a link.
        for project in &mut available_projects {
            let name = project["name"].as_str().unwrap_or("").trim().to_lowercase();
            let matches: Vec<String> = rows
                .iter()
                .filter(|r| r["receipt"].is_null())
                .filter_map(|r| r["path"].as_str())
                .filter(|p| {
                    project_key_of(Path::new(p)).is_none()
                        && project_title(Path::new(p)).trim().to_lowercase() == name
                })
                .map(str::to_string)
                .collect();
            project["localMatches"] = json!(matches);
        }
        for row in &mut rows {
            let receipt = row["receipt"].clone();
            let key = receipt["projectKey"]
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    row["path"]
                        .as_str()
                        .and_then(|p| project_key_of(Path::new(p)))
                });
            let Some(key) = key else {
                continue;
            };
            let heads = crate::drive_sync::heads(&remote, &key);
            if let Some(file) = heads.first() {
                let changed = file["id"] != receipt["archiveId"]
                    || file["sha256Checksum"] != receipt["archiveHash"];
                if heads.len() > 1 || changed {
                    let managed = heads.len() == 1
                        && file["appProperties"]["lemlioSync"] == "1"
                        && file["sha256Checksum"] == file["appProperties"]["lemlioArchiveHash"];
                    row["status"] = json!(if managed && row["status"] == "saved" {
                        "incoming"
                    } else {
                        "conflict"
                    });
                    row["conflict"] = conflict_details(file, heads.len());
                    row["conflict"]["versions"] = revision_choices(&heads);
                    row["deviceName"] = file["appProperties"]["lemlioDeviceName"].clone();
                }
            } else {
                row["status"] = json!("pending");
            }
        }
        Ok::<_, String>(())
    }
    .await;
    for row in &mut rows {
        if let Some(record) = row.as_object_mut() {
            record.remove("receipt");
        }
    }
    let all = rows.is_empty() || (verified.is_ok() && rows.iter().all(|r| r["status"] == "saved"));
    Ok(
        json!({"allBackedUp":all,"projects":rows,"availableProjects":available_projects,"connected":verified.is_ok(),"error":verified.err()}),
    )
}

#[cfg(test)]
mod folder_sync_tests {
    use super::*;
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A throwaway backup folder, project library and per-computer settings.
    struct Sandbox {
        temp: tempfile::TempDir,
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    impl Sandbox {
        fn new() -> Self {
            let guard = GUARD.lock().unwrap_or_else(|p| p.into_inner());
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("Dropbox").join(ROOT_NAME);
            std::fs::create_dir_all(&root).unwrap();
            *TEST_FOLDER.lock().unwrap() = Some(root);
            *crate::projects::TEST_LIBRARY.lock().unwrap() = Some(temp.path().join("library"));
            Sandbox {
                temp,
                _guard: guard,
            }
        }
        /// Switch to another computer: its own settings, device id and backup records.
        fn computer(&self, name: &str) {
            *crate::drive_receipts::TEST_CONFIG.lock().unwrap() =
                Some(self.temp.path().join(format!("config-{name}")));
        }
        fn project(&self, computer: &str, text: &str) -> PathBuf {
            let dir = self.temp.path().join(computer).join("Paper");
            std::fs::create_dir_all(dir.join("figs")).unwrap();
            std::fs::write(dir.join("main.tex"), text).unwrap();
            std::fs::write(dir.join("figs/binary.dat"), [0, 1, 2, 255]).unwrap();
            dir
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            *TEST_FOLDER.lock().unwrap_or_else(|p| p.into_inner()) = None;
            *TEST_REMOTE.lock().unwrap_or_else(|p| p.into_inner()) = None;
            *crate::projects::TEST_LIBRARY
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
            *crate::drive_receipts::TEST_CONFIG
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = None;
        }
    }
    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for item in std::fs::read_dir(from).unwrap() {
            let item = item.unwrap();
            let target = to.join(item.file_name());
            if item.file_type().unwrap().is_dir() {
                copy_dir(&item.path(), &target);
            } else {
                std::fs::copy(item.path(), target).unwrap();
            }
        }
    }
    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }
    fn text(path: &Path) -> String {
        std::fs::read_to_string(path.join("main.tex")).unwrap()
    }
    fn visible_entries(dir: &Path) -> Vec<String> {
        // A folder that was never created has nothing visible in it.
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        names
    }
    fn stored_files() -> Vec<Value> {
        backup_store::list(&PathBuf::from(link().unwrap().folder.unwrap())).unwrap()
    }

    #[test]
    fn a_newer_backup_replaces_the_same_project_in_place_without_a_duplicate() {
        let sandbox = Sandbox::new();
        run(async {
            let state = DriveState::default();
            sandbox.computer("a");
            let a = sandbox.project("a", "version one");
            let a_path = a.to_string_lossy().to_string();
            backup_project(&state, a_path.clone()).await.unwrap();
            assert!(
                read_project_id(&a).is_some(),
                "the project gets a stable id"
            );

            // PC B already holds an older copy of the very same project.
            sandbox.computer("b");
            let b = sandbox.temp.path().join("b").join("Paper");
            copy_dir(&a, &b);
            let b_path = b.to_string_lossy().to_string();
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            assert_eq!(summary["projects"][0]["status"], "saved", "{summary}");
            assert!(
                summary["availableProjects"].as_array().unwrap().is_empty(),
                "{summary}"
            );

            // PC A keeps editing and backs up again.
            sandbox.computer("a");
            std::fs::write(a.join("main.tex"), "version two from PC A").unwrap();
            backup_project(&state, a_path.clone()).await.unwrap();
            let head = crate::drive_receipts::load(&a_path).unwrap().unwrap();

            // PC B recognizes the newer revision of the same project and takes it.
            sandbox.computer("b");
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            assert_eq!(summary["projects"][0]["status"], "incoming", "{summary}");
            assert!(
                summary["availableProjects"].as_array().unwrap().is_empty(),
                "{summary}"
            );
            let synced = sync_project(&state, b_path.clone(), head.archive_hash.clone())
                .await
                .unwrap();
            assert_eq!(text(&b), "version two from PC A");
            assert_eq!(
                std::fs::read(b.join("figs/binary.dat")).unwrap(),
                [0, 1, 2, 255]
            );
            let recovery = Path::new(synced["recoveryPath"].as_str().unwrap());
            assert_eq!(
                text(recovery),
                "version one",
                "the old copy stays recoverable"
            );
            assert_eq!(
                visible_entries(b.parent().unwrap()),
                ["Paper"],
                "no second project"
            );
            assert!(
                visible_entries(&sandbox.temp.path().join("library").join("Imports")).is_empty()
            );
            assert_eq!(read_project_id(&b), read_project_id(&a));
            let settled = backup_summary(&state, vec![b_path]).await.unwrap();
            assert_eq!(settled["projects"][0]["status"], "saved", "{settled}");
        });
    }

    #[test]
    fn the_same_project_is_updated_in_place_when_backups_live_in_dropbox() {
        let sandbox = Sandbox::new();
        run(async {
            let fake = crate::dropbox::fake::Fake::start().await;
            let (client, _store) =
                crate::dropbox::fake::client(&fake, crate::dropbox::fake::quick());
            *TEST_REMOTE.lock().unwrap() = Some(Remote::Dropbox {
                client,
                account: "dbid:acct".into(),
            });
            let state = DriveState::default();
            sandbox.computer("a");
            let a = sandbox.project("a", "version one");
            let a_path = a.to_string_lossy().to_string();
            let first = backup_project(&state, a_path.clone()).await.unwrap();
            assert_eq!(first["provider"], "dropbox");

            // The same project, an older copy, on another computer.
            sandbox.computer("b");
            let b = sandbox.temp.path().join("b").join("Paper");
            copy_dir(&a, &b);
            let b_path = b.to_string_lossy().to_string();
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            assert_eq!(summary["projects"][0]["status"], "saved", "{summary}");
            assert!(
                summary["availableProjects"].as_array().unwrap().is_empty(),
                "{summary}"
            );

            sandbox.computer("a");
            std::fs::write(a.join("main.tex"), "version two from PC A").unwrap();
            backup_project(&state, a_path.clone()).await.unwrap();
            let head = crate::drive_receipts::load(&a_path).unwrap().unwrap();
            assert_eq!(head.folder_id, "dropbox:dbid:acct");

            sandbox.computer("b");
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            assert_eq!(summary["projects"][0]["status"], "incoming", "{summary}");
            let synced = sync_project(&state, b_path.clone(), head.archive_hash.clone())
                .await
                .unwrap();
            assert_eq!(text(&b), "version two from PC A");
            assert_eq!(
                text(Path::new(synced["recoveryPath"].as_str().unwrap())),
                "version one"
            );
            assert_eq!(
                visible_entries(b.parent().unwrap()),
                ["Paper"],
                "no second project"
            );
            let settled = backup_summary(&state, vec![b_path]).await.unwrap();
            assert_eq!(settled["projects"][0]["status"], "saved", "{settled}");
            // Both revisions are still in Dropbox; none was overwritten.
            assert_eq!(remote_files().await.unwrap().unwrap().1.len(), 2);
        });
    }

    #[test]
    fn a_project_without_an_id_is_linked_after_confirmation_never_duplicated() {
        let sandbox = Sandbox::new();
        run(async {
            let state = DriveState::default();
            sandbox.computer("a");
            let a = sandbox.project("a", "shared text");
            backup_project(&state, a.to_string_lossy().to_string())
                .await
                .unwrap();

            // PC B has the same-titled project from before ids existed.
            sandbox.computer("b");
            let b = sandbox.project("b", "shared text");
            let b_path = b.to_string_lossy().to_string();
            assert!(read_project_id(&b).is_none());
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            let available = summary["availableProjects"].as_array().unwrap();
            assert_eq!(available.len(), 1, "{summary}");
            assert_eq!(available[0]["localMatches"], json!([b_path]), "{summary}");
            let archive_id = available[0]["id"].as_str().unwrap().to_string();
            // Nothing is linked until the user confirms.
            assert!(read_project_id(&b).is_none());

            let linked = link_project(&state, b_path.clone(), archive_id.clone())
                .await
                .unwrap();
            assert_eq!(linked["provablyRelated"], true, "{linked}");
            assert_eq!(read_project_id(&b), read_project_id(&a));
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            assert_eq!(summary["projects"][0]["status"], "saved", "{summary}");
            assert!(
                summary["availableProjects"].as_array().unwrap().is_empty(),
                "{summary}"
            );

            // A project that already has its own identity cannot be hijacked by a link.
            let other = sandbox.project("c", "unrelated");
            ensure_project_key(&other, None).unwrap();
            assert!(
                link_project(&state, other.to_string_lossy().to_string(), archive_id)
                    .await
                    .is_err()
            );
            assert_eq!(stored_files().len(), 1);
        });
    }

    #[test]
    fn diverged_copies_are_a_conflict_and_the_cloud_choice_replaces_in_place() {
        let sandbox = Sandbox::new();
        run(async {
            let state = DriveState::default();
            sandbox.computer("a");
            let a = sandbox.project("a", "base");
            let a_path = a.to_string_lossy().to_string();
            backup_project(&state, a_path.clone()).await.unwrap();
            sandbox.computer("b");
            let b = sandbox.temp.path().join("b").join("Paper");
            copy_dir(&a, &b);
            let b_path = b.to_string_lossy().to_string();
            backup_summary(&state, vec![b_path.clone()]).await.unwrap();

            // Both computers edit independently.
            sandbox.computer("a");
            std::fs::write(a.join("main.tex"), "edited on PC A").unwrap();
            backup_project(&state, a_path.clone()).await.unwrap();
            let head = crate::drive_receipts::load(&a_path).unwrap().unwrap();
            sandbox.computer("b");
            std::fs::write(b.join("main.tex"), "edited on PC B").unwrap();
            let summary = backup_summary(&state, vec![b_path.clone()]).await.unwrap();
            assert_eq!(summary["projects"][0]["status"], "conflict", "{summary}");
            // The automatic path refuses to overwrite local edits.
            assert!(
                sync_project(&state, b_path.clone(), head.archive_hash.clone())
                    .await
                    .is_err()
            );
            assert_eq!(text(&b), "edited on PC B");

            // Choosing the cloud version replaces the project in place and keeps a recovery copy.
            let chosen = use_cloud_version(&state, b_path.clone(), head.archive_hash.clone())
                .await
                .unwrap();
            assert_eq!(text(&b), "edited on PC A");
            assert_eq!(
                text(Path::new(chosen["recoveryPath"].as_str().unwrap())),
                "edited on PC B"
            );
            assert_eq!(visible_entries(b.parent().unwrap()), ["Paper"]);
            let settled = backup_summary(&state, vec![b_path]).await.unwrap();
            assert_eq!(settled["projects"][0]["status"], "saved", "{settled}");
        });
    }

    #[test]
    fn a_missing_sync_folder_is_never_rebuilt_but_a_deleted_backup_folder_is() {
        let sandbox = Sandbox::new();
        let dropbox = sandbox.temp.path().join("Dropbox");
        let root = dropbox.join(ROOT_NAME);
        std::fs::remove_dir_all(&root).unwrap();
        let link = Link {
            folder: Some(root.to_string_lossy().to_string()),
            ..Default::default()
        };
        assert_eq!(backup_root(&link).unwrap(), root);
        assert!(root.is_dir());
        std::fs::remove_dir_all(&dropbox).unwrap();
        assert!(backup_root(&link).is_err());
        assert!(!dropbox.exists(), "Dropbox itself must not be recreated");
        assert!(existing_backup_root(&link).unwrap().is_none());
    }

    #[test]
    fn choosing_a_folder_creates_lemlio_backups_inside_it() {
        let sandbox = Sandbox::new();
        let dropbox = sandbox.temp.path().join("Dropbox");
        let chosen = set_backup_folder(&dropbox).unwrap();
        assert_eq!(PathBuf::from(&chosen), dropbox.join(ROOT_NAME));
        assert_eq!(set_backup_folder(&dropbox.join(ROOT_NAME)).unwrap(), chosen);
        assert!(set_backup_folder(Path::new("relative/folder")).is_err());
        assert!(set_backup_folder(&sandbox.temp.path().join("absent")).is_err());
    }
}
