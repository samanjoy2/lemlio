import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useMicrophone } from "voice-glow";

export function useDictation(onText: (text: string) => void, enabled = true) {
  const mic = useMicrophone({
    constraints: { echoCancellation: true, noiseSuppression: true },
  });
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const session = useRef<string | null>(null);
  const callback = useRef(onText);
  callback.current = onText;
  const stopMic = useRef(mic.stop);
  stopMic.current = mic.stop;
  const stop = async () => {
    const id = session.current;
    session.current = null;
    stopMic.current();
    setRecording(false);
    setStarting(false);
    if (id) await invoke("speech_stop", { sessionId: id }).catch(() => {});
  };
  useEffect(() => {
    if (!enabled) {
      void stop();
      return;
    }
    const off = listen<{ sessionId: string; type: string; text?: string }>(
      "speech-dictation",
      ({ payload }) => {
        if (payload.sessionId !== session.current) return;
        if (payload.type === "text" && payload.text)
          callback.current(payload.text);
        else if (payload.type === "ready") {
          setStarting(false);
          setRecording(true);
        } else if (payload.type === "error") {
          setError(payload.text || "Speech recognition failed");
          void stop();
        } else if (payload.type === "stopped") void stop();
      },
    );
    return () => {
      const id = session.current;
      session.current = null;
      stopMic.current();
      if (id) void invoke("speech_stop", { sessionId: id }).catch(() => {});
      void off.then((unlisten) => unlisten());
    };
  }, [enabled]);
  const start = async () => {
    setError("");
    setStarting(true);
    const id = crypto.randomUUID();
    session.current = id;
    try {
      const stream = await mic.start();
      if (session.current !== id) {
        mic.stop();
        return;
      }
      if (!stream)
        throw new Error(
          "Microphone access is unavailable. Allow microphone access in Windows settings.",
        );
      await invoke("speech_start", { sessionId: id });
    } catch (error) {
      setError(String(error));
      await stop();
    }
  };
  return { stream: mic.stream, recording, starting, error, start, stop };
}
