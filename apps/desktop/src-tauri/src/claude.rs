//! Local Claude Code client. Runs the user's own `claude` CLI in headless
//! stream-json mode and re-emits its output on the same events the Codex
//! integration uses (`codex-output`, `codex-complete`), so the chat UI is
//! provider-agnostic. Credentials stay in Claude Code's own credential store.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

struct Running {
    child: Arc<Mutex<Child>>,
    window: String,
}

#[derive(Clone, Default)]
pub struct ClaudeProcessState {
    running: Arc<Mutex<HashMap<String, Running>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

fn find_claude_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CLAUDE_BINARY") {
        let path = PathBuf::from(path);
        return path
            .is_file()
            .then_some(path)
            .ok_or("CLAUDE_BINARY must point to your Claude Code executable".into());
    }
    if let Ok(path) = which::which("claude") {
        return Ok(path);
    }
    let home = dirs::home_dir().ok_or("Could not find your home directory")?;
    let mut candidates = vec![
        home.join(".claude/local/claude"),
        home.join(".local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    #[cfg(target_os = "windows")]
    {
        candidates.push(home.join(".local/bin/claude.exe"));
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm/claude.cmd"));
        }
    }
    candidates.into_iter().find(|p| p.is_file()).ok_or(
        "Claude Code was not found. Install it from https://claude.com/claude-code, or set CLAUDE_BINARY to your claude executable.".into(),
    )
}

fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.kill_on_drop(true);
    cmd
}

fn output(window: &WebviewWindow, tab: &str, msg: Value) {
    let _ = window.emit("codex-output", json!({"tab_id":tab,"data":msg.to_string()}));
}
fn complete(window: &WebviewWindow, tab: &str, success: bool) {
    let _ = window.emit("codex-complete", json!({"tab_id":tab,"success":success}));
}

#[derive(serde::Serialize)]
pub struct ClaudeStatus {
    installed: bool,
    authenticated: bool,
    binary_path: Option<String>,
    version: Option<String>,
    account_email: Option<String>,
}

