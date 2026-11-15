//! Resolve named OpenType fonts from portable files, never from the host's font list.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

fn be16(data: &[u8], pos: usize) -> Option<usize> {
    Some(u16::from_be_bytes(data.get(pos..pos + 2)?.try_into().ok()?) as usize)
}
fn be32(data: &[u8], pos: usize) -> Option<usize> {
    Some(u32::from_be_bytes(data.get(pos..pos + 4)?.try_into().ok()?) as usize)
}

/// OpenType name table: family, subfamily, full name, PostScript name, typographic family.
fn names(data: &[u8]) -> Option<BTreeMap<usize, String>> {
    let count = be16(data, 4)?.min(256);
    let mut offset = None;
    for index in 0..count {
        let record = 12 + index * 16;
        if data.get(record..record + 4)? == b"name" {
            offset = be32(data, record + 8);
            break;
        }
    }
    let start = offset?;
    let strings = start.checked_add(be16(data, start + 4)?)?;
    let mut result = BTreeMap::new();
    for index in 0..be16(data, start + 2)?.min(4096) {
        let record = start + 6 + index * 12;
        let platform = be16(data, record)?;
        let id = be16(data, record + 6)?;
        if ![1, 2, 4, 6, 16, 17].contains(&id) {
            continue;
        }
        let length = be16(data, record + 8)?;
        let pos = strings.checked_add(be16(data, record + 10)?)?;
        let value = data.get(pos..pos.checked_add(length)?)?;
        let value = if platform == 0 || platform == 3 {
            String::from_utf16(
                &value
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            )
            .ok()?
        } else {
            String::from_utf8_lossy(value).into_owned()
        };
        if !value.is_empty() {
            result.entry(id).or_insert(value);
        }
    }
    Some(result)
}

fn scan_fonts(root: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 12 || files.len() > 2048 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with('.')
                && !matches!(name.as_ref(), "node_modules" | "target" | "dist")
            {
                scan_fonts(&path, depth + 1, files);
            }
        } else if path
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("otf") || x.eq_ignore_ascii_case("ttf"))
        {
            files.push(path);
        }
    }
}

