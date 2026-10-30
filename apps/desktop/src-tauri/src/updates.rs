//! Public release checks. Downloads start only after an explicit user click.
use serde_json::{json, Value};
fn version(value: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 {
        return Err("Unrecognized release version".into());
    }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Unrecognized release version".into());
        }
        result[i] = part.parse().map_err(|_| "Unrecognized release version")?;
    }
    Ok(result)
}
fn installer(version: &str, os: &str, arch: &str) -> Option<String> {
    let suffix = match (os, arch) {
        ("windows", "x86_64") => "x64-setup.exe",
        ("macos", "aarch64") => "AppleSilicon.dmg",
        ("macos", "x86_64") => "Intel.dmg",
        _ => return None,
    };
    Some(format!("Lemlio_{version}_{suffix}"))
}
#[tauri::command]
pub async fn check_app_update() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Lemlio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get("https://api.github.com/repos/samanjoy2/lemlio/releases/latest")
        .send()
        .await
        .map_err(|_| "Cannot reach GitHub. Check your connection and try again.")?;
    if !response.status().is_success() {
        return Err("GitHub could not provide the latest release. Try again later.".into());
    }
    let release: Value = response
        .json()
        .await
        .map_err(|_| "Invalid release information")?;
    let tag = release["tag_name"]
        .as_str()
        .ok_or("Missing release version")?;
    let latest = tag
        .strip_prefix("lemlio-v")
        .ok_or("Unrecognized release version")?;
    let available = version(latest)? > version(env!("CARGO_PKG_VERSION"))?;
    let expected = installer(latest, std::env::consts::OS, std::env::consts::ARCH);
    let download = expected
        .filter(|name| {
            release["assets"].as_array().is_some_and(|assets| {
                assets
                    .iter()
                    .any(|a| a["name"].as_str() == Some(name.as_str()))
            })
        })
        .map(|name| format!("https://github.com/samanjoy2/lemlio/releases/download/{tag}/{name}"));
    Ok(
        json!({"available":available,"currentVersion":env!("CARGO_PKG_VERSION"),"latestVersion":latest,"downloadUrl":download,"releaseUrl":format!("https://github.com/samanjoy2/lemlio/releases/tag/{tag}")}),
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn versions_compare_numerically_and_reject_unexpected_release_tags() {
        assert!(super::version("1.2.10").unwrap() > super::version("1.2.9").unwrap());
        for invalid in ["1.2", "1.2.3-beta", "1.2.3/evil", "1..3"] {
            assert!(super::version(invalid).is_err());
        }
    }
    #[test]
    fn installers_match_the_machine_architecture() {
        assert_eq!(
            super::installer("1.2.7", "macos", "aarch64").unwrap(),
            "Lemlio_1.2.7_AppleSilicon.dmg"
        );
        assert_eq!(
            super::installer("1.2.7", "macos", "x86_64").unwrap(),
            "Lemlio_1.2.7_Intel.dmg"
        );
        assert_eq!(
            super::installer("1.2.7", "windows", "x86_64").unwrap(),
            "Lemlio_1.2.7_x64-setup.exe"
        );
        assert!(super::installer("1.2.7", "linux", "x86_64").is_none());
    }
}
