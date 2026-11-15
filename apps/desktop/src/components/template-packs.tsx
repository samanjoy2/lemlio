import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { exists, join } from "@/lib/tauri/fs";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CloudDownloadIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestOpenLink } from "@/components/workspace/preview/external-link-dialog";
import { DEFAULT_AGENTS_MD } from "@/lib/default-agents-md";
import {
  formatVersionDate,
  shortVersion,
  templateState,
  useTemplatePacks,
  type TemplatePack,
} from "@/lib/templates";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";

const DEFAULT_NAMES: Record<string, string> = {
  acl: "ACL paper",
  "ieee-enhanced": "IEEE paper",
};

export function TemplatePacks() {
  const { packs, error, checking, busyId, install, checkNow } =
    useTemplatePacks();
  const [creating, setCreating] = useState<TemplatePack | null>(null);
  const updates = packs.filter((p) => p.updateAvailable).length;

  const use = async (pack: TemplatePack) => {
    if (!pack.installed && !(await install(pack.id))) return;
    setCreating(packs.find((p) => p.id === pack.id) ?? pack);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-bold text-2xl tracking-tight">Templates</h1>
            <p className="mt-1 max-w-xl text-muted-foreground text-sm">
              Official templates, downloaded straight from their publishers.
              Lemlio tells you when a newer version is available.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={checking}
            onClick={() => void checkNow(true)}
          >
            {checking ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <RefreshCwIcon />
            )}
            Check for updates
          </Button>
        </div>

        {updates > 0 && (
          <p
            role="status"
            className="rounded-[12px] bg-primary/10 px-4 py-3 text-primary text-sm"
          >
            {updates === 1
              ? "1 template has a newer version."
              : `${updates} templates have newer versions.`}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              busy={busyId === pack.id}
              disabled={busyId !== null}
              onUse={() => void use(pack)}
              onUpdate={() => void install(pack.id)}
            />
          ))}
        </div>
      </div>

      <CreateFromTemplate pack={creating} onClose={() => setCreating(null)} />
    </div>
  );
}

function PackCard({
  pack,
  busy,
  disabled,
  onUse,
  onUpdate,
}: {
  pack: TemplatePack;
  busy: boolean;
  disabled: boolean;
  onUse: () => void;
  onUpdate: () => void;
}) {
  const state = templateState(pack);
  return (
    <article className="flex flex-col gap-4 rounded-[18px] border border-border bg-card p-5 shadow-sm">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-semibold text-lg leading-tight tracking-tight">
            {pack.name}
          </h2>
          {state === "update" && (
            <span className="shrink-0 rounded-full bg-primary px-2.5 py-0.5 font-semibold text-primary-foreground text-xs">
              Update available
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {pack.description}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {pack.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs"
            >
              {tag}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => requestOpenLink(pack.url)}
          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
        >
          github.com/{pack.repo}
          <ArrowUpRightIcon size={12} />
        </button>
      </div>

      <div className="mt-auto space-y-3">
        <VersionLine pack={pack} state={state} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={onUse}>
            {busy && !pack.installed ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : pack.installed ? (
              <FolderOpenIcon />
            ) : (
              <CloudDownloadIcon />
            )}
            {pack.installed ? "Use this template" : "Download and use"}
          </Button>
          {state === "update" && (
            <Button variant="outline" disabled={disabled} onClick={onUpdate}>
              {busy ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <RefreshCwIcon />
              )}
              Update
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function VersionLine({
  pack,
  state,
}: {
  pack: TemplatePack;
  state: ReturnType<typeof templateState>;
}) {
  if (state === "missing")
    return (
      <p className="text-muted-foreground text-xs">
        Not on this computer yet. It is downloaded from GitHub when you first
        use it.
      </p>
    );
  const have = pack.installed!;
  const date = formatVersionDate(have.committedAt);
  return (
    <div className="space-y-1 text-xs">
      <p
        className={`flex items-center gap-1.5 ${state === "current" ? "text-success" : "text-muted-foreground"}`}
      >
        {state === "current" && <CheckCircle2Icon size={14} />}
        {state === "current"
          ? "Up to date"
          : state === "update"
            ? "Installed"
            : "Installed"}{" "}
        · version {shortVersion(have.sha)}
        {date ? ` · ${date}` : ""}
      </p>
      {state === "update" && pack.latest && (
        <p className="text-foreground">
          Newer: version {shortVersion(pack.latest.sha)}
          {formatVersionDate(pack.latest.committedAt)
            ? ` · ${formatVersionDate(pack.latest.committedAt)}`
            : ""}
          {pack.latest.message ? ` — “${pack.latest.message}”` : ""}
        </p>
      )}
      {state === "unchecked" && (
        <p className="text-muted-foreground">
          Not compared with the latest version yet.
        </p>
      )}
    </div>
  );
}

function CreateFromTemplate({
  pack,
  onClose,
}: {
  pack: TemplatePack | null;
  onClose: () => void;
}) {
  const lastFolder = useProjectStore((s) => s.lastProjectFolder);
  const setLastFolder = useProjectStore((s) => s.setLastProjectFolder);
  const addRecent = useProjectStore((s) => s.addRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!pack) return;
    setName(DEFAULT_NAMES[pack.id] ?? pack.name);
    setError("");
    if (folder) return;
    if (lastFolder) setFolder(lastFolder);
    else
      void homeDir()
        .then((home) => join(home, "Documents", "Lemlio"))
        .then(async (dir) => {
          await mkdir(dir, { recursive: true }).catch(() => {});
          setFolder(dir);
        })
        .catch(() => {});
  }, [pack?.id]);

  if (!pack) return null;

  const choose = async () => {
    const selected = await chooseFolder({
      directory: true,
      multiple: false,
      title: "Choose where to keep the new project",
    });
    if (typeof selected === "string") setFolder(selected);
  };

  const create = async () => {
    if (!folder || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const destination = await join(folder, name.trim());
      const mainFile = await invoke<string>("template_create_project", {
        id: pack.id,
        destination,
      });
      const agents = await join(destination, "AGENTS.md");
      if (!(await exists(agents)))
        await writeTextFile(agents, DEFAULT_AGENTS_MD);
      setLastFolder(folder);
      addRecent(destination);
      await openProject(destination);
      const document = useDocumentStore.getState();
      const main = document.files.find((f) => f.relativePath === mainFile);
      if (main) document.setMainFile(main.id);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error("Could not create the project", { description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project from {pack.name}</DialogTitle>
          <DialogDescription>
            Version {pack.installed ? shortVersion(pack.installed.sha) : ""} of
            the official files is copied into a new folder. It opens with{" "}
            <strong>{pack.mainFile}</strong>.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Project name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-10 w-full rounded-[10px] border border-input bg-background px-3 text-sm outline-none focus:border-primary/60 focus:ring-[3px] focus:ring-primary/20"
            />
          </label>
          <div className="space-y-1.5 text-sm">
            <span className="font-medium">Location</span>
            <div className="flex items-center gap-2">
              <p
                className="min-w-0 flex-1 truncate rounded-[10px] bg-muted px-3 py-2 text-muted-foreground text-xs"
                title={folder ?? ""}
              >
                {folder ?? "Choosing…"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={choose}
              >
                Change…
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !folder || !name.trim()}>
              {busy && <LoaderCircleIcon className="animate-spin" />}
              Create project
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