#[tauri::command]
pub async fn check_claude_status() -> Result<ClaudeStatus, String> {
    let Ok(binary) = find_claude_binary() else {
        return Ok(ClaudeStatus {
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
    // `claude auth status` prints JSON ({"loggedIn":true,"email":...}) on current
    // versions. If it is unavailable or unparsable we cannot prove the user is
    // signed out, so we let them try rather than blocking the chat.
    let status = tokio::time::timeout(
        Duration::from_secs(15),
        command(&binary).args(["auth", "status"]).output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok());
    let authenticated = status
        .as_ref()
        .and_then(|s| s["loggedIn"].as_bool())
        .unwrap_or(true);
    Ok(ClaudeStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary.display().to_string()),
        version,
        account_email: status
            .as_ref()
            .and_then(|s| s["email"].as_str())
            .map(str::to_string),
    })
}

/// Runs `claude auth login`, which opens the user's browser, and reports the
/// outcome on the shared `login-complete` event.
#[tauri::command]
pub async fn login_claude(window: WebviewWindow) -> Result<String, String> {
    let binary = find_claude_binary()?;
    let mut child = command(&binary)
        .args(["auth", "login"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start Claude Code: {e}"))?;
    tokio::spawn(async move {
        let ok = tokio::time::timeout(Duration::from_secs(600), child.wait())
            .await
            .ok()
            .and_then(Result::ok)
            .is_some_and(|s| s.success());
        let _ = window.emit("login-complete", ok);
    });
    // Claude Code opens the browser itself; the UI has no URL to open.
    Ok("https://claude.ai/login".into())
}

#[tauri::command]
pub async fn list_claude_models() -> Result<Vec<Value>, String> {
    let model = |id: &str, name: &str, description: &str| {
        json!({
            "id": id, "model": id, "displayName": name, "description": description,
            "hidden": false, "supportedReasoningEfforts": []
        })
    };
    Ok(vec![
        model(
            "sonnet",
            "Claude Sonnet",
            "Fast and capable for everyday writing and edits",
        ),
        model(
            "opus",
            "Claude Opus",
            "Most capable for complex, multi-step work",
        ),
        model("haiku", "Claude Haiku", "Fastest and most economical"),
    ])
}

const INSTRUCTIONS: &str = "You are Claude inside Lemlio, a local scientific writing workspace. If the project has AGENTS.md or CLAUDE.md, read it. Preserve the existing LaTeX preamble, bibliography, and structure. Read files before editing; make small targeted edits. Explain your plan for substantial changes. Use citations and cross-references correctly; do not invent sources or research findings. Do not create Python virtual environments in the project; use the shared tools described below. Save publication-quality figures in figures/. After LaTeX edits, verify compilation with the terminal command described below, read its output, and fix errors before claiming success. Never claim a compile or visual check you have not performed. Do not assume tectonic is unavailable merely because it is not on the system PATH. Compiler-generated .prism output and compile logs are allowed. Do not manually edit .prism, .prismpro, or .venv internals. The user may attach screenshots of the app or PDF; look at them when present.";

fn instructions(main_file: Option<&str>, use_texlive: bool, tools: &str) -> String {
    let app = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    format!(
        "{INSTRUCTIONS}\nSelected main file: {}. Selected compiler: {}.\n{tools}\nCompile command: run the Lemlio binary at {app:?} with arguments --compile-project <absolute-project-directory> <relative-main.tex> --tectonic. Quote paths with spaces. Check the exit code and compiler output; omit --tectonic only for the optional system compiler. This uses the same bundled fonts and project staging as the editor.",
        main_file.unwrap_or("not selected"),
        if use_texlive {
            "optional system LaTeX"
        } else {
            "bundled Tectonic"
        }
    )
}

#[allow(clippy::too_many_arguments)]
async fn start_turn(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    session_id: Option<String>,
    model: Option<String>,
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
    let mut extra_roots: Vec<String> = vec![];
    for selected in related_projects.unwrap_or_default() {
        if extra_roots.len() >= 19 {
            return Err("A group run supports at most 20 projects".into());
        }
        let root = std::fs::canonicalize(&selected)
            .map_err(|e| format!("Cannot open grouped project: {e}"))?;
        if !root.is_dir() {
            return Err("Grouped project must be a directory".into());
        }
        crate::collaboration::manifest(&root)?;
        let value = root.to_string_lossy().to_string();
        if root != path && !extra_roots.contains(&value) {
            extra_roots.push(value);
        }
    }
    crate::collaboration::manifest(&path)?;

    let state = window.state::<ClaudeProcessState>().inner().clone();
    state.cancelled.lock().await.remove(&tab_id);
    if state.running.lock().await.contains_key(&tab_id) {
        return Err("This chat already has a running Claude turn".into());
    }

    let binary = find_claude_binary()?;
    let app = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut cmd = command(&binary);
    cmd.current_dir(&path)
        .args(["-p", "--output-format", "stream-json", "--verbose"])
        .args(["--permission-mode", "acceptEdits"])
        .arg("--append-system-prompt")
        .arg(instructions(
            main_file.as_deref(),
            use_texlive.unwrap_or(false),
            &crate::tools::prompt_section(window.app_handle()),
        ))
        .arg("--allowedTools")
        .args([
            "Read".to_string(),
            "Edit".to_string(),
            "Write".to_string(),
            "Glob".to_string(),
            "Grep".to_string(),
            format!("Bash({app}:*)"),
            "Bash(uv:*)".to_string(),
            "Bash(python:*)".to_string(),
            "Bash(python3:*)".to_string(),
            "Bash(ls:*)".to_string(),
        ])
        .args(
            crate::tools::allowed_commands(window.app_handle())
                .into_iter()
                .map(|c| format!("Bash({c}:*)")),
        );
    if !images.is_empty() {
        // Images need structured input; plain stdin text cannot carry them.
        cmd.args(["--input-format", "stream-json"]);
    }
    for root in &extra_roots {
        cmd.args(["--add-dir", root]);
    }
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        // The selected model may be left over from the Codex provider.
        if !m.starts_with("gpt-") {
            cmd.args(["--model", &m]);
        }
    }
    if let Some(id) = session_id {
        cmd.args(["--resume", &id]);
    }
    let mut extra_paths: Vec<PathBuf> = crate::tools::env_bin_dir(window.app_handle())
        .into_iter()
        .collect();
    if let Ok(tectonic) = crate::latex::tectonic_binary() {
        cmd.env("LEMLIO_TECTONIC", &tectonic);
        if let Some(parent) = tectonic.parent() {
            extra_paths.push(parent.to_path_buf());
        }
    }
    if !extra_paths.is_empty() {
        if let Some(existing) = std::env::var_os("PATH") {
            extra_paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(extra_paths) {
            cmd.env("PATH", joined);
        }
    }
    cmd.env("LEMLIO_APP", &app);
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Claude Code: {e}"))?;
    // The prompt goes over stdin so quoting and length limits never apply.
    let mut stdin = child.stdin.take().ok_or("Claude stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Claude stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("Claude stderr unavailable")?;
    let payload = if images.is_empty() {
        prompt.clone().into_bytes()
    } else {
        let mut content = vec![json!({"type":"text","text":prompt})];
        for (mime, data) in &images {
            content.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}));
        }
        let mut line = json!({"type":"user","message":{"role":"user","content":content}}).to_string();
        line.push_str("\n");
        line.into_bytes()
    };
    stdin
        .write_all(&payload)
        .await
        .map_err(|e| format!("Could not send the prompt to Claude: {e}"))?;
    drop(stdin);

    let child = Arc::new(Mutex::new(child));
    state.running.lock().await.insert(
        tab_id.clone(),
        Running {
            child: child.clone(),
            window: window.label().to_string(),
        },
    );

    tokio::spawn(async move {
        let err_task = tokio::spawn(async move {
            let mut buf = vec![];
            let _ = (&mut stderr).take(16 * 1024).read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).trim().to_string()
        });
        let mut saw_result = false;
        let mut result_ok = false;
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if msg["type"] == "result" {
                saw_result = true;
                result_ok = msg["is_error"].as_bool() != Some(true);
            }
            // The CLI also emits bookkeeping events the chat UI has no use for.
            if matches!(
                msg["type"].as_str(),
                Some("system" | "assistant" | "user" | "result")
            ) {
                output(&window, &tab_id, msg);
            }
        }
        let status = child.lock().await.wait().await;
        let stderr_text = err_task.await.unwrap_or_default();
        state.running.lock().await.remove(&tab_id);
        let was_cancelled = state.cancelled.lock().await.remove(&tab_id);
        let exited_ok = status.map(|s| s.success()).unwrap_or(false);
        if !saw_result && !was_cancelled {
            let text = if stderr_text.is_empty() {
                "Claude stopped unexpectedly. Please retry.".to_string()
            } else {
                stderr_text
            };
            output(
                &window,
                &tab_id,
                json!({"type":"result","is_error":true,"result":text}),
            );
        }
        complete(
            &window,
            &tab_id,
            saw_result && result_ok && exited_ok && !was_cancelled,
        );
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn execute_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    #[allow(unused_variables)] effort_level: Option<String>,
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
        main_file,
        use_texlive,
        related_projects,
        images,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn resume_claude_code(
    window: WebviewWindow,
    project_path: String,
    session_id: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    #[allow(unused_variables)] effort_level: Option<String>,
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
        main_file,
        use_texlive,
        related_projects,
        images,
    )
    .await
}

#[tauri::command]
pub async fn cancel_claude_execution(window: WebviewWindow, tab_id: String) -> Result<(), String> {
    let state = window.state::<ClaudeProcessState>().inner().clone();
    let child = state
        .running
        .lock()
        .await
        .get(&tab_id)
        .map(|r| r.child.clone());
    if let Some(child) = child {
        state.cancelled.lock().await.insert(tab_id);
        let _ = child.lock().await.start_kill();
    }
    Ok(())
}

/// Claude Code keeps transcripts in ~/.claude/projects/<cwd with every
/// non-alphanumeric character replaced by '-'>/<session-id>.jsonl.
fn sessions_dir(project_path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(project_path).map_err(|e| e.to_string())?;
    let mut text = canonical.to_string_lossy().to_string();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        text = stripped.to_string();
    }
    let encoded: String = text
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Ok(dirs::home_dir()
        .ok_or("Could not find your home directory")?
        .join(".claude/projects")
        .join(encoded))
}

