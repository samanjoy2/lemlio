//! User-authorized Google Drive backups. Tokens stay in the OS credential store.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
#[derive(Clone, Default)]
pub struct DriveState {
    pending: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    login: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    upload: Arc<Mutex<()>>,
}
#[derive(Serialize, Deserialize, Clone)]
struct ClientConfig {
    client_id: String,
    client_secret: String,
}
#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    client_id: String,
    folder_id: Option<String>,
    last_backup: Option<u64>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn config_path() -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("Cannot locate app settings")?
        .join("Lemlio")
        .join("drive-client.json"))
}
fn config() -> Result<ClientConfig, String> {
    serde_json::from_str(
        &std::fs::read_to_string(config_path()?)
            .map_err(|_| "Choose your Desktop OAuth client JSON first")?,
    )
    .map_err(|_| "Invalid Drive client configuration".into())
}

#[cfg(target_os = "windows")]
fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("Lemlio.GoogleDrive", "oauth-tokens")
        .map_err(|_| "Cannot access Windows Credential Manager".into())
}
#[cfg(target_os = "windows")]
fn tokens() -> Result<Option<Tokens>, String> {
    match credential()?.get_password() {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| "Stored Drive connection is invalid; reconnect".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read Drive connection from Windows Credential Manager".into()),
    }
}
#[cfg(not(target_os = "windows"))]
fn tokens() -> Result<Option<Tokens>, String> {
    Ok(None)
}
#[cfg(target_os = "windows")]
fn save_tokens(tokens: &Tokens) -> Result<(), String> {
    credential()?
        .set_password(&serde_json::to_string(tokens).map_err(|_| "Cannot encode Drive connection")?)
        .map_err(|_| "Cannot save Drive connection in Windows Credential Manager".into())
}
#[cfg(not(target_os = "windows"))]
fn save_tokens(_: &Tokens) -> Result<(), String> {
    Err("Direct Drive sign-in is currently supported on Windows".into())
}

pub fn configure_client(path: &Path) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|_| "Cannot read the OAuth client JSON")?;
    let document: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|_| "Invalid OAuth JSON")?;
    let installed = &document["installed"];
    let client = ClientConfig {
        client_id: installed["client_id"]
            .as_str()
            .ok_or("Choose a Desktop app OAuth JSON, not a service account")?
            .to_string(),
        client_secret: installed["client_secret"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    };
    if !client.client_id.ends_with(".apps.googleusercontent.com") {
        return Err("This is not a Google Desktop OAuth client".into());
    }
    let path = config_path()?;
    let parent = path.parent().ok_or("Invalid settings folder")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create app settings")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot save client configuration")?;
    serde_json::to_writer(&mut temporary, &client)
        .map_err(|_| "Cannot save client configuration")?;
    temporary
        .persist(path)
        .map_err(|_| "Cannot save client configuration")?;
    Ok(())
}

pub fn clear_local_setup() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("Cannot remove the local Drive connection".into()),
    }
    let path = config_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot remove local OAuth configuration".into()),
    }
}
#[tauri::command]
pub fn drive_configure(client_path: String) -> Result<(), String> {
    configure_client(Path::new(&client_path))
}

#[tauri::command]
pub async fn drive_status(state: tauri::State<'_, DriveState>) -> Result<Value, String> {
    status(&state).await
}
async fn status(state: &DriveState) -> Result<Value, String> {
    let config = config().ok();
    let token = tokens()?;
    let connected = token
        .as_ref()
        .is_some_and(|t| config.as_ref().is_some_and(|c| c.client_id == t.client_id));
    Ok(
        json!({"configured":config.is_some(),"connected":connected,"pending":state.pending.load(Ordering::SeqCst),"error":state.error.lock().await.clone(),"lastBackup":token.as_ref().and_then(|t|t.last_backup),"folderUrl":token.and_then(|t|t.folder_id).map(|id|format!("https://drive.google.com/drive/folders/{id}"))}),
    )
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "Cannot initialize the Google connection".into())
}

