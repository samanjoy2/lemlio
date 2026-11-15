import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { open } from "@tauri-apps/plugin-shell";
import { useSettingsStore } from "@/stores/settings-store";
import { Button } from "./ui/button";

export function HandySettings() {
  const provider = useSettingsStore((s) => s.voiceProvider);
  const setProvider = useSettingsStore((s) => s.setVoiceProvider);
  const executablePath = useSettingsStore((s) => s.handyExecutable);
  const setExecutable = useSettingsStore((s) => s.setHandyExecutable);
  const [status, setStatus] = useState<{
    available: boolean;
    running: boolean;
    path?: string;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void invoke<typeof status>("check_handy_status", {
        executablePath: executablePath || null,
      })
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [executablePath]);
  return (
    <section className="min-w-0 space-y-3">
      <label className="flex flex-wrap items-center gap-3">
        Voice input
        <select
          className="rounded border bg-background p-2 text-foreground"
          value={provider}
          onChange={(e) => setProvider(e.target.value as "system" | "handy")}
        >
          <option value="system">System dictation</option>
          <option value="handy">Handy · local speech recognition</option>
        </select>
      </label>
      {provider === "handy" && (
        <>
          <h3 className="font-medium">Handy</h3>
          <p>
            Install Handy, open it, download a speech model, and allow
            microphone access. On Mac, also allow Accessibility. Keep Handy
            running in the background.
          </p>
          <p>
            In chat, click the microphone to start; click again to transcribe
            into the prompt. Keep the prompt focused while Handy pastes the
            text, then review it before sending. Handy's own shortcut also
            works.
          </p>
          <p className="text-muted-foreground text-xs">
            After downloading a speech model, ordinary transcription runs
            locally. No OpenAI API key is required. Check Handy's overlay to
            confirm when it is recording.
          </p>
          <p role="status">
            {status?.available
              ? status.running
                ? "Handy is running"
                : "Handy found · open it to finish setup"
              : "Handy not found · install it or select its executable"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void open("https://github.com/cjpais/Handy/releases/latest")
              }
            >
              Get Handy
            </Button>
            <Button
              disabled={!status?.available}
              onClick={() =>
                void invoke("handy_control", {
                  action: "open",
                  executablePath: executablePath || null,
                }).catch((e) => setError(String(e)))
              }
            >
              Open Handy
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const path = await chooseFile({
                    title: "Choose Handy executable",
                    directory: false,
                    multiple: false,
                  });
                  if (typeof path === "string")
                    setExecutable(
                      path.endsWith(".app")
                        ? `${path}/Contents/MacOS/Handy`
                        : path,
                    );
                } catch (error) {
                  setError(String(error));
                }
              }}
            >
              Locate Handy
            </Button>
            <Button
              variant="outline"
              disabled={!status?.running}
              onClick={() =>
                void invoke("handy_control", {
                  action: "cancel",
                  executablePath: executablePath || null,
                }).catch((e) => setError(String(e)))
              }
            >
              Cancel recording
            </Button>
            {executablePath && (
              <Button variant="ghost" onClick={() => setExecutable("")}>
                Auto-detect
              </Button>
            )}
          </div>
          {status?.path && (
            <p className="break-all text-muted-foreground text-xs">
              {status.path}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
