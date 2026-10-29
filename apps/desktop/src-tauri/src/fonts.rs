#[cfg(target_os = "windows")]
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Give bundled Tectonic access to packaged Latin Modern and installed Windows fonts.
/// The temporary config stays alive until the child exits; no project or system fonts are changed.
#[cfg(target_os = "windows")]
pub fn configure(
    command: &mut std::process::Command,
    binary: &std::path::Path,
) -> Result<tempfile::NamedTempFile, String> {
    use std::io::Write;
    let packaged = binary
        .parent()
        .ok_or("Cannot locate Tectonic resources")?
        .join("fonts");
    let fonts = if packaged.join("lmsans10-regular.otf").is_file() {
        packaged
    } else {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/tectonic/fonts")
    };
    if !fonts.join("lmsans10-regular.otf").is_file() {
        return Err(
            "Bundled fonts are missing. Reinstall Lemlio or run scripts/prepare-windows.ps1."
                .into(),
        );
    }
    let local = dirs::data_local_dir().ok_or("Cannot locate the font cache")?;
    let cache = local.join("Lemlio/font-cache");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let windows = std::env::var_os("WINDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "C:/Windows".into());
    let mut config = String::from("<?xml version=\"1.0\"?><!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\"><fontconfig>");
    if let Some(previous) = std::env::var_os("FONTCONFIG_FILE") {
        let previous = std::path::PathBuf::from(previous);
        if previous.is_file() {
            config.push_str(&format!(
                "<include ignore_missing=\"yes\">{}</include>",
                xml(&previous.to_string_lossy())
            ));
        }
    }
    for path in [
        fonts,
        windows.join("Fonts"),
        local.join("Microsoft/Windows/Fonts"),
    ] {
        config.push_str(&format!(
            "<dir>{}</dir>",
            xml(&path.to_string_lossy().replace('\\', "/"))
        ));
    }
    config.push_str(&format!(
        "<cachedir>{}</cachedir></fontconfig>",
        xml(&cache.to_string_lossy().replace('\\', "/"))
    ));
    let mut file = tempfile::NamedTempFile::new_in(&cache).map_err(|e| e.to_string())?;
    file.write_all(config.as_bytes())
        .map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    command.env("FONTCONFIG_FILE", file.path());
    Ok(file)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    #[test]
    fn font_paths_are_xml_escaped() {
        assert_eq!(xml("A&B/<font>\"'"), "A&amp;B/&lt;font&gt;&quot;&apos;");
    }
}

#[cfg(target_os = "macos")]
pub fn prepare_mac(main: &std::path::Path) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let packaged = executable
        .parent()
        .ok_or("Cannot locate font resources")?
        .join("../Resources/resources/tectonic/fonts");
    let fonts = if packaged.join("lmsans10-regular.otf").is_file() {
        packaged
    } else {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/tectonic/fonts")
    };
    let directory = main
        .parent()
        .ok_or("Cannot locate the build folder")?
        .join(".lemlio-fonts");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let families = [
        (
            "Latin Modern Sans",
            [
                "lmsans10-regular",
                "lmsans10-bold",
                "lmsans10-oblique",
                "lmsans10-boldoblique",
            ],
        ),
        (
            "Latin Modern Roman",
            [
                "lmroman10-regular",
                "lmroman10-bold",
                "lmroman10-italic",
                "lmroman10-bolditalic",
            ],
        ),
        (
            "Latin Modern Mono",
            [
                "lmmono10-regular",
                "lmmonolt10-bold",
                "lmmono10-italic",
                "lmmonolt10-boldoblique",
            ],
        ),
    ];
    let mut rules = String::from("\\AddToHook{package/fontspec/after}{");
    for (family, files) in families {
        for file in files {
            let name = format!("{file}.otf");
            let destination = directory.join(&name);
            if !destination.is_file() {
                std::fs::copy(fonts.join(name), destination)
                    .map_err(|e| format!("Cannot prepare bundled fonts: {e}"))?;
            }
        }
        rules.push_str(&format!("\\defaultfontfeatures[{family}]{{Path={{.lemlio-fonts/}},Extension=.otf,UprightFont={},BoldFont={},ItalicFont={},BoldItalicFont={}}}",files[0],files[1],files[2],files[3]));
    }
    rules.push('}');
    let source = std::fs::read_to_string(main).map_err(|e| e.to_string())?;
    if !source.starts_with(&rules) {
        std::fs::write(main, format!("{rules}{source}")).map_err(|e| e.to_string())?;
    }
    Ok(())
}