async fn token_request(form: &[(&str, &str)]) -> Result<Value, String> {
    let response = http_client()?
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|_| "Cannot reach Google sign-in. Check your connection.")?;
    if !response.status().is_success() {
        return Err("Google rejected the connection. Check the Desktop OAuth client and test-user settings, then reconnect.".into());
    }
    serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|_| "Cannot read Google response")?,
    )
    .map_err(|_| "Invalid Google response".into())
}

fn authorization_url(
    client_id: &str,
    redirect: &str,
    challenge: &str,
    nonce: &str,
) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|_| "Invalid OAuth endpoint")?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", nonce),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ]);
    Ok(url)
}
fn callback_parameters(
    target: &str,
    nonce: &str,
) -> Option<std::collections::HashMap<String, String>> {
    if !target.starts_with('/') {
        return None;
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let pairs: Vec<_> = url.query_pairs().into_owned().collect();
    if pairs.iter().filter(|(key, _)| key == "state").count() != 1
        || pairs.iter().filter(|(key, _)| key == "code").count() > 1
    {
        return None;
    }
    let parameters: std::collections::HashMap<_, _> = pairs.into_iter().collect();
    if parameters.get("state").map(String::as_str) != Some(nonce) {
        return None;
    }
    Some(parameters)
}
pub async fn begin_login(state: &DriveState) -> Result<String, String> {
    let client = config()?;
    if let Some(task) = state.login.lock().await.take() {
        task.abort();
    }
    *state.error.lock().await = None;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Cannot start the local Google sign-in callback")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Cannot read callback port")?
        .port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let nonce = uuid::Uuid::new_v4().to_string();
    let url = authorization_url(&client.client_id, &redirect, &challenge, &nonce)?;
    state.pending.store(true, Ordering::SeqCst);
    let current = state.clone();
    let task = tokio::spawn(async move {
        let result=tokio::time::timeout(Duration::from_secs(300),async {
     loop {
       let (mut stream,_)=listener.accept().await.map_err(|_|"Google callback failed".to_string())?;
       let mut buffer=vec![0;16384];
       let count=tokio::time::timeout(Duration::from_secs(10),stream.read(&mut buffer)).await.map_err(|_|"Google callback timed out")?.map_err(|_|"Cannot read Google callback")?;
       let request=String::from_utf8_lossy(&buffer[..count]);
       let target=request.lines().next().and_then(|line|line.split_whitespace().nth(1)).unwrap_or("/");
       let Some(parameters)=callback_parameters(target,&nonce) else {let _=stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;continue;};
       let exchange=async {
         let code=parameters.get("code").ok_or("Google sign-in was cancelled")?;
         let response=token_request(&[("client_id",&client.client_id),("client_secret",&client.client_secret),("code",code),("code_verifier",&verifier),("redirect_uri",&redirect),("grant_type","authorization_code")]).await?;
         let access=response["access_token"].as_str().ok_or("Google did not return an access token")?;
         let refresh=response["refresh_token"].as_str().ok_or("Google did not grant background access; reconnect and approve access")?;
         save_tokens(&Tokens{access_token:access.into(),refresh_token:refresh.into(),expires_at:now()+response["expires_in"].as_u64().unwrap_or(3600),client_id:client.client_id.clone(),folder_id:None,last_backup:None})?;
         Ok::<(),String>(())
       }.await;
       let message=if exchange.is_ok(){"Lemlio is connected to Google Drive. You can close this tab."}else{"Lemlio could not connect. Return to the app to check the connection."};
       let page=format!("<!doctype html><meta charset=utf-8><title>Lemlio</title><p>{message}</p>");
       let header=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",page.len(),page);
       let _=stream.write_all(header.as_bytes()).await;
       return exchange;
     }
   }).await;
        current.pending.store(false, Ordering::SeqCst);
        *current.error.lock().await = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("Google sign-in timed out. Try Connect again.".into()),
        };
    });
    *state.login.lock().await = Some(task);
    Ok(url.to_string())
}
#[tauri::command]
pub async fn drive_connect(state: tauri::State<'_, DriveState>) -> Result<String, String> {
    begin_login(&state).await
}
#[tauri::command]
pub async fn drive_cancel(state: tauri::State<'_, DriveState>) -> Result<(), String> {
    if let Some(task) = state.login.lock().await.take() {
        task.abort();
    }
    state.pending.store(false, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub async fn drive_disconnect(state: tauri::State<'_, DriveState>) -> Result<(), String> {
    if let Some(task) = state.login.lock().await.take() {
        task.abort();
    }
    state.pending.store(false, Ordering::SeqCst);
    if let Some(token) = tokens()? {
        let _ = http_client()?
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", token.refresh_token)])
            .send()
            .await;
    }
    #[cfg(target_os = "windows")]
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("Cannot remove the stored Drive connection".into()),
    }
    Ok(())
}

async fn authorized_tokens() -> Result<Tokens, String> {
    let client = config()?;
    let mut token = tokens()?.ok_or("Connect Google Drive first")?;
    if token.client_id != client.client_id {
        return Err("The OAuth client changed. Reconnect Google Drive.".into());
    }
    if token.expires_at <= now() + 60 {
        let response = token_request(&[
            ("client_id", &client.client_id),
            ("client_secret", &client.client_secret),
            ("refresh_token", &token.refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .await?;
        token.access_token = response["access_token"]
            .as_str()
            .ok_or("Google did not renew access; reconnect")?
            .into();
        token.expires_at = now() + response["expires_in"].as_u64().unwrap_or(3600);
        if let Some(refresh) = response["refresh_token"].as_str() {
            token.refresh_token = refresh.into();
        }
        save_tokens(&token)?;
    }
    Ok(token)
}
async fn google_json(response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        if response.status().as_u16() == 411 {
            return Err("Google Drive rejected the request length (HTTP 411). The backup remains queued; reconnecting is not required.".into());
        }
        return Err(format!(
            "Google Drive returned HTTP {}. Check access or reconnect.",
            response.status().as_u16()
        ));
    }
    serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|_| "Cannot read Drive response")?,
    )
    .map_err(|_| "Invalid Drive response".into())
}

async fn drive_children(
    client: &reqwest::Client,
    token: &str,
    parent: &str,
) -> Result<Vec<Value>, String> {
    let mut result = Vec::new();
    let mut page = String::new();
    loop {
        let response = client
            .get("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(token)
            .query(&[
                (
                    "q",
                    format!(
                        "trashed=false and '{}' in parents",
                        parent.replace('\\', "\\\\").replace('\'', "\\'")
                    ),
                ),
                (
                    "fields",
                    "nextPageToken,files(id,name,mimeType,size,sha256Checksum,appProperties)"
                        .into(),
                ),
                ("pageSize", "1000".into()),
                ("pageToken", page.clone()),
            ])
            .send()
            .await
            .map_err(|_| "Cannot list the Drive backup folder")?;
        let data = google_json(response).await?;
        result.extend(data["files"].as_array().cloned().unwrap_or_default());
        match data["nextPageToken"].as_str() {
            Some(next) if !next.is_empty() => page = next.to_string(),
            _ => break,
        }
    }
    Ok(result)
}
async fn create_drive_folder(
    client: &reqwest::Client,
    token: &str,
    parent: Option<&str>,
    name: &str,
    project_key: Option<&str>,
) -> Result<String, String> {
    let mut metadata = json!({"name":name,"mimeType":"application/vnd.google-apps.folder"});
    if let Some(parent) = parent {
        metadata["parents"] = json!([parent]);
    }
    if let Some(key) = project_key {
        metadata["appProperties"] = json!({"lemlioProject":key});
    }
    let response = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(token)
        .json(&metadata)
        .send()
        .await
        .map_err(|_| "Cannot create the Drive folder")?;
    google_json(response).await?["id"]
        .as_str()
        .map(str::to_string)
        .ok_or("Missing Drive folder ID".into())
}
fn chunk_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    token: &str,
    range: &str,
    body: Vec<u8>,
) -> reqwest::RequestBuilder {
    client
        .put(url)
        .bearer_auth(token)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Range", range)
        .header(reqwest::header::CONTENT_LENGTH, body.len().to_string())
        .body(body)
}

fn drive_file_matches(remote: &Value, hash: &str, size: u64) -> bool {
    remote["sha256Checksum"].as_str() == Some(hash)
        || (size == 0
            && (remote["size"].as_str() == Some("0") || remote["size"].as_u64() == Some(0)))
}

async fn upload_drive_file(
    client: &reqwest::Client,
    token: &str,
    parent: &str,
    name: &str,
    source: &Path,
    existing: Option<&str>,
) -> Result<Value, String> {
    let mime = match source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "tex" | "ltx" | "bib" | "sty" | "cls" | "txt" | "md" | "csv" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    let size = tokio::fs::metadata(source)
        .await
        .map_err(|_| "Cannot read backup file")?
        .len();
    let url = existing
        .map(|id| format!("https://www.googleapis.com/upload/drive/v3/files/{id}"))
        .unwrap_or_else(|| "https://www.googleapis.com/upload/drive/v3/files".into());
    let request = if existing.is_some() {
        client.patch(url)
    } else {
        client.post(url)
    };
    let mut metadata = json!({"name": name,"mimeType":mime});
    if existing.is_none() {
        metadata["parents"] = json!([parent]);
    }
    if size == 0 {
        // Empty files have no resumable chunks. Creating metadata or explicitly
        // replacing media with a length-zero body avoids invalid empty sessions.
        let response = if let Some(id) = existing {
            client
                .patch(format!(
                    "https://www.googleapis.com/upload/drive/v3/files/{id}"
                ))
                .query(&[
                    ("uploadType", "media"),
                    ("fields", "id,size,sha256Checksum"),
                ])
                .bearer_auth(token)
                .header("Content-Type", mime)
                .header(reqwest::header::CONTENT_LENGTH, "0")
                .body(Vec::<u8>::new())
                .send()
                .await
                .map_err(|_| "Cannot save the empty Drive file")?
        } else {
            client
                .post("https://www.googleapis.com/drive/v3/files")
                .query(&[("fields", "id,size,sha256Checksum")])
                .bearer_auth(token)
                .json(&metadata)
                .send()
                .await
                .map_err(|_| "Cannot create the empty Drive file")?
        };
        let result = google_json(response).await?;
        if result["id"].as_str().is_none() {
            return Err("Google did not confirm the empty file".into());
        }
        return Ok(result);
    }
    let metadata_body =
        serde_json::to_vec(&metadata).map_err(|_| "Cannot encode Drive upload metadata")?;
    let response = request
        .query(&[
            ("uploadType", "resumable"),
            ("fields", "id,size,sha256Checksum"),
        ])
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .header("X-Upload-Content-Type", mime)
        .header("X-Upload-Content-Length", size.to_string())
        .header(
            reqwest::header::CONTENT_LENGTH,
            metadata_body.len().to_string(),
        )
        .body(metadata_body)
        .send()
        .await
        .map_err(|_| "Cannot start the Drive file upload")?;
    if !response.status().is_success() {
        return Err(format!(
            "Cannot start Drive upload (HTTP {})",
            response.status().as_u16()
        ));
    }
    let location = response
        .headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .ok_or("Missing Drive upload session")?;
    let upload_url = reqwest::Url::parse(location).map_err(|_| "Invalid Drive upload URL")?;
    if upload_url.scheme() != "https" || upload_url.host_str() != Some("www.googleapis.com") {
        return Err("Unexpected Drive upload endpoint".into());
    }
    let mut file = tokio::fs::File::open(source)
        .await
        .map_err(|_| "Cannot open backup file")?;
    let mut offset = 0u64;
    loop {
        let length = (size - offset).min(8 * 1024 * 1024) as usize;
        let mut chunk = vec![0; length];
        file.read_exact(&mut chunk)
            .await
            .map_err(|_| "Cannot read backup data")?;
        let range = if size == 0 {
            "bytes */0".to_string()
        } else {
            format!("bytes {}-{}/{}", offset, offset + length as u64 - 1, size)
        };
        let mut response = None;
        for attempt in 0..3 {
            match chunk_request(client, upload_url.clone(), token, &range, chunk.clone())
                .send()
                .await
            {
                Ok(reply)
                    if reply.status().as_u16() != 429 && !reply.status().is_server_error() =>
                {
                    response = Some(reply);
                    break;
                }
                _ if attempt < 2 => tokio::time::sleep(Duration::from_secs(1 << attempt)).await,
                _ => return Err("Drive upload interrupted; automatic backup will retry".into()),
            }
        }
        let reply = response.ok_or("Drive upload failed")?;
        offset += length as u64;
        if reply.status().as_u16() != 308 {
            let uploaded = google_json(reply).await?;
            if offset != size || uploaded["id"].as_str().is_none() {
                return Err("Google did not confirm the complete file".into());
            }
            return Ok(uploaded);
        }
        if offset >= size {
            return Err("Google has not confirmed the complete file".into());
        }
    }
}
fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
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
pub async fn backup_project(state: &DriveState, project_path: String) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let snapshot = tokio::task::spawn_blocking(move || {
        let source = std::fs::canonicalize(&project_path).map_err(|e| e.to_string())?;
        if !source.is_dir() {
            return Err("Project folder is unavailable".to_string());
        }
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let entries = crate::projects::project_entries(&source)?;
        for (relative, folder) in &entries {
            let destination = directory.path().join(relative);
            if *folder {
                std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(source.join(relative), destination).map_err(|e| e.to_string())?;
            }
        }
        let normalized = source.to_string_lossy().replace('\\', "/").to_lowercase();
        let key = format!("{:x}", Sha256::digest(normalized.as_bytes()));
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
        Ok::<_, String>((directory, entries, key, name))
    })
    .await
    .map_err(|_| "Cannot prepare backup files")??;
    // A deleted backup root is recreated without touching any old backup files.
    if let Some(id) = token.folder_id.clone() {
        let response = client
            .get(format!("https://www.googleapis.com/drive/v3/files/{id}"))
            .bearer_auth(&token.access_token)
            .query(&[("fields", "id,trashed")])
            .send()
            .await
            .map_err(|_| "Cannot reach Google Drive")?;
        if response.status().as_u16() == 404 {
            token.folder_id = None;
        } else {
            let data = google_json(response).await?;
            if data["trashed"].as_bool() == Some(true) {
                token.folder_id = None;
            }
        }
    }
    if token.folder_id.is_none() {
        let root_files = drive_children(&client, &token.access_token, "root").await?;
        token.folder_id = root_files
            .iter()
            .find(|f| {
                f["name"] == "Lemlio Backups"
                    && f["mimeType"] == "application/vnd.google-apps.folder"
            })
            .and_then(|f| f["id"].as_str())
            .map(str::to_string);
        if token.folder_id.is_none() {
            token.folder_id = Some(
                create_drive_folder(&client, &token.access_token, None, "Lemlio Backups", None)
                    .await?,
            );
        }
        save_tokens(&token)?;
    }
    let root = token.folder_id.as_deref().ok_or("Missing backup root")?;
    let children = drive_children(&client, &token.access_token, root).await?;
    let project = children.iter().find(|f| {
        f["appProperties"]["lemlioProject"] == snapshot.2
            && f["mimeType"] == "application/vnd.google-apps.folder"
    });
    let project_folder = if let Some(folder) = project {
        let id = folder["id"]
            .as_str()
            .ok_or("Missing project folder ID")?
            .to_string();
        if folder["name"] != snapshot.3 {
            google_json(
                client
                    .patch(format!("https://www.googleapis.com/drive/v3/files/{id}"))
                    .bearer_auth(&token.access_token)
                    .json(&json!({"name":snapshot.3}))
                    .send()
                    .await
                    .map_err(|_| "Cannot update backup folder name")?,
            )
            .await?;
        }
        id
    } else {
        create_drive_folder(
            &client,
            &token.access_token,
            Some(root),
            &snapshot.3,
            Some(&snapshot.2),
        )
        .await?
    };
    let mut folders = std::collections::HashMap::from([(PathBuf::new(), project_folder.clone())]);
    let mut listings = std::collections::HashMap::<String, Vec<Value>>::new();
    let mut uploaded = 0usize;
    let mut unchanged = 0usize;
    for (relative, is_folder) in &snapshot.1 {
        let parent = relative.parent().unwrap_or(Path::new(""));
        let parent_id = folders.get(parent).ok_or("Missing parent folder")?.clone();
        if !listings.contains_key(&parent_id) {
            listings.insert(
                parent_id.clone(),
                drive_children(&client, &token.access_token, &parent_id).await?,
            );
        }
        let name = relative
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let existing = listings.get(&parent_id).and_then(|items| {
            items.iter().find(|f| {
                f["name"] == name
                    && (f["mimeType"] == "application/vnd.google-apps.folder") == *is_folder
            })
        });
        if *is_folder {
            let id = if let Some(file) = existing {
                file["id"].as_str().ok_or("Missing folder ID")?.to_string()
            } else {
                create_drive_folder(&client, &token.access_token, Some(&parent_id), &name, None)
                    .await?
            };
            folders.insert(relative.clone(), id);
            continue;
        }
        let path = snapshot.0.path().join(relative);
        let hash = sha256_file(&path)?;
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if existing.is_some_and(|f| drive_file_matches(f, &hash, size)) {
            unchanged += 1;
            continue;
        }
        let result = upload_drive_file(
            &client,
            &token.access_token,
            &parent_id,
            &name,
            &path,
            existing.and_then(|f| f["id"].as_str()),
        )
        .await?;
        if let Some(remote) = result["sha256Checksum"].as_str() {
            if remote != hash {
                return Err("Drive file verification failed; backup will retry".into());
            }
        }
        uploaded += 1;
    }
    token.last_backup = Some(now());
    save_tokens(&token)?;
    Ok(
        json!({"name":snapshot.3,"uploadedFiles":uploaded,"unchangedFiles":unchanged,"lastBackup":token.last_backup,"folderUrl":format!("https://drive.google.com/drive/folders/{project_folder}")}),
    )
}
#[tauri::command]
pub async fn drive_backup_project(
    state: tauri::State<'_, DriveState>,
    project_path: String,
) -> Result<Value, String> {
    backup_project(&state, project_path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upload_chunks_always_declare_their_exact_length_including_empty_bodies() {
        let client = reqwest::Client::new();
        for body in [Vec::new(), vec![1, 2, 3]] {
            let length = body.len();
            let request = chunk_request(
                &client,
                reqwest::Url::parse("http://127.0.0.1/upload").unwrap(),
                "test",
                "bytes */3",
                body,
            )
            .build()
            .unwrap();
            assert_eq!(
                request.headers()[reqwest::header::CONTENT_LENGTH],
                length.to_string()
            );
            assert_eq!(request.body().unwrap().as_bytes().unwrap().len(), length);
        }
    }
    #[test]
    fn empty_backups_are_not_reuploaded_when_drive_has_no_checksum() {
        assert!(drive_file_matches(&json!({"size":"0"}), "empty-hash", 0));
        assert!(!drive_file_matches(&json!({"size":"0"}), "file-hash", 2));
        assert!(drive_file_matches(
            &json!({"sha256Checksum":"file-hash"}),
            "file-hash",
            2
        ));
    }
    #[test]
    fn callback_rejects_wrong_or_ambiguous_state() {
        assert!(callback_parameters("/?state=wrong&code=code", "expected").is_none());
        assert!(
            callback_parameters("/?state=expected&state=wrong&code=code", "expected").is_none()
        );
        assert!(
            callback_parameters("/?state=expected&code=first&code=second", "expected").is_none()
        );
        assert!(
            callback_parameters("https://example.com/?state=expected&code=code", "expected")
                .is_none()
        );
    }
    #[test]
    fn valid_callback_decodes_code_without_logging_it() {
        let parameters =
            callback_parameters("/?state=expected&code=a%2Bb%2Fc", "expected").unwrap();
        assert_eq!(parameters["code"], "a+b/c");
    }
    #[test]
    fn authorization_is_google_only_with_pkce_and_minimal_scope() {
        let url = authorization_url(
            "example.apps.googleusercontent.com",
            "http://127.0.0.1:49152",
            "challenge",
            "nonce",
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["scope"], SCOPE);
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["state"], "nonce");
        assert_eq!(pairs["access_type"], "offline");
    }
}
