//! Local Codex app-server client. Credentials stay in Codex's credential store.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

type Reply = Result<Value, String>;
#[derive(Clone, Default)]
pub struct CodexProcessState {
    servers: Arc<Mutex<HashMap<String, Arc<Rpc>>>>,
}
struct Rpc {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    requests: Mutex<HashMap<String, Value>>,
    routes: Mutex<HashMap<String, String>>,
    projects: Mutex<HashMap<String, String>>,
    active: Mutex<HashMap<String, String>>,
    text: Mutex<HashMap<String, String>>,
    cancelled: Mutex<HashSet<String>>,
    usage: Mutex<HashMap<String, Value>>,
    items: Mutex<HashMap<String, Value>>,
    next_id: AtomicU64,
    alive: AtomicBool,
}

pub(crate) fn is_essential_env_var(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    matches!(
        k.as_str(),
        "HOME"
            | "USER"
            | "SHELL"
            | "LANG"
            | "USERPROFILE"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "TEMP"
            | "TMP"
            | "SYSTEMROOT"
            | "SYSTEMDRIVE"
            | "COMPUTERNAME"
            | "USERNAME"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "COMMONPROGRAMFILES"
            | "PATHEXT"
            | "PSMODULEPATH"
            | "WINDIR"
            | "HTTP_PROXY"
            | "HTTPS_PROXY"
            | "NO_PROXY"
            | "ALL_PROXY"
    ) || k.starts_with("LC_")
}

