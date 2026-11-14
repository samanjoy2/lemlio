//! Dropbox transport for project backups ("App folder" access).
//!
//! Sign-in is OAuth with PKCE and no client secret. Only the long-lived refresh
//! token (plus a cached access token) is kept, in the operating system credential
//! store. Backups use the same model as the folder store: immutable
//! `<uuid>.zip` revisions plus a `<uuid>.json` sidecar that carries the name and
//! sync properties. The ZIP is uploaded first and the sidecar second, so a
//! revision exists only once both are present and the sizes agree.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::backup_store::{entry, sha256_file, valid_id};

/// Prefix of the error returned when the user has to sign in to Dropbox again.
pub const RECONNECT: &str = "DROPBOX_RECONNECT:";
/// Set when Dropbox rejected or revoked the saved connection.
pub static NEEDS_RECONNECT: AtomicBool = AtomicBool::new(false);
/// Least privilege: the app folder only, plus the account name for the settings screen.
pub const SCOPES: &str =
    "account_info.read files.metadata.read files.metadata.write files.content.read files.content.write";
/// Loopback ports tried in order. Each must be registered as a redirect URI.
pub const LOOPBACK_PORTS: [u16; 4] = [53682, 53683, 53684, 53685];
/// Everything lives in one folder inside the app folder, so a reset can move it aside.
const FOLDER: &str = "/Lemlio Backups";
const ARG: &str = "Dropbox-API-Arg";

pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}
/// Every redirect URI the sign-in may use. The setup guide shows exactly these.
pub fn redirect_uris() -> Vec<String> {
    LOOPBACK_PORTS
        .iter()
        .map(|port| redirect_uri(*port))
        .collect()
}
/// The permissions the Dropbox app must have, as the setup guide lists them.
pub fn permissions() -> Vec<&'static str> {
    SCOPES.split(' ').collect()
}
/// An app key is a short letters-and-digits identifier. Anything with spaces,
/// punctuation or a long string is a secret or token pasted by mistake.
pub fn valid_app_key(key: &str) -> bool {
    (10..=24).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// A plain-language fix for a failed sign-in, chosen from what Dropbox answered.
/// Only keywords are matched, so an unfamiliar answer falls back to a general hint.
pub fn explain_sign_in_error(body: &Value, redirect: Option<&str>) -> String {
    let code = body["error"].as_str().unwrap_or("");
    let text = body["error_description"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| text.contains(w) || code.contains(w));
    if code == "access_denied" {
        "Dropbox sign-in was cancelled.".into()
    } else if has(&["redirect"]) {
        format!(
            "Dropbox does not recognize this sign-in address. In the Dropbox App Console open Settings > Redirect URIs and add exactly this URI: {}",
            redirect.unwrap_or("http://127.0.0.1:53682")
        )
    } else if has(&["invalid_client", "client_id", "app key"]) {
        "Dropbox does not recognize this app key. Copy the App key (not the App secret) from the Settings tab of your Dropbox app.".into()
    } else if has(&["secret", "public client", "pkce", "code_verifier"]) {
        "Turn on Allow public clients in the Settings tab of your Dropbox app, then connect again."
            .into()
    } else if has(&["scope", "permission"]) {
        missing_scope_message(None)
    } else if has(&["limit", "development"]) {
        "Your Dropbox app has reached the 500-user limit for apps in Development status. Apply for production approval in the Dropbox App Console.".into()
    } else {
        "Dropbox rejected the sign-in. Connect again and use the newest page or code.".into()
    }
}
pub fn missing_scope_message(scope: Option<&str>) -> String {
    format!(
        "Your Dropbox app is missing a permission{}. On its Permissions tab tick {}, press Submit, then connect again.",
        scope.map(|s| format!(" ({s})")).unwrap_or_default(),
        SCOPES.replace(' ', ", ")
    )
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn reconnect(message: &str) -> String {
    NEEDS_RECONNECT.store(true, Ordering::SeqCst);
    format!("{RECONNECT} {message}")
}

// ---- Tokens ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Tokens {
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at: u64,
    pub app_key: String,
    pub account_id: String,
}

pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<Tokens>, String>;
    fn save(&self, tokens: &Tokens) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// Tokens in memory only (tests).
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(StdMutex<Option<Tokens>>);
#[cfg(test)]
impl TokenStore for MemoryStore {
    fn load(&self) -> Result<Option<Tokens>, String> {
        Ok(self.0.lock().map_err(|e| e.to_string())?.clone())
    }
    fn save(&self, tokens: &Tokens) -> Result<(), String> {
        *self.0.lock().map_err(|e| e.to_string())? = Some(tokens.clone());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.0.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}

/// Windows Credential Manager or the macOS Keychain.
pub struct KeyringStore;
#[cfg(any(target_os = "windows", target_os = "macos"))]
impl KeyringStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("Lemlio.Dropbox", "oauth-tokens")
            .map_err(|_| "Cannot access the system credential store".to_string())
    }
}
#[cfg(any(target_os = "windows", target_os = "macos"))]
impl TokenStore for KeyringStore {
    fn load(&self) -> Result<Option<Tokens>, String> {
        match Self::entry()?.get_password() {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|_| "Stored Dropbox connection is invalid; reconnect".to_string()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => {
                Err("Cannot read the Dropbox connection from the system credential store".into())
            }
        }
    }
    fn save(&self, tokens: &Tokens) -> Result<(), String> {
        Self::entry()?
            .set_password(
                &serde_json::to_string(tokens)
                    .map_err(|_| "Cannot encode the Dropbox connection")?,
            )
            .map_err(|_| {
                "Cannot save the Dropbox connection in the system credential store".to_string()
            })
    }
    fn clear(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Cannot remove the stored Dropbox connection".into()),
        }
    }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl TokenStore for KeyringStore {
    fn load(&self) -> Result<Option<Tokens>, String> {
        Ok(None)
    }
    fn save(&self, _: &Tokens) -> Result<(), String> {
        Err(
            "Dropbox sign-in is supported on Windows and macOS. Use a synced folder instead."
                .into(),
        )
    }
    fn clear(&self) -> Result<(), String> {
        Ok(())
    }
}

// ---- Sign-in -----------------------------------------------------------------

