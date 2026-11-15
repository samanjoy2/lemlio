import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MicIcon } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";

export function VoiceStatus() {
  const provider = useSettingsStore((s) => s.voiceProvider);
  const executablePath = useSettingsStore((s) => s.handyExecutable);
  const mac = navigator.userAgent.includes("Mac");
  const [ready, setReady] = useState<boolean>();
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void invoke<{ available: boolean }>(
        provider === "handy" ? "check_handy_status" : "check_speech_status",
        provider === "handy"
          ? { executablePath: executablePath || null }
          : undefined,
      )
        .then((result) => {
          if (!disposed) setReady(result.available);
        })
        .catch(() => {
          if (!disposed) setReady(false);
        });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [provider, executablePath]);
  return (
    <button
      type="button"
      className="home-connection-row"
      title={
        provider === "handy"
          ? "Configure Handy local dictation"
          : ready
            ? "Speech language installed; microphone permission is requested when recording starts"
            : "Configure Windows speech dictation"
      }
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("lemlio-open-settings", { detail: "Voice" }),
        )
      }
    >
      <span className="home-connection-icon">
        <MicIcon size={15} />
      </span>
      <span className="home-connection-name">Voice</span>
      <span
        className={
          ready ? "home-connection-badge is-connected" : "home-connection-badge"
        }
      >
        {provider === "handy"
          ? ready
            ? "Handy found"
            : "Handy setup"
          : mac
            ? "System dictation"
            : ready === undefined
              ? "Checking"
              : ready
                ? "Ready"
                : "Setup"}
      </span>
    </button>
  );
}
