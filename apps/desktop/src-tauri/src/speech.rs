use std::{collections::HashMap, sync::Arc};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

#[derive(Clone, Default)]
pub struct SpeechState(Arc<Mutex<HashMap<String, (String, Arc<Mutex<Child>>)>>>);

#[tauri::command]
pub async fn check_speech_status() -> Result<serde_json::Value, String> {
    if !cfg!(target_os = "windows") {
        return Ok(serde_json::json!({"available":false,"languages":[]}));
    }
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile","-NonInteractive","-Command", "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Speech; $languages=@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object {$_.Culture.Name}); ConvertTo-Json -InputObject $languages -Compress"])
        .stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "Windows speech check timed out")?
        .map_err(|_| "Cannot check Windows speech languages")?;
    if !result.status.success() {
        return Err("Windows speech recognition is unavailable".into());
    }
    let languages: Vec<String> = serde_json::from_slice(&result.stdout)
        .map_err(|_| "Cannot read Windows speech languages")?;
    Ok(serde_json::json!({"available":!languages.is_empty(),"languages":languages}))
}
pub async fn stop_for_window(state: &SpeechState, label: &str) {
    if let Some((_, child)) = state.0.lock().await.remove(label) {
        let _ = child.lock().await.kill().await;
    }
}

const DICTATION: &str = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Speech
  $available=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if($available.Count -eq 0){ throw 'Install a Windows speech language: Settings > Time & language > Language & region > Language options > Speech. Then restart Lemlio.' }
  $recognizer=New-Object System.Speech.Recognition.SpeechRecognitionEngine($available[0])
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $recognizer.SetInputToDefaultAudioDevice()
  [Console]::WriteLine('{"type":"ready"}')
  $until=[DateTime]::UtcNow.AddMinutes(2)
  while([DateTime]::UtcNow -lt $until){
    $result=$recognizer.Recognize([TimeSpan]::FromSeconds(8))
    if($null -ne $result -and $result.Text){ [Console]::WriteLine((@{type='text';text=$result.Text}|ConvertTo-Json -Compress)) }
  }
} catch { [Console]::WriteLine((@{type='error';text=$_.Exception.Message}|ConvertTo-Json -Compress)) }
finally { if($null -ne $recognizer){$recognizer.Dispose()} }
"#;

#[tauri::command]
pub async fn speech_stop(window: WebviewWindow, session_id: Option<String>) -> Result<(), String> {
    let state = window.state::<SpeechState>();
    let mut recordings = state.0.lock().await;
    if !recordings
        .get(window.label())
        .is_some_and(|(id, _)| session_id.as_ref() == Some(id))
    {
        return Ok(());
    }
    if let Some((_, child)) = recordings.remove(window.label()) {
        let _ = child.lock().await.kill().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn speech_start(window: WebviewWindow, session_id: String) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Windows speech dictation is available on Windows".into());
    }
    stop_for_window(window.state::<SpeechState>().inner(), window.label()).await;
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            DICTATION,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start Windows speech recognition")?;
    let stdout = child.stdout.take().ok_or("Speech output unavailable")?;
    let child = Arc::new(Mutex::new(child));
    let state = window.state::<SpeechState>().inner().clone();
    state.0.lock().await.insert(
        window.label().to_string(),
        (session_id.clone(), child.clone()),
    );
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut event) = serde_json::from_str::<serde_json::Value>(&line) {
                event["sessionId"] = serde_json::json!(session_id);
                let _ = window.emit("speech-dictation", event);
            }
        }
        let _ = window.emit(
            "speech-dictation",
            serde_json::json!({"sessionId":session_id,"type":"stopped"}),
        );
        let mut recordings = state.0.lock().await;
        if recordings
            .get(window.label())
            .is_some_and(|(id, _)| id == &session_id)
        {
            recordings.remove(window.label());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn open_speech_settings() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Open your operating system's speech language settings".into());
    }
    std::process::Command::new("explorer.exe")
        .arg("ms-settings:regionlanguage")
        .spawn()
        .map_err(|_| "Cannot open Windows language settings")?;
    Ok(())
}
