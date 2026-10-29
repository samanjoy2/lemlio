import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useDictation } from "@/hooks/use-dictation";
const mic = vi.hoisted(() => ({
  stop: vi.fn(),
  start: vi.fn(async () => ({ getTracks: () => [] })),
}));
vi.mock("voice-glow", () => ({
  useMicrophone: () => ({
    stream: null,
    state: "idle",
    start: mic.start,
    stop: mic.stop,
  }),
}));
it("inserts speech into the draft, stops the mic, and rejects late speech after stopping", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let notification: (event: any) => void = () => {};
  vi.mocked(listen).mockImplementation(async (_name, callback) => {
    notification = callback;
    return () => {};
  });
  vi.mocked(invoke).mockResolvedValue({});
  const text = vi.fn();
  function Recorder() {
    const recording = useDictation(text);
    return (
      <>
        <button onClick={() => void recording.start()}>Start</button>
        <button onClick={() => void recording.stop()}>Stop</button>
        <span>{recording.recording ? "Listening" : "Idle"}</span>
      </>
    );
  }
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Recorder />));
    await act(async () => element.querySelectorAll("button")[0].click());
    const call = vi
      .mocked(invoke)
      .mock.calls.find(([name]) => name === "speech_start");
    const sessionId = (call?.[1] as { sessionId: string }).sessionId;
    await act(async () =>
      notification({ payload: { sessionId, type: "ready" } }),
    );
    expect(element.textContent).toContain("Listening");
    await act(async () =>
      notification({
        payload: { sessionId, type: "text", text: "Please edit the title" },
      }),
    );
    expect(text).toHaveBeenCalledWith("Please edit the title");
    await act(async () => element.querySelectorAll("button")[1].click());
    await act(async () =>
      notification({ payload: { sessionId, type: "text", text: "Late text" } }),
    );
    expect(text).toHaveBeenCalledTimes(1);
    expect(mic.stop).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("speech_stop", { sessionId });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([name]) => name !== "execute_codex_code"),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
