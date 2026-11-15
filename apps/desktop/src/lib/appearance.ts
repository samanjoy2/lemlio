import { useEffect } from "react";
import { useSettingsStore, type AccentName } from "@/stores/settings-store";

/** Accent colours: Apple's system colours, tuned for white text on top. */
export const ACCENTS: Record<
  AccentName,
  { label: string; light: string; dark: string }
> = {
  blue: { label: "Blue", light: "#007aff", dark: "#0a84ff" },
  purple: { label: "Purple", light: "#af52de", dark: "#bf5af2" },
  pink: { label: "Pink", light: "#e0245e", dark: "#ff375f" },
  red: { label: "Red", light: "#ff3b30", dark: "#ff453a" },
  orange: { label: "Orange", light: "#e8740c", dark: "#f58a1f" },
  green: { label: "Green", light: "#248a3d", dark: "#30a14e" },
  teal: { label: "Teal", light: "#0a8fa6", dark: "#1aa7be" },
  graphite: { label: "Graphite", light: "#5c5c61", dark: "#8e8e93" },
};

const STYLE_ID = "lemlio-appearance";

export function accentCss(name: AccentName): string {
  const accent = ACCENTS[name] ?? ACCENTS.blue;
  const vars = (color: string) =>
    `--primary:${color};--ring:${color};--sidebar-primary:${color};--sidebar-ring:${color};--info:${color};`;
  return `:root{${vars(accent.light)}}.dark{${vars(accent.dark)}}`;
}

/** Writes the accent and editor size into the page. Safe to call repeatedly. */
export function applyAppearance(accent: AccentName, editorFontSize: number) {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `${accentCss(accent)}:root{--editor-font-size:${editorFontSize}px;}`;
}

/** Keeps the page in step with the saved appearance settings. */
export function useAppearance() {
  const accent = useSettingsStore((s) => s.accent);
  const size = useSettingsStore((s) => s.editorFontSize);
  useEffect(() => applyAppearance(accent, size), [accent, size]);
}