fn user_text(entry: &Value) -> Option<String> {
    let content = &entry["message"]["content"];
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else {
        content.as_array()?.iter().find(|b| b["type"] == "text")?["text"]
            .as_str()?
            .to_string()
    };
    (!text.trim().is_empty() && !text.trim_start().starts_with('<')).then_some(text)
}

#[derive(serde::Serialize)]
pub struct ClaudeSessionInfo {
    session_id: String,
    title: String,
    last_modified: i64,
}

#[tauri::command]
pub async fn list_claude_sessions(project_path: String) -> Result<Vec<ClaudeSessionInfo>, String> {
    let dir = sessions_dir(&project_path)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(vec![]);
    };
    let mut sessions = vec![];
    for entry in entries.flatten() {
        let file = entry.path();
        if file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = file
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let title = std::fs::File::open(&file)
            .ok()
            .and_then(|f| {
                use std::io::BufRead;
                std::io::BufReader::new(f)
                    .lines()
                    .take(200)
                    .map_while(Result::ok)
                    .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
                    .filter(|e| e["type"] == "user" && e["isSidechain"] != true)
                    .find_map(|e| user_text(&e))
            })
            .map(|t| t.chars().take(100).collect::<String>());
        // Sessions with no user prompt are empty or internal; skip them.
        if let Some(title) = title {
            sessions.push(ClaudeSessionInfo {
                session_id: id,
                title,
                last_modified: modified,
            });
        }
    }
    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    sessions.truncate(100);
    Ok(sessions)
}

