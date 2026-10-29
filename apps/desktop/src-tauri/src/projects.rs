//! Local project library and ZIP transfers. Imported files are never executed.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

static IMPORT_LOCK: Mutex<()> = Mutex::new(());

fn titles_path() -> Result<PathBuf, String> {
    Ok(library_root()?.join("project-details.json"))
}

#[tauri::command]
pub fn project_titles() -> Value {
    titles_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(json!({}))
}

#[tauri::command]
pub fn rename_project(project_path: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err("Enter a project name of 1–200 characters".into());
    }
    let _guard = IMPORT_LOCK.lock().map_err(|e| e.to_string())?;
    let path = titles_path()?;
    let mut details: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    details[project_path.replace('\\', "/").to_lowercase()] = json!(name);
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing library")?)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, &details).map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn project_details(project_path: String) -> Result<Value, String> {
    let root = Path::new(&project_path);
    let metadata = fs::metadata(root).map_err(|e| e.to_string())?;
    let timestamp = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64)
    };
    let modified = scan_project(root)?
        .iter()
        .filter_map(|p| fs::metadata(root.join(p)).ok()?.modified().ok())
        .max();
    let details: Value = titles_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    Ok(
        json!({"name":details[project_path.replace('\\',"/").to_lowercase()],"created":timestamp(metadata.created()),"modified":timestamp(modified.ok_or_else(||std::io::Error::other("No files")))}),
    )
}

#[tauri::command]
pub async fn project_pdf_preview(
    state: tauri::State<'_, crate::latex::LatexCompilerState>,
    project_path: String,
    main_file: Option<String>,
    use_texlive: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    let main_file = main_file.or_else(|| {
        project_metadata(Path::new(&project_path), Path::new(""), "").ok()?["mainFile"]
            .as_str()
            .map(str::to_string)
    });
    if let Some(main) = main_file {
        let root = Path::new(&project_path);
        let relative = zip_path(&main)?;
        let pdf = relative.with_extension("pdf");
        let build_log = root
            .join(".prism/build")
            .join(relative.with_extension("log"));
        if fs::read_to_string(build_log)
            .ok()
            .is_some_and(|log| log.lines().any(|line| line.starts_with('!')))
        {
            return Err("The last compilation failed".into());
        }
        for candidate in [root.join(".prism/build").join(&pdf), root.join(&pdf)] {
            if candidate.is_file() {
                return fs::read(candidate)
                    .map(tauri::ipc::Response::new)
                    .map_err(|e| e.to_string());
            }
        }
        return crate::latex::compile_project(
            &state,
            project_path,
            main,
            use_texlive.unwrap_or(false),
        )
        .await
        .map(tauri::ipc::Response::new);
    }
    Err("No main document".into())
}
const MAX_FILES: usize = 25_000;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn library_roots() -> Vec<PathBuf> {
    dirs::data_local_dir()
        .map(|root| vec![root.join("Lemlio").join("Projects")])
        .unwrap_or_default()
}

