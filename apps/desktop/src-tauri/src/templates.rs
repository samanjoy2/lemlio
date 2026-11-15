//! Official LaTeX templates, downloaded from their GitHub repositories on request.
//!
//! Nothing is bundled: the files come straight from the publisher's repository, so
//! Lemlio never redistributes them, and it can tell when the repository has a newer
//! version. Only allow-listed repositories can be downloaded.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Pack {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    repo: &'static str,
    /// The file to open first in a new project.
    main_file: &'static str,
    tags: &'static [&'static str],
}

const PACKS: &[Pack] = &[
    Pack {
        id: "acl",
        name: "ACL style files",
        description: "The official template for ACL, EMNLP, NAACL and other *CL conference papers: acl.sty, the bibliography style and an example paper.",
        repo: "acl-org/acl-style-files",
        main_file: "acl_latex.tex",
        tags: &["ACL", "NLP", "conference", "pdfLaTeX"],
    },
    Pack {
        id: "ieee-enhanced",
        name: "IEEE Enhanced",
        description: "A modern IEEE conference paper: the publisher's IEEEtran layout with microtype, working hyperlinks and DOIs in the references. Starts from the example that needs no extra setup.",
        repo: "latextemplates/ieee-enhanced",
        main_file: "paper-basic-listings.tex",
        tags: &["IEEE", "conference", "IEEEtran"],
    },
];

const MAX_ARCHIVE: usize = 30 * 1024 * 1024;
const MAX_FILE: u64 = 12 * 1024 * 1024;
const MAX_TOTAL: u64 = 60 * 1024 * 1024;
const MAX_FILES: usize = 1500;
/// How long a "no update" answer is trusted before GitHub is asked again.
const CHECK_INTERVAL: u64 = 6 * 60 * 60;

const EXTENSIONS: &[&str] = &[
    "tex", "sty", "cls", "clo", "bst", "bib", "bbx", "cbx", "def", "cfg", "ltx", "txt", "md", "png",
    "jpg", "jpeg", "pdf", "eps", "svg",
];
const NAMES: &[&str] = &["license", "licence", "copying", "readme"];
const SKIPPED_FILES: &[&str] = &["changelog.md", "contributing.md"];
const SKIPPED_DIRS: &[&str] = &[
    "tests",
    "test",
    "comparison",
    "generator-latex-template",
    "node_modules",
    "docs",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Version {
    sha: String,
    committed_at: String,
    message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Installed {
    sha: String,
    committed_at: String,
    message: String,
    fetched_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateCache {
    checked_at: u64,
    latest: HashMap<String, Version>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn pack(id: &str) -> Result<&'static Pack, String> {
    PACKS
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Unknown template".to_string())
}

fn templates_root() -> Result<PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("Cannot locate app data")?
        .join("Lemlio")
        .join("templates"))
}

fn files_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("files")
}

fn read_installed(root: &Path, id: &str) -> Option<Installed> {
    let raw = std::fs::read(root.join(id).join("meta.json")).ok()?;
    let meta: Installed = serde_json::from_slice(&raw).ok()?;
    files_dir(root, id).is_dir().then_some(meta)
}

