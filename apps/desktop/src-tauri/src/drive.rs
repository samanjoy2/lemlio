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

pub async fn backup_project(state: &DriveState, project_path: String) -> Result<Value, String> {
    let _upload = state.upload.lock().await;
    let mut token = authorized_tokens().await?;
    let client = http_client()?;
    let temporary = tokio::task::spawn_blocking(move || {
        let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
        let zip = directory.path().join("project.zip");
        crate::projects::export_to(Path::new(&project_path), &zip)?;
        let name = Path::new(&project_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        Ok::<_, String>((directory, zip, name))
    })
    .await
    .map_err(|_| "Cannot prepare the project backup")??;
    if token.folder_id.is_none() {
        let response=client.get("https://www.googleapis.com/drive/v3/files").bearer_auth(&token.access_token).query(&[("q","trashed=false and mimeType='application/vnd.google-apps.folder' and name='Lemlio Backups'"),("fields","files(id)")]).send().await.map_err(|_|"Cannot reach Google Drive")?;
        let folders = google_json(response).await?;
        let id = if let Some(id) = folders["files"][0]["id"].as_str() {
            id.to_string()
        } else {
            let response=client.post("https://www.googleapis.com/drive/v3/files").bearer_auth(&token.access_token).header("Content-Type","application/json").body(json!({"name":"Lemlio Backups","mimeType":"application/vnd.google-apps.folder"}).to_string()).send().await.map_err(|_|"Cannot create the Drive backup folder")?;
            google_json(response).await?["id"]
                .as_str()
                .ok_or("Missing backup folder ID")?
                .to_string()
        };
        token.folder_id = Some(id);
        save_tokens(&token)?;
    }
    let filename = format!(
        "{}-{}.zip",
        temporary.2,
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let size = std::fs::metadata(&temporary.1)
        .map_err(|_| "Cannot read backup ZIP")?
        .len();
    let response = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(&token.access_token)
        .header("Content-Type", "application/json")
        .header("X-Upload-Content-Type", "application/zip")
        .header("X-Upload-Content-Length", size.to_string())
        .body(
            json!({"name":filename,"parents":[token.folder_id.clone().ok_or("No backup folder")?]})
                .to_string(),
        )
        .send()
        .await
        .map_err(|_| "Cannot start the Drive upload")?;
    if !response.status().is_success() {
        return Err(format!(
            "Google Drive could not start the backup (HTTP {})",
            response.status().as_u16()
        ));
    }
    let location = response
        .headers()
        .get("location")
        .and_then(|header| header.to_str().ok())
        .ok_or("Google did not provide an upload session")?
        .to_string();
    let upload_url = reqwest::Url::parse(&location).map_err(|_| "Invalid Google upload URL")?;
    if upload_url.scheme() != "https" || upload_url.host_str() != Some("www.googleapis.com") {
        return Err("Unexpected Google upload endpoint".into());
    }
    let mut file = tokio::fs::File::open(&temporary.1)
        .await
        .map_err(|_| "Cannot open the backup ZIP")?;
    let mut offset = 0u64;
    let mut uploaded = Value::Null;
    while offset < size {
        let length = (size - offset).min(8 * 1024 * 1024) as usize;
        let mut chunk = vec![0; length];
        file.read_exact(&mut chunk)
            .await
            .map_err(|_| "Cannot read backup data")?;
        let mut response = None;
        for attempt in 0..3 {
            match client
                .put(upload_url.clone())
                .bearer_auth(&token.access_token)
                .header("Content-Type", "application/zip")
                .header(
                    "Content-Range",
                    format!("bytes {}-{}/{}", offset, offset + length as u64 - 1, size),
                )
                .body(chunk.clone())
                .send()
                .await
            {
                Ok(result)
                    if result.status().as_u16() != 429 && !result.status().is_server_error() =>
                {
                    response = Some(result);
                    break;
                }
                _ if attempt < 2 => tokio::time::sleep(Duration::from_secs(1 << attempt)).await,
                _ => {
                    return Err(
                        "Drive upload was interrupted. Retry the backup when connected.".into(),
                    )
                }
            }
        }
        let response = response.ok_or("Drive upload failed")?;
        if response.status().as_u16() != 308 {
            uploaded = google_json(response).await?;
        }
        offset += length as u64;
    }
    if uploaded["id"].as_str().is_none() {
        return Err("Google did not confirm the completed backup".into());
    }
    token.last_backup = Some(now());
    save_tokens(&token)?;
    Ok(
        json!({"name":filename,"bytes":size,"lastBackup":token.last_backup,"folderUrl":format!("https://drive.google.com/drive/folders/{}",token.folder_id.unwrap_or_default())}),
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
