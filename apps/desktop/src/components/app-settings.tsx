import { AppUpdates } from "./app-updates";
import { DriveSettings } from "./drive-settings";
import { AppearanceSettings } from "./appearance-settings";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { SettingsIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Tabs } from "./panelui/tabs";
import { Switch } from "./panelui/switch";
import { Button } from "./ui/button";
import { CodexSetup } from "./codex-setup";
import { ToolsLibrary } from "./tools-library";
import { useSettingsStore } from "@/stores/settings-store";
import { useTheme } from "next-themes";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { agentCommand, AGENT_LABELS } from "@/lib/agent-provider";
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
    localStorage.getItem("lemlio-setup-complete") ? "General" : "Assistant",
  );
  useEffect(() => {
    const show = (event: Event) => {
      setTab((event as CustomEvent<string>).detail || "General");
      setVisible(true);
    };
    window.addEventListener("lemlio-open-settings", show);
    return () => window.removeEventListener("lemlio-open-settings", show);
  }, []);
  const settings = useSettingsStore();
  const selectedModel = useCodexChatStore((s) => s.selectedModel);
  const setSelectedModel = useCodexChatStore((s) => s.setSelectedModel);
  const [models, setModels] = useState<
    { model: string; displayName: string; hidden: boolean }[]
  >([]);
  useEffect(() => {
    if (visible && tab === "Assistant")
      void invoke<typeof models>(agentCommand("listModels"))
        .then(setModels)
        .catch(() => {});
  }, [visible, tab, settings.agentProvider]);
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
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (typeof value === "string") setTab(value);
            }}
            variant="underline"
          >
            <Tabs.List aria-label="Settings sections">
              {[
                "General",
                "Appearance",
                "Assistant",
                "Compiler",
                "Tools",
                "Backup",
                "Voice",
                "About",
              ].map((name) => (
                <Tabs.Trigger key={name} value={name}>
                  {name}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value={tab} className="space-y-4 py-4 text-sm">
              {tab === "Appearance" && <AppearanceSettings />}
              {tab === "General" && (
                <div className="space-y-4">
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
                  <label
                    htmlFor="skip-backed-up-close"
                    className="flex items-start gap-2"
                  >
                    <Switch
                      size="sm"
                      id="skip-backed-up-close"
                      checked={settings.skipCloseWhenBackedUp}
                      onCheckedChange={settings.setSkipCloseWhenBackedUp}
                      label="Skip close confirmation when backed up"
                    />
                    Skip the close confirmation only when every project is saved
                    and backed up
                  </label>
                </div>
              )}
              {tab === "Assistant" && (
                <>
                  <label className="block">
                    AI assistant
                    <select
                      className="ml-3 rounded border p-2"
                      value={settings.agentProvider}
                      onChange={(e) =>
                        settings.setAgentProvider(
                          e.target.value as "codex" | "claude",
                        )
                      }
                    >
                      <option value="codex">Codex (OpenAI)</option>
                      <option value="claude">Claude (Anthropic)</option>
                    </select>
                  </label>
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
                              {m.model === "gpt-6-luna" || m.model === "haiku"
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
                    {settings.agentProvider === "claude"
                      ? "New chats use Claude Haiku, the most economical model. Choose another model in the chat model picker."
                      : "New chats use GPT-6 Luna when it is in your available model list. Choose another model in the chat model picker."}
                  </p>
                  <Button
                    onClick={() =>
                      open(
                        settings.agentProvider === "claude"
                          ? "https://docs.claude.com/en/docs/claude-code/overview"
                          : "https://developers.openai.com/codex/cli",
                      )
                    }
                  >
                    {AGENT_LABELS[settings.agentProvider]} setup instructions
                  </Button>
                  <p>
                    You can connect later. Editing and compilation work without{" "}
                    {AGENT_LABELS[settings.agentProvider]}.
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
                  <label
                    htmlFor="auto-compile-setting"
                    className="flex items-center gap-2"
                  >
                    <Switch
                      size="sm"
                      id="auto-compile-setting"
                      checked={settings.autoCompile}
                      onCheckedChange={settings.setAutoCompile}
                      label="Compile automatically after edits"
                    />{" "}
                    Compile automatically after edits
                  </label>
                  <Button onClick={() => open("https://miktex.org/download")}>
                    Install MiKTeX
                  </Button>
                  <p>
                    MiKTeX is optional during setup and can be installed later.
                    Tectonic is included in the desktop app.
                  </p>
                </>
              )}
              {tab === "Tools" && <ToolsLibrary />}
              {tab === "Backup" && <DriveSettings />}
              {tab === "Voice" &&
                (navigator.userAgent.includes("Mac") ? (
                  <div className="space-y-3">
                    <h3 className="font-medium">macOS Dictation</h3>
                    <p>
                      Enable Dictation in System Settings → Keyboard →
                      Dictation. Focus the Codex prompt and use the Dictation
                      shortcut configured there. Review the text before pressing
                      Send.
                    </p>
                    <Button onClick={() => void invoke("open_speech_settings")}>
                      Open macOS Keyboard settings
                    </Button>
                    <p className="text-muted-foreground text-xs">
                      Mac voice input uses system Dictation. The Windows
                      microphone recording mode is not used on macOS.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <h3 className="font-medium">Windows speech dictation</h3>
                    <p>
                      Use the microphone in Codex chat to dictate an editable
                      prompt. Review it, then press Send. No extra OpenAI API
                      key is needed.
                    </p>
                    <p className="text-muted-foreground">
                      Install a Windows speech language under Time &amp;
                      language → Language &amp; region → your language →
                      Language options → Speech. Restart Lemlio after
                      installation.
                    </p>
                    <Button onClick={() => void invoke("open_speech_settings")}>
                      Open Windows language settings
                    </Button>
                    <p className="text-muted-foreground text-xs">
                      Microphone access must be allowed in Windows. Recording
                      stops when you stop dictation or close the chat.
                    </p>
                  </div>
                ))}
              {tab === "About" && (
                <>
                  <h2 className="font-semibold text-xl">Lemlio {version}</h2>
                  <p>
                    LaTeX projects, PDF previews, and Codex on your desktop.
                  </p>
                  <AppUpdates />
                  <p>
                    Based on the MIT-licensed Claude Prism project by delibae,
                    with a new Codex integration, project library, ZIP
                    transfers, system compiler support, and interface changes.
                    Original license notices are retained.
                  </p>
                  <Button
                    onClick={() => open("https://github.com/samanjoy2/lemlio")}
                  >
                    Source and releases
                  </Button>
                </>
              )}
            </Tabs.Content>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}
