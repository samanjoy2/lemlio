import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useCodexChatStore } from "@/stores/codex-chat-store";

interface Question {
  id: string;
  header: string;
  question: string;
  options?: { label: string; description: string }[];
}
interface Request {
  id: number | string;
  tab_id: string;
  method: string;
  params: {
    command?: string;
    reason?: string;
    cwd?: string;
    grantRoot?: string;
    threadId: string;
    permissions?: unknown;
    networkApprovalContext?: { host: string; protocol: string };
    questions?: Question[];
    item?: unknown;
  };
}

export function CodexRequests() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const register = async () => {
      const stop = await listen<Request>("codex-request", ({ payload }) => {
        setRequests((items) =>
          items.some((item) => item.id === payload.id)
            ? items
            : [...items, payload],
        );
      });
      if (disposed) {
        stop();
        return;
      }
      stops.push(stop);
      const resolved = await listen<{ requestId: number | string }>(
        "codex-request-resolved",
        ({ payload }) => {
          setRequests((items) =>
            items.filter((item) => item.id !== payload.requestId),
          );
        },
      );
      if (disposed) {
        resolved();
        return;
      }
      stops.push(resolved);
      const completed = await listen<{ tab_id: string }>(
        "codex-complete",
        ({ payload }) => {
          setRequests((items) =>
            items.filter((item) => item.tab_id !== payload.tab_id),
          );
        },
      );
      if (disposed) {
        completed();
        return;
      }
      stops.push(completed);
    };
    void register();
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);
  const request = requests[0];
  useEffect(() => {
    setAnswers({});
    setError(null);
  }, [request?.id]);
  if (!request) return null;
  const questions = request.params.questions ?? [];
  const isQuestion = request.method === "item/tool/requestUserInput";
  const isPermissions = request.method === "item/permissions/requestApproval";
  const supported =
    isQuestion ||
    isPermissions ||
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(request.method);
  const tab = useCodexChatStore
    .getState()
    .tabs.find((tab) => tab.id === request.tab_id);
  const reply = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    let result: unknown;
    if (isQuestion) {
      result = {
        answers: Object.fromEntries(
          questions.map((question) => [
            question.id,
            {
              answers: [
                accept
                  ? (answers[question.id] ?? "")
                  : "User declined to answer",
              ],
            },
          ]),
        ),
      };
    } else if (isPermissions) {
      result = {
        permissions: accept ? request.params.permissions : {},
        scope: "turn",
      };
    } else if (supported) result = { decision: accept ? "accept" : "decline" };
    else result = { error: "This request is not supported by Lemlio" };
    try {
      await invoke("respond_codex_request", { requestId: request.id, result });
      setRequests((items) => items.filter((item) => item.id !== request.id));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="pointer-events-auto fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-request-title"
        className="max-h-[80vh] w-full max-w-xl space-y-4 overflow-y-auto rounded-xl border bg-background p-6 shadow-xl"
      >
        <h2 id="codex-request-title" className="font-semibold">
          {isQuestion ? "Codex has a question" : "Codex needs your approval"}
        </h2>
        <p className="text-muted-foreground text-xs">
          {tab?.title ?? "Codex chat"}
        </p>
        {request.params.reason && (
          <p className="text-sm">{request.params.reason}</p>
        )}
        {request.params.networkApprovalContext && (
          <p className="text-sm">
            Connect to {request.params.networkApprovalContext.host} using{" "}
            {request.params.networkApprovalContext.protocol}
          </p>
        )}
        {request.params.command && (
          <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {request.params.command}
          </pre>
        )}
        {request.params.cwd && (
          <p className="break-all text-muted-foreground text-xs">
            Working folder: {request.params.cwd}
          </p>
        )}
        {request.params.grantRoot && (
          <p className="break-all text-sm">
            Requested folder: {request.params.grantRoot}
          </p>
        )}
        {isPermissions && (
          <pre className="whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {JSON.stringify(request.params.permissions, null, 2)}
          </pre>
        )}
        {request.method === "item/fileChange/requestApproval" &&
          request.params.item !== undefined && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
              {JSON.stringify(request.params.item, null, 2)}
            </pre>
          )}
        {isQuestion &&
          questions.map((question) => (
            <label key={question.id} className="block space-y-2 text-sm">
              <span>{question.question}</span>
              {question.options?.length ? (
                <select
                  className="w-full rounded border bg-background p-2"
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                >
                  <option value="">Choose an answer</option>
                  {question.options.map((option) => (
                    <option key={option.label} value={option.label}>
                      {option.label} — {option.description}
                    </option>
                  ))}
                </select>
              ) : null}
              <input
                className="w-full rounded border bg-background p-2"
                aria-label={`Answer: ${question.header}`}
                placeholder="Or type your answer"
                value={answers[question.id] ?? ""}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
        {!supported && (
          <p className="text-sm">
            This version of Lemlio cannot handle {request.method}. Decline to
            let Codex continue.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => reply(false)}
          >
            Decline
          </Button>
          {supported && (
            <Button
              disabled={
                busy ||
                (isQuestion &&
                  questions.some((question) => !answers[question.id]?.trim()))
              }
              onClick={() => reply(true)}
            >
              {isQuestion ? "Send answer" : "Approve once"}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