pub fn new_verifier() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
/// The page the user approves on dropbox.com. Without `redirect` Dropbox shows
/// the authorization code on screen for the user to paste into Lemlio.
pub fn authorization_url(
    app_key: &str,
    redirect: Option<&str>,
    challenge: &str,
    state: &str,
) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse("https://www.dropbox.com/oauth2/authorize")
        .map_err(|_| "Invalid Dropbox endpoint")?;
    {
        let mut query = url.query_pairs_mut();
        query.extend_pairs([
            ("client_id", app_key),
            ("response_type", "code"),
            ("token_access_type", "offline"),
            ("scope", SCOPES),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ]);
        if let Some(redirect) = redirect {
            query.append_pair("redirect_uri", redirect);
        }
    }
    Ok(url)
}
/// Query parameters of the loopback request, only if `state` matches exactly once.
pub fn callback_parameters(target: &str, state: &str) -> Option<HashMap<String, String>> {
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
    let parameters: HashMap<_, _> = pairs.into_iter().collect();
    if parameters.get("state").map(String::as_str) != Some(state) {
        return None;
    }
    Some(parameters)
}

// ---- Client ------------------------------------------------------------------

#[derive(Clone)]
pub struct Endpoints {
    pub api: String,
    pub content: String,
    pub token: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            api: "https://api.dropboxapi.com".into(),
            content: "https://content.dropboxapi.com".into(),
            token: "https://api.dropboxapi.com/oauth2/token".into(),
        }
    }
}
#[derive(Clone, Copy)]
pub struct Tuning {
    /// Files up to this size use a single `/files/upload` call (Dropbox allows 150 MB).
    pub single_upload_limit: u64,
    pub chunk: usize,
    pub max_retry_wait: Duration,
    pub backoff: Duration,
}
impl Default for Tuning {
    fn default() -> Self {
        Self {
            single_upload_limit: 100 * 1024 * 1024,
            chunk: 8 * 1024 * 1024,
            max_retry_wait: Duration::from_secs(60),
            backoff: Duration::from_millis(500),
        }
    }
}

fn sidecars() -> &'static StdMutex<HashMap<String, Value>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, Value>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[derive(Clone)]
pub struct Dropbox {
    http: reqwest::Client,
    endpoints: Endpoints,
    store: Arc<dyn TokenStore>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    folder_ready: Arc<AtomicBool>,
    tuning: Tuning,
}

fn short(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the request timed out".into()
    } else if error.is_connect() {
        "no connection".into()
    } else {
        "network error".into()
    }
}