pub(crate) fn library_root() -> Result<PathBuf, String> {
    let roots = library_roots();
    let root = roots
        .iter()
        .find(|root| root.join("library.json").is_file())
        .or_else(|| roots.iter().find(|root| root.is_dir()))
        .or_else(|| roots.first())
        .cloned()
        .ok_or_else(|| "Cannot locate the Projects folder".to_string())?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

#[tauri::command]
pub fn project_storage_location() -> Result<String, String> {
    Ok(library_root()?.to_string_lossy().to_string())
}

fn ensure_library_layout(root: &Path) -> Result<(), String> {
    for folder in ["Imports", "Archives"] {
        fs::create_dir_all(root.join(folder)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn initialize_project_storage() -> Result<(), String> {
    ensure_library_layout(&library_root()?)
}

fn read_catalog(root: &Path) -> Result<Value, String> {
    let path = root.join("library.json");
    if !path.exists() {
        return Ok(json!({"projects":[],"failedExportCount":0}));
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Cannot read project library: {error}"))
}

fn catalog_from_root(root: &Path) -> Result<Value, String> {
    ensure_library_layout(root)?;
    let mut data = read_catalog(&root)?;
    if let Some(projects) = data["projects"].as_array_mut() {
        projects.retain_mut(|project| {
            let relative = PathBuf::from(project["relativePath"].as_str().unwrap_or(""));
            if relative.as_os_str().is_empty()
                || relative
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return false;
            }
            let path = root.join(relative);
            if !path.is_dir() {
                return false;
            }
            project["path"] = json!(path);
            true
        });
    }
    let projects = data["projects"]
        .as_array_mut()
        .ok_or("Invalid project library")?;
    let mut seen: std::collections::HashSet<String> = projects
        .iter()
        .filter_map(|project| project["relativePath"].as_str())
        .map(|path| path.replace('\\', "/").to_lowercase())
        .collect();
    let mut folders: Vec<_> = fs::read_dir(root.join("Imports"))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    folders.sort_by_key(|entry| entry.file_name());
    for folder in folders {
        let name = folder.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || ignored_component(&name) {
            continue;
        }
        let metadata = match fs::symlink_metadata(folder.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let relative = PathBuf::from("Imports").join(&name);
        if !seen.insert(display_path(&relative).to_lowercase()) {
            continue;
        }
        if let Ok(mut project) = project_metadata(root, &relative, &name) {
            if project["texFileCount"].as_u64().unwrap_or(0) == 0 {
                continue;
            }
            project["path"] = json!(folder.path());
            projects.push(project);
        }
    }
    data["root"] = json!(root);
    Ok(data)
}

#[tauri::command]
pub async fn list_imported_projects() -> Result<Value, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = IMPORT_LOCK.lock().map_err(|error| error.to_string())?;
        catalog_from_root(&library_root()?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Copy,
    Move,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub(crate) projects: Vec<Value>,
    pub(crate) storage_path: String,
    archive_path: Option<String>,
    source_moved: bool,
    warning: Option<String>,
}

fn ignored_component(name: &str) -> bool {
    if name.eq_ignore_ascii_case("Keys")
        || name == "drive-client.json"
        || name == "google-drive-oauth.json"
        || (name.starts_with("client_secret") && name.ends_with(".json"))
    {
        return true;
    }
    matches!(
        name,
        ".prism" | ".prismpro" | ".git" | ".venv" | "node_modules" | "__MACOSX"
    )
}

fn zip_path(name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("Unsafe ZIP path: {name}"));
    }
    let mut path = PathBuf::new();
    for part in normalized.trim_end_matches('/').split('/') {
        let device = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && matches!(device.as_bytes()[3], b'1'..=b'9'));
        if part.is_empty()
            || part == "."
            || part == ".."
            || reserved
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return Err(format!("Unsupported or unsafe ZIP path: {name}"));
        }
        path.push(part);
    }
    Ok(path)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn safe_folder_name(name: &str) -> String {
    let name: String = name
        .chars()
        .take(100)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_end_matches('.');
    if name.is_empty() || zip_path(name).is_err() {
        "Imported project".to_string()
    } else {
        name.to_string()
    }
}

fn available_path(parent: &Path, name: &str, extension: Option<&str>) -> PathBuf {
    for index in 1.. {
        let stem = if index == 1 {
            name.to_string()
        } else {
            format!("{name} ({index})")
        };
        let filename = extension.map(|ext| format!("{stem}.{ext}")).unwrap_or(stem);
        let path = parent.join(filename);
        if !path.exists() {
            return path;
        }
    }
    unreachable!()
}

pub(crate) fn project_entries(root: &Path) -> Result<Vec<(PathBuf, bool)>, String> {
    fn walk(base: &Path, relative: &Path, paths: &mut Vec<(PathBuf, bool)>) -> Result<(), String> {
        for item in fs::read_dir(base.join(relative)).map_err(|error| error.to_string())? {
            let item = item.map_err(|error| error.to_string())?;
            if ignored_component(&item.file_name().to_string_lossy()) {
                continue;
            }
            let metadata = fs::symlink_metadata(item.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Linked files cannot be included in a ZIP: {}",
                    item.path().display()
                ));
            }
            let next = relative.join(item.file_name());
            if metadata.is_dir() {
                paths.push((next.clone(), true));
                walk(base, &next, paths)?;
            } else if metadata.is_file() {
                paths.push((next, false));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, Path::new(""), &mut files)?;
    files.sort();
    Ok(files)
}

fn scan_project(root: &Path) -> Result<Vec<PathBuf>, String> {
    Ok(project_entries(root)?
        .into_iter()
        .filter_map(|(path, directory)| if directory { None } else { Some(path) })
        .collect())
}

fn project_metadata(base: &Path, relative: &Path, name: &str) -> Result<Value, String> {
    let root = base.join(relative);
    let files = scan_project(&root)?;
    let tex: Vec<_> = files
        .iter()
        .filter(|path| {
            path.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("tex") || ext.eq_ignore_ascii_case("ltx")
            })
        })
        .collect();
    let main = tex.iter().min_by_key(|path| {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        let priority = match name.as_str() {
            "main.tex" | "document.tex" => 0,
            "acl_latex.tex" | "paper.tex" | "poster.tex" => 1,
            _ => {
                if fs::read_to_string(root.join(path))
                    .unwrap_or_default()
                    .contains("\\documentclass")
                {
                    2
                } else {
                    3
                }
            }
        };
        (priority, path.components().count())
    });
    Ok(
        json!({"name":name,"relativePath":display_path(relative),"mainFile":main.map(|path|display_path(path)),"fileCount":files.len(),"texFileCount":tex.len(),"conversationCount":files.iter().filter(|path| display_path(path).contains("conversations/") && path.extension().is_some_and(|ext|ext=="json")).count()}),
    )
}

