import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MicIcon } from "lucide-react";

export function VoiceStatus() {
  const mac = navigator.userAgent.includes("Mac");
  const [ready, setReady] = useState<boolean>();
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void invoke<{ available: boolean }>("check_speech_status")
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
  }, []);
  return (
    <button
      type="button"
      className="home-connection-row"
      title={
        ready
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
        {mac
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
