import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRightIcon,
  FolderOpenIcon,
  MinusIcon,
  SearchIcon,
  SettingsIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useDocumentStore } from "@/stores/document-store";
import { toast } from "sonner";

export function WindowHeader() {
  const root = useDocumentStore((s) => s.projectRoot);
  const file = useDocumentStore(
    (s) => s.files.find((f) => f.id === s.activeFileId)?.name,
  );
  const [name, setName] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (root)
        void invoke<{ name: string }>("project_details", { projectPath: root })
          .then((p) => {
            if (!disposed) setName(p.name);
          })
          .catch(() => {});
    };
    refresh();
    window.addEventListener("project-library-changed", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("project-library-changed", refresh);
    };
  }, [root]);
  if (!navigator.userAgent.includes("Windows")) return null;
  const saveThen = async (action: () => void | Promise<void>) => {
    try {
      await useDocumentStore.getState().saveAllFiles();
      if (useDocumentStore.getState().files.some((f) => f.isDirty))
        throw Error("Save your edits before closing this project");
      await action();
    } catch (error) {
      toast.error("Could not save your edits", { description: String(error) });
    }
  };
  return (
    <header className="app-window-header">
      <div className="app-window-brand" data-tauri-drag-region>
        <img src="/icon-192.png" alt="" />
        <span>Lemlio</span>
      </div>
      <nav
        aria-label="Project breadcrumb"
        className="flex min-w-0 items-center gap-2 text-xs"
      >
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() =>
            void saveThen(() => useDocumentStore.getState().closeProject())
          }
        >
          Projects
        </button>
        {root && (
          <>
            <ChevronRightIcon
              size={12}
              className="shrink-0 text-muted-foreground"
            />
            <span className="max-w-60 truncate">
              {name || root.split(/[/\\]/).pop()}
            </span>
            {file && (
              <span className="max-w-48 truncate text-muted-foreground">
                / {file}
              </span>
            )}
          </>
        )}
      </nav>
      <div
        className="h-full min-w-3 flex-1"
        data-tauri-drag-region
        onDoubleClick={() => void getCurrentWindow().toggleMaximize()}
      />
      {!root && (
        <button
          type="button"
          className="app-window-action"
          title="Search projects (Ctrl+K)"
          aria-label="Search projects"
          onClick={() =>
            window.dispatchEvent(new Event("lemlio-focus-project-search"))
          }
        >
          <SearchIcon size={15} />
        </button>
      )}
      <button
        type="button"
        className="app-window-action"
        title={root ? "Open project folder" : "Open Imports folder"}
        aria-label={root ? "Open project folder" : "Open Imports folder"}
        onClick={async () => {
          try {
            const path =
              root ||
              `${await invoke<string>("project_storage_location")}/Imports`;
            await invoke("open_project_folder", { projectPath: path });
          } catch (error) {
            toast.error(String(error));
          }
        }}
      >
        <FolderOpenIcon size={15} />
      </button>
      <button
        type="button"
        className="app-window-action"
        aria-label="Settings"
        title="Settings"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("lemlio-open-settings", { detail: "General" }),
          )
        }
      >
        <SettingsIcon size={15} />
      </button>
      <div className="app-window-controls">
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => void getCurrentWindow().minimize()}
        >
          <MinusIcon size={14} />
        </button>
        <button
          type="button"
          aria-label="Maximize or restore window"
          onClick={() => void getCurrentWindow().toggleMaximize()}
        >
          <SquareIcon size={12} />
        </button>
        <button
          type="button"
          aria-label="Close window"
          className="app-window-close"
          onClick={() => void saveThen(() => getCurrentWindow().close())}
        >
          <XIcon size={15} />
        </button>
      </div>
    </header>
  );
}
