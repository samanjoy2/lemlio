//! Short commands for AI assistants, so they never have to quote a long path.
//!
//! `lemlio-compile main.tex` runs from the project folder. It sits on the PATH the
//! assistant is started with, so it works the same from PowerShell and Git Bash, and
//! one allow-list entry covers it. The command is a thin wrapper around the app's own
//! `--compile-project` mode, which tries Tectonic first and falls back to an installed
//! system TeX by itself when a document needs fonts Tectonic cannot build.
use std::path::{Path, PathBuf};

pub const COMPILE: &str = "lemlio-compile";

/// The Windows and Unix versions of the compile command for the app at `exe`.
pub fn compile_scripts(exe: &str) -> (String, String) {
    let windows = exe.replace('/', "\\");
    let unix = exe.replace('\\', "/");
    let cmd = format!(
        "@echo off\r\n\
         if \"%~1\"==\"\" (\r\n\
         \x20 echo Usage: {COMPILE} ^<main.tex^> [--system]\r\n\
         \x20 exit /b 2\r\n\
         )\r\n\
         if /i \"%~2\"==\"--system\" (\r\n\
         \x20 \"{windows}\" --compile-project \"%CD%\" \"%~1\"\r\n\
         ) else (\r\n\
         \x20 \"{windows}\" --compile-project \"%CD%\" \"%~1\" --tectonic\r\n\
         )\r\n\
         exit /b %ERRORLEVEL%\r\n"
    );
    let sh = format!(
        "#!/bin/sh\n\
         # Compile a LaTeX project from its folder: {COMPILE} <main.tex> [--system]\n\
         if [ -z \"$1\" ]; then echo \"Usage: {COMPILE} <main.tex> [--system]\" >&2; exit 2; fi\n\
         DIR=\"$(pwd -W 2>/dev/null || pwd)\"\n\
         if [ \"$2\" = \"--system\" ]; then\n\
         \x20 \"{unix}\" --compile-project \"$DIR\" \"$1\"\n\
         else\n\
         \x20 \"{unix}\" --compile-project \"$DIR\" \"$1\" --tectonic\n\
         fi\n\
         exit $?\n"
    );
    (cmd, sh)
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == content) {
        return Ok(());
    }
    std::fs::write(path, content)
}

/// Write the commands next to the app's data and return their folder. Cheap to call
/// before every assistant turn: files are only rewritten when the app has moved.
pub fn ensure_in(dir: &Path, exe: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let (cmd, sh) = compile_scripts(exe);
    write_if_changed(&dir.join(format!("{COMPILE}.cmd")), &cmd)?;
    let unix_path = dir.join(COMPILE);
    write_if_changed(&unix_path, &sh)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&unix_path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dir.to_path_buf())
}

/// The folder to put on an assistant's PATH, or None if it cannot be prepared.
pub fn ensure() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?.join("Lemlio").join("agent-bin");
    let exe = std::env::current_exe().ok()?;
    ensure_in(&dir, &exe.to_string_lossy()).ok()
}

/// Claude Code allow-list entries for the compile command and the app itself, for both
/// of its shell tools and every way a path to the app is commonly written.
pub fn allow_rules(exe: &str) -> Vec<String> {
    let windows = exe.replace('/', "\\");
    let forward = exe.replace('\\', "/");
    let mut spellings = vec![COMPILE.to_string(), windows, forward.clone()];
    // Git Bash writes C:/Users/me/app.exe as /c/Users/me/app.exe.
    if let Some((drive, rest)) = forward.split_once(":/") {
        if drive.len() == 1 {
            spellings.push(format!("/{}/{rest}", drive.to_lowercase()));
        }
    }
    spellings.sort();
    spellings.dedup();
    spellings
        .into_iter()
        .flat_map(|s| [format!("Bash({s}:*)"), format!("PowerShell({s}:*)")])
        .collect()
}

