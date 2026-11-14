import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PlusIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/panelui/switch";
import {
  TOOL_PRESETS,
  listTools,
  validateToolForm,
  type InstallPreview,
  type ToolKind,
  type ToolSpec,
} from "@/lib/tools";

type Draft = Pick<
  ToolSpec,
  "name" | "description" | "kind" | "source" | "command"
>;
const EMPTY: Draft = {
  name: "",
  description: "",
  kind: "package",
  source: "",
  command: "",
};
const KIND_LABEL: Record<ToolKind, string> = {
  git: "Git repository",
  package: "Python package (pip/uv)",
  command: "Local command",
};
const toSpec = (d: Draft): ToolSpec => ({ ...d, id: "", enabled: true });

export function useTools() {
  const [tools, setTools] = useState<ToolSpec[]>([]);
  const refresh = useCallback(
    () =>
      listTools()
        .then(setTools)
        .catch(() => setTools([])),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { tools, refresh };
}

export function ToolsLibrary() {
  const { tools, refresh } = useTools();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uvMissing, setUvMissing] = useState(false);
  const [uvInstalling, setUvInstalling] = useState(false);

  const review = async () => {
    if (!draft) return;
    setError(null);
    const problem = validateToolForm(draft);
    if (problem) return setError(problem);
    try {
      const p = await invoke<InstallPreview>("tools_preview", {
        spec: toSpec(draft),
      });
      if (p.needs_uv) {
        const uv = await invoke<{ installed: boolean }>("check_uv_status");
        setUvMissing(!uv.installed);
      } else setUvMissing(false);
      setPreview(p);
    } catch (e) {
      setError(String(e));
    }
  };

  const confirm = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("tools_install", { spec: toSpec(draft) });
      setDraft(null);
      setPreview(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const installUv = async () => {
    setUvInstalling(true);
    setError(null);
    const stop = await listen<boolean>("uv-install-complete", (event) => {
      stop();
      setUvInstalling(false);
      if (event.payload) setUvMissing(false);
      else setError("Installing uv failed. Install it from astral.sh/uv.");
    });
    try {
      await invoke("install_uv");
    } catch (e) {
      stop();
      setUvInstalling(false);
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Tools extend what the AI can do. Add a command-line tool and say when
        the AI should use it. Python tools are installed once into a shared
        environment, never into your projects.
      </p>
      <div className="space-y-2">
        {tools.length === 0 && (
          <p className="text-muted-foreground text-sm">No tools added yet.</p>
        )}
        {tools.map((tool) => (
          <article key={tool.id} className="space-y-1.5 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              <div className="flex items-center gap-2">
                <Switch
                  size="sm"
                  id={`tool-${tool.id}`}
                  checked={tool.enabled}
                  label={`Enable ${tool.name}`}
                  onCheckedChange={async (enabled: boolean) => {
                    await invoke("tools_set_enabled", { id: tool.id, enabled });
                    void refresh();
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${tool.name}`}
                  onClick={async () => {
                    await invoke("tools_remove", { id: tool.id });
                    void refresh();
                  }}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {tool.description}
            </p>
            <code className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs">
              {tool.command}
            </code>
          </article>
        ))}
      </div>

      {!draft && (
        <div className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({ ...EMPTY });
              setPreview(null);
            }}
          >
            <PlusIcon className="size-4" /> Add a tool
          </Button>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Examples:</span>
            {TOOL_PRESETS.map((p) => (
              <Button
                key={p.name}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft({ ...p });
                  setPreview(null);
                }}
              >
                {p.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {draft && !preview && (
        <form
          className="space-y-2 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          <Input
            aria-label="Tool name"
            placeholder="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <select
            aria-label="Tool type"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as ToolKind })
            }
          >
            {(Object.keys(KIND_LABEL) as ToolKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {draft.kind !== "command" && (
            <Input
              aria-label="Tool source"
              placeholder={
                draft.kind === "git"
                  ? "https://github.com/owner/repo.git"
                  : "package-name"
              }
              value={draft.source}
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            />
          )}
          <Input
            aria-label="Tool command"
            placeholder="Command the AI runs, e.g. aclpubcheck"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <Textarea
            aria-label="When and how to use it"
            placeholder="When and how should the AI use this tool?"
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Review install
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {draft && preview && (
        <div
          className="space-y-2 rounded-lg border border-primary/40 p-3"
          role="group"
          aria-label="Confirm tool installation"
        >
          <p className="font-medium text-sm">Confirm: {draft.name}</p>
          <p className="text-sm">{preview.warning}</p>
          {preview.steps.length > 0 && (
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
              {preview.steps.join("\n")}
            </pre>
          )}
          {uvMissing && (
            <div className="space-y-1 text-sm">
              <p>
                This needs <b>uv</b>, which is not installed. Installing uv runs
                the official installer from astral.sh.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={uvInstalling}
                onClick={installUv}
              >
                {uvInstalling ? "Installing uv…" : "Install uv"}
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || uvMissing}
              onClick={() => void confirm()}
            >
              {busy ? "Installing…" : "Install and add"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Back
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap text-destructive text-sm"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export function ToolsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WrenchIcon className="size-4" /> AI tools
          </DialogTitle>
          <DialogDescription>
            Commands the AI can run for you.
          </DialogDescription>
        </DialogHeader>
        <ToolsLibrary />
      </DialogContent>
    </Dialog>
  );
}