fn files_equal(first: &Path, second: &Path) -> std::io::Result<bool> {
    let mut first = File::open(first)?;
    let mut second = File::open(second)?;
    if first.metadata()?.len() != second.metadata()?.len() {
        return Ok(false);
    }
    let mut a = [0; 64 * 1024];
    let mut b = [0; 64 * 1024];
    loop {
        let count = first.read(&mut a)?;
        if count == 0 {
            return Ok(true);
        }
        second.read_exact(&mut b[..count])?;
        if a[..count] != b[..count] {
            return Ok(false);
        }
    }
}

fn import_into(root: &Path, source: &Path, mode: ImportMode) -> Result<ImportResult, String> {
    import_with_options(root, source, mode, false)
}
pub(crate) fn restore_snapshot(source: &Path) -> Result<ImportResult, String> {
    import_with_options(&library_root()?, source, ImportMode::Copy, true)
}
pub(crate) fn restore_snapshot_in(root: &Path, source: &Path) -> Result<ImportResult, String> {
    ensure_library_layout(root)?;
    import_with_options(root, source, ImportMode::Copy, true)
}
fn import_with_options(
    root: &Path,
    source: &Path,
    mode: ImportMode,
    snapshot: bool,
) -> Result<ImportResult, String> {
    let _guard = IMPORT_LOCK.lock().map_err(|error| error.to_string())?;
    let mut catalog = read_catalog(root)?;
    if !catalog["projects"].is_array() {
        return Err("The project library is invalid; import stopped to preserve it".to_string());
    }
    let source = fs::canonicalize(source).map_err(|error| format!("Cannot open ZIP: {error}"))?;
    let mut archive = zip::ZipArchive::new(File::open(&source).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Cannot read ZIP: {error}"))?;
    if archive.len() > MAX_FILES {
        return Err("This ZIP contains too many files (limit: 25,000)".to_string());
    }
    let mut entries = Vec::new();
    let mut targets = HashMap::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = zip_path(entry.name())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("ZIP links and special files are not supported".to_string());
        }
        let key = display_path(&path).to_lowercase();
        if let Some(previous_is_dir) = targets.insert(key, entry.is_dir()) {
            if !entry.is_dir() || !previous_is_dir {
                return Err(format!("Duplicate ZIP path: {}", entry.name()));
            }
        }
        total = total
            .checked_add(entry.size())
            .ok_or("ZIP size exceeds the import limit")?;
        if total > MAX_BYTES {
            return Err("This ZIP expands beyond the 2 GB import limit".to_string());
        }
        if path
            .components()
            .any(|part| ignored_component(&part.as_os_str().to_string_lossy()))
        {
            continue;
        }
        entries.push((index, path, entry.is_dir()));
    }
    for (_, path, _) in &entries {
        for ancestor in path
            .ancestors()
            .skip(1)
            .filter(|path| !path.as_os_str().is_empty())
        {
            if targets.get(&display_path(ancestor).to_lowercase()) == Some(&false) {
                return Err(format!(
                    "A ZIP file is also used as a folder: {}",
                    ancestor.display()
                ));
            }
        }
    }
    fs::create_dir_all(root.join("Imports")).map_err(|error| error.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".import-")
        .tempdir_in(root.join("Imports"))
        .map_err(|error| error.to_string())?;
    for (index, relative, directory) in entries {
        let destination = staging.path().join(relative);
        if directory {
            fs::create_dir_all(destination).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let expected_size = entry.size();
        let mut output = File::create(&destination).map_err(|error| error.to_string())?;
        let copied = std::io::copy(&mut entry.by_ref().take(expected_size + 1), &mut output)
            .map_err(|error| format!("Cannot extract {}: {error}", destination.display()))?;
        if copied != expected_size {
            return Err("The ZIP file size does not match its contents".to_string());
        }
    }
    drop(archive);
    let name = safe_folder_name(
        source
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .as_ref(),
    );
    let destination = available_path(&root.join("Imports"), &name, None);
    let relative = destination
        .strip_prefix(root)
        .map_err(|error| error.to_string())?;
    let mut projects = Vec::new();
    // Prism's full-library export has one directory per project and an export report.
    let report = staging.path().join("export-errors.json");
    if report.is_file() && !snapshot {
        if let Ok(report) = fs::read_to_string(&report)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok())
            .ok_or(())
        {
            let mut failures = catalog["failedExports"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for item in report["errors"].as_array().into_iter().flatten() {
                if let (Some(name), Some(message)) =
                    (item["projectTitle"].as_str(), item["message"].as_str())
                {
                    let failure = json!({"name":name,"message":message});
                    if !failures.contains(&failure) {
                        failures.push(failure);
                    }
                }
            }
            catalog["failedExportCount"] = json!(catalog["failedExportCount"]
                .as_u64()
                .unwrap_or(0)
                .max(failures.len() as u64));
            catalog["failedExports"] = json!(failures);
        }
        for item in fs::read_dir(staging.path()).map_err(|error| error.to_string())? {
            let item = item.map_err(|error| error.to_string())?;
            if item
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                let mut metadata = project_metadata(
                    staging.path(),
                    Path::new(&item.file_name()),
                    &item.file_name().to_string_lossy(),
                )?;
                metadata["relativePath"] = json!(display_path(&relative.join(item.file_name())));
                projects.push(metadata);
            }
        }
    } else {
        let mut metadata = project_metadata(staging.path(), Path::new(""), &name)?;
        metadata["relativePath"] = json!(display_path(relative));
        if !snapshot && metadata["texFileCount"].as_u64().unwrap_or(0) == 0 {
            return Err(
                "No LaTeX source was found in this ZIP. Choose an exported project ZIP."
                    .to_string(),
            );
        }
        projects.push(metadata);
    }
    if projects.is_empty() {
        return Err("No project folders were found in the ZIP".to_string());
    }
    catalog["projects"]
        .as_array_mut()
        .ok_or("Invalid project library")?
        .extend(projects.clone());
    let mut manifest = tempfile::NamedTempFile::new_in(root).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut manifest, &catalog).map_err(|error| error.to_string())?;
    manifest
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    fs::rename(staging.path(), &destination).map_err(|error| error.to_string())?;
    if let Err(error) = manifest.persist(root.join("library.json")) {
        let _ = fs::rename(&destination, staging.path());
        return Err(format!(
            "Cannot update the project library: {}",
            error.error
        ));
    }
    for project in &mut projects {
        project["path"] = json!(root.join(
            project["relativePath"]
                .as_str()
                .ok_or("Invalid project path")?
        ));
    }
    let mut result = ImportResult {
        projects,
        storage_path: destination.to_string_lossy().to_string(),
        archive_path: None,
        source_moved: false,
        warning: None,
    };
    if matches!(mode, ImportMode::Move) {
        let move_result = (|| -> Result<PathBuf, String> {
            let archives = root.join("Archives");
            fs::create_dir_all(&archives).map_err(|error| error.to_string())?;
            let target = available_path(&archives, &name, Some("zip"));
            let mut saved =
                tempfile::NamedTempFile::new_in(&archives).map_err(|error| error.to_string())?;
            std::io::copy(
                &mut File::open(&source).map_err(|error| error.to_string())?,
                &mut saved,
            )
            .map_err(|error| error.to_string())?;
            saved
                .as_file()
                .sync_all()
                .map_err(|error| error.to_string())?;
            if !files_equal(&source, saved.path()).map_err(|error| error.to_string())? {
                return Err("ZIP verification failed; the original was kept".to_string());
            }
            saved.persist(&target).map_err(|error| error.to_string())?;
            result.archive_path = Some(target.to_string_lossy().to_string());
            fs::remove_file(&source).map_err(|error| error.to_string())?;
            Ok(target)
        })();
        match move_result {
            Ok(_) => result.source_moved = true,
            Err(error) => result.warning = Some(format!("Project imported. The original ZIP was kept because it could not be moved: {error}")),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn import_project_zip(
    archive_path: String,
    mode: ImportMode,
) -> Result<ImportResult, String> {
    let root = library_root()?;
    tokio::task::spawn_blocking(move || import_into(&root, Path::new(&archive_path), mode))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn export_to(project: &Path, destination: &Path) -> Result<usize, String> {
    let project = fs::canonicalize(project).map_err(|error| error.to_string())?;
    if !project.is_dir() {
        return Err("Select a project folder to export".to_string());
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("Select a folder for the ZIP")?;
    let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if parent.starts_with(&project) {
        return Err("Save the ZIP outside the project folder".to_string());
    }
    if !destination
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err("The export filename must end in .zip".to_string());
    }
    let entries = project_entries(&project)?;
    let file_count = entries.iter().filter(|(_, directory)| !directory).count();
    let mut temporary =
        tempfile::NamedTempFile::new_in(&parent).map_err(|error| error.to_string())?;
    {
        let mut archive = zip::ZipWriter::new(temporary.as_file_mut());
        let options = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644)
            .large_file(true);
        for (relative, directory) in &entries {
            if *directory {
                archive
                    .add_directory(
                        format!("{}/", display_path(relative)),
                        options.unix_permissions(0o755),
                    )
                    .map_err(|error| error.to_string())?;
                continue;
            }
            archive
                .start_file(display_path(relative), options)
                .map_err(|error| error.to_string())?;
            std::io::copy(
                &mut File::open(project.join(relative)).map_err(|error| error.to_string())?,
                &mut archive,
            )
            .map_err(|error| error.to_string())?;
        }
        archive.finish().map_err(|error| error.to_string())?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(destination)
        .map_err(|error| error.to_string())?;
    Ok(file_count)
}

#[tauri::command]
pub async fn export_project_zip(
    project_path: String,
    destination: String,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        export_to(Path::new(&project_path), Path::new(&destination))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_keeps_one_snapshot_and_never_overwrites_an_existing_folder() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Library");
        ensure_library_layout(&root).unwrap();
        let existing = root.join("Imports/Paper");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("main.tex"), "PC original").unwrap();
        let archive = temp.path().join("Paper.zip");
        let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::FileOptions::default();
        zip.start_file("main.tex", options).unwrap();
        zip.write_all(b"restored source").unwrap();
        zip.start_file("export-errors.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        let result = import_with_options(&root, &archive, ImportMode::Copy, true).unwrap();
        assert_eq!(result.projects.len(), 1);
        assert_ne!(Path::new(&result.storage_path), existing);
        assert_eq!(
            fs::read_to_string(existing.join("main.tex")).unwrap(),
            "PC original"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&result.storage_path).join("main.tex")).unwrap(),
            "restored source"
        );
    }
    #[test]
    fn fresh_library_creates_import_and_archive_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Projects");
        assert!(catalog_from_root(&root).unwrap()["projects"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(root.join("Imports").is_dir());
        assert!(root.join("Archives").is_dir());
    }

    #[test]
    fn copied_folders_are_discovered_without_reimport_or_catalog_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        ensure_library_layout(root).unwrap();
        let paper = root.join("Imports/Paper/latex");
        fs::create_dir_all(&paper).unwrap();
        fs::write(paper.join("main.tex"), "\\documentclass{article}").unwrap();
        fs::create_dir_all(root.join("Imports/Images only")).unwrap();
        fs::write(root.join("Imports/Images only/figure.png"), b"figure").unwrap();
        let first = catalog_from_root(root).unwrap();
        assert_eq!(first["projects"].as_array().unwrap().len(), 1);
        assert_eq!(first["projects"][0]["mainFile"], "latex/main.tex");
        assert!(!root.join("library.json").exists());
        fs::create_dir_all(root.join("Imports/New CV")).unwrap();
        fs::write(
            root.join("Imports/New CV/cv.tex"),
            "\\documentclass{article}",
        )
        .unwrap();
        assert_eq!(
            catalog_from_root(root).unwrap()["projects"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let manifest = json!({"projects":[{"name":"Paper title", "relativePath":"Imports/Paper"}]});
        fs::write(root.join("library.json"), manifest.to_string()).unwrap();
        let merged = catalog_from_root(root).unwrap();
        assert_eq!(merged["projects"].as_array().unwrap().len(), 2);
        assert_eq!(merged["projects"][0]["name"], "Paper title");
        assert_eq!(
            fs::read_to_string(root.join("library.json")).unwrap(),
            manifest.to_string()
        );
    }
    use std::io::Write;

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, content) in files {
            writer
                .start_file(
                    *name,
                    zip::write::FileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn copy_import_keeps_original_and_registers_nested_binary_assets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Projects");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("library.json"), r#"{"projects":[{"name":"Existing","relativePath":"old"}],"failedExportCount":9,"failedExports":[{"name":"Missing","message":"403"}]}"#).unwrap();
        let source = temp.path().join("Paper.zip");
        let figure = b"\x89PNG\r\n\x1a\n\x00\xffbinary";
        write_zip(
            &source,
            &[
                ("latex/paper.tex", b"\\documentclass{article}"),
                ("latex/figs/icon.png", figure),
                ("latex/refs.bib", b"bibliography"),
            ],
        );
        let result = import_into(&root, &source, ImportMode::Copy).unwrap();
        assert!(source.is_file());
        assert!(!result.source_moved);
        assert_eq!(result.projects.len(), 1);
        assert_eq!(result.projects[0]["mainFile"], "latex/paper.tex");
        let project = Path::new(result.projects[0]["path"].as_str().unwrap());
        assert!(project.starts_with(root.join("Imports")));
        assert_eq!(
            fs::read(project.join("latex/figs/icon.png")).unwrap(),
            figure
        );
        let catalog = read_catalog(&root).unwrap();
        assert_eq!(catalog["projects"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["failedExportCount"], 9);
        assert_eq!(catalog["failedExports"][0]["name"], "Missing");
        let second = import_into(&root, &source, ImportMode::Copy).unwrap();
        assert_ne!(result.storage_path, second.storage_path);
        assert!(project.is_dir());
    }

    #[test]
    fn move_keeps_verified_zip_in_archives_after_import() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("Paper.zip");
        write_zip(&source, &[("main.tex", b"\\documentclass{article}")]);
        let original = fs::read(&source).unwrap();
        let result = import_into(&temp.path().join("Projects"), &source, ImportMode::Move).unwrap();
        assert!(result.source_moved);
        assert!(!source.exists());
        assert_eq!(fs::read(result.archive_path.unwrap()).unwrap(), original);
        assert!(Path::new(&result.storage_path).join("main.tex").is_file());
    }

    #[test]
    fn unsafe_zip_names_and_duplicates_never_delete_source() {
        for bad in [
            "../escape.tex",
            "/escape.tex",
            "C:/escape.tex",
            "latex/../../escape.tex",
            "figs/icon.png:stream",
            "NUL.tex",
            "dir./main.tex",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("bad.zip");
            write_zip(&source, &[("main.tex", b"tex"), (bad, b"bad")]);
            let root = temp.path().join("Projects");
            assert!(
                import_into(&root, &source, ImportMode::Move).is_err(),
                "{bad}"
            );
            assert!(source.is_file());
            assert!(!root.join("library.json").exists());
            assert!(!temp.path().join("escape.tex").exists());
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("duplicates.zip");
        write_zip(&source, &[("main.tex", b"one"), ("MAIN.tex", b"two")]);
        assert!(import_into(&temp.path().join("Projects"), &source, ImportMode::Copy).is_err());
    }

    #[test]
    fn corrupt_zip_rolls_back_and_keeps_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("corrupt.zip");
        write_zip(&source, &[("main.tex", b"unique source contents")]);
        let mut data = fs::read(&source).unwrap();
        let position = data
            .windows(22)
            .position(|bytes| bytes == b"unique source contents")
            .unwrap();
        data[position] ^= 1;
        fs::write(&source, data).unwrap();
        let root = temp.path().join("Projects");
        assert!(import_into(&root, &source, ImportMode::Move).is_err());
        assert!(source.is_file());
        assert!(!root.join("library.json").exists());
        assert_eq!(fs::read_dir(root.join("Imports")).unwrap().count(), 0);
    }

    #[test]
    fn export_round_trip_preserves_sources_and_figures_without_internal_caches() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(source.join("latex/figs")).unwrap();
        fs::create_dir_all(source.join("empty folder")).unwrap();
        fs::create_dir_all(source.join("Keys")).unwrap();
        fs::write(
            source.join("Keys/oauth.json"),
            "synthetic local-only credential fixture",
        )
        .unwrap();
        fs::write(
            source.join("client_secret_test.json"),
            "synthetic local-only credential fixture",
        )
        .unwrap();
        fs::create_dir_all(source.join(".prism/build")).unwrap();
        fs::create_dir_all(source.join(".prismpro/history.git")).unwrap();
        fs::write(source.join("latex/main.tex"), "\\documentclass{article}").unwrap();
        fs::write(source.join("latex/figs/chart.pdf"), b"%PDF-1.7\0\xfffigure").unwrap();
        fs::write(source.join("latex/refs.bib"), "@article{example}").unwrap();
        fs::write(source.join(".prism/build/main.pdf"), "cache").unwrap();
        fs::write(source.join(".prismpro/history.git/config"), "history").unwrap();
        let destination = temp.path().join("round-trip.zip");
        assert_eq!(export_to(&source, &destination).unwrap(), 3);
        let result = import_into(
            &temp.path().join("Projects"),
            &destination,
            ImportMode::Copy,
        )
        .unwrap();
        assert_eq!(result.projects[0]["mainFile"], "latex/main.tex");
        let imported = Path::new(&result.storage_path);
        assert_eq!(
            fs::read(imported.join("latex/figs/chart.pdf")).unwrap(),
            fs::read(source.join("latex/figs/chart.pdf")).unwrap()
        );
        assert!(!imported.join(".prism").exists());
        assert!(!imported.join(".prismpro").exists());
        assert!(imported.join("empty folder").is_dir());
        assert!(!imported.join("Keys").exists());
        assert!(!imported.join("client_secret_test.json").exists());
        // Replacing an existing export is also atomic and produces a valid ZIP.
        fs::write(source.join("latex/refs.bib"), "changed bibliography").unwrap();
        export_to(&source, &destination).unwrap();
        let archive = zip::ZipArchive::new(File::open(&destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 6);
        let inside = source.join("do-not-overwrite.zip");
        fs::write(&inside, "original").unwrap();
        assert!(export_to(&source, &inside).is_err());
        assert_eq!(fs::read(&inside).unwrap(), b"original");
    }

    #[test]
    fn batch_prism_export_registers_individual_projects() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("Prism.zip");
        write_zip(
            &source,
            &[
                ("One/latex/paper.tex", b"\\documentclass{article}"),
                ("Two/main.tex", b"\\documentclass{article}"),
                (
                    "export-errors.json",
                    b"{\"failedProjectCount\":0,\"errors\":[]}",
                ),
            ],
        );
        let result = import_into(&temp.path().join("Projects"), &source, ImportMode::Copy).unwrap();
        assert_eq!(result.projects.len(), 2);
        for project in result.projects {
            assert!(Path::new(project["path"].as_str().unwrap()).is_dir());
        }
    }
}
