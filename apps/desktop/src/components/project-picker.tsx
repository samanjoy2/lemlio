import { MotionConfig } from "motion/react";
import { ProjectGroups, requestProjectGroups } from "./project-groups";
import { LayersIcon } from "lucide-react";
import { toast } from "sonner";
import { openGroupWorkspace } from "@/lib/project-group-actions";
import { useProjectGroups } from "@/stores/project-groups-store";
import { openCollaboration } from "./collaboration-dialog";
import { AppSettings } from "@/components/app-settings";
import { DriveStatus } from "@/components/drive-status";
import { Select as PanelSelect } from "./panelui/select";
import { DriveDiscoveryNotice } from "./drive-discovery-notice";
import { DriveBackupOverview } from "@/components/drive-backup-overview";
import { requestDriveRestore } from "@/components/drive-restore-dialog";
import { VoiceStatus } from "@/components/voice-status";
import { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTheme } from "next-themes";
import {
  ArrowUpRightIcon,
  PencilIcon,
  Trash2Icon,
  BookOpenIcon,
  TerminalSquareIcon,
  Clock3Icon,
  FileTextIcon,
  FolderOpenIcon,
  LayoutGridIcon,
  ListIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  SunIcon,
  PanelsTopLeftIcon,
  ArchiveIcon,
  XIcon,
  UploadIcon,
  UsersIcon,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import { projectPathKey, type CatalogProject } from "@/lib/project-catalog";
import { collectionIcon } from "@/lib/collection-icons";
import { useCollectionsStore } from "@/stores/collections-store";
import {
  CollectionDialog,
  type CollectionDialogState,
} from "./collection-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectWizard, type CreationMode } from "./project-wizard";
import { CodexSetup } from "./codex-setup";
import { ProjectCard } from "./project-library";
import { ToolsDialog, useTools } from "./tools-library";
import {
  ImportProjectDialog,
  useProjectZipExport,
} from "./project-zip-transfer";
import "./project-home.css";

type ProjectView = "all" | "recent" | "starred" | "archived";

export function ProjectPicker() {
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [wizardMode, setWizardMode] = useState<CreationMode | null>(null);
  const [version, setVersion] = useState("");
  const [view, setView] = useState<ProjectView>("all");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [collectionDialog, setCollectionDialog] =
    useState<CollectionDialogState>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [toolsOpen, setToolsOpen] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const { exportingPath, exportZip } = useProjectZipExport();
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { projects, loading, error, refresh } = useProjectCatalog();
  const { tools } = useTools();
  const recent = useProjectStore((state) => state.recentProjects);
  const starred = useProjectStore((state) => state.starredPaths);
  const addRecent = useProjectStore((state) => state.addRecentProject);
  const removeRecent = useProjectStore((state) => state.removeRecentProject);
  const toggleStar = useProjectStore((state) => state.toggleStarred);
  const archivedPaths = useProjectStore((state) => state.archivedPaths);
  const toggleArchive = useProjectStore((state) => state.toggleArchived);
  const collections = useCollectionsStore((state) => state.collections);
  const members = useCollectionsStore((state) => state.members);
  const collection = collections.find((c) => c.id === collectionId);
  const groups = useProjectGroups((state) => state.groups);
  const codexStatus = useCodexSetupStore((state) => state.status);
  const checkCodex = useCodexSetupStore((state) => state.checkStatus);
  const account = useCodexSetupStore((state) => state.accountEmail);
  const compiler = useSettingsStore((state) => state.compilerBackend);
  const setCompiler = useSettingsStore((state) => state.setCompilerBackend);
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(() => {
    void checkCodex();
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, [checkCodex]);
  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener("lemlio-focus-project-search", focusSearch);
    return () =>
      window.removeEventListener("lemlio-focus-project-search", focusSearch);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !toolsOpen &&
        !importOpen &&
        !showModeDialog &&
        !wizardMode
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toolsOpen, importOpen, showModeDialog, wizardMode]);

  useEffect(() => {
    const cloned = () => {
      setSort("recent");
      setView("all");
      setCollectionId(null);
      setQuery("");
    };
    window.addEventListener("lemlio-project-cloned", cloned);
    return () => window.removeEventListener("lemlio-project-cloned", cloned);
  }, []);
  useEffect(() => {
    const open = (event: Event) =>
      setCollectionDialog({
        mode: "create",
        projectPath: (event as CustomEvent<{ projectPath?: string }>).detail
          ?.projectPath,
      });
    window.addEventListener("lemlio-new-collection", open);
    return () => window.removeEventListener("lemlio-new-collection", open);
  }, []);
  // A collection that was deleted can no longer be the one on screen.
  useEffect(() => {
    if (collectionId && !collections.some((c) => c.id === collectionId))
      setCollectionId(null);
  }, [collections, collectionId]);
  const archivedKeys = useMemo(() => new Set(archivedPaths), [archivedPaths]);
  const activeProjects = useMemo(
    () => projects.filter((p) => !archivedKeys.has(projectPathKey(p.path))),
    [projects, archivedKeys],
  );
  const inCollection = (path: string) =>
    !collectionId || !!members[collectionId]?.includes(projectPathKey(path));
  const recentKeys = useMemo(
    () => new Set(recent.map((project) => projectPathKey(project.path))),
    [recent],
  );
  const visible = useMemo(
    () =>
      projects
        .filter((project) => {
          const key = projectPathKey(project.path);
          const names = collections
            .filter((c) => members[c.id]?.includes(key))
            .map((c) => c.name)
            .join(" ");
          return (
            archivedKeys.has(key) === (view === "archived") &&
            inCollection(project.path) &&
            (view !== "recent" || recentKeys.has(key)) &&
            (view !== "starred" || starred.includes(key)) &&
            `${project.name} ${names} ${project.mainFile ?? ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase())
          );
        })
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name)
            : b.lastOpened - a.lastOpened || a.name.localeCompare(b.name),
        ),
    [
      projects,
      collectionId,
      collections,
      members,
      archivedKeys,
      view,
      recentKeys,
      starred,
      query,
      sort,
    ],
  );
  const navigate = (
    next: ProjectView,
    nextCollection: string | null = null,
  ) => {
    setView(next);
    setCollectionId(nextCollection);
    setQuery("");
  };
  const openProject = async (
    project: Pick<CatalogProject, "path" | "name" | "mainFile">,
  ) => {
    setOpening(project.path);
    setOpenError(null);
    try {
      await useDocumentStore.getState().openProject(project.path);
      addRecent(project.path);
      if (
        project.mainFile &&
        useDocumentStore
          .getState()
          .files.some((file) => file.id === project.mainFile)
      )
        useDocumentStore.getState().setActiveFile(project.mainFile);
    } catch (error) {
      setOpenError(String(error));
    } finally {
      setOpening(null);
    }
  };
  const openFolder = async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Open Project Folder",
      });
      if (typeof path === "string")
        await openProject({ path, name: path.split(/[/\\]/).pop() || path });
    } catch (error) {
      setOpenError(String(error));
    }
  };
  const chooseMode = (mode: CreationMode) => {
    setShowModeDialog(false);
    setWizardMode(mode);
  };
  useEffect(() => {
    const action = (event: Event) => {
      switch ((event as CustomEvent<string>).detail) {
        case "new":
          setShowModeDialog(true);
          break;
        case "import":
          setImportOpen(true);
          break;
        case "open":
          void openFolder();
          break;
        case "refresh":
          refresh();
          break;
      }
    };
    window.addEventListener("lemlio-library-action", action);
    return () => window.removeEventListener("lemlio-library-action", action);
  }, [openFolder, refresh]);
  if (wizardMode)
    return (
      <ProjectWizard mode={wizardMode} onBack={() => setWizardMode(null)} />
    );
  const heading =
    collection?.name ??
    (view === "recent"
      ? "Recent projects"
      : view === "starred"
        ? "Starred projects"
        : view === "archived"
          ? "Archived projects"
          : "All projects");

  return (
    <div className="project-home">
      <aside className="home-sidebar" aria-label="Workspace navigation">
        <button
          type="button"
          className="home-brand"
          onClick={() => navigate("all")}
        >
          <img src="/icon-192.png" alt="" />
          <span>Lemlio</span>
        </button>
        <nav className="home-navigation">
          <button
            type="button"
            className={!collectionId && view === "all" ? "is-active" : ""}
            onClick={() => navigate("all")}
          >
            <LayoutGridIcon size={16} />
            <span>All projects</span>
            <small>{activeProjects.length}</small>
          </button>
          <button
            type="button"
            className={!collectionId && view === "recent" ? "is-active" : ""}
            onClick={() => navigate("recent")}
          >
            <Clock3Icon size={16} />
            <span>Recent</span>
            <small>{recent.length}</small>
          </button>
          <button
            type="button"
            className={!collectionId && view === "starred" ? "is-active" : ""}
            onClick={() => navigate("starred")}
          >
            <StarIcon size={16} />
            <span>Starred</span>
            <small>
              {
                projects.filter((project) =>
                  starred.includes(projectPathKey(project.path)),
                ).length
              }
            </small>
          </button>
          <button
            type="button"
            className={view === "archived" ? "is-active" : ""}
            onClick={() => navigate("archived")}
          >
            <ArchiveIcon size={16} />
            <span>Archived</span>
            <small>{projects.length - activeProjects.length}</small>
          </button>
          <div className="home-nav-label-row">
            <p className="home-nav-label">Project groups</p>
            <button
              type="button"
              aria-label="New project group"
              title="New project group"
              onClick={() => requestProjectGroups(true)}
            >
              <PlusIcon size={14} />
            </button>
          </div>
          {groups.length === 0 && (
            <p className="home-nav-hint">
              Work on related projects together, such as several versions of a
              CV. Press + to make a group.
            </p>
          )}
          {groups.map((group) => (
            <button
              type="button"
              key={group.id}
              onClick={() =>
                void openGroupWorkspace(group.id).catch((error) =>
                  toast.error("Could not open the group", {
                    description: String(error?.message ?? error),
                  }),
                )
              }
            >
              <LayersIcon size={16} />
              <span>{group.name}</span>
              <small>{group.paths.length}</small>
            </button>
          ))}
          {groups.length > 0 && (
            <button type="button" onClick={() => requestProjectGroups(false)}>
              <PencilIcon size={16} />
              <span>Manage groups</span>
            </button>
          )}
          <div className="home-nav-label-row">
            <p className="home-nav-label">Collections</p>
            <button
              type="button"
              aria-label="New collection"
              title="New collection"
              onClick={() => setCollectionDialog({ mode: "create" })}
            >
              <PlusIcon size={14} />
            </button>
          </div>
          {collections.length === 0 && (
            <p className="home-nav-hint">
              Group projects your own way. Press + to make a collection.
            </p>
          )}
          {collections.map((item) => {
            const Icon = collectionIcon(item.name);
            return (
              <button
                type="button"
                key={item.id}
                className={collectionId === item.id ? "is-active" : ""}
                onClick={() => navigate("all", item.id)}
              >
                <Icon size={16} />
                <span>{item.name}</span>
                <small>
                  {
                    activeProjects.filter((project) =>
                      members[item.id]?.includes(projectPathKey(project.path)),
                    ).length
                  }
                </small>
              </button>
            );
          })}
          <p className="home-nav-label">Workspace</p>
          <button type="button" onClick={() => openCollaboration(true)}>
            <UsersIcon size={16} />
            <span>Join shared project</span>
          </button>
          <button type="button" onClick={() => setToolsOpen(true)}>
            <BookOpenIcon size={16} />
            <span>AI tools</span>
            <small>{tools.length}</small>
          </button>
          <button type="button" onClick={() => chooseMode("template")}>
            <PanelsTopLeftIcon size={16} />
            <span>Templates</span>
            <ArrowUpRightIcon size={13} />
          </button>
          <button type="button" onClick={openFolder}>
            <FolderOpenIcon size={16} />
            <span>Open a folder</span>
          </button>
          <button type="button" onClick={() => setImportOpen(true)}>
            <UploadIcon size={16} />
            <span>Import ZIP</span>
          </button>
          <button
            type="button"
            title="Projects placed here appear automatically"
            onClick={async () => {
              const root = await invoke<string>("project_storage_location");
              await invoke("open_project_folder", {
                projectPath: `${root}/Imports`,
              });
            }}
          >
            <FolderOpenIcon size={16} />
            <span>Imports folder</span>
          </button>
        </nav>
        <div className="home-sidebar-footer">
          <section className="home-connections" aria-label="Connections">
            <div className="home-connection-heading">Connections</div>
            <button
              type="button"
              className="home-connection-row"
              title={account || "Codex settings"}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("lemlio-open-settings", { detail: "Codex" }),
                )
              }
            >
              <span className="home-connection-icon">
                <TerminalSquareIcon size={15} />
              </span>
              <span className="home-connection-name">Codex</span>
              <span
                className={
                  codexStatus === "ready"
                    ? "home-connection-badge is-connected"
                    : "home-connection-badge"
                }
              >
                {codexStatus === "ready"
                  ? "Connected"
                  : codexStatus === "checking"
                    ? "Checking"
                    : "Connect"}
              </span>
            </button>
            <DriveStatus />
            <button
              type="button"
              className="home-connection-row"
              onClick={requestDriveRestore}
            >
              <span className="home-connection-icon">
                <UploadIcon size={15} className="rotate-180" />
              </span>
              <span className="home-connection-name">Restore from backup</span>
            </button>
            <VoiceStatus />
          </section>
          <div className="home-compiler">
            <span>Compiler</span>
            <PanelSelect
              value={compiler}
              onValueChange={(value) => {
                if (value === "tectonic" || value === "texlive")
                  setCompiler(value);
              }}
              items={[
                { value: "tectonic", label: "Tectonic" },
                { value: "texlive", label: "MiKTeX / TeX Live" },
              ]}
            >
              <PanelSelect.Trigger aria-label="LaTeX compiler" size="sm">
                <PanelSelect.Value />
              </PanelSelect.Trigger>
              <PanelSelect.Content>
                <PanelSelect.Item value="tectonic">Tectonic</PanelSelect.Item>
                <PanelSelect.Item value="texlive">
                  MiKTeX / TeX Live
                </PanelSelect.Item>
              </PanelSelect.Content>
            </PanelSelect>
          </div>
          <div className="home-footer-controls">
            <AppSettings />
            <button
              type="button"
              aria-label={
                resolvedTheme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {resolvedTheme === "dark" ? (
                <SunIcon size={15} />
              ) : (
                <MoonIcon size={15} />
              )}
            </button>
          </div>
          <div className="home-footer-version">
            Lemlio <span>{version ? `v${version}` : ""}</span>
          </div>
        </div>
      </aside>

      <main className="home-main">
        <div className="home-content">
          <div className="home-heading">
            <div>
              <div className="flex items-center gap-2">
                <h1>
                  {collection?.name ??
                    (view === "archived" ? "Archived" : "Projects")}
                </h1>
                {collection && (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Rename collection"
                      title="Rename collection"
                      onClick={() =>
                        setCollectionDialog({
                          mode: "rename",
                          id: collection.id,
                        })
                      }
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete collection"
                      title="Delete collection"
                      onClick={() =>
                        setCollectionDialog({
                          mode: "delete",
                          id: collection.id,
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </>
                )}
              </div>
              {view === "archived" && !collection && (
                <p>
                  Archived projects are tucked away from your other lists.
                  Nothing is deleted, and backups keep working.
                </p>
              )}
            </div>
            <div className="home-heading-actions">
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <UploadIcon size={15} />
                Import ZIP
              </Button>
              <Button variant="outline" onClick={openFolder}>
                <FolderOpenIcon size={15} />
                Open folder
              </Button>
              <Button onClick={() => setShowModeDialog(true)}>
                <PlusIcon size={16} />
                New project
              </Button>
            </div>
          </div>
          {codexStatus !== "ready" && (
            <div className="home-connection-panel">
              <CodexSetup />
            </div>
          )}
          <ProjectGroups />
          <DriveDiscoveryNotice />
          <DriveBackupOverview projects={projects} />
          <div className="home-toolbar">
            <div className="home-project-tabs">
              <button
                type="button"
                className={view === "all" ? "is-active" : ""}
                onClick={() => navigate("all", collectionId)}
              >
                {collection?.name ?? "All projects"}
                <span>
                  {
                    activeProjects.filter((project) =>
                      inCollection(project.path),
                    ).length
                  }
                </span>
              </button>
              <button
                type="button"
                className={view === "recent" ? "is-active" : ""}
                onClick={() => navigate("recent", collectionId)}
              >
                Recent
              </button>
              <button
                type="button"
                className={view === "starred" ? "is-active" : ""}
                onClick={() => navigate("starred", collectionId)}
              >
                Starred
              </button>
            </div>
            <label className="home-search">
              <SearchIcon size={16} />
              <input
                ref={searchRef}
                aria-label="Search projects"
                placeholder="Search projects…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear project search"
                  onClick={() => setQuery("")}
                >
                  <XIcon size={13} />
                </button>
              ) : (
                <kbd>Ctrl K</kbd>
              )}
            </label>
          </div>
          <div className="home-results-bar">
            <p>
              {loading
                ? "Loading your workspace…"
                : `${visible.length} ${visible.length === 1 ? "project" : "projects"}`}
              {collection && (
                <button type="button" onClick={() => setCollectionId(null)}>
                  in {collection.name}
                  <XIcon size={11} />
                </button>
              )}
            </p>
            <div>
              <label className="home-sort">
                <span>Sort by</span>
                <select
                  aria-label="Sort projects"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="recent">Recently opened</option>
                  <option value="name">Name A–Z</option>
                </select>
              </label>
              <div
                className="home-view-toggle"
                role="group"
                aria-label="Project layout"
              >
                <button
                  type="button"
                  aria-label="Grid view"
                  aria-pressed={layout === "grid"}
                  className={layout === "grid" ? "is-active" : ""}
                  onClick={() => setLayout("grid")}
                >
                  <LayoutGridIcon size={16} />
                </button>
                <button
                  type="button"
                  aria-label="List view"
                  aria-pressed={layout === "list"}
                  className={layout === "list" ? "is-active" : ""}
                  onClick={() => setLayout("list")}
                >
                  <ListIcon size={16} />
                </button>
              </div>
            </div>
          </div>
          {(openError || error) && (
            <p role="alert" className="home-error">
              {openError || error}
            </p>
          )}
          <MotionConfig reducedMotion="user">
            <section
              aria-label={heading}
              className={`home-project-grid ${layout === "list" ? "is-list" : ""}`}
            >
              {!loading && !query && view === "all" && !collectionId && (
                <button
                  type="button"
                  className="home-new-project-card"
                  onClick={() => setShowModeDialog(true)}
                >
                  <span>
                    <PlusIcon size={22} strokeWidth={1.5} />
                  </span>
                  <strong>Create a project</strong>
                </button>
              )}
              {visible.map((project) => (
                <ProjectCard
                  key={projectPathKey(project.path)}
                  project={project}
                  starred={starred.includes(projectPathKey(project.path))}
                  archived={archivedKeys.has(projectPathKey(project.path))}
                  busy={opening !== null || exportingPath !== null}
                  opening={opening === project.path}
                  onOpen={() => openProject(project)}
                  onStar={() => toggleStar(project.path)}
                  onArchive={() => toggleArchive(project.path)}
                  onExport={() => exportZip(project.path, project.name)}
                  exporting={exportingPath === project.path}
                  onRemoveRecent={
                    view === "recent"
                      ? () => removeRecent(project.path)
                      : undefined
                  }
                />
              ))}
              {loading &&
                [0, 1, 2, 3, 4, 5].map((id) => (
                  <div key={id} className="home-project-skeleton" />
                ))}
            </section>
          </MotionConfig>
          {!loading && visible.length === 0 && (
            <div className="home-empty">
              <FolderOpenIcon size={30} strokeWidth={1.2} />
              <h2>
                {query
                  ? "No projects found"
                  : collection
                    ? "This collection is empty"
                    : view === "archived"
                      ? "Nothing archived"
                      : view === "starred"
                        ? "No starred projects"
                        : view === "recent"
                          ? "No recent projects"
                          : "No projects yet"}
              </h2>
              <p>
                {query
                  ? "Try a different name, or clear your search."
                  : collection
                    ? "Open a project's ··· menu and choose Add to collection."
                    : view === "archived"
                      ? "Archive a project to tuck it away without deleting it."
                      : view === "starred"
                        ? "Star any project to find it here."
                        : view === "recent"
                          ? "Projects you open will appear here."
                          : "Create a project or open a folder to get started."}
              </p>
            </div>
          )}
        </div>
      </main>

      <CollectionDialog
        state={collectionDialog}
        onClose={() => setCollectionDialog(null)}
        onCreated={(id) => navigate("all", id)}
      />
      <ToolsDialog open={toolsOpen} onOpenChange={setToolsOpen} />
      <ImportProjectDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          navigate("all");
          refresh();
        }}
        onOpenProject={openProject}
      />
      <Dialog open={showModeDialog} onOpenChange={setShowModeDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Choose how you’d like to begin your project.
            </DialogDescription>
          </DialogHeader>
          <div className="home-create-options">
            <button type="button" onClick={() => chooseMode("template")}>
              <PanelsTopLeftIcon size={23} />
              <strong>Start with a template</strong>
              <span>
                Papers, CVs, posters, and more. A little structure to get going.
              </span>
              <small>
                Browse templates <ArrowUpRightIcon size={13} />
              </small>
            </button>
            <button type="button" onClick={() => chooseMode("scratch")}>
              <FileTextIcon size={23} />
              <strong>Start from scratch</strong>
              <span>A blank document, ready for whatever comes next.</span>
              <small>
                Create a document <ArrowUpRightIcon size={13} />
              </small>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
