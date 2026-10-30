import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { Button } from "./ui/button";
type Update = {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseUrl: string;
};
export function AppUpdates() {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update>();
  const [error, setError] = useState("");
  return (
    <section
      className="space-y-3 rounded-xl border border-border p-4"
      aria-label="App updates"
    >
      <p className="font-medium">Updates</p>
      <Button
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          setError("");
          try {
            setUpdate(await invoke<Update>("check_app_update"));
          } catch (e) {
            setError(String(e));
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? "Checking GitHub..." : "Check for updates"}
      </Button>
      {update && (
        <p role="status" className="text-sm">
          {update.available
            ? `Lemlio ${update.latestVersion} is available. You have ${update.currentVersion}.`
            : `You are up to date (Lemlio ${update.currentVersion}).`}
        </p>
      )}
      {update?.available && (
        <Button
          onClick={() => {
            void open(update.downloadUrl || update.releaseUrl).catch((e) =>
              setError(String(e)),
            );
          }}
        >
          {update.downloadUrl
            ? `Download Lemlio ${update.latestVersion}`
            : "View release downloads"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        Download opens in your browser. Close Lemlio, then run the Windows
        installer or replace the app in Applications on Mac. Your projects,
        settings, and Drive connection are kept.
      </p>
    </section>
  );
}