fn read_cache(root: &Path) -> UpdateCache {
    std::fs::read(root.join("updates.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid template path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether a file of the repository belongs in a project. Sources, styles,
/// bibliographies, small images and licences: no tooling, CI or dot-files.
fn wanted(relative: &Path) -> bool {
    let parts: Vec<String> = relative
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let Some(name) = parts.last().map(|n| n.to_lowercase()) else {
        return false;
    };
    if parts.iter().any(|p| p.starts_with('.')) {
        return false;
    }
    if parts[..parts.len() - 1]
        .first()
        .is_some_and(|dir| SKIPPED_DIRS.contains(&dir.to_lowercase().as_str()))
    {
        return false;
    }
    if SKIPPED_FILES.contains(&name.as_str()) {
        return false;
    }
    if NAMES.contains(&name.as_str()) {
        return true;
    }
    relative
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

/// Unpack the repository archive into `destination`, keeping only wanted files.
/// GitHub wraps everything in one top folder, which is dropped.
fn extract(archive: &[u8], destination: &Path) -> Result<usize, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|_| "The downloaded template is not a valid archive".to_string())?;
    if zip.len() > 20_000 {
        return Err("The template archive has too many files".into());
    }
    let (mut count, mut total) = (0usize, 0u64);
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(inside) = entry.enclosed_name() else {
            continue; // an unsafe path (such as one with `..`) is never written
        };
        let relative: PathBuf = inside.components().skip(1).collect();
        if relative.as_os_str().is_empty() || !wanted(&relative) {
            continue;
        }
        if entry.size() > MAX_FILE {
            continue;
        }
        total += entry.size();
        count += 1;
        if count > MAX_FILES || total > MAX_TOTAL {
            return Err("The template is larger than Lemlio accepts".into());
        }
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry
            .by_ref()
            .take(MAX_FILE + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() as u64 > MAX_FILE {
            return Err("A template file is larger than Lemlio accepts".into());
        }
        std::fs::write(&target, data).map_err(|e| e.to_string())?;
    }
    if count == 0 {
        return Err("The template archive contained no usable files".into());
    }
    Ok(count)
}

/// Replace the installed copy with a freshly extracted one. The old copy is only
/// removed once the new one is in place.
fn swap_in(root: &Path, id: &str, staged: &Path, meta: &Installed) -> Result<(), String> {
    let pack_dir = root.join(id);
    std::fs::create_dir_all(&pack_dir).map_err(|e| e.to_string())?;
    let live = files_dir(root, id);
    let old = pack_dir.join(format!("files.old-{}", uuid::Uuid::new_v4().simple()));
    if live.exists() {
        std::fs::rename(&live, &old).map_err(|e| format!("Cannot replace the template: {e}"))?;
    }
    if let Err(error) = std::fs::rename(staged, &live) {
        if old.exists() {
            let _ = std::fs::rename(&old, &live);
        }
        return Err(format!("Cannot install the template: {error}"));
    }
    write_json(&pack_dir.join("meta.json"), meta)?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for item in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let target = to.join(item.file_name());
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_tree(&item.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(item.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn status(root: &Path) -> Value {
    let cache = read_cache(root);
    let packs: Vec<Value> = PACKS
        .iter()
        .map(|p| {
            let installed = read_installed(root, p.id);
            let latest = cache.latest.get(p.id);
            let update = matches!((&installed, latest), (Some(i), Some(l)) if i.sha != l.sha);
            json!({
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "repo": p.repo,
                "url": format!("https://github.com/{}", p.repo),
                "mainFile": p.main_file,
                "tags": p.tags,
                "installed": installed,
                "latest": latest,
                "updateAvailable": update,
                "checkedAt": if cache.checked_at > 0 { json!(cache.checked_at) } else { Value::Null },
            })
        })
        .collect();
    json!({ "packs": packs, "error": Value::Null })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Lemlio-templates")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "Cannot start the download".to_string())
}

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "GitHub did not answer in time. Check your connection and try again.".into()
    } else {
        "Cannot reach GitHub. Check your connection and try again.".into()
    }
}

fn http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        403 | 429 => "GitHub is limiting requests right now. Try again in a little while.".into(),
        404 => "The template repository was not found.".into(),
        code => format!("GitHub answered with an error (HTTP {code})."),
    }
}

fn parse_version(body: &Value) -> Option<Version> {
    let sha = body["sha"].as_str()?.to_string();
    if sha.len() < 7 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(Version {
        sha,
        committed_at: body["commit"]["committer"]["date"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        message: body["commit"]["message"]
            .as_str()
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect(),
    })
}

async fn latest_version(client: &reqwest::Client, repo: &str) -> Result<Version, String> {
    let response = client
        .get(format!("https://api.github.com/repos/{repo}/commits/HEAD"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "GitHub sent an unexpected answer.".to_string())?;
    parse_version(&body).ok_or_else(|| "GitHub sent an unexpected answer.".to_string())
}

async fn download(client: &reqwest::Client, repo: &str, sha: &str) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(format!("https://codeload.github.com/{repo}/zip/{sha}"))
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| network_error(&e))?
    {
        if bytes.len() + chunk.len() > MAX_ARCHIVE {
            return Err("The template is larger than Lemlio accepts.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn check_updates(root: &Path, force: bool) -> Result<Value, String> {
    let cache = read_cache(root);
    if !force && now().saturating_sub(cache.checked_at) < CHECK_INTERVAL {
        return Ok(status(root));
    }
    let client = client()?;
    let mut latest = cache.latest.clone();
    let mut first_error = None;
    let mut any = false;
    for p in PACKS {
        match latest_version(&client, p.repo).await {
            Ok(version) => {
                latest.insert(p.id.to_string(), version);
                any = true;
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if any {
        write_json(
            &root.join("updates.json"),
            &UpdateCache {
                checked_at: now(),
                latest,
            },
        )?;
    }
    let mut result = status(root);
    if let Some(error) = first_error {
        result["error"] = json!(error);
    }
    Ok(result)
}

async fn install(root: &Path, id: &str) -> Result<Value, String> {
    let selected = pack(id)?;
    let client = client()?;
    let version = latest_version(&client, selected.repo).await?;
    let archive = download(&client, selected.repo, &version.sha).await?;
    let pack_dir = root.join(id);
    std::fs::create_dir_all(&pack_dir).map_err(|e| e.to_string())?;
    let staged = pack_dir.join(format!("files.new-{}", uuid::Uuid::new_v4().simple()));
    let outcome = (|| {
        extract(&archive, &staged)?;
        if !staged.join(selected.main_file).is_file() {
            return Err("The template does not contain its main file.".to_string());
        }
        swap_in(
            root,
            id,
            &staged,
            &Installed {
                sha: version.sha.clone(),
                committed_at: version.committed_at.clone(),
                message: version.message.clone(),
                fetched_at: now(),
            },
        )
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staged);
    }
    outcome?;
    // What was just installed is, by definition, the latest we know of.
    let mut cache = read_cache(root);
    cache.latest.insert(id.to_string(), version);
    if cache.checked_at == 0 {
        cache.checked_at = now();
    }
    write_json(&root.join("updates.json"), &cache)?;
    Ok(status(root))
}

fn create_project(root: &Path, id: &str, destination: &Path) -> Result<String, String> {
    let selected = pack(id)?;
    let source = files_dir(root, id);
    if read_installed(root, id).is_none() {
        return Err("Download the template first.".into());
    }
    if !destination.is_absolute() {
        return Err("Choose a full folder path for the project.".into());
    }
    if destination.exists()
        && std::fs::read_dir(destination)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("That project folder already exists and is not empty.".into());
    }
    copy_tree(&source, destination)?;
    Ok(selected.main_file.to_string())
}

#[tauri::command]
pub fn template_packs() -> Result<Value, String> {
    Ok(status(&templates_root()?))
}

#[tauri::command]
pub async fn template_check_updates(force: Option<bool>) -> Result<Value, String> {
    check_updates(&templates_root()?, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn template_install(id: String) -> Result<Value, String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    install(&templates_root()?, &id).await
}

#[tauri::command]
pub fn template_create_project(id: String, destination: String) -> Result<String, String> {
    create_project(&templates_root()?, &id, Path::new(&destination))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(files: &[(&str, &str)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            for (name, content) in files {
                writer
                    .start_file(*name, zip::write::FileOptions::default())
                    .unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        bytes
    }

    #[test]
    fn only_template_files_are_kept() {
        for good in [
            "acl.sty",
            "acl_latex.tex",
            "paper.bib",
            "IEEEtran-doi.bst",
            "figures/plot.png",
            "LICENSE",
            "README.md",
        ] {
            assert!(wanted(Path::new(good)), "{good} should be kept");
        }
        for bad in [
            ".github/workflows/build.yml",
            ".gitignore",
            "Makefile",
            "Dockerfile",
            "tests/regression/a.tex",
            "comparison/build.sh",
            "generator-latex-template/x.tex",
            "CHANGELOG.md",
            "run.exe",
            "deep/.hidden/a.tex",
        ] {
            assert!(!wanted(Path::new(bad)), "{bad} should be skipped");
        }
    }

    #[test]
    fn extracting_drops_the_top_folder_and_unsafe_paths() {
        let zip = archive(&[
            ("repo-abc/acl.sty", "style"),
            ("repo-abc/figures/a.png", "png"),
            ("repo-abc/.github/ci.yml", "ci"),
            ("repo-abc/tests/t.tex", "test"),
            ("repo-abc/../../evil.tex", "evil"),
            ("/etc/passwd.tex", "evil"),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path().join("out");
        assert_eq!(extract(&zip, &out).unwrap(), 2);
        assert_eq!(std::fs::read_to_string(out.join("acl.sty")).unwrap(), "style");
        assert!(out.join("figures/a.png").is_file());
        assert!(!out.join(".github").exists() && !out.join("tests").exists());
        assert!(!temp.path().join("evil.tex").exists());
        assert!(extract(b"not a zip", &temp.path().join("x")).is_err());
        assert!(extract(&archive(&[("r/.hidden", "x")]), &temp.path().join("y")).is_err());
    }

    fn meta(sha: &str) -> Installed {
        Installed {
            sha: sha.into(),
            committed_at: "2026-01-01T00:00:00Z".into(),
            message: "msg".into(),
            fetched_at: 1,
        }
    }
    fn stage(root: &Path, text: &str) -> PathBuf {
        let staged = root.join(format!("staged-{text}"));
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("acl_latex.tex"), text).unwrap();
        staged
    }

    #[test]
    fn an_update_replaces_the_installed_files_and_is_reported_until_installed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(read_installed(root, "acl").is_none());
        swap_in(root, "acl", &stage(root, "one"), &meta("aaaaaaa")).unwrap();
        assert_eq!(
            std::fs::read_to_string(files_dir(root, "acl").join("acl_latex.tex")).unwrap(),
            "one"
        );
        // Upstream moves on: the pack is flagged.
        let cache = UpdateCache {
            checked_at: now(),
            latest: HashMap::from([(
                "acl".to_string(),
                Version {
                    sha: "bbbbbbb".into(),
                    committed_at: "2026-02-01T00:00:00Z".into(),
                    message: "New year".into(),
                },
            )]),
        };
        write_json(&root.join("updates.json"), &cache).unwrap();
        let acl = &status(root)["packs"][0];
        assert_eq!(acl["updateAvailable"], true);
        assert_eq!(acl["installed"]["sha"], "aaaaaaa");
        assert_eq!(acl["latest"]["message"], "New year");
        // Installing the new version replaces the files and clears the flag.
        swap_in(root, "acl", &stage(root, "two"), &meta("bbbbbbb")).unwrap();
        assert_eq!(
            std::fs::read_to_string(files_dir(root, "acl").join("acl_latex.tex")).unwrap(),
            "two"
        );
        assert_eq!(status(root)["packs"][0]["updateAvailable"], false);
        assert_eq!(std::fs::read_dir(root.join("acl")).unwrap().count(), 2); // files + meta, no leftovers
    }

    #[test]
    fn a_new_project_is_a_copy_and_never_overwrites_anything() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("templates");
        std::fs::create_dir_all(&root).unwrap();
        assert!(create_project(&root, "acl", &temp.path().join("p")).is_err()); // not downloaded
        swap_in(&root, "acl", &stage(&root, "one"), &meta("aaaaaaa")).unwrap();
        let project = temp.path().join("My paper");
        assert_eq!(create_project(&root, "acl", &project).unwrap(), "acl_latex.tex");
        assert_eq!(std::fs::read_to_string(project.join("acl_latex.tex")).unwrap(), "one");
        // A folder that already has content is refused.
        assert!(create_project(&root, "acl", &project).is_err());
        assert!(create_project(&root, "acl", Path::new("relative/path")).is_err());
        assert!(create_project(&root, "unknown", &temp.path().join("q")).is_err());
    }

    #[test]
    fn github_answers_are_read_defensively() {
        let good = json!({"sha":"d5adc823ff0f80f98c80405ca0ab66c68e684409",
            "commit":{"committer":{"date":"2026-06-29T11:47:20-04:00"},"message":"Fix bug\n\nLong body"}});
        let version = parse_version(&good).unwrap();
        assert_eq!(version.message, "Fix bug");
        assert!(parse_version(&json!({"sha":"not-hex!","commit":{}})).is_none());
        assert!(parse_version(&json!({})).is_none());
    }

    #[test]
    #[ignore = "needs internet: downloads the real templates from GitHub"]
    fn live_download_of_both_official_templates() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            for p in PACKS {
                let after = install(root, p.id).await.unwrap();
                let entry = after["packs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|x| x["id"] == p.id)
                    .unwrap();
                assert_eq!(entry["updateAvailable"], false, "{} just installed", p.id);
                assert!(files_dir(root, p.id).join(p.main_file).is_file());
                let project = temp.path().join(format!("project-{}", p.id));
                assert_eq!(create_project(root, p.id, &project).unwrap(), p.main_file);
                println!(
                    "{}: version {} with {} files",
                    p.id,
                    entry["installed"]["sha"].as_str().unwrap_or_default(),
                    walk(&project)
                );
            }
            // Asking GitHub again finds nothing newer.
            let again = check_updates(root, true).await.unwrap();
            assert!(again["packs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|x| x["updateAvailable"] == false));
        });
    }
    fn walk(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    walk(&e.path())
                } else {
                    1
                }
            })
            .sum()
    }

    #[test]
    fn only_listed_repositories_can_be_downloaded() {
        assert!(pack("acl").is_ok() && pack("ieee-enhanced").is_ok());
        assert!(pack("../../etc").is_err());
        assert!(pack("evil/repo").is_err());
    }
}
