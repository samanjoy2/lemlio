import {
  ArrowUpRightIcon,
  FileTextIcon,
  Loader2Icon,
  StarIcon,
  XIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  PencilIcon,
  CopyPlusIcon,
  FolderOpenIcon,
} from "lucide-react";
import { projectPathKey, type CatalogProject } from "@/lib/project-catalog";
import { ArchiveIcon, ArchiveRestoreIcon, FolderPlusIcon } from "lucide-react";
import { useCollectionsStore } from "@/stores/collections-store";
import {
  CloudAlertIcon,
  CloudCheckIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
} from "lucide-react";
import { backupSummary } from "@/lib/backup-summary";
import { DRIVE_UPDATED, projectDriveStatus } from "@/lib/drive-backup-status";
import { collectionIcon } from "@/lib/collection-icons";
import { requestNewCollection } from "./collection-dialog";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  cachedProjectThumbnail,
  projectThumbnail,
  THUMBNAIL_UPDATED,
} from "@/lib/project-thumbnails";
import { useSettingsStore } from "@/stores/settings-store";
import { ActivityOrb } from "./activity-feedback";
import { requestProjectClone } from "./clone-project-dialog";
import { requestProjectDelete } from "./delete-project-dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

function openedLabel(timestamp: number): string {
  if (!timestamp) return "";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days === 0) return "Opened today";
  if (days === 1) return "Opened yesterday";
  return `Opened ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "Asia/Dhaka" }).format(timestamp)}`;
}

