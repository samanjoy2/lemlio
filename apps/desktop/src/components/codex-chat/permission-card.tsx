import { type FC } from "react";
import { ShieldQuestionIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCodexChatStore } from "@/stores/codex-chat-store";

/**
 * Shown when the assistant was refused a command. It says exactly what was wanted;
 * nothing runs until the user chooses.
 */
export const PermissionCard: FC = () => {
  const approvals = useCodexChatStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.approvals ?? [],
  );
  const streaming = useCodexChatStore((s) => s.isStreaming);
  const approve = useCodexChatStore((s) => s.approveAndContinue);
  const dismiss = useCodexChatStore((s) => s._setApprovals);
  const activeTabId = useCodexChatStore((s) => s.activeTabId);
  if (approvals.length === 0) return null;
  const allowable = approvals.filter((a) => a.rule);
  const rules = allowable.map((a) => a.rule as string);

  return (
    <section
      aria-label="Permission needed"
      className="my-3 space-y-3 rounded-[18px] border border-primary/30 bg-primary/5 p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <ShieldQuestionIcon className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-sm">Permission needed</p>
          <p className="text-muted-foreground text-xs">
            The assistant wants to do the following. Nothing runs unless you
            allow it.
          </p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {approvals.map((a) => (
          <li
            key={a.id}
            className="break-all rounded-[10px] bg-muted px-3 py-2 font-mono text-[12px] leading-snug"
          >
            {a.summary}
            {!a.rule && (
              <span className="mt-1 block font-sans text-[11px] text-muted-foreground">
                This kind of action cannot be allowed from here.
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {rules.length > 0 && (
          <>
            <Button
              size="sm"
              disabled={streaming}
              onClick={() => void approve(rules, false)}
            >
              Allow once and continue
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={streaming}
              onClick={() => void approve(rules, true)}
            >
              Always allow in this project
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => dismiss(activeTabId, [])}
        >
          Not now
        </Button>
      </div>
    </section>
  );
};
