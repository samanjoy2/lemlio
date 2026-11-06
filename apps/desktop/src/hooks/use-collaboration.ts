import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect } from "react";
import { toast } from "sonner";
import { useDocumentStore } from "@/stores/document-store";
import {
  activateCollaboration,
  activeCollaboration,
  deactivateCollaboration,
  useCollaborationStore,
} from "@/lib/collaboration/runtime";
import { projectPathKey } from "@/lib/project-catalog";

export function useCollaboration() {
  const root = useDocumentStore((s) => s.projectRoot);
  useLayoutEffect(() => {
    let disposed = false;
    if (!root) {
      void deactivateCollaboration().catch((error) =>
        toast.error("Shared history could not be saved", {
          description: String(error),
        }),
      );
      return;
    }
    useCollaborationStore.setState({ loading: true, path: root });
    void activateCollaboration(root)
      .catch((error) => {
        if (!disposed) {
          useCollaborationStore.setState({ error: String(error) });
          toast.error("Could not load shared history", {
            description: String(error),
          });
        }
      })
      .finally(() => {
        if (!disposed) useCollaborationStore.setState({ loading: false });
      });
    const stop = useDocumentStore.subscribe((state, previous) => {
      const replica = activeCollaboration();
      if (
        !replica ||
        projectPathKey(replica.path) !== projectPathKey(root) ||
        state.projectRoot !== root ||
        state.files === previous.files
      )
        return;
      for (const file of state.files) {
        if (file.content === undefined || !file.isDirty) continue;
        const id = replica.project.fileAt(file.relativePath);
        if (id && replica.project.heads(id)[0]?.kind === "text")
          replica.project.setText(id, file.content);
      }
    });
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== root || disposed) return;
      const replica = activeCollaboration();
      if (!replica || replica.path !== root) return;
      const files = replica.project.materialize().files;
      const doc = useDocumentStore.getState();
      let any = false;
      const updated = doc.files.map((file) => {
        const shared = files.find((f) => f.path === file.relativePath);
        if (shared?.text !== undefined && shared.text !== file.content) {
          any = true;
          return { ...file, content: shared.text, isDirty: true };
        }
        return file;
      });
      if (any) {
        useDocumentStore.setState((s) => ({
          files: updated,
          contentGeneration: s.contentGeneration + 1,
        }));
        void doc.saveAllFiles().catch(() => {});
      }
    };
    const materialized = (event: Event) => {
      if ((event as CustomEvent<string>).detail === root && !disposed)
        void useDocumentStore
          .getState()
          .refreshFiles()
          .catch(() => {});
    };
    const saved = (event: Event) => {
      if ((event as CustomEvent<string>).detail === root && !disposed)
        void activeCollaboration()
          ?.reconcileDisk()
          .catch((error) =>
            useCollaborationStore.setState({ error: String(error) }),
          );
    };
    const renamed = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== root) return;
      void invoke<{ name?: string }>("project_details", { projectPath: root })
        .then((details) => {
          if (details.name && activeCollaboration()?.path === root)
            activeCollaboration()!.project.meta.set("title", details.name);
        })
        .catch(() => {});
    };
    const scan = setInterval(() => {
      if (
        !disposed &&
        !useDocumentStore.getState().files.some((f) => f.isDirty)
      )
        void activeCollaboration()
          ?.reconcileDisk()
          .catch((error) =>
            useCollaborationStore.setState({ error: String(error) }),
          );
    }, 10000);
    window.addEventListener("lemlio-project-renamed", renamed);
    window.addEventListener("lemlio-collaboration-changed", changed);
    window.addEventListener("lemlio-collaboration-files", materialized);
    window.addEventListener("lemlio-project-saved", saved);
    return () => {
      disposed = true;
      stop();
      clearInterval(scan);
      window.removeEventListener("lemlio-project-renamed", renamed);
      window.removeEventListener("lemlio-collaboration-changed", changed);
      window.removeEventListener("lemlio-collaboration-files", materialized);
      window.removeEventListener("lemlio-project-saved", saved);
    };
  }, [root]);
}