export function ProjectCard({
  project,
  starred,
  archived,
  busy,
  opening,
  onOpen,
  onStar,
  onArchive,
  onRemoveRecent,
  onExport,
  exporting,
}: {
  project: CatalogProject;
  starred: boolean;
  archived: boolean;
  busy: boolean;
  opening: boolean;
  onOpen: () => void;
  onStar: () => void;
  onArchive: () => void;
  onRemoveRecent?: () => void;
  onExport: () => void;
  exporting: boolean;
}) {
  const archive = project.texFileCount === 0;
  const collections = useCollectionsStore((s) => s.collections);
  const members = useCollectionsStore((s) => s.members);
  const toggleCollection = useCollectionsStore((s) => s.toggle);
  const projectKey = projectPathKey(project.path);
  const [, refreshBackup] = useState(0);
  useEffect(() => {
    const update = () => refreshBackup((n) => n + 1);
    window.addEventListener(DRIVE_UPDATED, update);
    // "5 minutes ago" goes stale; refresh it now and then.
    const timer = setInterval(update, 60_000);
    return () => {
      window.removeEventListener(DRIVE_UPDATED, update);
      clearInterval(timer);
    };
  }, []);
  const backup = backupSummary(projectDriveStatus(project.path));
  const BackupIcon = !backup
    ? CloudCheckIcon
    : backup.tone === "incoming"
      ? CloudDownloadIcon
      : backup.tone === "attention"
        ? CloudAlertIcon
        : backup.text.startsWith("Backing up")
          ? CloudUploadIcon
          : CloudCheckIcon;
  const memberOf = collections.filter((c) =>
    members[c.id]?.includes(projectKey),
  );
  const card = useRef<HTMLElement>(null);
  const [thumbnail, setThumbnail] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [details, setDetails] = useState<{
    name?: string;
    created?: number;
    modified?: number;
  }>({});
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.name);
  const [renameError, setRenameError] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void invoke<typeof details>("project_details", {
        projectPath: project.path,
      })
        .then((value) => {
          if (!disposed) setDetails(value);
        })
        .catch(() => {});
    refresh();
    window.addEventListener("project-library-changed", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("project-library-changed", refresh);
    };
  }, [project.path]);
  useEffect(() => {
    let disposed = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void (async () => {
        try {
          const url = await projectThumbnail(
            project.path,
            project.mainFile,
            useSettingsStore.getState().compilerBackend === "texlive",
            () => {
              if (!disposed) setPreviewLoading(true);
            },
          );
          if (!disposed) setThumbnail(url || undefined);
        } catch {
        } finally {
          if (!disposed) setPreviewLoading(false);
        }
      })();
    });
    const unlisten = listen<string>(THUMBNAIL_UPDATED, (event) => {
      if (event.payload === project.path)
        void cachedProjectThumbnail(project.path)
          .then((cached) => {
            if (!disposed) setThumbnail(cached.dataUrl || undefined);
          })
          .catch(() => {});
    });
    if (card.current) observer.observe(card.current);
    return () => {
      disposed = true;
      observer.disconnect();
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [project.path, project.mainFile]);
  const date = (value?: number) =>
    value ? new Date(value).toLocaleDateString() : "Unavailable";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.article
          ref={card}
          className="home-project-card"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.985 }}
          transition={{
            type: "spring",
            stiffness: 420,
            damping: 32,
            mass: 0.7,
          }}
        >
          <button
            type="button"
            className="home-project-open"
            aria-label={`Open ${project.name}`}
            disabled={busy}
            onClick={onOpen}
          >
            <div className="home-project-cover" aria-hidden="true">
              {previewLoading && <ActivityOrb compact label="Preparing PDF…" />}
              {thumbnail && (
                <img
                  src={thumbnail}
                  alt=""
                  className="h-full w-full object-cover object-top"
                />
              )}
              <div
                className="home-mini-document"
                style={
                  thumbnail || previewLoading ? { display: "none" } : undefined
                }
              >
                <FileTextIcon size={20} strokeWidth={1.3} />
                <span />
                <span />
                <span />
                <span />
              </div>
              <span
                className="home-project-kind"
                style={thumbnail ? { display: "none" } : undefined}
              >
                {archive ? "Conversations" : (memberOf[0]?.name ?? "Project")}
              </span>
            </div>
            <div className="home-project-body">
              <h3 title={details.name || project.name}>
                {details.name || project.name}
              </h3>
              <p>
                Created {date(details.created)} · Modified{" "}
                {date(details.modified)}
              </p>
              <p>
                {archive
                  ? "Conversation archive"
                  : project.fileCount !== undefined
                    ? `${project.fileCount} files`
                    : "Local project"}
                {!archive && project.mainFile
                  ? ` · ${project.mainFile.split(/[/\\]/).pop()}`
                  : ""}
              </p>
              {backup && (
                <p
                  className={`home-project-backup is-${backup.tone}`}
                  title={backup.detail}
                >
                  <BackupIcon size={13} aria-hidden />
                  <span>{backup.text}</span>
                </p>
              )}
              {(opening || !!project.lastOpened) && (
                <div className="home-project-bottom">
                  <span>
                    {opening
                      ? "Opening project…"
                      : project.lastOpened
                        ? openedLabel(project.lastOpened)
                        : project.imported
                          ? ""
                          : ""}
                  </span>
                  {opening ? (
                    <Loader2Icon size={14} className="animate-spin" />
                  ) : (
                    <ArrowUpRightIcon size={14} />
                  )}
                </div>
              )}
            </div>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="absolute top-2 left-2 rounded-md border border-border/50 bg-background/95 p-1.5 shadow-sm"
                aria-label={`Actions for ${project.name}`}
              >
                <MoreHorizontalIcon size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => {
                  setTitle(details.name || project.name);
                  setEditing(true);
                }}
              >
                <PencilIcon />
                Rename project
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() =>
                  requestProjectClone(
                    project.path,
                    details.name || project.name,
                  )
                }
              >
                <CopyPlusIcon />
                Clone project
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void invoke("open_project_folder", {
                    projectPath: project.path,
                  })
                }
              >
                <FolderOpenIcon />
                Open project folder
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={onExport}>
                <DownloadIcon />
                Export ZIP
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderPlusIcon />
                  Add to collection
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {collections.map((collection) => {
                    const Icon = collectionIcon(collection.name);
                    return (
                      <DropdownMenuCheckboxItem
                        key={collection.id}
                        checked={!!members[collection.id]?.includes(projectKey)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={() =>
                          toggleCollection(collection.id, project.path)
                        }
                      >
                        <Icon />
                        {collection.name}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                  {collections.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onSelect={() => requestNewCollection(project.path)}
                  >
                    <FolderPlusIcon />
                    New collection…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={onArchive}>
                {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {archived ? "Unarchive project" : "Archive project"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  requestProjectDelete(
                    project.path,
                    details.name || project.name,
                  )
                }
              >
                <Trash2Icon />
                Delete project…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {editing && (
            <div className="absolute inset-0 z-10 flex flex-col gap-2 bg-background p-4">
              <label className="text-xs">
                Project name
                <input
                  className="mt-2 w-full rounded border p-2"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <p role="alert" className="text-destructive text-xs">
                {renameError}
              </p>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await invoke("rename_project", {
                      projectPath: project.path,
                      name: title,
                    });
                    setDetails({ ...details, name: title.trim() });
                    setEditing(false);
                    window.dispatchEvent(new Event("project-library-changed"));
                    window.dispatchEvent(
                      new CustomEvent("lemlio-project-renamed", {
                        detail: project.path,
                      }),
                    );
                  } catch (e) {
                    setRenameError(String(e));
                  }
                }}
              >
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          )}
          <button
            type="button"
            className={`home-star ${starred ? "is-starred" : ""}`}
            aria-label={`${starred ? "Unstar" : "Star"} ${project.name}`}
            aria-pressed={starred}
            onClick={onStar}
          >
            <StarIcon size={15} fill={starred ? "currentColor" : "none"} />
          </button>
          {onRemoveRecent && (
            <button
              type="button"
              className="home-remove-recent"
              title="Remove from recent projects"
              aria-label={`Remove ${project.name} from recent`}
              onClick={onRemoveRecent}
            >
              <XIcon size={13} />
            </button>
          )}
          <button
            type="button"
            className="home-export"
            aria-label={`Export ${project.name} as ZIP`}
            title="Export project ZIP"
            disabled={busy}
            onClick={onExport}
          >
            {exporting ? (
              <Loader2Icon size={14} className="animate-spin" />
            ) : (
              <DownloadIcon size={14} />
            )}
          </button>
        </motion.article>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={busy} onSelect={onOpen}>
          Open project
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            setTitle(details.name || project.name);
            setEditing(true);
          }}
        >
          <PencilIcon />
          Rename project
        </ContextMenuItem>
        <ContextMenuItem
          disabled={busy}
          onSelect={() =>
            requestProjectClone(project.path, details.name || project.name)
          }
        >
          <CopyPlusIcon />
          Clone project
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void invoke("open_project_folder", { projectPath: project.path })
          }
        >
          <FolderOpenIcon />
          Open project folder
        </ContextMenuItem>
        <ContextMenuItem disabled={busy} onSelect={onExport}>
          <DownloadIcon />
          Export ZIP
        </ContextMenuItem>
        <ContextMenuItem onSelect={onStar}>
          <StarIcon />
          {starred ? "Unstar" : "Star"} project
        </ContextMenuItem>
        <ContextMenuItem onSelect={onArchive}>
          {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {archived ? "Unarchive" : "Archive"} project
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() =>
            requestProjectDelete(project.path, details.name || project.name)
          }
        >
          <Trash2Icon />
          Delete project…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
