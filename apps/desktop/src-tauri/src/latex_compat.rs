//! Compatibility changes apply only to the staged build tree, never project sources.
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

fn uncomment(source: &str) -> String {
    source
        .lines()
        .map(|line| {
            let mut slashes = 0;
            let mut end = line.len();
            for (index, ch) in line.char_indices() {
                if ch == '%' && slashes % 2 == 0 {
                    end = index;
                    break;
                }
                slashes = if ch == '\\' { slashes + 1 } else { 0 };
            }
            &line[..end]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn prepare_xcolor(build_root: &Path, main: &Path) -> Result<usize, String> {
    let root = std::fs::canonicalize(build_root).map_err(|e| e.to_string())?;
    let command=regex::Regex::new(r"\\(usepackage|RequirePackage|documentclass|LoadClass|input|include)\s*(?:\[([^\]]*)\]\s*)?\{([^}]+)\}").map_err(|e|e.to_string())?;
    let pass = regex::Regex::new(r"\\PassOptionsToPackage\s*\{([^}]+)\}\s*\{xcolor\}")
        .map_err(|e| e.to_string())?;
    let mut pending = vec![main.to_path_buf()];
    let mut visited = BTreeSet::new();
    let mut options = BTreeSet::<String>::new();
    let add_options = |text: &str, options: &mut BTreeSet<String>| {
        for option in text.split(',').map(str::trim) {
            if !option.is_empty()
                && option
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "-_=:.".contains(ch))
            {
                options.insert(option.to_string());
            }
        }
    };
    while let Some(path) = pending.pop() {
        let path = match std::fs::canonicalize(path) {
            Ok(path) if path.starts_with(&root) => path,
            _ => continue,
        };
        if !visited.insert(path.clone()) {
            continue;
        }
        if visited.len() > 2048 {
            return Err("Too many linked preamble files".into());
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let source = uncomment(&raw);
        let preamble = source.split("\\begin{document}").next().unwrap_or(&source);
        for found in pass.captures_iter(preamble) {
            add_options(&found[1], &mut options);
        }
        for found in command.captures_iter(preamble) {
            let kind = &found[1];
            for name in found[3].split(',').map(str::trim) {
                if name.contains(['\\', '{', '}', '$', '#']) || name.is_empty() {
                    continue;
                }
                if name == "xcolor" && matches!(kind, "usepackage" | "RequirePackage") {
                    if let Some(value) = found.get(2) {
                        add_options(value.as_str(), &mut options);
                    }
                }
                let extension = match kind {
                    "usepackage" | "RequirePackage" => "sty",
                    "documentclass" | "LoadClass" => "cls",
                    _ => "tex",
                };
                let mut name = PathBuf::from(name);
                if name.extension().is_none() {
                    name.set_extension(extension);
                }
                for base in [
                    path.parent().unwrap_or(&root),
                    main.parent().unwrap_or(&root),
                    root.as_path(),
                ] {
                    let candidate = base.join(&name);
                    if candidate.is_file() {
                        pending.push(candidate);
                        break;
                    }
                }
            }
        }
    }
    if options.is_empty() {
        return Ok(0);
    }
    let source = std::fs::read_to_string(main).map_err(|e| e.to_string())?;
    let prefix = format!(
        "\\PassOptionsToPackage{{{}}}{{xcolor}}",
        options.iter().cloned().collect::<Vec<_>>().join(",")
    );
    if !source.trim_start_matches('\u{feff}').starts_with(&prefix) {
        // Same-line prefix preserves original line numbers for errors and SyncTeX.
        std::fs::write(
            main,
            format!("{}{}", prefix, source.trim_start_matches('\u{feff}')),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(options.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gathers_reachable_preamble_options_before_indirect_loads_without_line_shift() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source="\\documentclass{article}\n\\usepackage{tikz}\n\\input{cv_settings}\n\\begin{document}\nText";
        std::fs::write(root.join("main.tex"), source).unwrap();
        std::fs::write(
            root.join("cv_settings.tex"),
            "% \\usepackage[wrong]{xcolor}\n\\usepackage[dvipsnames,table]{xcolor}",
        )
        .unwrap();
        std::fs::write(
            root.join("unrelated.tex"),
            "\\usepackage[unrelated]{xcolor}",
        )
        .unwrap();
        assert_eq!(prepare_xcolor(root, &root.join("main.tex")).unwrap(), 2);
        let patched = std::fs::read_to_string(root.join("main.tex")).unwrap();
        assert!(
            patched.starts_with("\\PassOptionsToPackage{dvipsnames,table}{xcolor}\\documentclass")
        );
        assert_eq!(patched.lines().count(), source.lines().count());
        assert!(!patched.contains("unrelated"));
        prepare_xcolor(root, &root.join("main.tex")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("main.tex")).unwrap(),
            patched
        );
    }
    #[test]
    fn follows_local_class_and_handles_cycles_but_ignores_document_body() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(
            root.join("main.tex"),
            "\\documentclass{custom}\n\\begin{document}\n\\usepackage[wrong]{xcolor}",
        )
        .unwrap();
        std::fs::write(
            root.join("custom.cls"),
            "\\RequirePackage[svgnames]{xcolor}\n\\input{cycle}",
        )
        .unwrap();
        std::fs::write(root.join("cycle.tex"), "\\input{cycle}").unwrap();
        assert_eq!(prepare_xcolor(root, &root.join("main.tex")).unwrap(), 1);
        assert!(std::fs::read_to_string(root.join("main.tex"))
            .unwrap()
            .starts_with("\\PassOptionsToPackage{svgnames}{xcolor}"));
    }
}
