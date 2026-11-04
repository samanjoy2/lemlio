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

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("Lemlio.GoogleDrive", "oauth-tokens")
        .map_err(|_| "Cannot access the system credential store".into())
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn tokens() -> Result<Option<Tokens>, String> {
    match credential()?.get_password() {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| "Stored Drive connection is invalid; reconnect".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read Drive connection from the system credential store".into()),
    }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn tokens() -> Result<Option<Tokens>, String> {
    Ok(None)
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn save_tokens(tokens: &Tokens) -> Result<(), String> {
    credential()?
        .set_password(&serde_json::to_string(tokens).map_err(|_| "Cannot encode Drive connection")?)
        .map_err(|_| "Cannot save Drive connection in the system credential store".into())
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn save_tokens(_: &Tokens) -> Result<(), String> {
    Err("Direct Drive sign-in is currently supported on Windows and macOS".into())
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
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
        let status = response.status().as_u16();
        if status == 411 {
            return Err("Google Drive rejected the request length (HTTP 411). The backup remains queued; reconnecting is not required.".into());
        }
        let details: Value = response.json().await.unwrap_or(Value::Null);
        let reason = details["error"]["errors"][0]["reason"]
            .as_str()
            .unwrap_or("requestRejected");
        let message: String = details["error"]["message"]
            .as_str()
            .unwrap_or("Google did not allow this request")
            .chars()
            .take(300)
            .collect();
        return Err(format!(
            "Google Drive returned HTTP {status} ({reason}): {message}"
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
                    "nextPageToken,files(id,name,mimeType,size,sha256Checksum,appProperties,modifiedTime)"
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

#[cfg(test)]
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
    project_key: &str,
    sync_properties: &Value,
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
        "zip" => "application/zip",
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
    let mut metadata = json!({"name": name,"mimeType":mime,"appProperties":{"lemlioProject":project_key,"lemlioFormat":"zip-v2","lemlioArchiveHash":sha256_file(source)?}});
    if let Some(properties) = sync_properties.as_object() {
        for (key, value) in properties {
            metadata["appProperties"][key] = value.clone();
        }
    }
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

fn validate_backup_root(file: &Value) -> Result<(), String> {
    if file["name"] != "Lemlio Backups"
        || file["mimeType"] != "application/vnd.google-apps.folder"
        || file["ownedByMe"] != true
    {
        return Err(
            "Reset stopped: the configured Drive folder is not your Lemlio Backups folder".into(),
        );
    }
    Ok(())
}

/// Explicit reset only: trash the configured backup root, never permanently delete it.
pub async fn reset_backups(state: &DriveState) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let mut trashed = false;
    if let Some(id) = token.folder_id.clone() {
        let response = client
            .get(format!("https://www.googleapis.com/drive/v3/files/{id}"))
            .bearer_auth(&token.access_token)
            .query(&[("fields", "id,name,mimeType,ownedByMe,trashed")])
            .send()
            .await
            .map_err(|_| "Cannot inspect the backup folder")?;
        if response.status().as_u16() != 404 {
            let file = google_json(response).await?;
            validate_backup_root(&file)?;
            if file["trashed"] != true {
                let response = client
                    .patch(format!("https://www.googleapis.com/drive/v3/files/{id}"))
                    .bearer_auth(&token.access_token)
                    .query(&[("fields", "id,trashed")])
                    .json(&json!({"trashed":true}))
                    .send()
                    .await
                    .map_err(|_| "Cannot move the backup folder to Trash")?;
                if google_json(response).await.map_err(|error| if error.contains("appNotAuthorizedToChild") { "Google cannot reset this folder because it contains items outside Lemlio's app access. Open the backup folder in Drive, move that folder to Trash, then try Reset again. Your PC files are unaffected.".to_string() } else {error})?["trashed"] != true {
                    return Err("Google did not confirm moving the backup folder to Trash".into());
                }
            }
            trashed = true;
        }
    }
    token.folder_id = None;
    token.last_backup = None;
    save_tokens(&token)?;
    token.folder_id = Some(
        create_drive_folder(&client, &token.access_token, None, "Lemlio Backups", None).await?,
    );
    save_tokens(&token)?;
    *state.error.lock().await = None;
    Ok(
        json!({"trashedPreviousFolder":trashed,"folderUrl":format!("https://drive.google.com/drive/folders/{}",token.folder_id.unwrap())}),
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
async fn conflict_archive(key: &str, expected: &str) -> Result<String, String> {
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let root = existing_backup_root(&client, &mut token)
        .await?
        .ok_or("No Drive backup folder")?;
    let files = drive_children(&client, &token.access_token, &root).await?;
    crate::drive_sync::heads(&files, key)
        .into_iter()
        .find(|f| f["sha256Checksum"] == expected)
        .and_then(|f| f["id"].as_str().map(str::to_string))
        .ok_or("The Drive revision changed again; refresh before continuing".into())
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
    let receipt =
        crate::drive_receipts::load(&project_path)?.ok_or("Project is not linked to Drive")?;
    if !receipt_unchanged(Path::new(&project_path), &receipt)? {
        return Err("Local files changed too. Review both versions; nothing was replaced".into());
    }
    let id = conflict_archive(&receipt.project_key, &expected).await?;
    // Only a single, genuine Lemlio revision may fast-forward automatically.
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let root = existing_backup_root(&client, &mut token)
        .await?
        .ok_or("No backup folder")?;
    let files = drive_children(&client, &token.access_token, &root).await?;
    let heads = crate::drive_sync::heads(&files, &receipt.project_key);
    if heads.len() != 1
        || heads[0]["id"] != id
        || heads[0]["appProperties"]["lemlioSync"] != "1"
        || heads[0]["sha256Checksum"] != heads[0]["appProperties"]["lemlioArchiveHash"]
    {
        return Err("Drive has competing or externally edited versions; review them first".into());
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

pub async fn backup_project(state: &DriveState, project_path: String) -> Result<Value, String> {
    backup_project_with_choice(state, project_path, None, false).await
}

async fn backup_project_with_choice(
    state: &DriveState,
    project_path: String,
    expected_remote_hash: Option<&str>,
    rename_backup: bool,
) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let snapshot = tokio::task::spawn_blocking(move || {
        let source = std::fs::canonicalize(&project_path).map_err(|e| e.to_string())?;
        if !source.is_dir() {
            return Err("Project folder is unavailable".to_string());
        }
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let revision = local_revision(&source)?;
        let file_count = crate::projects::export_to(&source, &directory.path().join("backup.zip"))?;
        if local_revision(&source)? != revision {
            return Err("Project changed while preparing its ZIP; backup will retry".into());
        }
        let local_path = source.to_string_lossy().to_string();
        let receipt = crate::drive_receipts::load(&local_path)?;
        // Keep the established archive identity for existing Windows projects.
        let normalized = if cfg!(target_os = "windows") {
            local_path.replace('\\', "/").to_lowercase()
        } else {
            crate::drive_receipts::path_key(&local_path)
        };
        let key = receipt
            .as_ref()
            .map(|r| r.project_key.clone())
            .unwrap_or_else(|| format!("{:x}", Sha256::digest(normalized.as_bytes())));
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
    let heads = crate::drive_sync::heads(&children, &snapshot.2);
    if heads.len() > 16 {
        return Err(
            "Too many concurrent Drive versions; export local files before resolving in Drive"
                .into(),
        );
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
                .unwrap_or("Drive revision was removed; refresh first".into()));
        }
    }
    if heads.len() > 1 && expected_remote_hash.is_none() {
        let mut conflict = conflict_details(existing.unwrap(), heads.len());
        conflict["versions"] = revision_choices(&heads);
        return Err(format!("DRIVE_CONFLICT:{conflict}"));
    }
    let archive = snapshot.0.path().join("backup.zip");
    let content = snapshot.4.trim_start_matches("content-v1:");
    let old_hash = sha256_file(&archive)?;
    if let Some(remote) = existing {
        let baseline = snapshot
            .5
            .as_ref()
            .filter(|r| r.folder_id == root && remote["id"].as_str() == Some(r.archive_id.as_str()))
            .map(|r| r.archive_hash.as_str());
        let same_content = remote["appProperties"]["lemlioContent"] == content
            && remote["sha256Checksum"] == remote["appProperties"]["lemlioArchiveHash"];
        if !same_content {
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
        "lemlioDevice":device["id"],"lemlioDeviceName":device["name"],"lemlioSavedAt":now().to_string()});
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
        let result = upload_drive_file(
            &client,
            &token.access_token,
            root,
            &archive_name,
            &archive,
            None, // Immutable revision: another device can never overwrite this upload.
            &snapshot.2,
            &properties,
        )
        .await?;
        if result["sha256Checksum"].as_str() != Some(hash.as_str()) {
            return Err("Drive ZIP verification failed; backup will retry".into());
        }
        result["id"]
            .as_str()
            .ok_or("Missing backup archive ID")?
            .to_string()
    };
    token.last_backup = Some(now());
    save_tokens(&token)?;
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
            last_backup: token.last_backup.unwrap_or_default(),
        },
    )?;
    Ok(
        json!({"name":snapshot.3,"format":"zip","sourceFiles":snapshot.1,"sourceRevision":snapshot.4,"uploadedFiles":if reused {0} else {1},"unchangedFiles":if reused {1} else {0},"deviceName":device["name"],"lastBackup":token.last_backup,"archiveUrl":format!("https://drive.google.com/file/d/{archive_id}/view"),"folderUrl":format!("https://drive.google.com/drive/folders/{root}")}),
    )
}
#[tauri::command]
pub async fn drive_backup_project(
    state: tauri::State<'_, DriveState>,
    project_path: String,
    expected_remote_hash: Option<String>,
    rename_backup: Option<bool>,
) -> Result<Value, String> {
    backup_project_with_choice(
        &state,
        project_path,
        expected_remote_hash.as_deref(),
        rename_backup.unwrap_or(false),
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
    fn reset_only_accepts_owned_lemlio_backup_folders() {
        let folder = json!({"name":"Lemlio Backups","mimeType":"application/vnd.google-apps.folder","ownedByMe":true});
        assert!(validate_backup_root(&folder).is_ok());
        for field in ["name", "mimeType", "ownedByMe"] {
            let mut other = folder.clone();
            other[field] = Value::Null;
            assert!(validate_backup_root(&other).is_err());
        }
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

async fn existing_backup_root(
    client: &reqwest::Client,
    token: &mut Tokens,
) -> Result<Option<String>, String> {
    if let Some(id) = token.folder_id.clone() {
        let response = client
            .get(format!("https://www.googleapis.com/drive/v3/files/{id}"))
            .bearer_auth(&token.access_token)
            .query(&[("fields", "id,trashed")])
            .send()
            .await
            .map_err(|_| "Cannot reach Drive")?;
        if response.status().is_success() && google_json(response).await?["trashed"] != true {
            return Ok(Some(id));
        }
    }
    let root = drive_children(client, &token.access_token, "root")
        .await?
        .into_iter()
        .find(|f| {
            f["name"] == "Lemlio Backups" && f["mimeType"] == "application/vnd.google-apps.folder"
        })
        .and_then(|f| f["id"].as_str().map(str::to_string));
    token.folder_id = root.clone();
    save_tokens(token)?;
    Ok(root)
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
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let Some(root) = existing_backup_root(&client, &mut token).await? else {
        return Ok(json!({"projects":[]}));
    };
    let files = drive_children(&client, &token.access_token, &root).await?;
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
        projects.push(json!({"id":file["id"],"name":display_archive_name(&file),"size":file["size"],"modifiedTime":file["modifiedTime"],"localPath":local,"deviceName":file["appProperties"]["lemlioDeviceName"],"branches":crate::drive_sync::heads(&files,key).len()}));
    }
    Ok(json!({"projects":projects}))
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
        .ok_or("This project has no linked Drive backup")?;
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
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let root = existing_backup_root(&client, &mut token)
        .await?
        .ok_or("No backup folder was found in this account")?;
    let metadata = google_json(
        client
            .get(format!(
                "https://www.googleapis.com/drive/v3/files/{archive_id}"
            ))
            .bearer_auth(&token.access_token)
            .query(&[(
                "fields",
                "id,name,mimeType,parents,trashed,sha256Checksum,size,appProperties",
            )])
            .send()
            .await
            .map_err(|_| "Cannot inspect the Drive backup")?,
    )
    .await?;
    if !managed_archive(&metadata, &root) {
        return Err("Choose a ZIP from this account's Lemlio backup folder".into());
    }
    let project_key = metadata["appProperties"]["lemlioProject"]
        .as_str()
        .ok_or("Missing project identity")?
        .to_string();
    if let Some((path, expected)) = &binding {
        let receipt =
            crate::drive_receipts::load(path)?.ok_or("Backup link changed; refresh and retry")?;
        if receipt.project_key != project_key {
            return Err("Backup link changed; refresh and retry".into());
        }
        if metadata["sha256Checksum"].as_str() != Some(expected.as_str()) {
            return Err(
                "The Drive version changed again. Refresh the conflict before downloading.".into(),
            );
        }
    } else if crate::drive_receipts::linked_project(&project_key)?.is_some() {
        return Err("This Drive project is already linked to a local folder. Open that local project instead.".into());
    }
    let expected_hash = metadata["sha256Checksum"]
        .as_str()
        .ok_or("Drive has not confirmed the backup checksum yet")?
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
    let mut response = client
        .get(format!(
            "https://www.googleapis.com/drive/v3/files/{archive_id}"
        ))
        .bearer_auth(&token.access_token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|_| "Cannot download the backup ZIP")?;
    if !response.status().is_success() {
        google_json(response).await?;
        return Err("Cannot download the backup ZIP".into());
    }
    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Backup download was interrupted; local projects were kept")?
    {
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or("Backup ZIP is too large")?;
        if total > 2 * 1024 * 1024 * 1024 {
            return Err("Backup ZIP exceeds the 2 GB download limit".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    if format!("{:x}", hash.finalize()) != expected_hash {
        return Err("The Drive ZIP changed or its download is incomplete. Refresh backups and try again; local files were kept.".into());
    }
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
            return Err("Revision manifest does not match the Drive backup".into());
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
            "Drive revision metadata does not match its source files; local files were kept".into(),
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
        rows.push(json!({"path":path,"status":if saved{"saved"}else{"pending"},"lastBackup":receipt.as_ref().map(|r|r.last_backup),"sourceRevision":receipt.as_ref().map(|r|&r.source_revision),"receipt":receipt}));
    }
    if rows.is_empty() {
        return Ok(json!({"allBackedUp":true,"projects":[],"connected":tokens()?.is_some()}));
    }
    let verified = async {
        let mut token = authorized_tokens().await?;
        let client = http_client()?;
        let Some(root) = existing_backup_root(&client, &mut token).await? else {
            return Err("No Drive backup folder is available".to_string());
        };
        let remote = drive_children(&client, &token.access_token, &root).await?;
        for row in &mut rows {
            let receipt = row["receipt"].clone();
            let Some(key) = receipt["projectKey"].as_str() else {
                continue;
            };
            let heads = crate::drive_sync::heads(&remote, key);
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
    let all = verified.is_ok() && rows.iter().all(|r| r["status"] == "saved");
    Ok(
        json!({"allBackedUp":all,"projects":rows,"connected":verified.is_ok(),"error":verified.err()}),
    )
}

#[cfg(test)]
mod restore_live_test {
    use super::*;
    #[test]
    #[ignore = "Needs connected Drive; only generated disposable projects are uploaded"]
    fn live_two_device_sync_renames_conflicts_and_recovery() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let title = format!("Lemlio-Sync-QA-{}",uuid::Uuid::new_v4());
            let a = temporary.path().join("device-a").join(&title);
            let b = temporary.path().join("device-b").join(&title);
            for path in [&a,&b] {
                std::fs::create_dir_all(path.join("figs")).unwrap();
                std::fs::write(path.join("main.tex"),"Original fictional paper").unwrap();
                std::fs::write(path.join("figs/binary.dat"),[0,1,2,255]).unwrap();
            }
            let a_path = a.to_string_lossy().to_string(); let b_path=b.to_string_lossy().to_string();
            let state=DriveState::default();
            backup_project(&state,a_path.clone()).await.unwrap();
            let base=crate::drive_receipts::load(&a_path).unwrap().unwrap();
            // Two independent local receipts emulate two installations using one account.
            crate::drive_receipts::save(&b_path,base.clone()).unwrap();
            let outcome=async {
                let no_change=backup_project(&state,b_path.clone()).await?;
                if no_change["uploadedFiles"] != 0 {return Err("Unchanged second device uploaded unnecessarily".into());}
                std::fs::write(a.join("main.tex"),"Edited on device A").map_err(|e|e.to_string())?;
                backup_project(&state,a_path.clone()).await?;
                let next=crate::drive_receipts::load(&a_path)?.unwrap();
                if next.archive_id==base.archive_id {return Err("New revision overwrote the base archive".into());}
                let summary=backup_summary(&state,vec![b_path.clone()]).await?;
                if summary["projects"][0]["status"]!="incoming" {return Err(format!("Expected incoming update: {summary}"));}
                let synced=sync_project(&state,b_path.clone(),next.archive_hash.clone()).await?;
                if std::fs::read_to_string(b.join("main.tex")).map_err(|e|e.to_string())?!="Edited on device A" {return Err("Incoming source was not installed".into());}
                let recovery=Path::new(synced["recoveryPath"].as_str().ok_or("Missing recovery path")?);
                if std::fs::read_to_string(recovery.join("main.tex")).map_err(|e|e.to_string())?!="Original fictional paper" {return Err("Recovery source was lost".into());}
                if std::fs::read(b.join("figs/binary.dat")).map_err(|e|e.to_string())?!=[0,1,2,255] {return Err("Binary changed in sync".into());}
                let renamed=format!("{title} renamed");
                crate::projects::rename_project(a_path.clone(),renamed.clone())?;
                backup_project_with_choice(&state,a_path.clone(),None,true).await?;
                let rename=crate::drive_receipts::load(&a_path)?.unwrap();
                sync_project(&state,b_path.clone(),rename.archive_hash.clone()).await?;
                if project_title(&b)!=renamed {return Err("Project rename did not sync".into());}
                let unchanged=backup_project(&state,b_path.clone()).await?;
                if unchanged["uploadedFiles"]!=0 {return Err("Synced project uploaded again".into());}
                std::fs::write(a.join("main.tex"),"Independent PC edit").map_err(|e|e.to_string())?;
                std::fs::write(b.join("main.tex"),"Independent Mac edit").map_err(|e|e.to_string())?;
                backup_project(&state,b_path.clone()).await?;
                let remote=crate::drive_receipts::load(&b_path)?.unwrap();
                let conflict=backup_summary(&state,vec![a_path.clone()]).await?;
                if conflict["projects"][0]["status"]!="conflict" {return Err("Simultaneous local/remote edits were not flagged".into());}
                if sync_project(&state,a_path.clone(),remote.archive_hash.clone()).await.is_ok() {return Err("Changed local source was overwritten".into());}
                if std::fs::read_to_string(a.join("main.tex")).map_err(|e|e.to_string())?!="Independent PC edit" {return Err("Local edits were lost".into());}
                backup_project_with_choice(&state,a_path.clone(),Some(&remote.archive_hash),false).await?;
                let resolved=backup_summary(&state,vec![a_path.clone()]).await?;
                if resolved["projects"][0]["status"]!="saved" {return Err("Explicit version resolution did not settle".into());}
                Ok::<_,String>(())
            }.await;
            // Cleanup only exact generated project IDs; never reset or touch other backups.
            let token=authorized_tokens().await.unwrap(); let client=http_client().unwrap();
            let root=token.folder_id.as_deref().unwrap();
            for file in drive_children(&client,&token.access_token,root).await.unwrap() {
                if file["appProperties"]["lemlioProject"]==base.project_key && file["name"].as_str().is_some_and(|n|n.starts_with(&title)) {
                    let id=file["id"].as_str().unwrap();
                    let result=google_json(client.patch(format!("https://www.googleapis.com/drive/v3/files/{id}")).bearer_auth(&token.access_token).query(&[("fields","id,trashed")]).json(&json!({"trashed":true})).send().await.unwrap()).await.unwrap();
                    assert_eq!(result["trashed"],true);
                }
            }
            outcome.unwrap();
            println!("Verified live two-device fast-forward, binary integrity, rename propagation, deduplication, genuine conflict protection and explicit resolution. Only disposable snapshots moved to Trash.");
        });
    }
}