fn find_codex_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_BINARY") {
        let path = PathBuf::from(path);
        return path
            .is_file()
            .then_some(path)
            .ok_or("CODEX_BINARY must point to your Codex executable".into());
    }
    if let Ok(path) = which::which("codex") {
        return Ok(path);
    }
    let home = dirs::home_dir().ok_or("Could not find your home directory")?;
    let mut candidates = vec![
        home.join(".local/bin/codex"),
        home.join(".cargo/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    #[cfg(target_os = "windows")]
    {
        candidates.push(home.join(".local/bin/codex.exe"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            if let Ok(entries) = std::fs::read_dir(PathBuf::from(local).join("OpenAI/Codex/bin")) {
                let mut versions: Vec<_> = entries
                    .flatten()
                    .map(|e| e.path().join("codex.exe"))
                    .collect();
                versions.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
                versions.reverse();
                candidates.extend(versions);
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm/codex.cmd"));
        }
    }
    candidates.into_iter().find(|p| p.is_file()).ok_or(
        "Codex was not found. Install it with npm install -g @openai/codex, or set CODEX_BINARY to your codex.exe.".into())
}

fn command(program: &Path) -> Command {
    #[cfg(target_os = "windows")]
    let mut cmd = if program
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
    {
        let script = program
            .parent()
            .unwrap_or(Path::new("."))
            .join("node_modules/@openai/codex/bin/codex.js");
        let mut cmd = Command::new("node");
        cmd.arg(script);
        cmd
    } else {
        Command::new(program)
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.kill_on_drop(true);
    cmd
}

impl Rpc {
    async fn send(&self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("Codex connection closed: {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
    async fn call(&self, method: &str, params: Value) -> Reply {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Codex disconnected. Retry to reconnect.".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(error) = self
            .send(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let reply = tokio::time::timeout(Duration::from_secs(60), rx).await;
        self.pending.lock().await.remove(&id);
        reply
            .map_err(|_| format!("Codex {method} timed out"))?
            .map_err(|_| "Codex disconnected before responding".to_string())?
    }
    async fn start(window: WebviewWindow) -> Result<Arc<Self>, String> {
        let mut launch = command(&find_codex_binary()?);
        if let Ok(app) = std::env::current_exe() {
            launch.env("LEMLIO_APP", app);
        }
        let mut extra_paths: Vec<PathBuf> = vec![];
        if let Some(bin) = crate::tools::env_bin_dir(window.app_handle()) {
            extra_paths.push(bin);
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Some(system_tex) = crate::latex::system_tex_bin_dir() {
            // So the assistant can run MiKTeX / TeX Live tools (mf, mpm, tlmgr, pdflatex) itself.
            extra_paths.push(system_tex);
        }
        if let Ok(binary) = crate::latex::tectonic_binary() {
            launch.env("LEMLIO_TECTONIC", &binary);
            if let Some(parent) = binary.parent() {
                extra_paths.push(parent.to_path_buf());
            }
        }
        if !extra_paths.is_empty() {
            if let Some(existing) = std::env::var_os("PATH") {
                extra_paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(path) = std::env::join_paths(extra_paths) {
                launch.env("PATH", path);
            }
        }
        let mut child = launch
            .args(["app-server", "--listen", "stdio://"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start Codex: {e}"))?;
        let stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Codex stderr unavailable")?;
        let rpc = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            routes: Mutex::new(HashMap::new()),
            projects: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            text: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            usage: Mutex::new(HashMap::new()),
            items: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
        });
        let reader = rpc.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    if msg.get("method").is_none() {
                        if let Some(id) = msg["id"].as_u64() {
                            if let Some(tx) = reader.pending.lock().await.remove(&id) {
                                let result = if msg.get("error").is_some() {
                                    Err(msg["error"]["message"]
                                        .as_str()
                                        .unwrap_or("Codex request failed")
                                        .to_string())
                                } else {
                                    Ok(msg["result"].clone())
                                };
                                let _ = tx.send(result);
                            }
                        }
                    } else {
                        reader.event(&window, msg).await;
                    }
                }
            }
            reader.alive.store(false, Ordering::Release);
            reader.pending.lock().await.clear();
            reader.requests.lock().await.clear();
            for thread in reader.active.lock().await.keys() {
                if let Some(tab) = reader.routes.lock().await.get(thread) {
                    output(
                        &window,
                        tab,
                        json!({"type":"result","is_error":true,"result":"Codex disconnected. Please retry."}),
                    );
                    complete(&window, tab, false);
                }
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        if let Err(error)=rpc.call("initialize",json!({"clientInfo":{"name":"prismpro","title":"Lemlio","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await {
            let _=rpc.child.lock().await.kill().await; return Err(error);
        }
        rpc.send(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(rpc)
    }
    async fn event(&self, window: &WebviewWindow, msg: Value) {
        let method = msg["method"].as_str().unwrap_or("");
        let p = &msg["params"];
        if method == "account/login/completed" {
            let _ = window.emit("login-complete", p["success"].as_bool().unwrap_or(false));
            return;
        }
        let thread = p["threadId"].as_str().unwrap_or("");
        let tab = self.routes.lock().await.get(thread).cloned();
        if msg.get("id").is_some() {
            if let Some(tab) = tab {
                if method == "item/tool/call"
                    && (!matches!(
                        p["tool"].as_str(),
                        Some("lemlio_compile" | "lemlio_view_pdf_page")
                    ) || self.cancelled.lock().await.contains(&tab))
                {
                    let _ = self.send(json!({"id":msg["id"],"result":{"success":false,"contentItems":[{"type":"inputText","text":"Unknown tool or cancelled turn"}]}})).await;
                    return;
                }
                self.requests
                    .lock()
                    .await
                    .insert(msg["id"].to_string(), msg.clone());
                let mut params = p.clone();
                if method == "item/tool/call" {
                    params["projectPath"] = self
                        .projects
                        .lock()
                        .await
                        .get(thread)
                        .map(|p| json!(p))
                        .unwrap_or(Value::Null);
                }
                if let Some(item) = self
                    .items
                    .lock()
                    .await
                    .get(p["itemId"].as_str().unwrap_or(""))
                {
                    params["item"] = item.clone();
                }
                let _ = window.emit(
                    "codex-request",
                    json!({"tab_id":tab,"id":msg["id"],"method":method,"params":params}),
                );
            } else {
                let _=self.send(json!({"id":msg["id"],"error":{"code":-32601,"message":"Unsupported host request"}})).await;
            }
            return;
        }
        if method == "serverRequest/resolved" {
            self.requests
                .lock()
                .await
                .remove(&p["requestId"].to_string());
            let _ = window.emit("codex-request-resolved", p.clone());
        }
        let Some(tab) = tab else {
            return;
        };
        match method {
            "turn/started" => {
                if let Some(id) = p["turn"]["id"].as_str() {
                    self.active.lock().await.insert(thread.into(), id.into());
                }
            }
            "item/agentMessage/delta" => {
                let id = p["itemId"].as_str().unwrap_or("");
                let mut text = self.text.lock().await;
                let buffer = text.entry(format!("{thread}:{id}")).or_default();
                buffer.push_str(p["delta"].as_str().unwrap_or(""));
                output(
                    window,
                    &tab,
                    json!({"type":"assistant","id":id,"message":{"content":[{"type":"text","text":buffer}]}}),
                );
            }
            "item/started" | "item/completed" => {
                if let Some(id) = p["item"]["id"].as_str() {
                    if method == "item/started" {
                        self.items.lock().await.insert(id.into(), p["item"].clone());
                    } else {
                        self.items.lock().await.remove(id);
                    }
                }
                for message in item_messages(&p["item"], method == "item/completed") {
                    output(window, &tab, message);
                }
                if method == "item/completed" {
                    self.text.lock().await.remove(&format!(
                        "{thread}:{}",
                        p["item"]["id"].as_str().unwrap_or("")
                    ));
                }
            }
            "thread/tokenUsage/updated" => {
                self.usage
                    .lock()
                    .await
                    .insert(thread.into(), p["tokenUsage"]["last"].clone());
            }
            "error" if p["willRetry"].as_bool() != Some(true) => {
                output(
                    window,
                    &tab,
                    json!({"type":"result","is_error":true,"result":p["error"]["message"]}),
                );
            }
            "turn/completed" => {
                self.active.lock().await.remove(thread);
                let success = p["turn"]["status"] == "completed";
                let usage = self
                    .usage
                    .lock()
                    .await
                    .remove(thread)
                    .unwrap_or(Value::Null);
                output(
                    window,
                    &tab,
                    json!({"type":"result","is_error":!success,
                    "result":p["turn"]["error"]["message"].as_str().unwrap_or(if success {""} else {"Codex turn interrupted or failed."}),
                    "usage":{"input_tokens":usage["inputTokens"].as_i64().unwrap_or(0),"output_tokens":usage["outputTokens"].as_i64().unwrap_or(0)}}),
                );
                self.requests
                    .lock()
                    .await
                    .retain(|_, r| r["params"]["threadId"] != thread);
                complete(window, &tab, success);
            }
            _ => {}
        }
    }
}

fn output(window: &WebviewWindow, tab: &str, msg: Value) {
    let _ = window.emit("codex-output", json!({"tab_id":tab,"data":msg.to_string()}));
}
fn complete(window: &WebviewWindow, tab: &str, success: bool) {
    let _ = window.emit("codex-complete", json!({"tab_id":tab,"success":success}));
}

/// Normalize Codex items into the editor's chat blocks, including file-change tracking.
fn item_messages(item: &Value, completed: bool) -> Vec<Value> {
    let id = item["id"].as_str().unwrap_or("");
    let assistant = |id: String, block: Value| json!({"type":"assistant","id":id,"message":{"content":[block]}});
    let result = |id: String, content: Value| json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":content,"is_error":matches!(item["status"].as_str(),Some("failed"|"declined")) || item["success"] == false}]}});
    match item["type"].as_str().unwrap_or(""){
        "agentMessage" if completed=>vec![assistant(id.into(),json!({"type":"text","text":item["text"]}))],
        "userMessage" if completed=>{
            let blocks:Vec<_>=item["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="text").map(|b|json!({"type":"text","text":b["text"]})).collect();
            vec![json!({"type":"user","message":{"content":blocks}})]
        }
        "commandExecution"=>if completed{vec![result(id.into(),item["aggregatedOutput"].clone())]}
            else{vec![assistant(id.into(),json!({"type":"tool_use","id":id,"name":"Bash","input":{"command":item["command"]}}))]},
        "fileChange"=>item["changes"].as_array().into_iter().flatten().enumerate().map(|(i,c)|{
            let id=format!("{id}-{i}"); if completed{result(id,json!("File updated"))}
            else{assistant(id.clone(),json!({"type":"tool_use","id":id,"name":"Edit","input":{"file_path":c["path"],"diff":c["diff"]}}))}
        }).collect(),
        "dynamicToolCall"=>if completed {
            let summary = item["contentItems"].as_array().into_iter().flatten().filter_map(|c|c["text"].as_str()).collect::<Vec<_>>().join("\n");
            vec![result(id.into(),json!(summary))]
        } else { vec![assistant(id.into(),json!({"type":"tool_use","id":id,"name":item["tool"],"input":item["arguments"]}))] },
        "mcpToolCall"=>if completed{vec![result(id.into(),item["result"].clone())]}
            else{vec![assistant(id.into(),json!({"type":"tool_use","id":id,"name":item["tool"],"input":item["arguments"]}))]},
        "reasoning" if completed=>{
            let text=item["summary"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("\n");
            if text.is_empty(){vec![]}else{vec![assistant(id.into(),json!({"type":"thinking","thinking":text}))]}
        }
        _=>vec![],
    }
}

async fn server(window: &WebviewWindow) -> Result<Arc<Rpc>, String> {
    let state = window.state::<CodexProcessState>();
    let mut servers = state.servers.lock().await;
    if let Some(rpc) = servers.get(window.label()) {
        if rpc.alive.load(Ordering::Acquire) {
            return Ok(rpc.clone());
        }
    }
    let rpc = Rpc::start(window.clone()).await?;
    servers.insert(window.label().into(), rpc.clone());
    Ok(rpc)
}

#[derive(serde::Serialize)]
pub struct CodexStatus {
    installed: bool,
    authenticated: bool,
    binary_path: Option<String>,
    version: Option<String>,
    account_email: Option<String>,
}
#[tauri::command]
pub async fn check_codex_status(window: WebviewWindow) -> Result<CodexStatus, String> {
    let Ok(binary) = find_codex_binary() else {
        return Ok(CodexStatus {
            installed: false,
            authenticated: false,
            binary_path: None,
            version: None,
            account_email: None,
        });
    };
    let version = tokio::time::timeout(
        Duration::from_secs(10),
        command(&binary).arg("--version").output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let account = server(&window)
        .await?
        .call("account/read", json!({"refreshToken":false}))
        .await?;
    Ok(CodexStatus {
        installed: true,
        authenticated: !account["account"].is_null() || account["requiresOpenaiAuth"] == false,
        binary_path: Some(binary.display().to_string()),
        version,
        account_email: account["account"]["email"].as_str().map(str::to_string),
    })
}
#[tauri::command]
pub async fn login_codex(window: WebviewWindow) -> Result<String, String> {
    let result = server(&window)
        .await?
        .call("account/login/start", json!({"type":"chatgpt"}))
        .await?;
    result["authUrl"]
        .as_str()
        .map(str::to_string)
        .ok_or("Codex did not return a sign-in URL".into())
}
#[tauri::command]
pub async fn list_codex_models(window: WebviewWindow) -> Result<Vec<Value>, String> {
    let rpc = server(&window).await?;
    let mut models = vec![];
    let mut cursor = Value::Null;
    loop {
        let page = rpc
            .call("model/list", json!({"limit":100,"cursor":cursor}))
            .await?;
        models.extend(page["data"].as_array().cloned().unwrap_or_default());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    Ok(models)
}

const INSTRUCTIONS:&str="You are Codex inside Lemlio, a local scientific writing workspace. Read the project AGENTS.md. Preserve the existing LaTeX preamble, bibliography, and structure. Read files before editing; make small targeted edits. Explain your plan for substantial changes. Use citations and cross-references correctly; do not invent sources or research findings. Do not create Python virtual environments in the project; use the shared tools described below. Save publication-quality figures in figures/. Use lemlio_compile after LaTeX edits to actually verify compilation with the editor's selected main file and compiler. Read its diagnostics and fix errors before claiming success. Use lemlio_view_pdf_page after a successful compile when checking layout, figures, or formatting; it returns an image of the compiled page. Never claim a compile or visual check you have not performed. Do not assume tectonic is unavailable merely because it is not on the system PATH. If this older chat does not expose the Lemlio tools, use the terminal fallback described below or explain that a new chat is needed for the integrated tools. Compiler-generated .prism output and terminal-fallback logs are allowed. Do not manually edit .prism, .prismpro, or .venv internals. The user may attach screenshots of the app or PDF; look at them when present. When a compile fails, solve it yourself before asking the user: read the log, fix the real cause, and recompile. Lemlio's compile command uses Tectonic first and automatically retries with an installed MiKTeX or TeX Live when Tectonic cannot build a font (for example BangTeX Bengali fonts that only exist as METAFONT sources). If a compile still fails you may run the system tools yourself: omit --tectonic in the Lemlio compile command to force the system compiler, install a missing LaTeX package with the system package manager (MiKTeX: mpm --install <package>; TeX Live: tlmgr install <package>), or generate fonts from METAFONT sources with mf. Never delete, shorten or rewrite the user's content, such as non-English text, only to make it compile; if the only possible fix would change their content, explain and ask first.";

fn compiler_tools() -> Value {
    serde_json::from_str(include_str!("../../src/lib/codex-compiler-tools.json"))
        .expect("Lemlio compiler tool definitions are valid JSON")
}

fn compiler_instructions(main_file: Option<&str>, use_texlive: bool, tools: &str) -> String {
    let app = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    #[cfg(target_os = "windows")]
    let fallback = format!(
        r#"Windows terminal fallback for older chats: Lemlio executable is {app:?}. In PowerShell, create .prism/agent-check, then use Start-Process -FilePath '<Lemlio executable>' -ArgumentList @('--compile-project', ('"'+(Get-Location).Path+'"'), '<main.tex>', '--tectonic') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput '.prism/agent-check/stdout.log' -RedirectStandardError '.prism/agent-check/stderr.log'. Read both logs and the process ExitCode. Replace placeholders with the provided executable and actual root file; use the project directory as cwd. Omit --tectonic only when deliberately testing the optional system compiler. This uses the same bundled fonts, asset staging and package fixes as the editor. Raw tectonic is also on this process PATH, but prefer the Lemlio tools/pipeline."#
    );
    #[cfg(not(target_os="windows"))]
    let fallback = format!("Terminal fallback for older chats: execute the Lemlio binary at {app:?} with arguments --compile-project <absolute-project-directory> <relative-main.tex> --tectonic. Quote paths with spaces. Check the exit code and compiler output; omit --tectonic only for the optional system compiler. This uses the same bundled fonts and project staging as the editor.");
    format!(
        "{INSTRUCTIONS}\nSelected main file: {}. Selected compiler: {}.\n{tools}\n{fallback}",
        main_file.unwrap_or("not selected"),
        if use_texlive {
            "optional system LaTeX"
        } else {
            "bundled Tectonic"
        }
    )
}

async fn start_turn(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    session_id: Option<String>,
    model: Option<String>,
    effort_level: Option<String>,
    main_file: Option<String>,
    use_texlive: Option<bool>,
    related_projects: Option<Vec<String>>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let images = crate::tools::validate_images(images)?;
    let path =
        std::fs::canonicalize(&project_path).map_err(|e| format!("Cannot open project: {e}"))?;
    if !path.is_dir() {
        return Err("Project path must be a directory".into());
    }
    let mut roots = vec![path.to_string_lossy().to_string()];
    for selected in related_projects.unwrap_or_default() {
        if roots.len() >= 20 {
            return Err("A group run supports at most 20 projects".into());
        }
        let root = std::fs::canonicalize(&selected)
            .map_err(|e| format!("Cannot open grouped project: {e}"))?;
        if !root.is_dir() {
            return Err("Grouped project must be a directory".into());
        }
        crate::collaboration::manifest(&root)?;
        let value = root.to_string_lossy().to_string();
        if !roots.contains(&value) {
            roots.push(value);
        }
    }
    crate::collaboration::manifest(&path)?;
    let rpc = server(&window).await?;
    rpc.cancelled.lock().await.remove(&tab_id);
    let previous = rpc
        .routes
        .lock()
        .await
        .iter()
        .find_map(|(thread, tab)| (tab == &tab_id).then_some(thread.clone()));
    if let Some(thread) = previous {
        if rpc.active.lock().await.contains_key(&thread) {
            return Err("This chat already has a running Codex turn".into());
        }
    }
    let mut params = json!({"cwd":project_path,"developerInstructions":compiler_instructions(main_file.as_deref(), use_texlive.unwrap_or(false), &crate::tools::prompt_section(&window.app_handle().clone())),"approvalPolicy":"on-request","sandbox":"workspace-write"});
    if let Some(m) = model.as_ref().filter(|m| !m.is_empty()) {
        params["model"] = json!(m);
    }
    let thread = if let Some(id) = session_id {
        params["threadId"] = json!(id);
        rpc.call("thread/resume", params).await?
    } else {
        params["dynamicTools"] = compiler_tools();
        rpc.call("thread/start", params).await?
    };
    let thread_id = thread["thread"]["id"]
        .as_str()
        .ok_or("Codex did not return a thread ID")?
        .to_string();
    rpc.routes
        .lock()
        .await
        .insert(thread_id.clone(), tab_id.clone());
    rpc.projects
        .lock()
        .await
        .insert(thread_id.clone(), path.to_string_lossy().to_string());
    output(
        &window,
        &tab_id,
        json!({"type":"system","subtype":"init","session_id":thread_id}),
    );
    if rpc.cancelled.lock().await.contains(&tab_id) {
        return Err("Codex request cancelled".into());
    }
    let mut input = vec![json!({"type":"text","text":prompt,"text_elements":[]})];
    for (mime, data) in &images {
        input.push(json!({"type":"image","url":format!("data:{mime};base64,{data}")}));
    }
    let mut params = json!({"threadId":thread_id,"input":input});
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        params["model"] = json!(m);
    }
    if let Some(e) = effort_level.filter(|e| !e.is_empty()) {
        params["effort"] = json!(e);
    }
    params["sandboxPolicy"] =
        json!({"type":"workspaceWrite","writableRoots":roots,"networkAccess":false});
    let turn = match rpc.call("turn/start", params.clone()).await {
        Err(error) if !images.is_empty() => {
            // Some models cannot take images: keep the conversation going without them.
            params["input"] = json!([{"type":"text","text":prompt,"text_elements":[]}]);
            output(&window, &tab_id, json!({"type":"assistant","id":format!("img-{tab_id}"),"message":{"content":[{"type":"text","text":format!("_The attached image could not be sent ({error}). Continuing without it._")}]}}));
            rpc.call("turn/start", params).await?
        }
        other => other?,
    };
    if rpc.cancelled.lock().await.contains(&tab_id) {
        rpc.call(
            "turn/interrupt",
            json!({"threadId":thread_id,"turnId":turn["turn"]["id"]}),
        )
        .await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn execute_codex_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
    main_file: Option<String>,
    use_texlive: Option<bool>,
    related_projects: Option<Vec<String>>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    start_turn(
        window,
        project_path,
        prompt,
        tab_id,
        None,
        model,
        effort_level,
        main_file,
        use_texlive,
        related_projects,
        images,
    )
    .await
}
#[tauri::command]
pub async fn resume_codex_code(
    window: WebviewWindow,
    project_path: String,
    session_id: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
    main_file: Option<String>,
    use_texlive: Option<bool>,
    related_projects: Option<Vec<String>>,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    start_turn(
        window,
        project_path,
        prompt,
        tab_id,
        Some(session_id),
        model,
        effort_level,
        main_file,
        use_texlive,
        related_projects,
        images,
    )
    .await
}
#[tauri::command]
pub async fn cancel_codex_execution(window: WebviewWindow, tab_id: String) -> Result<(), String> {
    let rpc = server(&window).await?;
    rpc.cancelled.lock().await.insert(tab_id.clone());
    let threads: Vec<_> = rpc
        .routes
        .lock()
        .await
        .iter()
        .filter(|(_, tab)| *tab == &tab_id)
        .map(|(id, _)| id.clone())
        .collect();
    for thread in threads {
        let turn = rpc.active.lock().await.get(&thread).cloned();
        if let Some(turn) = turn {
            rpc.call("turn/interrupt", json!({"threadId":thread,"turnId":turn}))
                .await?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn respond_codex_request(
    window: WebviewWindow,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    let rpc = server(&window).await?;
    let request = rpc
        .requests
        .lock()
        .await
        .remove(&request_id.to_string())
        .ok_or("This Codex request is no longer pending")?;
    if let Err(error) = rpc.send(json!({"id":request_id,"result":result})).await {
        rpc.requests
            .lock()
            .await
            .insert(request_id.to_string(), request);
        return Err(error);
    }
    Ok(())
}
#[derive(serde::Serialize)]
pub struct CodexSessionInfo {
    session_id: String,
    title: String,
    last_modified: i64,
}
#[tauri::command]
pub async fn list_codex_sessions(
    window: WebviewWindow,
    project_path: String,
) -> Result<Vec<CodexSessionInfo>, String> {
    let page = server(&window)
        .await?
        .call(
            "thread/list",
            json!({"cwd":project_path,"limit":100,"sortKey":"updated_at"}),
        )
        .await?;
    Ok(page["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| CodexSessionInfo {
            session_id: t["id"].as_str().unwrap_or("").into(),
            title: t["name"]
                .as_str()
                .or_else(|| t["preview"].as_str())
                .unwrap_or("Codex chat")
                .chars()
                .take(100)
                .collect(),
            last_modified: t["updatedAt"].as_i64().unwrap_or(0),
        })
        .collect())
}
#[tauri::command]
pub async fn load_session_history(
    window: WebviewWindow,
    project_path: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    let data = server(&window)
        .await?
        .call(
            "thread/read",
            json!({"threadId":session_id,"includeTurns":true}),
        )
        .await?;
    let expected = std::fs::canonicalize(project_path).map_err(|e| e.to_string())?;
    let actual = data["thread"]["cwd"]
        .as_str()
        .ok_or("Codex thread has no project directory")?;
    if std::fs::canonicalize(actual).map_err(|e| e.to_string())? != expected {
        return Err("This chat belongs to a different project".into());
    }
    let mut messages = vec![];
    for turn in data["thread"]["turns"].as_array().into_iter().flatten() {
        for item in turn["items"].as_array().into_iter().flatten() {
            if matches!(
                item["type"].as_str(),
                Some("commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall")
            ) {
                messages.extend(item_messages(item, false));
            }
            messages.extend(item_messages(item, true));
        }
    }
    Ok(messages)
}
pub async fn kill_process_for_window(state: &CodexProcessState, window_label: &str) {
    if let Some(rpc) = state.servers.lock().await.remove(window_label) {
        let _ = rpc.child.lock().await.kill().await;
    }
}

#[derive(serde::Serialize)]
pub struct ShellCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}
#[tauri::command]
pub async fn run_shell_command(command: String, cwd: String) -> Result<ShellCommandResult, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/d", "/s", "/c", &command]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    let output = cmd
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(ShellCommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into(),
        stderr: String::from_utf8_lossy(&output.stderr).into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiler_tools_are_bounded_and_visible_in_chat_history() {
        let tools = compiler_tools();
        assert_eq!(tools.as_array().unwrap().len(), 2);
        assert_eq!(tools[0]["name"], "lemlio_compile");
        assert_eq!(tools[1]["name"], "lemlio_view_pdf_page");
        assert!(tools[0]["inputSchema"]["properties"]
            .get("projectPath")
            .is_none());
        let item = json!({"type":"dynamicToolCall","id":"compile","tool":"lemlio_compile","arguments":{},"status":"completed","success":false,"contentItems":[{"type":"inputText","text":"Missing image"},{"type":"inputImage","imageUrl":"do-not-copy-image-into-history"}]});
        assert_eq!(
            item_messages(&item, false)[0]["message"]["content"][0]["name"],
            "lemlio_compile"
        );
        let result = item_messages(&item, true);
        assert_eq!(
            result[0]["message"]["content"][0]["content"],
            "Missing image"
        );
        assert_eq!(result[0]["message"]["content"][0]["is_error"], true);
    }
    #[test]
    fn normalizes_text_and_command_failures() {
        assert_eq!(
            item_messages(
                &json!({"type":"agentMessage","id":"a","text":"Hello"}),
                true
            )[0]["message"]["content"][0]["text"],
            "Hello"
        );
        assert!(item_messages(&json!({"type":"agentMessage"}), false).is_empty());
        let item = json!({"type":"commandExecution","id":"b","command":"python plot.py","aggregatedOutput":"failed","status":"failed"});
        assert_eq!(
            item_messages(&item, false)[0]["message"]["content"][0]["name"],
            "Bash"
        );
        assert_eq!(
            item_messages(&item, true)[0]["message"]["content"][0]["is_error"],
            true
        );
    }
    #[test]
    fn matches_each_file_change_to_its_result() {
        let item = json!({"type":"fileChange","id":"patch","changes":[{"path":"main.tex"},{"path":"refs.bib"}],"status":"completed"});
        let started = item_messages(&item, false);
        let finished = item_messages(&item, true);
        assert_eq!(started.len(), 2);
        for i in 0..2 {
            assert_eq!(
                started[i]["message"]["content"][0]["id"],
                finished[i]["message"]["content"][0]["tool_use_id"]
            );
        }
    }
}
