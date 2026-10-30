import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PencilIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ProjectTitle({ path }: { path: string | null }) {
  const fallback = path?.split(/[/\\]/).pop() || "Project";
  const [name, setName] = useState(fallback);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    setName(fallback);
    if (path)
      void invoke<{ name: string }>("project_details", { projectPath: path })
        .then((result) => {
          if (!disposed) setName(result.name || fallback);
        })
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [path, fallback]);
  return (
    <>
      <button
        type="button"
        className="flex max-w-full items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
        title="Rename project"
        onClick={() => {
          setDraft(name);
          setError("");
          setEditing(true);
        }}
      >
        <span className="truncate">{name}</span>
        <PencilIcon size={11} className="shrink-0" />
      </button>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!path || !draft.trim()) return;
              setBusy(true);
              setError("");
              try {
                await invoke("rename_project", {
                  projectPath: path,
                  name: draft.trim(),
                });
                setName(draft.trim());
                setEditing(false);
                window.dispatchEvent(new Event("project-library-changed"));
                window.dispatchEvent(
                  new CustomEvent("lemlio-project-renamed", { detail: path }),
                );
              } catch (error) {
                setError(String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Input
              aria-label="Project name"
              autoFocus
              maxLength={200}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button type="submit" disabled={busy || !draft.trim()}>
              {busy ? "Saving…" : "Save name"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
