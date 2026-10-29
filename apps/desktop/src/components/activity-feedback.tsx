import { useEffect, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import "./activity-feedback.css";

export function ActivityOrb({
  label,
  compact = false,
  state = "composing",
  pill = false,
}: {
  label: string;
  compact?: boolean;
  state?: "composing" | "breathing";
  pill?: boolean;
}) {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <div
      role="status"
      className={
        pill
          ? "agent-thinking-pill"
          : compact
            ? "flex items-center gap-2 text-muted-foreground text-xs"
            : "flex flex-col items-center gap-4 text-muted-foreground text-sm"
      }
    >
      <ThinkingOrb
        state={state}
        size={compact || pill ? 20 : 64}
        paused={reduced}
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

export function BorderBeam({
  active,
  colorVariant = "mono",
}: {
  active: boolean;
  colorVariant?: "mono";
}) {
  return active ? (
    <span
      aria-hidden="true"
      className={`activity-border-beam activity-border-${colorVariant}`}
    />
  ) : null;
}
