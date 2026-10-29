use std::path::{Path, PathBuf};

fn converter() -> Option<PathBuf> {
    ["gswin64c", "gswin32c", "mgs", "gs"]
        .into_iter()
        .find_map(|name| which::which(name).ok())
        .or_else(|| {
            ["/opt/homebrew/bin/gs", "/usr/local/bin/gs"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
                .or_else(|| {
                    dirs::data_local_dir()
                        .map(|p| p.join("Programs/MiKTeX/miktex/bin/x64/mgs.exe"))
                        .filter(|p| p.is_file())
                })
        })
}

/// Convert EPS assets only inside the already isolated build tree.
pub fn prepare(root: &Path) -> Result<(), String> {
    let entries = crate::projects::project_entries(root)?;
    let eps: Vec<_> = entries
        .iter()
        .filter(|(p, folder)| {
            !folder && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("eps"))
        })
        .map(|(p, _)| p.clone())
        .collect();
    if eps.is_empty() {
        return Ok(());
    }
    let binary = converter();
    let mut replaced = std::collections::HashSet::new();
    for relative in eps {
        let source = root.join(&relative);
        let destination = source.with_extension("pdf");
        if !destination.is_file() {
            let Some(binary) = &binary else {
                continue;
            };
            let mut command = std::process::Command::new(binary);
            command
                .args([
                    "-dSAFER",
                    "-dBATCH",
                    "-dNOPAUSE",
                    "-dEPSCrop",
                    "-sDEVICE=pdfwrite",
                ])
                .arg(format!("-sOutputFile={}", destination.to_string_lossy()))
                .arg("-f")
                .arg(&source);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command
                .output()
                .map_err(|e| format!("Cannot convert EPS figure: {e}"))?;
            if !output.status.success() {
                continue;
            }
        }
        if std::fs::read(&destination).is_ok_and(|bytes| bytes.starts_with(b"%PDF-")) {
            replaced.insert(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    if replaced.is_empty() {
        return Ok(());
    }
    let command = regex::Regex::new(r"(\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{)([^}]+)(\})")
        .map_err(|e| e.to_string())?;
    for (relative, folder) in entries {
        if folder
            || !relative.extension().is_some_and(|e| {
                ["tex", "sty", "cls"]
                    .iter()
                    .any(|ext| e.eq_ignore_ascii_case(ext))
            })
        {
            continue;
        }
        let path = root.join(&relative);
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        let updated = command.replace_all(&source, |found: &regex::Captures| {
            let name = found[2].trim().replace('\\', "/");
            let direct = root.join(&name);
            let beside = path.parent().unwrap_or(root).join(&name);
            let replacement = [&direct, &beside]
                .into_iter()
                .filter_map(|p| std::fs::canonicalize(p).ok())
                .find_map(|p| {
                    p.strip_prefix(root)
                        .ok()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                });
            if replacement.is_some_and(|p| replaced.contains(&p)) {
                let pdf = Path::new(&name)
                    .with_extension("pdf")
                    .to_string_lossy()
                    .replace('\\', "/");
                format!("{}{}{}", &found[1], pdf, &found[3])
            } else {
                found[0].to_string()
            }
        });
        if updated != source {
            std::fs::write(path, updated.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_matching_pdf_in_the_stage_without_changing_other_graphics_or_lines() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir(root.join("logos")).unwrap();
        std::fs::write(root.join("logos/logo.eps"), "EPS bytes").unwrap();
        std::fs::write(root.join("logos/logo.pdf"), b"%PDF-1.4\n").unwrap();
        let source = "\\includegraphics[height=7cm]{logos/logo.eps}\n\\includegraphics{photo.png}";
        std::fs::write(root.join("main.tex"), source).unwrap();
        super::prepare(&root).unwrap();
        let updated = std::fs::read_to_string(root.join("main.tex")).unwrap();
        assert_eq!(updated, source.replace("logos/logo.eps", "logos/logo.pdf"));
        assert_eq!(
            std::fs::read_to_string(root.join("logos/logo.eps")).unwrap(),
            "EPS bytes"
        );
    }
}
