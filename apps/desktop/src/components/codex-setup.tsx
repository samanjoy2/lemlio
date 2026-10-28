import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import {
  LoaderIcon,
  RefreshCwIcon,
  LogInIcon,
  TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCodexSetupStore } from "@/stores/codex-setup-store";

export function CodexSetup() {
  const { status, error, isLoggingIn, checkStatus, login, finishLogin } =
    useCodexSetupStore();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<boolean>("login-complete", (event) =>
      finishLogin(event.payload),
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [finishLogin]);
  if (status === "ready") return null;
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
      <div className="flex items-center gap-2">
        {status === "checking" || isLoggingIn ? (
          <LoaderIcon className="size-5 animate-spin" />
        ) : (
          <TerminalIcon className="size-5" />
        )}
        <p className="font-medium text-sm">
          {isLoggingIn
            ? "Complete your ChatGPT sign-in"
            : status === "checking"
              ? "Connecting to your Codex"
              : "Connect Codex"}
        </p>
      </div>
      <p className="text-muted-foreground text-xs">
        Lemlio uses your local Codex and existing ChatGPT sign-in. Your
        documents stay on this computer; AI requests are sent through Codex.
      </p>
      {status === "not-installed" && (
        <>
          <p className="text-xs">Install Codex in a terminal, then refresh:</p>
          <code className="select-all rounded bg-muted px-3 py-2 text-xs">
            npm install -g @openai/codex
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => open("https://developers.openai.com/codex/cli")}
          >
            Codex setup guide
          </Button>
        </>
      )}
      {status === "not-authenticated" && !isLoggingIn && (
        <Button size="sm" onClick={login}>
          <LogInIcon className="mr-2 size-4" />
          Sign in with ChatGPT
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={status === "checking"}
        onClick={checkStatus}
      >
        <RefreshCwIcon className="mr-2 size-4" />
        Refresh connection
      </Button>
    </div>
  );
}
