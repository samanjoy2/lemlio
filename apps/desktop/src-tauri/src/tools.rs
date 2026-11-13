//! User-added AI tools. Python tools live in ONE shared environment under the
//! app data directory (created lazily, never inside a project). Nothing is
//! downloaded or run until the user has seen the exact steps and confirmed.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ToolSpec {
    /// Stable slug derived from the name.
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// When and how the AI should use this tool (shown to the AI).
    pub description: String,
    /// "git" (repository URL), "package" (pip/uv package) or "command" (already installed).
    pub kind: String,
    /// git URL, package requirement, or empty for "command".
    #[serde(default)]
    pub source: String,
    /// Executable the AI runs, e.g. `aclpubcheck` (a Python console script in the
    /// shared environment, or any command on the PATH / absolute path).
    pub command: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn yes() -> bool {
    true
}

#[derive(Serialize)]
pub struct InstallPreview {
    /// Human-readable steps, exactly what `tools_install` will execute.
    pub steps: Vec<String>,
    pub warning: String,
    pub needs_uv: bool,
}

struct Step {
    program: String,
    args: Vec<String>,
}
impl Step {
    fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .map(|a| {
                if a.contains(' ') {
                    format!("\"{a}\"")
                } else {
                    a.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn tools_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?
        .join("tools"))
}
pub fn env_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(tools_root(app)?.join("env"))
}
pub fn env_bin_dir(app: &AppHandle) -> Option<PathBuf> {
    env_dir(app).ok().map(|d| crate::uv::venv_bin_dir(&d))
}

fn slug(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    s.split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Validate and normalise a user-supplied spec. Pure, so it is unit-tested.
pub fn validate(mut spec: ToolSpec) -> Result<ToolSpec, String> {
    spec.name = spec.name.trim().to_string();
    spec.description = spec.description.trim().to_string();
    spec.source = spec.source.trim().to_string();
    spec.command = spec.command.trim().to_string();
    if spec.name.is_empty() || spec.name.chars().count() > 40 {
        return Err("Give the tool a name of up to 40 characters".into());
    }
    spec.id = slug(&spec.name);
    if spec.id.is_empty() {
        return Err("The tool name needs letters or digits".into());
    }
    if spec.description.is_empty() || spec.description.chars().count() > 600 {
        return Err("Describe when the AI should use it (up to 600 characters)".into());
    }
    if spec.command.is_empty()
        || spec.command.chars().count() > 300
        || spec.command.contains(['\n', '\r', '"', '`', '$', ';', '&', '|', '<', '>'])
    {
        return Err("The command must be a single program name or path, without shell characters".into());
    }
    match spec.kind.as_str() {
        "git" => {
            let ok = spec.source.starts_with("https://")
                && !spec.source.contains(char::is_whitespace)
                && !spec.source.contains(['"', '`', '$', ';', '&', '|', '<', '>'])
                && spec.source.len() > 12;
            if !ok {
                return Err("Use an https:// git repository URL".into());
            }
        }
        "package" => {
            let s = &spec.source;
            let ok = !s.is_empty()
                && s.len() <= 120
                && !s.starts_with('-')
                && !s.contains("://")
                && s.chars().all(|c| {
                    c.is_ascii_alphanumeric() || "._-[],=<>!~".contains(c)
                });
            if !ok {
                return Err("Use a package name such as aclpubcheck or pkg==1.2".into());
            }
        }
        "command" => spec.source.clear(),
        _ => return Err("Unknown tool type".into()),
    }
    Ok(spec)
}

fn install_steps(spec: &ToolSpec, uv: &str, env: &Path) -> Vec<Step> {
    if spec.kind == "command" {
        return vec![];
    }
    let python = crate::uv::venv_python(env).to_string_lossy().to_string();
    let target = if spec.kind == "git" {
        format!("git+{}", spec.source)
    } else {
        spec.source.clone()
    };
    let mut steps = vec![];
    if !crate::uv::venv_python(env).exists() {
        steps.push(Step {
            program: uv.into(),
            args: vec!["venv".into(), env.to_string_lossy().to_string()],
        });
    }
    steps.push(Step {
        program: uv.into(),
        args: vec!["pip".into(), "install".into(), "--python".into(), python, target],
    });
    steps
}

fn load(app: &AppHandle) -> Vec<ToolSpec> {
    tools_root(app)
        .ok()
        .and_then(|d| std::fs::read(d.join("tools.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn save(app: &AppHandle, tools: &[ToolSpec]) -> Result<(), String> {
    let root = tools_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let tmp = root.join("tools.json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(tools).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, root.join("tools.json")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tools_list(app: AppHandle) -> Vec<ToolSpec> {
    load(&app)
}

#[tauri::command]
pub fn tools_preview(app: AppHandle, spec: ToolSpec) -> Result<InstallPreview, String> {
    let spec = validate(spec)?;
    let uv = crate::uv::find_uv_binary()?;
    let steps = install_steps(&spec, &uv, &env_dir(&app)?);
    let warning = match spec.kind.as_str() {
        "command" => "Nothing will be downloaded. The AI will be allowed to run this command on your computer.".to_string(),
        _ => "This downloads third-party code and installs it into Lemlio's shared tools environment. Installing can run code from that package. The AI may then run it on your computer. Only continue if you trust the source.".to_string(),
    };
    Ok(InstallPreview {
        steps: steps.iter().map(Step::display).collect(),
        warning,
        needs_uv: spec.kind != "command",
    })
}

/// Install (if needed) and register a tool. The UI calls this only after the
/// user confirmed the steps returned by `tools_preview`.
#[tauri::command]
pub async fn tools_install(app: AppHandle, spec: ToolSpec) -> Result<ToolSpec, String> {
    let spec = validate(spec)?;
    let env = env_dir(&app)?;
    if spec.kind != "command" {
        let uv = crate::uv::find_uv_binary()?;
        if which::which(&uv).is_err() && !Path::new(&uv).is_file() {
            return Err("uv is required to install tools. Install it first, then try again.".into());
        }
        std::fs::create_dir_all(tools_root(&app)?).map_err(|e| e.to_string())?;
        for step in install_steps(&spec, &uv, &env) {
            let mut cmd = tokio::process::Command::new(&step.program);
            cmd.args(&step.args).kill_on_drop(true);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            let out = tokio::time::timeout(std::time::Duration::from_secs(900), cmd.output())
                .await
                .map_err(|_| "Installation timed out".to_string())?
                .map_err(|e| format!("Could not run {}: {e}", step.program))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                let tail: String = err.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
                return Err(format!("`{}` failed:\n{}", step.display(), tail.trim()));
            }
        }
    }
    let mut tools = load(&app);
    tools.retain(|t| t.id != spec.id);
    tools.push(spec.clone());
    save(&app, &tools)?;
    Ok(spec)
}

#[tauri::command]
pub fn tools_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let mut tools = load(&app);
    tools
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("Tool not found")?
        .enabled = enabled;
    save(&app, &tools)
}

/// Unregisters a tool. Installed packages stay in the shared environment.
#[tauri::command]
pub fn tools_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mut tools = load(&app);
    tools.retain(|t| t.id != id);
    save(&app, &tools)
}

/// Prompt section describing enabled tools to either assistant.
pub fn prompt_section(app: &AppHandle) -> String {
    describe(&load(app), env_bin_dir(app).as_deref())
}
pub fn describe(tools: &[ToolSpec], bin: Option<&Path>) -> String {
    let enabled: Vec<_> = tools.iter().filter(|t| t.enabled).collect();
    let mut text = String::from(
        "Python environment: do not create per-project virtual environments or install packages into the project. Reuse a project's existing .venv only if it already has one.",
    );
    if enabled.is_empty() {
        return text;
    }
    if let Some(bin) = bin {
        text.push_str(&format!(
            " User-added tools are installed in the shared environment whose executables are in {} (already on PATH).",
            bin.display()
        ));
    }
    text.push_str("\nTools the user added (run them from the terminal when their description fits; show the user the result):");
    for t in enabled {
        text.push_str(&format!("\n- {} — run as `{}`. {}", t.name, t.command, t.description));
    }
    text
}
/// Commands Claude Code may run without asking, one per enabled tool.
pub fn allowed_commands(app: &AppHandle) -> Vec<String> {
    load(app)
        .into_iter()
        .filter(|t| t.enabled)
        .map(|t| t.command)
        .collect()
}

/// Screenshots come only from the user's explicit action in the chat composer.
/// Accept PNG/JPEG data URLs only, a few at a time, with a size cap.
pub fn validate_images(images: Option<Vec<String>>) -> Result<Vec<(String, String)>, String> {
    let images = images.unwrap_or_default();
    if images.len() > 4 {
        return Err("At most 4 images can be attached to one message".into());
    }
    images
        .into_iter()
        .map(|url| {
            let (mime, data) = if let Some(d) = url.strip_prefix("data:image/png;base64,") {
                ("image/png", d)
            } else if let Some(d) = url.strip_prefix("data:image/jpeg;base64,") {
                ("image/jpeg", d)
            } else {
                return Err("Only PNG or JPEG images can be attached".to_string());
            };
            if data.is_empty() || data.len() > 12 * 1024 * 1024 {
                return Err("The attached image is empty or larger than 9 MB".to_string());
            }
            if !data.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) {
                return Err("The attached image is not valid base64".to_string());
            }
            Ok((mime.to_string(), data.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn image_validation() {
        assert!(validate_images(None).unwrap().is_empty());
        assert_eq!(validate_images(Some(vec!["data:image/png;base64,AAAA".into()])).unwrap()[0].0, "image/png");
        assert!(validate_images(Some(vec!["https://x/y.png".into()])).is_err());
        assert!(validate_images(Some(vec!["data:image/png;base64,A\"<".into()])).is_err());
        assert!(validate_images(Some(vec!["data:image/png;base64,AA".into(); 5])).is_err());
    }
    use super::*;
    fn spec(kind: &str, source: &str) -> ToolSpec {
        ToolSpec {
            id: String::new(),
            name: "ACL Pub Check".into(),
            description: "Check paper format".into(),
            kind: kind.into(),
            source: source.into(),
            command: "aclpubcheck".into(),
            enabled: true,
        }
    }
    #[test]
    fn validates_sources() {
        let ok = validate(spec("git", "https://github.com/acl-org/aclpubcheck.git")).unwrap();
        assert_eq!(ok.id, "acl-pub-check");
        assert!(validate(spec("git", "git@github.com:a/b.git")).is_err());
        assert!(validate(spec("git", "https://x.com/a b")).is_err());
        assert!(validate(spec("package", "aclpubcheck==1.0")).is_ok());
        assert!(validate(spec("package", "--index-url=evil")).is_err());
        assert!(validate(spec("package", "https://evil/x.whl")).is_err());
        assert!(validate(spec("package", "a; rm -rf")).is_err());
        let mut c = spec("command", "ignored");
        c.command = "echo hi && calc".into();
        assert!(validate(c).is_err());
        assert!(validate(spec("other", "x")).is_err());
    }
    #[test]
    fn steps_are_shared_env_and_never_in_project() {
        let s = validate(spec("git", "https://github.com/acl-org/aclpubcheck.git")).unwrap();
        let steps = install_steps(&s, "uv", Path::new("/nonexistent/env"));
        assert_eq!(steps.len(), 2);
        assert!(steps[0].display().starts_with("uv venv"));
        assert!(steps[1].display().contains("git+https://github.com/acl-org/aclpubcheck.git"));
        assert!(install_steps(&validate(spec("command", "")).unwrap(), "uv", Path::new("/e")).is_empty());
    }
    #[test]
    fn only_enabled_tools_are_described() {
        let mut a = validate(spec("package", "aclpubcheck")).unwrap();
        let mut b = a.clone();
        b.name = "Hidden".into();
        b.enabled = false;
        a.enabled = true;
        let text = describe(&[a, b], None);
        assert!(text.contains("ACL Pub Check") && !text.contains("Hidden"));
        assert!(describe(&[], None).contains("per-project"));
    }
}
