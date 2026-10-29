use std::path::{Path, PathBuf};

fn checked_target(path: &Path, protected: &[PathBuf]) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || std::fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("Select the actual project folder, not a link".into());
    }
    let target = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !target.is_dir()
        || target.parent().is_none()
        || protected
            .iter()
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .any(|p| target == p || p.starts_with(&target))
    {
        return Err("This system or library folder cannot be deleted as a project".into());
    }
    Ok(target)
}

fn recycle_script(path: &Path) -> String {
    let path = path
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\'', "''");
    format!("$ErrorActionPreference='Stop';Add-Type -AssemblyName Microsoft.VisualBasic;[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('{path}',[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)")
}

#[tauri::command]
pub async fn delete_project(project_path: String) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err(
            "Move this project to your system Trash, then remove it from recent projects".into(),
        );
    }
    tokio::task::spawn_blocking(move || {
        let protected: Vec<_> = [dirs::home_dir(), dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir(), dirs::config_dir(), dirs::data_local_dir()]
            .into_iter().flatten().chain([crate::projects::library_root()?]).collect();
        let library = crate::projects::library_root()?;
        let mut protected = protected;
        protected.extend([library.join("Imports"), library.join("Archives")]);
        let target = checked_target(Path::new(&project_path), &protected)?;
        let script = recycle_script(&target);
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded]);
        #[cfg(target_os = "windows")]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let result = command.output().map_err(|_| "Cannot open Windows Recycle Bin")?;
        if !result.status.success() || target.exists() {
            return Err("Windows could not move this project to the Recycle Bin. Close files using it and try again.".into());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_protected_folders_and_their_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        let protected = temp.path().join("Projects/Imports");
        let project = protected.join("Paper");
        std::fs::create_dir_all(&project).unwrap();
        assert!(checked_target(temp.path(), &[protected.clone()]).is_err());
        assert!(checked_target(&protected, &[protected.clone()]).is_err());
        assert!(checked_target(&project, &[protected]).is_ok());
        assert!(checked_target(Path::new("relative"), &[]).is_err());
    }
    #[test]
    fn recycle_script_quotes_names_as_literals() {
        let script = recycle_script(Path::new("C:/Papers/Jo's $notes"));
        assert!(script.contains("'C:/Papers/Jo''s $notes'"));
        assert!(script.contains("SendToRecycleBin"));
        assert!(!script.contains("DeletePermanently"));
    }
}