impl Dropbox {
    pub fn new(store: Arc<dyn TokenStore>) -> Self {
        Self::with(store, Endpoints::default(), Tuning::default())
    }
    pub fn with(store: Arc<dyn TokenStore>, endpoints: Endpoints, tuning: Tuning) -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(300))
                .build()
                .unwrap_or_default(),
            endpoints,
            store,
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            folder_ready: Arc::new(AtomicBool::new(false)),
            tuning,
        }
    }

    /// A valid access token. `stale` is a token that just failed: it is replaced
    /// unless another task already did so.
    async fn access_token(&self, stale: Option<&str>) -> Result<String, String> {
        let _guard = self.refresh_lock.lock().await;
        let mut tokens = self
            .store
            .load()?
            .ok_or_else(|| reconnect("Connect Dropbox first"))?;
        let usable = !tokens.access_token.is_empty() && tokens.expires_at > now() + 60;
        match stale {
            None if usable => return Ok(tokens.access_token),
            Some(old) if tokens.access_token != old => return Ok(tokens.access_token),
            _ => {}
        }
        let response = self
            .http
            .post(&self.endpoints.token)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", tokens.refresh_token.as_str()),
                ("client_id", tokens.app_key.as_str()),
            ])
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Cannot reach Dropbox ({}). Check your connection.",
                    short(&e)
                )
            })?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            if status.as_u16() == 400 || status.as_u16() == 401 {
                return Err(reconnect(
                    "Dropbox no longer accepts this connection. Connect Dropbox again.",
                ));
            }
            return Err(format!(
                "Dropbox could not renew access (HTTP {})",
                status.as_u16()
            ));
        }
        tokens.access_token = body["access_token"]
            .as_str()
            .ok_or("Dropbox did not renew access; reconnect")?
            .to_string();
        tokens.expires_at = now() + body["expires_in"].as_u64().unwrap_or(14400);
        self.store.save(&tokens)?;
        NEEDS_RECONNECT.store(false, Ordering::SeqCst);
        Ok(tokens.access_token)
    }

    /// Send a request with a fresh token, retrying rate limits, server errors,
    /// dropped connections and one expired token. `build` runs once per attempt.
    async fn send<F>(&self, build: F) -> Result<reqwest::Response, String>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let mut token = self.access_token(None).await?;
        let mut renewed = false;
        let mut attempt = 0u32;
        loop {
            match build(&self.http, &token).send().await {
                Err(error) => {
                    attempt += 1;
                    if attempt > 3 {
                        return Err(format!(
                            "Cannot reach Dropbox ({}); backup will retry",
                            short(&error)
                        ));
                    }
                    tokio::time::sleep(self.tuning.backoff * 2u32.pow(attempt - 1)).await;
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    if status == 401 {
                        let body = response.text().await.unwrap_or_default();
                        if body.contains("missing_scope") {
                            let scope = serde_json::from_str::<Value>(&body).ok().and_then(|v| {
                                v["error"]["required_scope"].as_str().map(str::to_string)
                            });
                            return Err(missing_scope_message(scope.as_deref()));
                        }
                        if renewed {
                            return Err(reconnect(
                                "Dropbox no longer accepts this connection. Connect Dropbox again.",
                            ));
                        }
                        renewed = true;
                        token = self.access_token(Some(&token)).await?;
                    } else if status == 429 {
                        attempt += 1;
                        if attempt > 6 {
                            return Err("Dropbox is limiting requests; backup will retry".into());
                        }
                        let wait = response
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.parse::<u64>().ok())
                            .map(Duration::from_secs)
                            .unwrap_or(self.tuning.backoff * 2)
                            .min(self.tuning.max_retry_wait);
                        tokio::time::sleep(wait).await;
                    } else if status >= 500 && attempt < 3 {
                        attempt += 1;
                        tokio::time::sleep(self.tuning.backoff * 2u32.pow(attempt - 1)).await;
                    } else {
                        return Ok(response);
                    }
                }
            }
        }
    }

    async fn failure(response: reqwest::Response) -> String {
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let summary: String = body["error_summary"]
            .as_str()
            .unwrap_or("request rejected")
            .chars()
            .take(200)
            .collect();
        format!("Dropbox returned HTTP {status}: {summary}")
    }

    async fn rpc(&self, route: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}/2/{route}", self.endpoints.api);
        let response = self
            .send(|http, token| http.post(&url).bearer_auth(token).json(body))
            .await?;
        if !response.status().is_success() {
            return Err(Self::failure(response).await);
        }
        Ok(response.json().await.unwrap_or(Value::Null))
    }

    async fn content(
        &self,
        route: &str,
        arg: &Value,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, String> {
        let url = format!("{}/2/{route}", self.endpoints.content);
        let arg = arg.to_string();
        self.send(|http, token| {
            let request = http
                .post(&url)
                .bearer_auth(token)
                .header(ARG, &arg)
                .header("Content-Type", "application/octet-stream");
            match &body {
                Some(bytes) => request.body(bytes.clone()),
                None => request,
            }
        })
        .await
    }

    pub async fn account(&self) -> Result<Value, String> {
        let url = format!("{}/2/users/get_current_account", self.endpoints.api);
        let response = self
            .send(|http, token| http.post(&url).bearer_auth(token))
            .await?;
        if !response.status().is_success() {
            return Err(Self::failure(response).await);
        }
        let account: Value = response.json().await.unwrap_or(Value::Null);
        Ok(json!({
            "id": account["account_id"],
            "name": account["name"]["display_name"],
            "email": account["email"],
        }))
    }

    /// Sign out at Dropbox (best effort) and forget the tokens. Backups stay in Dropbox.
    pub async fn disconnect(&self) -> Result<(), String> {
        let url = format!("{}/2/auth/token/revoke", self.endpoints.api);
        if let Ok(response) = self
            .send(|http, token| http.post(&url).bearer_auth(token))
            .await
        {
            drop(response);
        }
        NEEDS_RECONNECT.store(false, Ordering::SeqCst);
        self.store.clear()
    }

    /// Exchange the authorization code for tokens and keep them.
    pub async fn exchange_code(
        &self,
        app_key: &str,
        code: &str,
        verifier: &str,
        redirect: Option<&str>,
    ) -> Result<Tokens, String> {
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("client_id", app_key),
        ];
        if let Some(redirect) = redirect {
            form.push(("redirect_uri", redirect));
        }
        let response = self
            .http
            .post(&self.endpoints.token)
            .form(&form)
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Cannot reach Dropbox ({}). Check your connection.",
                    short(&e)
                )
            })?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(explain_sign_in_error(&body, redirect));
        }
        let tokens = Tokens {
            access_token: body["access_token"]
                .as_str()
                .ok_or("Dropbox did not return an access token")?
                .to_string(),
            refresh_token: body["refresh_token"]
                .as_str()
                .ok_or("Dropbox did not grant lasting access; try Connect again")?
                .to_string(),
            expires_at: now() + body["expires_in"].as_u64().unwrap_or(14400),
            app_key: app_key.to_string(),
            account_id: body["account_id"].as_str().unwrap_or_default().to_string(),
        };
        self.store.save(&tokens)?;
        NEEDS_RECONNECT.store(false, Ordering::SeqCst);
        Ok(tokens)
    }

    // ---- Backup storage --------------------------------------------------

    async fn ensure_folder(&self) -> Result<(), String> {
        if self.folder_ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        match self
            .rpc(
                "files/create_folder_v2",
                &json!({"path": FOLDER, "autorename": false}),
            )
            .await
        {
            Ok(_) => {}
            Err(error) if error.contains("conflict") => {}
            Err(error) => return Err(error),
        }
        self.folder_ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Names and sizes of the files in the backup folder.
    async fn files(&self) -> Result<Vec<(String, u64)>, String> {
        let mut page = match self
            .rpc(
                "files/list_folder",
                &json!({"path": FOLDER, "recursive": false, "limit": 2000}),
            )
            .await
        {
            Ok(page) => page,
            Err(error) if error.contains("not_found") => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut files = Vec::new();
        loop {
            for item in page["entries"].as_array().into_iter().flatten() {
                if item[".tag"] == "file" {
                    if let Some(name) = item["name"].as_str() {
                        files.push((name.to_string(), item["size"].as_u64().unwrap_or(0)));
                    }
                }
            }
            if page["has_more"] != true {
                return Ok(files);
            }
            page = self
                .rpc(
                    "files/list_folder/continue",
                    &json!({"cursor": page["cursor"]}),
                )
                .await?;
        }
    }

    /// Sidecars never change once written, so each is downloaded once.
    async fn sidecar(&self, id: &str) -> Result<Option<Value>, String> {
        if let Some(cached) = sidecars().lock().ok().and_then(|c| c.get(id).cloned()) {
            return Ok(Some(cached));
        }
        let response = self
            .content(
                "files/download",
                &json!({"path": format!("{FOLDER}/{id}.json")}),
                None,
            )
            .await?;
        if response.status().as_u16() == 409 {
            let error = Self::failure(response).await;
            return if error.contains("not_found") {
                Ok(None)
            } else {
                Err(error)
            };
        }
        if !response.status().is_success() {
            return Err(Self::failure(response).await);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Dropbox download was interrupted")?;
        let Ok(meta) = serde_json::from_slice::<Value>(&bytes) else {
            return Ok(None);
        };
        if let Ok(mut cache) = sidecars().lock() {
            if cache.len() > 4096 {
                cache.clear();
            }
            cache.insert(id.to_string(), meta.clone());
        }
        Ok(Some(meta))
    }

    /// Complete revisions, newest first. `root` is the id receipts remember.
    pub async fn list(&self, root: &str) -> Result<Vec<Value>, String> {
        let sizes: HashMap<String, u64> = self.files().await?.into_iter().collect();
        let ids: Vec<String> = sizes
            .keys()
            .filter_map(|name| name.strip_suffix(".json"))
            .filter(|id| valid_id(id) && sizes.contains_key(&format!("{id}.zip")))
            .map(str::to_string)
            .collect();
        let permits = Arc::new(tokio::sync::Semaphore::new(6));
        let mut tasks = tokio::task::JoinSet::new();
        for id in ids {
            let (client, permits) = (self.clone(), permits.clone());
            tasks.spawn(async move {
                let _permit = permits.acquire_owned().await;
                let meta = client.sidecar(&id).await;
                (id, meta)
            });
        }
        let mut found: Vec<(u64, Value)> = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            let (id, meta) = joined.map_err(|_| "Cannot read the Dropbox backups")?;
            let Some(meta) = meta? else {
                continue;
            };
            let (Some(size), Some(name), Some(hash)) = (
                meta["size"].as_u64(),
                meta["name"].as_str(),
                meta["sha256"].as_str(),
            ) else {
                continue;
            };
            if meta["schema"] != 1 || sizes.get(&format!("{id}.zip")) != Some(&size) {
                continue;
            }
            let saved = meta["savedAt"].as_u64().unwrap_or(0);
            found.push((
                saved,
                entry(root, &id, name, size, hash, &meta["appProperties"], saved),
            ));
        }
        found.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1["id"].as_str().cmp(&a.1["id"].as_str()))
        });
        Ok(found.into_iter().map(|(_, value)| value).collect())
    }

    async fn upload_bytes(&self, path: &str, bytes: Vec<u8>) -> Result<(), String> {
        let length = bytes.len() as u64;
        let arg = json!({"path": path, "mode": "add", "autorename": false, "mute": true});
        let response = self.content("files/upload", &arg, Some(bytes)).await?;
        if !response.status().is_success() {
            return Err(Self::failure(response).await);
        }
        let stored: Value = response.json().await.unwrap_or(Value::Null);
        if stored["size"].as_u64() != Some(length) {
            return Err("Dropbox did not confirm the complete file; backup will retry".into());
        }
        Ok(())
    }

    /// Chunked upload for big ZIPs. A wrong-offset reply after a dropped
    /// connection tells us where Dropbox really is, and the upload resumes there.
    async fn upload_session(&self, path: &str, source: &Path, size: u64) -> Result<(), String> {
        let mut file = tokio::fs::File::open(source)
            .await
            .map_err(|_| "Cannot open the backup file")?;
        let chunk = self.tuning.chunk as u64;
        let mut offset = 0u64;
        let mut session: Option<String> = None;
        let mut corrections = 0;
        loop {
            let take = (size - offset).min(chunk);
            let last = offset + take >= size;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|_| "Cannot read the backup file")?;
            let mut buffer = vec![0u8; take as usize];
            file.read_exact(&mut buffer)
                .await
                .map_err(|_| "Cannot read the backup data")?;
            let commit = json!({"path": path, "mode": "add", "autorename": false, "mute": true});
            let (route, arg) = match (&session, last) {
                (None, true) => return self.upload_bytes(path, buffer).await,
                (None, false) => ("files/upload_session/start", json!({"close": false})),
                (Some(id), false) => (
                    "files/upload_session/append_v2",
                    json!({"cursor": {"session_id": id, "offset": offset}, "close": false}),
                ),
                (Some(id), true) => (
                    "files/upload_session/finish",
                    json!({"cursor": {"session_id": id, "offset": offset}, "commit": commit}),
                ),
            };
            let response = self.content(route, &arg, Some(buffer)).await?;
            let status = response.status().as_u16();
            if status == 409 {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                let wrong = &body["error"]["lookup_failed"];
                if wrong[".tag"] == "incorrect_offset" && corrections < 5 {
                    offset = wrong["correct_offset"].as_u64().unwrap_or(offset).min(size);
                    corrections += 1;
                    continue;
                }
                return Err(format!(
                    "Dropbox returned HTTP 409: {}",
                    body["error_summary"].as_str().unwrap_or("upload rejected")
                ));
            }
            if !response.status().is_success() {
                return Err(Self::failure(response).await);
            }
            if session.is_none() {
                let body: Value = response.json().await.unwrap_or(Value::Null);
                session = Some(
                    body["session_id"]
                        .as_str()
                        .ok_or("Dropbox did not start the upload")?
                        .to_string(),
                );
            } else if last {
                let stored: Value = response.json().await.unwrap_or(Value::Null);
                if stored["size"].as_u64() != Some(size) {
                    return Err(
                        "Dropbox did not confirm the complete file; backup will retry".into(),
                    );
                }
                return Ok(());
            }
            offset += take;
        }
    }

    /// Store a new immutable revision: the ZIP first, then its sidecar.
    pub async fn put(
        &self,
        root: &str,
        name: &str,
        source: &Path,
        project_key: &str,
        properties: &Value,
    ) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let measured = source.to_path_buf();
        let (hash, size) = tokio::task::spawn_blocking(move || {
            let hash = sha256_file(&measured)?;
            let size = std::fs::metadata(&measured)
                .map_err(|e| e.to_string())?
                .len();
            Ok::<_, String>((hash, size))
        })
        .await
        .map_err(|_| "Cannot read the backup file")??;
        self.ensure_folder().await?;
        let zip = format!("{FOLDER}/{id}.zip");
        let outcome = async {
            if size <= self.tuning.single_upload_limit {
                let path = source.to_path_buf();
                let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
                    .await
                    .map_err(|_| "Cannot read the backup file")?
                    .map_err(|e| e.to_string())?;
                self.upload_bytes(&zip, bytes).await?;
            } else {
                self.upload_session(&zip, source, size).await?;
            }
            let mut merged = json!({
                "lemlioProject": project_key,
                "lemlioFormat": "zip-v2",
                "lemlioArchiveHash": hash,
            });
            if let Some(extra) = properties.as_object() {
                for (key, value) in extra {
                    merged[key] = value.clone();
                }
            }
            let saved = now();
            let meta = json!({
                "schema": 1, "name": name, "size": size, "savedAt": saved,
                "sha256": hash, "appProperties": merged,
            });
            let bytes = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
            self.upload_bytes(&format!("{FOLDER}/{id}.json"), bytes)
                .await?;
            Ok::<_, String>(entry(root, &id, name, size, &hash, &merged, saved))
        }
        .await;
        if outcome.is_err() {
            let _ = self.rpc("files/delete_v2", &json!({"path": zip})).await;
        }
        outcome
    }

    async fn download(&self, id: &str) -> Result<reqwest::Response, String> {
        if !valid_id(id) {
            return Err("Invalid backup revision".into());
        }
        let response = self
            .content(
                "files/download",
                &json!({"path": format!("{FOLDER}/{id}.zip")}),
                None,
            )
            .await?;
        if !response.status().is_success() {
            let error = Self::failure(response).await;
            return Err(if error.contains("not_found") {
                "That backup revision is not in Dropbox yet".to_string()
            } else {
                error
            });
        }
        Ok(response)
    }

    /// Stream a revision to `destination`, checking its checksum.
    pub async fn fetch(
        &self,
        id: &str,
        destination: &Path,
        expected: &str,
        cap: u64,
    ) -> Result<(), String> {
        let mut response = self.download(id).await?;
        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Backup download was interrupted; local projects were kept")?
        {
            total += chunk.len() as u64;
            if total > cap {
                return Err("Backup ZIP exceeds the 2 GB limit".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.sync_all().await.map_err(|e| e.to_string())?;
        if format!("{:x}", hash.finalize()) != expected {
            return Err("The backup ZIP changed or its download is incomplete. Refresh backups and try again; local files were kept.".into());
        }
        Ok(())
    }

    pub async fn read(&self, id: &str, cap: u64) -> Result<Vec<u8>, String> {
        let mut response = self.download(id).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Shared history download was interrupted")?
        {
            if bytes.len() as u64 + chunk.len() as u64 > cap {
                return Err(format!(
                    "Shared backup ZIP exceeds {} MB",
                    cap / 1024 / 1024
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// Move the backup folder aside inside Dropbox. Nothing is deleted.
    pub async fn reset(&self) -> Result<Option<String>, String> {
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let target = format!("{FOLDER} (reset {stamp})");
        let moved = match self
            .rpc(
                "files/move_v2",
                &json!({"from_path": FOLDER, "to_path": target, "autorename": true}),
            )
            .await
        {
            Ok(_) => Some(target),
            Err(error) if error.contains("not_found") => None,
            Err(error) => return Err(error),
        };
        self.folder_ready.store(false, Ordering::SeqCst);
        self.ensure_folder().await?;
        Ok(moved)
    }
}

/// A small in-memory imitation of the Dropbox endpoints Lemlio uses, served on a
/// local port, with switches for the failures real Dropbox produces.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Default)]
    pub struct State {
        pub files: BTreeMap<String, Vec<u8>>,
        pub folders: BTreeSet<String>,
        /// The only access token the server accepts.
        pub access: String,
        pub refreshes: u32,
        pub revoked: bool,
        pub revoke_calls: u32,
        /// The next request finds its access token expired.
        pub expire_access: bool,
        pub rate_limit: u32,
        pub server_errors: u32,
        pub page_size: usize,
        pub sessions: HashMap<String, Vec<u8>>,
        /// The next chunk is stored but the reply is lost (a 503).
        pub drop_after_append: bool,
        /// Answer file calls as an app that lacks this permission.
        pub missing_scope: Option<String>,
        pub log: Vec<String>,
    }
    pub struct Fake {
        pub endpoints: Endpoints,
        pub state: Arc<StdMutex<State>>,
    }
    type Reply = (u16, Vec<(String, String)>, Vec<u8>);
    fn reply(status: u16, value: Value) -> Reply {
        (
            status,
            vec![("Content-Type".into(), "application/json".into())],
            value.to_string().into_bytes(),
        )
    }

    impl Fake {
        pub async fn start() -> Fake {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let state = Arc::new(StdMutex::new(State {
                access: "AT0".into(),
                ..Default::default()
            }));
            let shared = state.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(serve(stream, shared.clone()));
                }
            });
            Fake {
                endpoints: Endpoints {
                    api: base.clone(),
                    content: base.clone(),
                    token: format!("{base}/oauth2/token"),
                },
                state,
            }
        }
        pub fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
            f(&mut self.state.lock().unwrap())
        }
    }

    async fn serve(mut stream: TcpStream, state: Arc<StdMutex<State>>) {
        let mut data = Vec::new();
        let mut buffer = [0u8; 8192];
        let end = loop {
            let count = stream.read(&mut buffer).await.unwrap_or(0);
            if count == 0 {
                return;
            }
            data.extend_from_slice(&buffer[..count]);
            if let Some(index) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                break index;
            }
        };
        let head = String::from_utf8_lossy(&data[..end]).to_string();
        let mut lines = head.lines();
        let path = lines
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("/")
            .to_string();
        let headers: HashMap<String, String> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
            .collect();
        let length: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut body = data[end + 4..].to_vec();
        while body.len() < length {
            let count = stream.read(&mut buffer).await.unwrap_or(0);
            if count == 0 {
                break;
            }
            body.extend_from_slice(&buffer[..count]);
        }
        let (status, extra, payload) = {
            let mut guard = state.lock().unwrap();
            handle(&mut guard, &path, &headers, body)
        };
        let mut out = format!(
            "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
            payload.len()
        );
        for (key, value) in extra {
            out.push_str(&format!("{key}: {value}\r\n"));
        }
        out.push_str("\r\n");
        let _ = stream.write_all(out.as_bytes()).await;
        let _ = stream.write_all(&payload).await;
    }

    fn list(st: &State, folder: &str, from: usize) -> Reply {
        if !st.folders.contains(folder) {
            return reply(409, json!({"error_summary": "path/not_found/.."}));
        }
        let prefix = format!("{folder}/");
        let all: Vec<(String, usize)> = st
            .files
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix) && !k[prefix.len()..].contains('/'))
            .map(|(k, v)| (k[prefix.len()..].to_string(), v.len()))
            .collect();
        let page = if st.page_size == 0 {
            all.len().max(1)
        } else {
            st.page_size
        };
        let end = (from + page).min(all.len());
        let entries: Vec<Value> = all[from.min(end)..end]
            .iter()
            .map(|(name, size)| json!({".tag": "file", "name": name, "size": size}))
            .collect();
        reply(
            200,
            json!({"entries": entries, "has_more": end < all.len(), "cursor": format!("{end}|{folder}")}),
        )
    }

    fn handle(
        st: &mut State,
        path: &str,
        headers: &HashMap<String, String>,
        body: Vec<u8>,
    ) -> Reply {
        st.log.push(path.to_string());
        if path == "/oauth2/token" {
            let form: HashMap<String, String> =
                reqwest::Url::parse(&format!("http://x/?{}", String::from_utf8_lossy(&body)))
                    .unwrap()
                    .query_pairs()
                    .into_owned()
                    .collect();
            return match form.get("grant_type").map(String::as_str) {
                Some("refresh_token") if !st.revoked => {
                    st.refreshes += 1;
                    st.access = format!("AT{}", st.refreshes);
                    reply(200, json!({"access_token": st.access, "expires_in": 14400}))
                }
                Some("authorization_code")
                    if form.get("code").map(String::as_str) == Some("good-code") =>
                {
                    st.refreshes += 1;
                    st.access = format!("AT{}", st.refreshes);
                    reply(
                        200,
                        json!({"access_token": st.access, "refresh_token": "RT-1", "expires_in": 14400, "account_id": "dbid:acct"}),
                    )
                }
                _ => reply(400, json!({"error": "invalid_grant"})),
            };
        }
        if st.expire_access {
            st.expire_access = false;
            st.access = "rotated-elsewhere".into();
        }
        let token = headers
            .get("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if token != st.access {
            return reply(401, json!({"error_summary": "expired_access_token/.."}));
        }
        if path.starts_with("/2/files/") {
            if let Some(scope) = st.missing_scope.clone() {
                return reply(
                    401,
                    json!({"error_summary": "missing_scope/..", "error": {".tag": "missing_scope", "required_scope": scope}}),
                );
            }
            if st.rate_limit > 0 {
                st.rate_limit -= 1;
                return (
                    429,
                    vec![("Retry-After".into(), "0".into())],
                    b"{}".to_vec(),
                );
            }
            if st.server_errors > 0 {
                st.server_errors -= 1;
                return reply(503, json!({}));
            }
        }
        let arg: Value = headers
            .get("dropbox-api-arg")
            .and_then(|a| serde_json::from_str(a).ok())
            .unwrap_or(Value::Null);
        let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let target = arg["path"].as_str().unwrap_or("").to_string();
        match path {
            "/2/users/get_current_account" => reply(
                200,
                json!({"account_id": "dbid:acct", "name": {"display_name": "Test User"}, "email": "test@example.com"}),
            ),
            "/2/auth/token/revoke" => {
                st.revoke_calls += 1;
                st.revoked = true;
                reply(200, json!({}))
            }
            "/2/files/create_folder_v2" => {
                let folder = args["path"].as_str().unwrap_or("").to_string();
                if st.folders.insert(folder) {
                    reply(200, json!({"metadata": {}}))
                } else {
                    reply(409, json!({"error_summary": "path/conflict/folder/.."}))
                }
            }
            "/2/files/list_folder" => list(st, args["path"].as_str().unwrap_or(""), 0),
            "/2/files/list_folder/continue" => {
                let cursor = args["cursor"].as_str().unwrap_or("0|");
                let (from, folder) = cursor.split_once('|').unwrap_or(("0", ""));
                list(st, folder, from.parse().unwrap_or(0))
            }
            "/2/files/upload" => {
                if st.files.contains_key(&target) {
                    return reply(409, json!({"error_summary": "path/conflict/file/.."}));
                }
                let size = body.len();
                st.files.insert(target, body);
                reply(200, json!({"size": size, "id": "id:1"}))
            }
            "/2/files/upload_session/start" => {
                let id = format!("session-{}", st.sessions.len());
                st.sessions.insert(id.clone(), body);
                reply(200, json!({"session_id": id}))
            }
            "/2/files/upload_session/append_v2" | "/2/files/upload_session/finish" => {
                let id = arg["cursor"]["session_id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let offset = arg["cursor"]["offset"].as_u64().unwrap_or(0) as usize;
                let current = st.sessions.get(&id).map(Vec::len).unwrap_or(0);
                if offset != current {
                    return reply(
                        409,
                        json!({"error_summary": "lookup_failed/incorrect_offset/..",
                               "error": {".tag": "lookup_failed", "lookup_failed": {".tag": "incorrect_offset", "correct_offset": current}}}),
                    );
                }
                if let Some(session) = st.sessions.get_mut(&id) {
                    session.extend_from_slice(&body);
                }
                if path.ends_with("append_v2") {
                    if st.drop_after_append {
                        st.drop_after_append = false;
                        return reply(503, json!({}));
                    }
                    return reply(200, Value::Null);
                }
                let data = st.sessions.remove(&id).unwrap_or_default();
                let size = data.len();
                st.files.insert(
                    arg["commit"]["path"].as_str().unwrap_or("").to_string(),
                    data,
                );
                reply(200, json!({"size": size}))
            }
            "/2/files/download" => match st.files.get(&target) {
                Some(bytes) => (200, Vec::new(), bytes.clone()),
                None => reply(409, json!({"error_summary": "path/not_found/.."})),
            },
            "/2/files/delete_v2" => {
                st.files.remove(args["path"].as_str().unwrap_or(""));
                reply(200, json!({"metadata": {}}))
            }
            "/2/files/move_v2" => {
                let from = args["from_path"].as_str().unwrap_or("").to_string();
                let to = args["to_path"].as_str().unwrap_or("").to_string();
                let moved: Vec<String> = st
                    .files
                    .keys()
                    .filter(|k| k.starts_with(&format!("{from}/")))
                    .cloned()
                    .collect();
                for key in moved {
                    if let Some(bytes) = st.files.remove(&key) {
                        st.files.insert(key.replacen(&from, &to, 1), bytes);
                    }
                }
                if st.folders.remove(&from) {
                    st.folders.insert(to);
                    reply(200, json!({"metadata": {}}))
                } else {
                    reply(409, json!({"error_summary": "from_lookup/not_found/.."}))
                }
            }
            _ => reply(404, json!({"error_summary": "unknown route"})),
        }
    }

    pub fn tokens() -> Tokens {
        Tokens {
            refresh_token: "RT-1".into(),
            access_token: "AT0".into(),
            expires_at: now() + 14400,
            app_key: "appkey123".into(),
            account_id: "dbid:acct".into(),
        }
    }
    pub fn quick() -> Tuning {
        Tuning {
            single_upload_limit: 64 * 1024 * 1024,
            chunk: 8 * 1024 * 1024,
            max_retry_wait: Duration::ZERO,
            backoff: Duration::from_millis(1),
        }
    }
    /// A client signed in to the fake, and the store holding its tokens.
    pub fn client(fake: &Fake, tuning: Tuning) -> (Dropbox, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::default());
        store.save(&tokens()).unwrap();
        (
            Dropbox::with(store.clone(), fake.endpoints.clone(), tuning),
            store,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }
    fn zip_file(dir: &Path, content: &[u8]) -> std::path::PathBuf {
        let path = dir.join(format!("{}.zip", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).unwrap();
        path
    }
    const ROOT: &str = "dropbox:dbid:acct";

    #[test]
    fn revisions_round_trip_through_paged_listings_and_hide_incomplete_ones() {
        run(async {
            let fake = Fake::start().await;
            fake.with(|s| s.page_size = 2);
            let (dropbox, _) = client(&fake, quick());
            let temp = tempfile::tempdir().unwrap();
            let source = zip_file(temp.path(), b"zip bytes for the backup");
            let mut ids = Vec::new();
            for _ in 0..3 {
                let stored = dropbox
                    .put(
                        ROOT,
                        "Paper.zip",
                        &source,
                        "project-1",
                        &json!({"lemlioContent": "c1"}),
                    )
                    .await
                    .unwrap();
                ids.push(stored["id"].as_str().unwrap().to_string());
            }
            let files = dropbox.list(ROOT).await.unwrap();
            assert_eq!(files.len(), 3);
            assert!(fake.with(|s| s.log.iter().any(|r| r.ends_with("list_folder/continue"))));
            assert_eq!(files[0]["sha256Checksum"], sha256_file(&source).unwrap());
            assert_eq!(
                files[0]["appProperties"]["lemlioArchiveHash"],
                files[0]["sha256Checksum"]
            );
            assert_eq!(files[0]["appProperties"]["lemlioProject"], "project-1");
            assert_eq!(files[0]["parents"][0], ROOT);
            assert_eq!(files[0]["mimeType"], "application/zip");
            assert_ne!(ids[0], ids[1], "revisions are never overwritten");

            // A ZIP that vanished, or is still the wrong size, is not a revision yet.
            fake.with(|s| {
                s.files.remove(&format!("{FOLDER}/{}.zip", ids[0]));
                s.files
                    .insert(format!("{FOLDER}/{}.zip", ids[1]), b"part".to_vec());
            });
            let files = dropbox.list(ROOT).await.unwrap();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0]["id"], ids[2]);

            // Downloads are checked against the stored checksum and size cap.
            let hash = sha256_file(&source).unwrap();
            let out = temp.path().join("out.zip");
            dropbox.fetch(&ids[2], &out, &hash, 1024).await.unwrap();
            assert_eq!(std::fs::read(&out).unwrap(), b"zip bytes for the backup");
            assert!(dropbox.fetch(&ids[2], &out, "wrong", 1024).await.is_err());
            assert!(dropbox.fetch(&ids[2], &out, &hash, 3).await.is_err());
            assert_eq!(
                dropbox.read(&ids[2], 1024).await.unwrap(),
                b"zip bytes for the backup"
            );
            assert!(dropbox.read(&ids[2], 3).await.is_err());
            assert!(dropbox.fetch("../escape", &out, &hash, 1024).await.is_err());
        });
    }

    #[test]
    fn big_files_upload_in_chunks_and_resume_after_a_lost_reply() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, _) = client(
                &fake,
                Tuning {
                    single_upload_limit: 10,
                    chunk: 8,
                    ..quick()
                },
            );
            let temp = tempfile::tempdir().unwrap();
            let content: Vec<u8> = (0..30u8).collect();
            let source = zip_file(temp.path(), &content);
            fake.with(|s| s.drop_after_append = true);
            let stored = dropbox
                .put(ROOT, "Big.zip", &source, "project-2", &json!({}))
                .await
                .unwrap();
            let id = stored["id"].as_str().unwrap();
            assert_eq!(
                fake.with(|s| s.files[&format!("{FOLDER}/{id}.zip")].clone()),
                content
            );
            let calls = fake.with(|s| s.log.clone());
            assert!(calls.iter().any(|r| r.ends_with("upload_session/start")));
            assert!(calls
                .iter()
                .any(|r| r.ends_with("upload_session/append_v2")));
            assert!(calls.iter().any(|r| r.ends_with("upload_session/finish")));
            assert_eq!(dropbox.list(ROOT).await.unwrap().len(), 1);
        });
    }

    #[test]
    fn rate_limits_and_server_errors_are_retried() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, _) = client(&fake, quick());
            let temp = tempfile::tempdir().unwrap();
            let source = zip_file(temp.path(), b"payload");
            fake.with(|s| {
                s.rate_limit = 2;
                s.server_errors = 1;
            });
            dropbox
                .put(ROOT, "A.zip", &source, "k", &json!({}))
                .await
                .unwrap();
            assert_eq!(dropbox.list(ROOT).await.unwrap().len(), 1);
            // A server that never recovers is reported, not retried forever.
            fake.with(|s| s.rate_limit = 100);
            assert!(dropbox.list(ROOT).await.is_err());
        });
    }

    #[test]
    fn an_expired_access_token_is_renewed_once_and_saved() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, store) = client(&fake, quick());
            fake.with(|s| s.expire_access = true);
            let account = dropbox.account().await.unwrap();
            assert_eq!(account["email"], "test@example.com");
            assert_eq!(account["name"], "Test User");
            assert_eq!(fake.with(|s| s.refreshes), 1);
            assert_eq!(store.load().unwrap().unwrap().access_token, "AT1");
            // The renewed token is reused, not renewed again.
            dropbox.account().await.unwrap();
            assert_eq!(fake.with(|s| s.refreshes), 1);
        });
    }

    #[test]
    fn a_revoked_connection_asks_the_user_to_reconnect() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, _) = client(&fake, quick());
            fake.with(|s| {
                s.expire_access = true;
                s.revoked = true;
            });
            let error = dropbox.list(ROOT).await.unwrap_err();
            assert!(error.starts_with(RECONNECT), "{error}");
            assert!(NEEDS_RECONNECT.load(Ordering::SeqCst));
            NEEDS_RECONNECT.store(false, Ordering::SeqCst);
        });
    }

    #[test]
    fn disconnecting_revokes_at_dropbox_and_forgets_tokens_but_keeps_backups() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, store) = client(&fake, quick());
            let temp = tempfile::tempdir().unwrap();
            let source = zip_file(temp.path(), b"keep me");
            dropbox
                .put(ROOT, "A.zip", &source, "k", &json!({}))
                .await
                .unwrap();
            let before = fake.with(|s| s.files.len());
            dropbox.disconnect().await.unwrap();
            assert!(store.load().unwrap().is_none());
            assert_eq!(fake.with(|s| s.revoke_calls), 1);
            assert_eq!(
                fake.with(|s| s.files.len()),
                before,
                "backups are never deleted"
            );
        });
    }

    #[test]
    fn reset_moves_the_backup_folder_aside_inside_dropbox() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, _) = client(&fake, quick());
            let temp = tempfile::tempdir().unwrap();
            let source = zip_file(temp.path(), b"old backup");
            dropbox
                .put(ROOT, "A.zip", &source, "k", &json!({}))
                .await
                .unwrap();
            let moved = dropbox.reset().await.unwrap().unwrap();
            assert!(moved.starts_with("/Lemlio Backups (reset "));
            assert!(dropbox.list(ROOT).await.unwrap().is_empty());
            assert!(fake.with(|s| s.files.keys().any(|k| k.starts_with(&moved))));
        });
    }

    #[test]
    fn sign_in_exchanges_the_code_and_keeps_only_the_tokens() {
        run(async {
            let fake = Fake::start().await;
            let store = Arc::new(MemoryStore::default());
            let dropbox = Dropbox::with(store.clone(), fake.endpoints.clone(), quick());
            assert!(dropbox
                .exchange_code("appkey123", "bad-code", "verifier", None)
                .await
                .is_err());
            assert!(store.load().unwrap().is_none());
            let tokens = dropbox
                .exchange_code(
                    "appkey123",
                    "good-code",
                    "verifier",
                    Some("http://127.0.0.1:53682"),
                )
                .await
                .unwrap();
            assert_eq!(tokens.account_id, "dbid:acct");
            let saved = store.load().unwrap().unwrap();
            assert_eq!(saved.refresh_token, "RT-1");
            assert_eq!(saved.app_key, "appkey123");
            assert_eq!(
                dropbox.account().await.unwrap()["email"],
                "test@example.com"
            );
        });
    }

    #[test]
    fn authorization_uses_pkce_offline_access_and_the_app_folder_scopes() {
        let verifier = new_verifier();
        let url = authorization_url(
            "appkey123",
            Some("http://127.0.0.1:53682"),
            &challenge(&verifier),
            "nonce",
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("www.dropbox.com"));
        assert_eq!(url.path(), "/oauth2/authorize");
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], "appkey123");
        assert_eq!(pairs["response_type"], "code");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["code_challenge"], challenge(&verifier));
        assert_eq!(pairs["token_access_type"], "offline");
        assert_eq!(pairs["state"], "nonce");
        assert_eq!(pairs["redirect_uri"], "http://127.0.0.1:53682");
        assert!(pairs["scope"].contains("files.content.write"));
        assert!(!pairs.contains_key("client_secret"));
        assert!(
            verifier.len() >= 43,
            "PKCE verifiers need at least 43 characters"
        );
        // The code option omits the redirect so Dropbox shows the code on screen.
        let manual = authorization_url("appkey123", None, &challenge(&verifier), "nonce").unwrap();
        assert!(!manual.query_pairs().any(|(key, _)| key == "redirect_uri"));
    }

    #[test]
    fn the_sign_in_callback_rejects_wrong_or_ambiguous_state() {
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
        let valid = callback_parameters("/?state=expected&code=a%2Bb%2Fc", "expected").unwrap();
        assert_eq!(valid["code"], "a+b/c");
    }

    #[test]
    fn app_keys_must_look_like_a_short_public_identifier() {
        assert!(valid_app_key("abc123def456ghi"));
        for bad in [
            "",
            "short",
            "has space inside1",
            "sl.AbCdEf-Token_value.with.dots",
            &"a".repeat(25),
            "key-with-dash12",
        ] {
            assert!(!valid_app_key(bad), "{bad}");
        }
    }

    #[test]
    fn the_guide_lists_the_same_redirects_and_permissions_the_code_uses() {
        let uris = redirect_uris();
        assert_eq!(uris.len(), LOOPBACK_PORTS.len());
        for (uri, port) in uris.iter().zip(LOOPBACK_PORTS) {
            assert_eq!(uri, &redirect_uri(port));
        }
        let wanted = permissions();
        for scope in [
            "files.metadata.read",
            "files.metadata.write",
            "files.content.read",
            "files.content.write",
            "account_info.read",
        ] {
            assert!(wanted.contains(&scope), "{scope}");
        }
    }

    #[test]
    fn common_sign_in_failures_get_a_specific_fix() {
        let uri = "http://127.0.0.1:53683";
        let say = |code: &str, text: &str| {
            explain_sign_in_error(
                &json!({"error": code, "error_description": text}),
                Some(uri),
            )
        };
        let redirect = say("invalid_grant", "redirect_uri mismatch");
        assert!(
            redirect.contains("Settings > Redirect URIs") && redirect.contains(uri),
            "{redirect}"
        );
        assert!(say("invalid_client", "unknown client_id").contains("App key (not the App secret)"));
        assert!(say(
            "invalid_request",
            "client secret required for non-public clients"
        )
        .contains("Allow public clients"));
        assert!(say("invalid_scope", "scope not allowed").contains("Permissions tab"));
        assert!(say(
            "invalid_request",
            "app is in development and reached the user limit"
        )
        .contains("500-user limit"));
        assert!(say("access_denied", "").contains("cancelled"));
        assert!(say("weird", "never seen before").contains("Connect again"));
    }

    #[test]
    fn a_missing_permission_is_named_instead_of_asking_to_reconnect() {
        run(async {
            let fake = Fake::start().await;
            let (dropbox, _) = client(&fake, quick());
            fake.with(|s| s.missing_scope = Some("files.content.write".into()));
            let error = dropbox.list(ROOT).await.unwrap_err();
            assert!(
                error.contains("missing a permission (files.content.write)"),
                "{error}"
            );
            assert!(error.contains("Permissions tab"));
            assert!(!error.starts_with(RECONNECT), "the sign-in itself is fine");
        });
    }
}
