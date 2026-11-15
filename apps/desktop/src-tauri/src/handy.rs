//! Optional control of the user's separately installed Handy application.
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;

fn executable(custom: Option<String>) -> Option<PathBuf> {
    if let Some(custom) = custom.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(custom);
        return path.is_file().then_some(path);
    }
    let mut candidates = vec![];
    if let Some(local) = dirs::data_local_dir() {
        candidates.extend([
            local.join("Handy/Handy.exe"),
            local.join("Programs/Handy/Handy.exe"),
        ]);
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(programs).join("Handy/Handy.exe"));
    }
    candidates.push(PathBuf::from(
        "/Applications/Handy.app/Contents/MacOS/Handy",
    ));
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications/Handy.app/Contents/MacOS/Handy"));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .or_else(|| which::which("Handy").ok())
        .or_else(|| which::which("handy").ok())
}

fn running() -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("tasklist.exe");
        cmd.args(["/FI", "IMAGENAME eq Handy.exe", "/NH"])
            .creation_flags(0x08000000);
        cmd.output().is_ok_and(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_lowercase()
                .contains("handy.exe")
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        ["Handy", "handy"].iter().any(|name| {
            std::process::Command::new("pgrep")
                .args(["-x", name])
                .output()
                .is_ok_and(|o| o.status.success())
        })
    }
}

#[tauri::command]
pub fn check_handy_status(executable_path: Option<String>) -> serde_json::Value {
    let path = executable(executable_path);
    serde_json::json!({"available": path.is_some(), "running": path.is_some() && running(), "path": path})
}

#[tauri::command]
pub fn handy_control(action: String, executable_path: Option<String>) -> Result<(), String> {
    if !["open", "toggle", "cancel"].contains(&action.as_str()) {
        return Err("Unsupported Handy action".into());
    }
    let path = executable(executable_path).ok_or("Handy is not installed or its executable cannot be found. Open Settings → Voice to set it up.")?;
    if action != "open" && !running() {
        return Err("Open Handy from Settings → Voice first, download a speech model, and finish its microphone/accessibility setup. Then return to the prompt and try again.".into());
    }
    let mut cmd = std::process::Command::new(path);
    match action.as_str() {
        "toggle" => {
            cmd.arg("--toggle-transcription");
        }
        "cancel" => {
            cmd.arg("--cancel");
        }
        _ => {}
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot control Handy: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_actions_and_missing_custom_executable() {
        assert!(handy_control("unexpected".into(), None).is_err());
        assert!(
            !check_handy_status(Some("Z:/missing-handydemo/Handy.exe".into()))["available"]
                .as_bool()
                .unwrap()
        );
    }
}
