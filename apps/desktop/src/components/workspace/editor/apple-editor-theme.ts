import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Editor chrome and syntax colours in the spirit of Xcode's default themes:
 * quiet gutters, a soft current-line wash, system-blue caret and selection.
 * Colours that follow the app theme come from CSS variables so the editor and
 * the surrounding UI always agree.
 */
const chrome = {
  ".cm-content": {
    caretColor: "var(--primary)",
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
    padding: "10px 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--primary)",
    borderLeftWidth: "2px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
    opacity: "0.75",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--primary) 6%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
    opacity: "1",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--primary) 26%, transparent)",
    },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
    borderRadius: "3px",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--warning) 28%, transparent)",
    borderRadius: "3px",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    borderRadius: "12px",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow: "var(--shadow-lg)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--primary)",
    color: "var(--primary-foreground)",
  },
  ".cm-panels": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--accent)",
    border: "none",
    color: "var(--muted-foreground)",
    borderRadius: "6px",
  },
} as const;

export const appleLightTheme = EditorView.theme(chrome, { dark: false });
export const appleDarkTheme = EditorView.theme(chrome, { dark: true });

export interface Palette {
  keyword: string;
  string: string;
  comment: string;
  number: string;
  fn: string;
  type: string;
  tag: string;
  meta: string;
  link: string;
}
const palette = (c: Palette) =>
  HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: c.keyword },
    { tag: [t.controlKeyword, t.moduleKeyword], color: c.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: c.string },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: c.comment,
      fontStyle: "italic",
    },
    { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.macroName,
      ],
      color: c.fn,
    },
    { tag: [t.typeName, t.className, t.namespace], color: c.type },
    { tag: [t.tagName, t.angleBracket], color: c.tag },
    { tag: [t.attributeName, t.propertyName], color: c.fn },
    { tag: [t.meta, t.processingInstruction, t.annotation], color: c.meta },
    { tag: [t.link, t.url], color: c.link, textDecoration: "underline" },
    { tag: t.heading, color: c.keyword, fontWeight: "700" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: [t.punctuation, t.separator, t.bracket], color: c.meta },
    { tag: t.invalid, color: "var(--destructive)" },
  ]);

export const appleLightHighlight = palette({
  keyword: "#ad3da4",
  string: "#d12f1b",
  comment: "#707f8c",
  number: "#272ad8",
  fn: "#326d74",
  type: "#0b4f79",
  tag: "#4b21b0",
  meta: "#78492a",
  link: "#0b5cd5",
});

export const appleDarkHighlight = palette({
  keyword: "#fc5fa3",
  string: "#fc6a5d",
  comment: "#7f8c98",
  number: "#d0bf69",
  fn: "#67b7a4",
  type: "#5dd8ff",
  tag: "#a167e6",
  meta: "#ff8170",
  link: "#6bb5ff",
});

export type EditorThemeName = "xcode" | "github" | "solarized" | "dracula";

export const EDITOR_THEMES: Record<
  EditorThemeName,
  { label: string; light: Palette; dark: Palette }
> = {
  xcode: {
    label: "Xcode",
    light: {
      keyword: "#ad3da4",
      string: "#d12f1b",
      comment: "#707f8c",
      number: "#272ad8",
      fn: "#326d74",
      type: "#0b4f79",
      tag: "#4b21b0",
      meta: "#78492a",
      link: "#0b5cd5",
    },
    dark: {
      keyword: "#fc5fa3",
      string: "#fc6a5d",
      comment: "#7f8c98",
      number: "#d0bf69",
      fn: "#67b7a4",
      type: "#5dd8ff",
      tag: "#a167e6",
      meta: "#ff8170",
      link: "#6bb5ff",
    },
  },
  github: {
    label: "GitHub",
    light: {
      keyword: "#cf222e",
      string: "#0a3069",
      comment: "#6e7781",
      number: "#0550ae",
      fn: "#8250df",
      type: "#953800",
      tag: "#116329",
      meta: "#0550ae",
      link: "#0969da",
    },
    dark: {
      keyword: "#ff7b72",
      string: "#a5d6ff",
      comment: "#8b949e",
      number: "#79c0ff",
      fn: "#d2a8ff",
      type: "#ffa657",
      tag: "#7ee787",
      meta: "#79c0ff",
      link: "#58a6ff",
    },
  },
  solarized: {
    label: "Solarized",
    light: {
      keyword: "#859900",
      string: "#2aa198",
      comment: "#93a1a1",
      number: "#d33682",
      fn: "#268bd2",
      type: "#b58900",
      tag: "#cb4b16",
      meta: "#6c71c4",
      link: "#268bd2",
    },
    dark: {
      keyword: "#99ad1a",
      string: "#35b5ab",
      comment: "#7a8f95",
      number: "#e0529a",
      fn: "#3a9be0",
      type: "#cf9d0d",
      tag: "#e0612a",
      meta: "#8388d4",
      link: "#4aa8ee",
    },
  },
  dracula: {
    label: "Dracula",
    light: {
      keyword: "#a3144d",
      string: "#846e15",
      comment: "#6c664b",
      number: "#644ac9",
      fn: "#036a06",
      type: "#0b6a89",
      tag: "#a3144d",
      meta: "#a34d14",
      link: "#0b6a89",
    },
    dark: {
      keyword: "#ff79c6",
      string: "#f1fa8c",
      comment: "#6e7fb4",
      number: "#bd93f9",
      fn: "#50fa7b",
      type: "#8be9fd",
      tag: "#ff79c6",
      meta: "#ffb86c",
      link: "#8be9fd",
    },
  },
};

const highlights = new Map<string, ReturnType<typeof palette>>();
/** The editor's chrome and syntax colours for a theme in light or dark mode. */
export function editorThemeExtensions(name: EditorThemeName, dark: boolean) {
  const theme = EDITOR_THEMES[name] ?? EDITOR_THEMES.xcode;
  const id = `${name}-${dark ? "dark" : "light"}`;
  let highlight = highlights.get(id);
  if (!highlight) {
    highlight = palette(dark ? theme.dark : theme.light);
    highlights.set(id, highlight);
  }
  return [
    dark ? appleDarkTheme : appleLightTheme,
    syntaxHighlighting(highlight),
  ];
}
