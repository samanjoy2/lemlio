import { DriveSettings } from "./drive-settings";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { CodexSetup } from "./codex-setup";
import { SkillsLibrary } from "./skills-library";
import { useSettingsStore } from "@/stores/settings-store";
import { useTheme } from "next-themes";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { useCodexChatStore } from "@/stores/codex-chat-store";
export function AppSettings() {
  const [visible, setVisible] = useState(
    () => !localStorage.getItem("lemlio-setup-complete"),
  );
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!localStorage.getItem("lemlio-setup-complete"))
      void invoke<{ available: boolean }>("detect_texlive")
        .then((status) => {
          if (
            !status.available &&
            useSettingsStore.getState().compilerBackend === "texlive"
          )
            useSettingsStore.getState().setCompilerBackend("tectonic");
        })
        .catch(() => {});
    void invoke<string | null>("startup_settings_tab")
      .then((tab) => {
        if (tab) {
          setTab(tab);
          setVisible(true);
        }
      })
      .catch(() => {});
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const [tab, setTab] = useState(() =>
    localStorage.getItem("lemlio-setup-complete") ? "General" : "Codex",
  );
  const selectedModel = useCodexChatStore((s) => s.selectedModel);
  const setSelectedModel = useCodexChatStore((s) => s.setSelectedModel);
  const [models, setModels] = useState<
    { model: string; displayName: string; hidden: boolean }[]
  >([]);
  useEffect(() => {
    if (visible && tab === "Codex")
      void invoke<typeof models>("list_codex_models")
        .then(setModels)
        .catch(() => {});
  }, [visible, tab]);
  const settings = useSettingsStore();
  const { theme, setTheme } = useTheme();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setVisible(true)}
        title="Settings"
      >
        <SettingsIcon size={16} />
        <span>Settings</span>
      </Button>
      <Dialog
        open={visible}
        onOpenChange={(value) => {
          setVisible(value);
          if (!value) localStorage.setItem("lemlio-setup-complete", "true");
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Settings &amp; setup</DialogTitle>
          </DialogHeader>
          <nav className="flex flex-wrap gap-2">
            {["General", "Codex", "Compiler", "Skills", "Backup", "About"].map(
              (name) => (
                <Button
                  key={name}
                  size="sm"
                  variant={tab === name ? "default" : "outline"}
                  onClick={() => setTab(name)}
                >
                  {name}
                </Button>
              ),
            )}
          </nav>
          <div className="space-y-4 py-4 text-sm">
            {tab === "General" && (
              <label>
                Appearance
                <select
                  className="ml-3 rounded border p-2"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </label>
            )}
            {tab === "Codex" && (
              <>
                <CodexSetup />
                <label className="block">
                  Default model
                  <select
                    className="ml-3 rounded border p-2"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                  >
                    {models.length ? (
                      models
                        .filter((m) => !m.hidden)
                        .map((m) => (
                          <option key={m.model} value={m.model}>
                            {m.displayName}
                            {m.model === "gpt-6-luna"
                              ? " · economical default"
                              : ""}
                          </option>
                        ))
                    ) : (
                      <option value={selectedModel}>{selectedModel}</option>
                    )}
                  </select>
                </label>
                <p>
                  New chats use GPT-6 Luna when it is in your available model
                  list. Choose another model in the chat model picker.
                </p>
                <Button
                  onClick={() =>
                    open("https://developers.openai.com/codex/cli")
                  }
                >
                  Codex setup instructions
                </Button>
                <p>
                  You can connect later. Editing and compilation work without
                  Codex.
                </p>
              </>
            )}
            {tab === "Compiler" && (
              <>
                <label>
                  Compiler
                  <select
                    className="ml-3 rounded border p-2"
                    value={settings.compilerBackend}
                    onChange={(e) =>
                      settings.setCompilerBackend(
                        e.target.value as "texlive" | "tectonic",
                      )
                    }
                  >
                    <option value="texlive">MiKTeX / TeX Live</option>
                    <option value="tectonic">Tectonic</option>
                  </select>
                </label>
                <label className="block">
                  <input
                    type="checkbox"
                    checked={settings.autoCompile}
                    onChange={(e) => settings.setAutoCompile(e.target.checked)}
                  />{" "}
                  Compile automatically after edits
                </label>
                <Button onClick={() => open("https://miktex.org/download")}>
                  Install MiKTeX
                </Button>
                <p>
                  MiKTeX is optional during setup and can be installed later.
                  Tectonic is included in the Windows build.
                </p>
              </>
            )}
            {tab === "Skills" && <SkillsLibrary />}
            {tab === "Backup" && <DriveSettings />}
            {tab === "About" && (
              <>
                <h2 className="font-semibold text-xl">Lemlio {version}</h2>
                <p>LaTeX projects, PDF previews, and Codex on your desktop.</p>
                <p>
                  Based on the MIT-licensed Claude Prism project by delibae,
                  with a new Codex integration, project library, ZIP transfers,
                  system compiler support, and interface changes. Original
                  license notices are retained.
                </p>
                <Button
                  onClick={() => open("https://github.com/samanjoy2/lemlio")}
                >
                  Source and releases
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
