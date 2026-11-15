import { CheckIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { ACCENTS } from "@/lib/appearance";
import { EDITOR_THEMES } from "@/components/workspace/editor/apple-editor-theme";
import {
  useSettingsStore,
  type AccentName,
  type EditorThemeName,
} from "@/stores/settings-store";

const SAMPLE: {
  text: string;
  color: keyof (typeof EDITOR_THEMES)["xcode"]["light"];
}[][] = [
  [{ text: "% A short note", color: "comment" }],
  [
    { text: "\\section", color: "keyword" },
    { text: "{Introduction}", color: "string" },
  ],
  [
    { text: "Let ", color: "meta" },
    { text: "$x = 42$", color: "number" },
    { text: " and ", color: "meta" },
    { text: "\\cite", color: "fn" },
    { text: "{vaswani}", color: "type" },
  ],
];

export function AppearanceSettings() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const accent = useSettingsStore((s) => s.accent);
  const setAccent = useSettingsStore((s) => s.setAccent);
  const editorTheme = useSettingsStore((s) => s.editorTheme);
  const setEditorTheme = useSettingsStore((s) => s.setEditorTheme);
  const size = useSettingsStore((s) => s.editorFontSize);
  const setSize = useSettingsStore((s) => s.setEditorFontSize);
  const dark = resolvedTheme === "dark";

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="font-semibold">Look</h3>
        <div
          role="radiogroup"
          aria-label="Light or dark"
          className="inline-flex gap-0.5 rounded-[11px] bg-[rgb(120_120_128/0.12)] p-[3px]"
        >
          {[
            ["system", "Automatic"],
            ["light", "Light"],
            ["dark", "Dark"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => setTheme(value)}
              className={`h-7 rounded-lg px-3 font-medium text-[13px] transition-colors ${
                theme === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-semibold">Accent colour</h3>
        <p className="text-muted-foreground text-sm">
          Used for buttons, selections, links and highlights across the app.
        </p>
        <div
          role="radiogroup"
          aria-label="Accent colour"
          className="flex flex-wrap gap-3"
        >
          {(Object.keys(ACCENTS) as AccentName[]).map((name) => {
            const color = dark ? ACCENTS[name].dark : ACCENTS[name].light;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={accent === name}
                aria-label={ACCENTS[name].label}
                title={ACCENTS[name].label}
                onClick={() => setAccent(name)}
                style={{ backgroundColor: color }}
                className="grid size-8 place-items-center rounded-full text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_1px_2px_rgb(0_0_0/0.2)] outline-offset-2 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {accent === name && <CheckIcon size={16} strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-semibold">Editor colours</h3>
        <p className="text-muted-foreground text-sm">
          How LaTeX is coloured while you write.
        </p>
        <div
          role="radiogroup"
          aria-label="Editor colours"
          className="grid gap-3 sm:grid-cols-2"
        >
          {(Object.keys(EDITOR_THEMES) as EditorThemeName[]).map((name) => {
            const palette = dark
              ? EDITOR_THEMES[name].dark
              : EDITOR_THEMES[name].light;
            const selected = editorTheme === name;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setEditorTheme(name)}
                className={`rounded-2xl border p-3 text-left transition-[box-shadow,border-color] ${
                  selected
                    ? "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_25%,transparent)]"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <span className="mb-2 flex items-center justify-between font-medium text-sm">
                  {EDITOR_THEMES[name].label}
                  {selected && <CheckIcon size={15} className="text-primary" />}
                </span>
                <span className="block rounded-lg bg-muted px-3 py-2 font-mono text-[12px] leading-5">
                  {SAMPLE.map((line, row) => (
                    <span key={row} className="block whitespace-pre">
                      {line.map((part, index) => (
                        <span
                          key={index}
                          style={{ color: palette[part.color] }}
                        >
                          {part.text}
                        </span>
                      ))}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-semibold">Editor text size</h3>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={11}
            max={22}
            step={1}
            value={size}
            aria-label="Editor text size"
            onChange={(event) => setSize(Number(event.target.value))}
            className="w-56 accent-[var(--primary)]"
          />
          <span className="w-12 text-sm tabular-nums">{size} px</span>
        </div>
      </section>
    </div>
  );
}
