import { XIcon } from "lucide-react";
import { useCodexChatStore } from "@/stores/codex-chat-store";
export function AgentStopButton() {
  const running = useCodexChatStore((s) => s.isStreaming);
  const cancel = useCodexChatStore((s) => s.cancelExecution);
  return running ? (
    <button
      type="button"
      aria-label="Stop agent"
      className="flex h-8 items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 text-destructive text-xs hover:bg-destructive/20"
      onClick={cancel}
    >
      <XIcon className="size-3.5" />
      Stop agent
    </button>
  ) : null;
}
