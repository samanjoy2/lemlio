import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openLink } from "@tauri-apps/plugin-shell";
import { Button } from "./ui/button";
import { checkAppKey } from "@/lib/dropbox-app-key";

export const DROPBOX_CONSOLE = "https://www.dropbox.com/developers/apps";

export interface GuideStatus {
  appKeyConfigured: boolean;
  builtInAppKey: boolean;
  ownAppKey: boolean;
  redirectUris?: string[];
  permissions?: string[];
}

/** Step-by-step setup of a Dropbox app, shown while no app key exists. */
export function DropboxSetupGuide({
  status,
  onChanged,
  onTest,
}: {
  status: GuideStatus;
  onChanged: () => void | Promise<void>;
  onTest: () => void | Promise<void>;
}) {
  const needsGuide = !status.appKeyConfigured;
  const [open, setOpen] = useState(needsGuide);
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (needsGuide) setOpen(true);
  }, [needsGuide]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setProblem("Copying was blocked. Select the address and copy it.");
    }
  };
  const save = async () => {
    const check = checkAppKey(key);
    if (!check.ok) {
      setProblem(check.reason);
      return;
    }
    try {
      setProblem("");
      await invoke("drive_set_app_key", { appKey: check.key });
      setKey("");
      setNote("App key saved on this computer. Press Test connection.");
      await onChanged();
    } catch (e) {
      setProblem(String(e));
    }
  };
  const remove = async () => {
    try {
      setProblem("");
      await invoke("drive_set_app_key", { appKey: "" });
      setNote("App key removed.");
      await onChanged();
    } catch (e) {
      setProblem(String(e));
    }
  };

  const permissions = status.permissions ?? [];
  return (
    <details
      className="rounded-lg border p-4"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer font-medium">
        {status.builtInAppKey
          ? "Use my own Dropbox app instead"
          : "Advanced: use my own Dropbox app"}
      </summary>
      <div className="mt-3 space-y-4 text-sm">
        {status.builtInAppKey ? (
          <p className="text-muted-foreground text-xs">
            Most people do not need this. Lemlio already includes a Dropbox app,
            so Connect Dropbox works as it is.
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Lemlio needs a Dropbox app of its own to sign in. Creating one takes
            about two minutes and is done once.
          </p>
        )}
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            Open the Dropbox App Console and choose <strong>Create app</strong>.
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openLink(DROPBOX_CONSOLE)}
              >
                Open Dropbox App Console
              </Button>
            </div>
          </li>
          <li>
            Choose <strong>Scoped access</strong>, then{" "}
            <strong>App folder</strong>, and give the app a name.
          </li>
          <li>
            On the <strong>Permissions</strong> tab, tick{" "}
            {permissions.map((permission, index) => (
              <span key={permission}>
                <code>{permission}</code>
                {index < permissions.length - 2
                  ? ", "
                  : index === permissions.length - 2
                    ? " and "
                    : ""}
              </span>
            ))}
            , then press <strong>Submit</strong>.
          </li>
          <li>
            On the <strong>Settings</strong> tab, turn on{" "}
            <strong>Allow public clients (Implicit Grant &amp; PKCE)</strong>.
          </li>
          <li>
            Still on <strong>Settings</strong>, under{" "}
            <strong>Redirect URIs</strong>, add each of these exactly, pressing{" "}
            <strong>Add</strong> after each one:
            <ul className="mt-2 space-y-2">
              {(status.redirectUris ?? []).map((uri) => (
                <li key={uri} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted/40 px-2 py-1 text-xs">
                    {uri}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Copy ${uri}`}
                    onClick={() => void copy(uri)}
                  >
                    {copied === uri ? "Copied" : "Copy"}
                  </Button>
                </li>
              ))}
            </ul>
          </li>
          <li>
            Copy the <strong>App key</strong> from the Settings tab and paste it
            below. You do not need the App secret. Never paste it.
          </li>
        </ol>
        <div className="space-y-2">
          <label className="grid gap-1 text-xs" htmlFor="dropbox-app-key">
            Dropbox app key
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="dropbox-app-key"
              className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3"
              aria-label="Dropbox app key"
              type="password"
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setKey(e.target.value);
                setProblem("");
              }}
            />
            <Button disabled={!key.trim()} onClick={() => void save()}>
              {status.ownAppKey ? "Replace key" : "Save key"}
            </Button>
            {status.ownAppKey && (
              <Button variant="outline" onClick={() => void remove()}>
                Remove key
              </Button>
            )}
          </div>
          {problem && (
            <p role="alert" className="text-destructive text-xs">
              {problem}
            </p>
          )}
          {note && !problem && (
            <p role="status" className="text-xs">
              {note}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            The key is a public identifier. It is saved only in Lemlio’s
            settings on this computer, never in a project or a backup.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!status.appKeyConfigured}
            onClick={() => void onTest()}
          >
            Test connection
          </Button>
          <span className="text-muted-foreground text-xs">
            Opens Dropbox to sign in with your new app.
          </span>
        </div>
        <div className="space-y-1 text-xs">
          <strong className="block">If sign-in fails</strong>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              Wrong address: add exactly the address Lemlio shows in Settings
              &gt; Redirect URIs.
            </li>
            <li>
              Rejected without a secret: turn on Allow public clients in
              Settings.
            </li>
            <li>
              Missing permission: tick the permissions above, press Submit, then
              connect again.
            </li>
            <li>
              Too many people: an app in Development can be linked by up to 500
              users.
            </li>
          </ul>
        </div>
        <p className="text-muted-foreground text-xs">
          About limits: a new Dropbox app can be linked by up to 500 people.
          When 50 have linked it, Dropbox asks you to apply for production
          approval within two weeks.
        </p>
      </div>
    </details>
  );
}