pub fn prepare(root: &Path, main: &Path) -> Result<(), String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let linked = regex::Regex::new(r"\\(?:input|include|usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}").unwrap();
    let requested = regex::Regex::new(r"\\(?:setmainfont|setsansfont|setmonofont|fontspec|IfFontExistsTF)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}|\\newfontfamily\s*\\[a-zA-Z]+\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}").unwrap();
    let mut pending = vec![main.to_path_buf()];
    let mut visited = BTreeSet::new();
    let mut requirements = BTreeSet::new();
    while let Some(path) = pending.pop() {
        let Ok(path) = std::fs::canonicalize(path) else {
            continue;
        };
        if !path.starts_with(&root) || !visited.insert(path.clone()) {
            continue;
        }
        if visited.len() > 2048 {
            return Err("Too many linked font configuration files".into());
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        let source = crate::latex_compat::uncomment(&source);
        let faces = regex::Regex::new(
            r"(?:BoldFont|ItalicFont|BoldItalicFont|SmallCapsFont)\s*=\s*\{?([^,}\]\n]+)",
        )
        .unwrap();
        for face in faces.captures_iter(&source) {
            let face = face[1].trim();
            if !face.ends_with(".otf") && !face.ends_with(".ttf") {
                return Err(format!("Font face '{face}' must use an explicit .otf/.ttf file included in this project, rather than a system font name."));
            }
            requirements.insert(face.to_string());
        }
        for capture in requested.captures_iter(&source) {
            let name = capture
                .get(1)
                .or_else(|| capture.get(2))
                .unwrap()
                .as_str()
                .trim();
            if name.contains(['\\', '#', '{', '}']) {
                return Err("Cannot verify a dynamically constructed font name. Use an explicit project .otf/.ttf filename with fontspec's Path option so compilation is portable.".into());
            }
            requirements.insert(name.to_string());
        }
        for capture in linked.captures_iter(&source) {
            for name in capture[1].split(',').map(str::trim) {
                if name.contains(['\\', '#', '{', '}']) {
                    continue;
                }
                for base in [
                    path.parent().unwrap_or(&root),
                    main.parent().unwrap_or(&root),
                    root.as_path(),
                ] {
                    for suffix in ["", ".tex", ".sty", ".cls"] {
                        let next = base.join(format!("{name}{suffix}"));
                        if next.is_file() {
                            pending.push(next);
                        }
                    }
                }
            }
        }
    }
    if requirements.is_empty() {
        return Ok(());
    }
    let mut files = Vec::new();
    scan_fonts(&root, 0, &mut files);
    files.sort();
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = executable.parent().ok_or("Cannot find bundled fonts")?;
    for base in [
        parent.join("resources/tectonic/fonts"),
        parent.join("../Resources/resources/tectonic/fonts"),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/tectonic/fonts"),
    ] {
        let mut bundled = Vec::new();
        scan_fonts(&base, 0, &mut bundled);
        bundled.sort();
        for path in bundled {
            if !files.contains(&path) {
                files.push(path);
            }
        }
    }
    let indexed: Vec<_> = files
        .iter()
        .filter_map(|path| {
            let data = std::fs::read(path).ok()?;
            Some((path, names(&data)?))
        })
        .collect();
    let destination = main
        .parent()
        .ok_or("Cannot locate main file")?
        .join(".lemlio-fonts");
    std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let mut rules = String::from("\\AddToHook{package/fontspec/after}{");
    for name in requirements {
        if name.ends_with(".otf") || name.ends_with(".ttf") {
            if files.iter().any(|p| {
                p.file_name().is_some_and(|f| {
                    f.to_string_lossy()
                        .eq_ignore_ascii_case(name.rsplit('/').next().unwrap_or(&name))
                })
            }) {
                continue;
            }
            return Err(format!("Required font file '{name}' is not included. Add it to this project's fonts folder and use fontspec's Path option."));
        }
        let candidates: Vec<_> = indexed
            .iter()
            .filter(|(_, names)| {
                names
                    .values()
                    .any(|value| value.eq_ignore_ascii_case(&name))
            })
            .collect();
        if candidates.is_empty() {
            return Err(format!("Required font '{name}' is not included with this project or Lemlio. Add the exact .otf/.ttf files to the project's fonts folder (with permission to use them), then recompile. System fonts and substitute fonts are not used automatically."));
        }
        let mut styles = BTreeMap::new();
        for (path, names) in candidates {
            let style = names
                .get(&17)
                .or_else(|| names.get(&2))
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            let key = match (
                style.contains("bold"),
                style.contains("italic") || style.contains("oblique"),
            ) {
                (false, false) => "UprightFont",
                (true, false) => "BoldFont",
                (false, true) => "ItalicFont",
                (true, true) => "BoldItalicFont",
            };
            // Generated filenames avoid TeX-special characters in arbitrary project paths.
            let id = indexed.iter().position(|(p, _)| p == path).unwrap();
            let filename = format!("font-{id}.{}", path.extension().unwrap().to_string_lossy());
            std::fs::copy(path, destination.join(&filename)).map_err(|e| e.to_string())?;
            styles.entry(key).or_insert(filename);
        }
        if !styles.contains_key("UprightFont") {
            return Err(format!("Font '{name}' has no regular face in the project's font files. Include the regular .otf/.ttf face."));
        }
        // Existence tests must check the portable file too, rather than the OS font list.
        let conditional = regex::Regex::new(&format!(
            r"\\IfFontExistsTF\s*\{{\s*{}\s*\}}",
            regex::escape(&name)
        ))
        .unwrap();
        let replacement = format!(
            "\\IfFontExistsTF{{.lemlio-fonts/{}}}",
            styles["UprightFont"]
        );
        for path in &visited {
            let source = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let updated = conditional.replace_all(&source, regex::NoExpand(&replacement));
            if updated != source {
                std::fs::write(path, updated.as_bytes()).map_err(|e| e.to_string())?;
            }
        }
        rules.push_str(&format!(
            "\\defaultfontfeatures[{name}]{{Path={{.lemlio-fonts/}},{} }}",
            styles
                .iter()
                .map(|(key, file)| format!("{key}={file}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    rules.push('}');
    let source = std::fs::read_to_string(main).map_err(|e| e.to_string())?;
    std::fs::write(main, format!("{rules}{source}")).map_err(|e| e.to_string())
}

pub fn inventory(work_dir: &Path) -> Vec<serde_json::Value> {
    use sha2::{Digest, Sha256};
    let Ok(entries) = std::fs::read_dir(work_dir.join(".lemlio-fonts")) else {
        return Vec::new();
    };
    let mut fonts: Vec<_> = entries.flatten().filter_map(|entry| {
        let data = std::fs::read(entry.path()).ok()?;
        Some(serde_json::json!({"file": entry.file_name().to_string_lossy(), "names": names(&data), "sha256": format!("{:x}", Sha256::digest(&data))}))
    }).collect();
    fonts.sort_by_key(|font| font["file"].as_str().unwrap_or("").to_string());
    fonts
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_named_font_is_reported_before_conditional_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main.tex");
        std::fs::write(&main, "\\documentclass{article}\\usepackage{fontspec}\\IfFontExistsTF{MissingLemlioFont123}{yes}{fallback}").unwrap();
        assert!(prepare(temp.path(), &main)
            .unwrap_err()
            .contains("MissingLemlioFont123"));
    }
    #[test]
    fn bundled_family_gets_explicit_portable_file_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main.tex");
        std::fs::write(
            &main,
            "\\documentclass{article}\\usepackage{fontspec}\\IfFontExistsTF{Latin Modern Sans}{\\setmainfont{Latin Modern Sans}}{fallback}",
        )
        .unwrap();
        prepare(temp.path(), &main).unwrap();
        let source = std::fs::read_to_string(main).unwrap();
        assert!(source.contains("UprightFont=font-"));
        assert!(source.contains("\\IfFontExistsTF{.lemlio-fonts/font-"));
    }
    #[test]
    fn malformed_font_data_does_not_panic() {
        for length in 0..300 {
            assert!(names(&vec![255; length]).is_none());
        }
    }
}
