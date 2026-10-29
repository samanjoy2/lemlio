import { useRef, useState, type ReactNode } from "react";
import { EditorView } from "@codemirror/view";
import { undo, redo, selectAll, toggleComment } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { requestProjectDelete } from "./delete-project-dialog";
import {
  CopyIcon,
  ScissorsIcon,
  ClipboardIcon,
  Undo2Icon,
  Redo2Icon,
  SaveIcon,
  PlayIcon,
  FolderOpenIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";

type TextInput = HTMLInputElement | HTMLTextAreaElement;
export function AppContextMenu({ children }: { children: ReactNode }) {
  const target = useRef<{
    view?: EditorView;
    input?: TextInput;
    from: number;
    to: number;
    text: string;
  }>({ from: 0, to: 0, text: "" });
  const [kind, setKind] = useState<"editor" | "input" | "workspace">(
    "workspace",
  );
  const [selected, setSelected] = useState(false);
  const project = useDocumentStore((s) => s.projectRoot);
  const streaming = useCodexChatStore((s) => s.isStreaming);
  const safe = (action: () => void | Promise<unknown>) => {
    Promise.resolve()
      .then(action)
      .catch((e) =>
        toast.error("Action could not be completed", {
          description: String(e),
        }),
      );
  };
  const settings = () =>
    window.dispatchEvent(
      new CustomEvent("lemlio-open-settings", { detail: "Google Drive" }),
    );
  const library = (action: string) =>
    window.dispatchEvent(
      new CustomEvent("lemlio-library-action", { detail: action }),
    );
  const replace = (text: string) => {
    const t = target.current;
    if (t.view) {
      t.view.dispatch(t.view.state.replaceSelection(text));
      t.view.focus();
    } else if (t.input) {
      const input = t.input;
      const value =
        input.value.slice(0, t.from) + text + input.value.slice(t.to);
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(t.from + text.length, t.from + text.length);
    }
  };
  const copy = () => navigator.clipboard.writeText(target.current.text);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          const element = event.target as HTMLElement;
          const editor = element.closest(".cm-editor");
          const view = editor
            ? EditorView.findFromDOM(editor as HTMLElement) || undefined
            : undefined;
          const input = element.closest(
            'textarea,input:not([type]),input[type="text"],input[type="search"],input[type="url"],input[type="email"],input[type="tel"],input[type="password"]',
          ) as TextInput | null;
          const from =
            view?.state.selection.main.from ?? input?.selectionStart ?? 0;
          const to = view?.state.selection.main.to ?? input?.selectionEnd ?? 0;
          const text = view
            ? view.state.sliceDoc(from, to)
            : input
              ? input.type === "password"
                ? ""
                : input.value.slice(from, to)
              : window.getSelection()?.toString() || "";
          target.current = { view, input: input || undefined, from, to, text };
          setKind(view ? "editor" : input ? "input" : "workspace");
          setSelected(!!text);
        }}
      >
        <div className="h-full min-h-0">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-56"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {kind === "editor" && (
          <>
            <ContextMenuItem
              onSelect={() => {
                const view = target.current.view!;
                undo(view);
                view.focus();
              }}
            >
              <Undo2Icon />
              Undo
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                const view = target.current.view!;
                redo(view);
                view.focus();
              }}
            >
              <Redo2Icon />
              Redo
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {(kind !== "workspace" || selected) && (
          <>
            {kind !== "workspace" && (
              <ContextMenuItem
                disabled={!selected || !!target.current.input?.readOnly}
                onSelect={() =>
                  safe(async () => {
                    await copy();
                    replace("");
                  })
                }
              >
                <ScissorsIcon />
                Cut
              </ContextMenuItem>
            )}
            <ContextMenuItem disabled={!selected} onSelect={() => safe(copy)}>
              <CopyIcon />
              Copy
            </ContextMenuItem>
            {kind !== "workspace" && (
              <>
                <ContextMenuItem
                  disabled={!!target.current.input?.readOnly}
                  onSelect={() =>
                    safe(async () =>
                      replace(await navigator.clipboard.readText()),
                    )
                  }
                >
                  <ClipboardIcon />
                  Paste
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    const t = target.current;
                    if (t.view) {
                      selectAll(t.view);
                      t.view.focus();
                    } else {
                      t.input?.focus();
                      t.input?.select();
                    }
                  }}
                >
                  Select all
                </ContextMenuItem>
              </>
            )}
            {kind === "editor" && (
              <ContextMenuItem
                onSelect={() => {
                  toggleComment(target.current.view!);
                  target.current.view!.focus();
                }}
              >
                Toggle comment
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {project ? (
          <>
            <ContextMenuItem
              onSelect={() =>
                safe(() => useDocumentStore.getState().saveAllFiles())
              }
            >
              <SaveIcon />
              Save all files
            </ContextMenuItem>
            <ContextMenuItem
              disabled={useDocumentStore.getState().isCompiling}
              onSelect={() =>
                window.dispatchEvent(new Event("lemlio-compile-preview"))
              }
            >
              <PlayIcon />
              Compile PDF
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                safe(() =>
                  invoke("open_project_folder", { projectPath: project }),
                )
              }
            >
              <FolderOpenIcon />
              Open project folder
            </ContextMenuItem>
            {streaming && (
              <ContextMenuItem
                onSelect={() =>
                  safe(() => useCodexChatStore.getState().cancelExecution())
                }
              >
                Stop agent
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() =>
                requestProjectDelete(
                  project,
                  project.split(/[/\\]/).pop() || "Project",
                )
              }
            >
              <Trash2Icon />
              Delete project…
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => library("new")}>
              New project
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => library("import")}>
              Import project ZIP
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => library("open")}>
              <FolderOpenIcon />
              Open a project folder
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => library("refresh")}>
              Refresh projects
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={settings}>
          <SettingsIcon />
          Settings
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