/// A permission rule the user approved in the chat. Only plain Bash and PowerShell
/// commands, one line, and never a bare wildcard.
pub fn valid_user_rule(rule: &str) -> bool {
    let inner = rule
        .strip_prefix("Bash(")
        .or_else(|| rule.strip_prefix("PowerShell("))
        .and_then(|r| r.strip_suffix(')'));
    let Some(inner) = inner else {
        return false;
    };
    let trimmed = inner.trim();
    !trimmed.is_empty()
        && trimmed != "*"
        && trimmed != ":*"
        && rule.len() <= 600
        && !rule.contains('\n')
        && !rule.contains('\r')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compile_command_uses_tectonic_unless_the_system_compiler_is_asked_for() {
        let (cmd, sh) = compile_scripts("C:/Users/me/AppData/Local/Lemlio/prismpro-desktop.exe");
        assert!(cmd.contains("\"C:\\Users\\me\\AppData\\Local\\Lemlio\\prismpro-desktop.exe\" --compile-project \"%CD%\" \"%~1\" --tectonic"));
        assert!(cmd.contains("--system"));
        assert!(cmd.contains("\r\n"));
        assert!(sh.starts_with("#!/bin/sh\n"));
        assert!(sh.contains("\"C:/Users/me/AppData/Local/Lemlio/prismpro-desktop.exe\" --compile-project \"$DIR\" \"$1\" --tectonic"));
    }

    #[test]
    fn commands_are_written_once_and_follow_the_app_when_it_moves() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("agent-bin");
        ensure_in(&dir, "C:/a/app.exe").unwrap();
        let before = std::fs::metadata(dir.join("lemlio-compile.cmd"))
            .unwrap()
            .modified()
            .unwrap();
        ensure_in(&dir, "C:/a/app.exe").unwrap();
        assert_eq!(
            before,
            std::fs::metadata(dir.join("lemlio-compile.cmd"))
                .unwrap()
                .modified()
                .unwrap()
        );
        ensure_in(&dir, "D:/b/app.exe").unwrap();
        assert!(std::fs::read_to_string(dir.join("lemlio-compile.cmd"))
            .unwrap()
            .contains("D:\\b\\app.exe"));
        assert!(dir.join("lemlio-compile").is_file());
    }

    #[test]
    #[ignore = "writes the commands for a real build so they can be run by hand"]
    fn write_commands_for_a_manual_check() {
        let out = std::env::var("LEMLIO_SHIM_OUT").unwrap();
        let exe = std::env::var("LEMLIO_SHIM_EXE").unwrap();
        ensure_in(Path::new(&out), &exe).unwrap();
    }

    #[test]
    fn the_allow_list_covers_each_shell_and_each_way_of_writing_the_app_path() {
        let rules = allow_rules("C:\\Users\\me\\AppData\\Local\\Lemlio\\prismpro-desktop.exe");
        for expected in [
            "Bash(lemlio-compile:*)",
            "PowerShell(lemlio-compile:*)",
            "Bash(/c/Users/me/AppData/Local/Lemlio/prismpro-desktop.exe:*)",
            "PowerShell(C:\\Users\\me\\AppData\\Local\\Lemlio\\prismpro-desktop.exe:*)",
            "Bash(C:/Users/me/AppData/Local/Lemlio/prismpro-desktop.exe:*)",
        ] {
            assert!(rules.iter().any(|r| r == expected), "missing {expected}");
        }
    }

    #[test]
    fn only_narrow_shell_rules_can_be_approved_from_the_chat() {
        assert!(valid_user_rule("Bash(aclpubcheck --paper_type long paper.pdf)"));
        assert!(valid_user_rule("PowerShell(Get-ChildItem latex)"));
        assert!(!valid_user_rule("Bash(*)"));
        assert!(!valid_user_rule("Bash()"));
        assert!(!valid_user_rule("Bash(:*)"));
        assert!(!valid_user_rule("Read(/etc/passwd)"));
        assert!(!valid_user_rule("Bash(echo hi\nrm -rf /)"));
        assert!(!valid_user_rule("Edit"));
    }
}
