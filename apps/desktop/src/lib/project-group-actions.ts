import { toast } from "sonner";
import {
  activeCollaboration,
  activateCollaboration,
  reconcileCollaborationSource,
  useCollaborationStore,
} from "@/lib/collaboration/runtime";
import { projectPathKey } from "@/lib/project-catalog";
import { invoke } from "@tauri-apps/api/core";
import { useProjectGroups } from "@/stores/project-groups-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
export interface GroupDiff {
  path: string;
  files: {
    file_path: string;
    status: string;
    old_content: string | null;
    new_content: string | null;
  }[];
}
export async function switchGroupProject(path: string) {
  const doc = useDocumentStore.getState();
  if (
    doc.isCompiling ||
    useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
  )
    throw Error(
      "Wait for the compiler or stop the agent before switching versions.",
    );
  await doc.saveAllFiles();
  if (useDocumentStore.getState().files.some((f) => f.isDirty))
    throw Error("Some edits could not be saved. This version is still open.");
  if (doc.projectRoot !== path) await doc.openProject(path);
}
export async function runGroupEdit(
  paths: string[],
  prompt: string,
  onReady?: () => void,
  context?: { label: string; filePath: string; selectedText: string },
  mainPath?: string,
) {
  const doc = useDocumentStore.getState();
  if (
    doc.isCompiling ||
    useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
  )
    throw Error("Wait for compilation and running agents to finish.");
  await doc.saveAllFiles();
  if (useDocumentStore.getState().files.some((f) => f.isDirty))
    throw Error("Save your changes first.");
  if (paths.length < 2 || paths.length > 20)
    throw Error("Choose between 2 and 20 projects.");
  const replica = activeCollaboration();
  if (
    replica &&
    paths.some((path) => projectPathKey(path) === projectPathKey(replica.path))
  ) {
    const wasLive =
      useCollaborationStore.getState().connected ||
      useCollaborationStore.getState().connecting ||
      useCollaborationStore.getState().hosting;
    await replica.disconnect();
    if (wasLive)
      toast.info("Live sharing paused for this group edit", {
        description:
          "Your shared history is kept. Reconnect after reviewing the agent's changes.",
      });
  }
  const review: { path: string; snapshot: string }[] = [];
  for (const path of paths) {
    await reconcileCollaborationSource(path);
    await invoke("history_init", { projectRoot: path });
    await invoke("history_snapshot", {
      projectRoot: path,
      message: "Before group agent edit",
    });
    const snapshots = await invoke<{ id: string }[]>("history_list", {
      projectRoot: path,
      limit: 1,
      offset: 0,
    });
    if (!snapshots[0]) throw Error(`Could not checkpoint ${path}`);
    review.push({ path, snapshot: snapshots[0].id });
  }
  useProjectGroups.setState({ review });
  await switchGroupProject(paths[0]);
  await activateCollaboration(paths[0]);
  onReady?.();
  const chat = useCodexChatStore.getState();
  const tabId = chat.createTab();
  useProjectGroups.setState({ scope: { tabId, paths: [...paths], mainPath } });
  await useCodexChatStore
    .getState()
    .sendPrompt(
      prompt,
      context
        ? { ...context, label: `${context.label} (from ${doc.projectRoot})` }
        : undefined,
    );
}
export async function reviewGroupEdit(): Promise<GroupDiff[]> {
  if (useCodexChatStore.getState().tabs.some((t) => t.isStreaming))
    throw Error("Wait for the agent to finish before reviewing changes.");
  await useDocumentStore.getState().saveAllFiles();
  if (useDocumentStore.getState().files.some((f) => f.isDirty))
    throw Error("Save your edits before review.");
  const result: { path: string; files: GroupDiff["files"] }[] = [];
  for (const item of useProjectGroups.getState().review) {
    await invoke("history_snapshot", {
      projectRoot: item.path,
      message: "Group edit review checkpoint",
    });
    const latest = await invoke<{ id: string }[]>("history_list", {
      projectRoot: item.path,
      limit: 1,
      offset: 0,
    });
    const files = await invoke<GroupDiff["files"]>("history_diff", {
      projectRoot: item.path,
      fromId: item.snapshot,
      toId: latest[0].id,
    });
    result.push({ path: item.path, files });
  }

  return result;
}

export async function stopGroupAgent() {
  const chat = useCodexChatStore.getState();
  const scope = useProjectGroups.getState().scope;
  const running =
    chat.tabs.find((t) => t.id === scope?.tabId && t.isStreaming) ||
    chat.tabs.find((t) => t.isStreaming);
  if (running) {
    chat.setActiveTab(running.id);
    await useCodexChatStore.getState().cancelExecution();
  }
}

export async function finalizeGroupEdit(tabId: string) {
  const scope = useProjectGroups.getState().scope;
  if (scope?.tabId !== tabId) return;
  const errors: string[] = [];
  for (const path of scope.paths) {
    try {
      await reconcileCollaborationSource(path);
      window.dispatchEvent(
        new CustomEvent("lemlio-project-saved", { detail: path }),
      );
    } catch (error) {
      errors.push(`${path}: ${String(error)}`);
    }
  }
  if (errors.length)
    throw Error(
      "Group files were kept, but shared history needs attention. " +
        errors.join("; "),
    );
}
