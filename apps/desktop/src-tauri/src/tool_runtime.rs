//! Application-owned Python, independent of PATH Python and other applications.
use std::path::{Path, PathBuf};
pub static RUNTIME_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn uv() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe.parent().ok_or("Cannot locate Lemlio")?;
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    [
        parent.join("resources/uv").join(name),
        parent.join("../Resources/resources/uv").join(name),
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/uv")
            .join(name),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .ok_or("Lemlio's bundled uv is missing. Reinstall Lemlio to repair Python tools.".into())
}
pub fn configure(cmd: &mut tokio::process::Command, root: &Path) {
    cmd.env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_CACHE_DIR", root.join("cache"))
        .env("UV_PYTHON_BIN_DIR", root.join("bin"))
        .env_remove("UV_PYTHON_PREFERENCE")
        .env_remove("UV_MANAGED_PYTHON")
        .env("UV_NO_CONFIG", "1")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH");
}
pub fn steps(root: &Path) -> Vec<Vec<String>> {
    // Preserve the interpreter ABI of already installed native Python packages.
    let version = std::fs::read_to_string(root.join("env/pyvenv.cfg"))
        .ok()
        .and_then(|cfg| {
            let value = cfg
                .lines()
                .find_map(|line| line.trim().strip_prefix("version_info = "))?;
            let parts: Vec<_> = value.split('.').collect();
            (parts.len() >= 2
                && parts[0] == "3"
                && !parts[1].is_empty()
                && parts[1].chars().all(|c| c.is_ascii_digit()))
            .then(|| format!("3.{}", parts[1]))
        })
        .unwrap_or_else(|| "3.12".into());
    vec![
        vec![
            "python".into(),
            "install".into(),
            "--no-bin".into(),
            version.clone(),
        ],
        vec![
            "venv".into(),
            "--managed-python".into(),
            "--python".into(),
            version,
            "--allow-existing".into(),
            root.join("env").to_string_lossy().into(),
        ],
    ]
}
pub async fn execute(root: &Path, args: &[String]) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(uv()?);
    configure(&mut cmd, root);
    cmd.args(args).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(900), cmd.output())
        .await
        .map_err(|_| "Python setup timed out")?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(3000)
            .collect());
    }
    Ok(())
}
pub async fn initialize(root: &Path, repair: bool) -> Result<(), String> {
    let _guard = RUNTIME_LOCK.lock().await;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if !repair
        && root.join("runtime-v1.json").is_file()
        && crate::uv::venv_python(&root.join("env")).is_file()
    {
        return Ok(());
    }
    for args in steps(root) {
        execute(root, &args).await?;
    }
    std::fs::write(root.join("runtime-v1.json"), b"{\"managedBy\":\"Lemlio\"}")
        .map_err(|e| e.to_string())
}

pub fn executable(spec: &crate::tools::ToolSpec, root: &Path) -> Result<PathBuf, String> {
    if spec.kind == "command" {
        return which::which(&spec.command)
            .map_err(|_| format!("Command '{}' was not found", spec.command));
    }
    // Python tools must resolve inside the managed environment, never through PATH.
    if Path::new(&spec.command).components().count() != 1 {
        return Err("Python tools must use a program name, not an external path".into());
    }
    let path = crate::uv::venv_python(&root.join("env"));
    path.is_file()
        .then_some(path)
        .ok_or("Shared Python is missing. Use Settings → Tools → Repair runtime.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn repair_preserves_an_existing_python_minor_version() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("env")).unwrap();
        std::fs::write(
            root.path().join("env/pyvenv.cfg"),
            "version_info = 3.13.7\n",
        )
        .unwrap();
        assert_eq!(super::steps(root.path())[0].last().unwrap(), "3.13");
        assert!(super::steps(root.path())[1].contains(&"3.13".into()));
    }
    #[test]
    fn runtime_steps_require_app_owned_python_and_preserve_packages() {
        let steps = super::steps(std::path::Path::new("/demo/tools"));
        assert!(steps[1].contains(&"--managed-python".into()));
        assert!(steps[1].contains(&"--allow-existing".into()));
        assert!(!steps[1].contains(&"--clear".into()));
        assert!(steps[0].contains(&"--no-bin".into()));
        let mut command = tokio::process::Command::new("uv");
        super::configure(&mut command, std::path::Path::new("/demo/tools"));
        assert!(command
            .as_std()
            .get_envs()
            .any(|(key, value)| key == "UV_PYTHON_PREFERENCE" && value.is_none()));
    }
}