#[tauri::command]
pub async fn load_claude_session_history(
    project_path: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    if !session_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid session ID".into());
    }
    let file = sessions_dir(&project_path)?.join(format!("{session_id}.jsonl"));
    let text = std::fs::read_to_string(&file)
        .map_err(|e| format!("Could not read this Claude chat: {e}"))?;
    let mut messages = vec![];
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = entry["type"].as_str().unwrap_or("");
        if !matches!(kind, "user" | "assistant")
            || entry["isSidechain"] == true
            || entry["isMeta"] == true
        {
            continue;
        }
        let mut content = entry["message"]["content"].clone();
        if let Some(s) = content.as_str() {
            content = json!([{"type":"text","text":s}]);
        }
        if content.as_array().map_or(true, |a| a.is_empty()) {
            continue;
        }
        messages.push(json!({"type":kind,"message":{"content":content}}));
    }
    Ok(messages)
}

pub async fn kill_process_for_window(state: &ClaudeProcessState, window_label: &str) {
    let mut running = state.running.lock().await;
    let tabs: Vec<_> = running
        .iter()
        .filter(|(_, r)| r.window == window_label)
        .map(|(tab, _)| tab.clone())
        .collect();
    for tab in tabs {
        if let Some(r) = running.remove(&tab) {
            let _ = r.child.lock().await.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plain_and_block_user_text() {
        assert_eq!(
            user_text(&json!({"message":{"content":"hello"}})).as_deref(),
            Some("hello")
        );
        assert_eq!(
            user_text(&json!({"message":{"content":[{"type":"text","text":"hi"}]}})).as_deref(),
            Some("hi")
        );
        assert!(
            user_text(&json!({"message":{"content":"<command-name>x</command-name>"}})).is_none()
        );
        assert!(user_text(&json!({"message":{"content":[{"type":"tool_result"}]}})).is_none());
    }

    #[test]
    fn session_directory_replaces_non_alphanumerics() {
        let dir = tempfile::tempdir().unwrap();
        let encoded = sessions_dir(dir.path().to_str().unwrap()).unwrap();
        let name = encoded.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }
}
