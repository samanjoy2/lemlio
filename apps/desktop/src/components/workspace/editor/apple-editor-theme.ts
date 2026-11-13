import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
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

const palette = (c: {
  keyword: string;
  string: string;
  comment: string;
  number: string;
  fn: string;
  type: string;
  tag: string;
  meta: string;
  link: string;
}) =>
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
