import { AppSettings } from "@/components/app-settings";
import { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useTheme } from "next-themes";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckIcon,
  Clock3Icon,
  FileTextIcon,
  FolderOpenIcon,
  GraduationCapIcon,
  LayoutGridIcon,
  ListIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  SunIcon,
  PanelsTopLeftIcon,
  PresentationIcon,
  FlaskConicalIcon,
  XIcon,
  UploadIcon,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import {
  projectPathKey,
  type CatalogProject,
  type ProjectCategory,
} from "@/lib/project-catalog";
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
import { SkillsLibraryDialog, useInstalledSkills } from "./skills-library";
import {
  ImportProjectDialog,
  useProjectZipExport,
} from "./project-zip-transfer";
import "./project-home.css";

type ProjectView = "all" | "recent" | "starred";
const categories: { label: ProjectCategory; icon: typeof FileTextIcon }[] = [
  { label: "Papers", icon: FileTextIcon },
  { label: "CVs", icon: GraduationCapIcon },
  { label: "Proposals", icon: FlaskConicalIcon },
  { label: "Posters", icon: PresentationIcon },
  { label: "Other", icon: FolderOpenIcon },
];

export function ProjectPicker() {
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [wizardMode, setWizardMode] = useState<CreationMode | null>(null);
  const [version, setVersion] = useState("");
  const [view, setView] = useState<ProjectView>("all");
  const [category, setCategory] = useState<ProjectCategory | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [skillsOpen, setSkillsOpen] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const { exportingPath, exportZip } = useProjectZipExport();
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { projects, loading, error, refresh } = useProjectCatalog();
  const { skills } = useInstalledSkills(null);
  const recent = useProjectStore((state) => state.recentProjects);
  const starred = useProjectStore((state) => state.starredPaths);
  const addRecent = useProjectStore((state) => state.addRecentProject);
  const removeRecent = useProjectStore((state) => state.removeRecentProject);
  const toggleStar = useProjectStore((state) => state.toggleStarred);
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
    const handler = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !skillsOpen &&
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
  }, [skillsOpen, importOpen, showModeDialog, wizardMode]);

  const recentKeys = useMemo(
    () => new Set(recent.map((project) => projectPathKey(project.path))),
    [recent],
  );
  const visible = useMemo(
    () =>
      projects
        .filter((project) => {
          const key = projectPathKey(project.path);
          return (
            (!category || project.category === category) &&
            (view !== "recent" || recentKeys.has(key)) &&
            (view !== "starred" || starred.includes(key)) &&
            `${project.name} ${project.category} ${project.mainFile ?? ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase())
          );
        })
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name)
            : b.lastOpened - a.lastOpened || a.name.localeCompare(b.name),
        ),
    [projects, category, view, recentKeys, starred, query, sort],
  );
  const navigate = (
    next: ProjectView,
    nextCategory: ProjectCategory | null = null,
  ) => {
    setView(next);
    setCategory(nextCategory);
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
  if (wizardMode)
    return (
      <ProjectWizard mode={wizardMode} onBack={() => setWizardMode(null)} />
    );
  const heading =
    category ??
    (view === "recent"
      ? "Recent projects"
      : view === "starred"
        ? "Starred projects"
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
          <span>
            Lemlio
            <span className="home-brand-subtitle"></span>
          </span>
        </button>
        <nav className="home-navigation">
          <button
            type="button"
            className={!category && view === "all" ? "is-active" : ""}
            onClick={() => navigate("all")}
          >
            <LayoutGridIcon size={16} />
            <span>All projects</span>
            <small>{projects.length}</small>
          </button>
          <button
            type="button"
            className={!category && view === "recent" ? "is-active" : ""}
            onClick={() => navigate("recent")}
          >
            <Clock3Icon size={16} />
            <span>Recent</span>
            <small>{recent.length}</small>
          </button>
          <button
            type="button"
            className={!category && view === "starred" ? "is-active" : ""}
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
          <p className="home-nav-label">COLLECTIONS</p>
          {categories.map(({ label, icon: Icon }) => (
            <button
              type="button"
              key={label}
              className={category === label ? "is-active" : ""}
              onClick={() => navigate("all", label)}
            >
              <Icon size={16} />
              <span>{label}</span>
              <small>
                {
                  projects.filter((project) => project.category === label)
                    .length
                }
              </small>
            </button>
          ))}
          <p className="home-nav-label">WORKSPACE</p>
          <button type="button" onClick={() => setSkillsOpen(true)}>
            <BookOpenIcon size={16} />
            <span>Skills</span>
            <small>{skills.length}</small>
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
        </nav>
        <div className="home-sidebar-footer">
          <AppSettings />
          <div className="home-codex-status">
            <span
              className={
                codexStatus === "ready"
                  ? "home-status-dot is-ready"
                  : "home-status-dot"
              }
            />
            <div>
              {codexStatus === "ready"
                ? "Codex connected"
                : codexStatus === "checking"
                  ? "Connecting to Codex…"
                  : "Connect your Codex"}
              <small title={account ?? undefined}>
                {codexStatus === "ready" ? "" : "Your local AI assistant"}
              </small>
            </div>
            {codexStatus === "ready" && <CheckIcon size={13} />}
          </div>
          <label className="home-compiler">
            <span>Compiler</span>
            <select
              aria-label="LaTeX compiler"
              value={compiler}
              onChange={(event) =>
                setCompiler(event.target.value as "texlive" | "tectonic")
              }
            >
              <option value="texlive">MiKTeX / TeX Live</option>
              <option value="tectonic">Tectonic</option>
            </select>
          </label>
          <div className="home-footer-bottom">
            <span>Lemlio {version ? `v${version}` : ""}</span>
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
        </div>
      </aside>

      <main className="home-main">
        <div className="home-content">
          <div className="home-heading">
            <div>
              <h1>Projects</h1>
              <p></p>
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
          <div className="home-toolbar">
            <div className="home-project-tabs">
              <button
                type="button"
                className={view === "all" ? "is-active" : ""}
                onClick={() => navigate("all", category)}
              >
                {category ?? "All projects"}
                <span>
                  {category
                    ? projects.filter(
                        (project) => project.category === category,
                      ).length
                    : projects.length}
                </span>
              </button>
              <button
                type="button"
                className={view === "recent" ? "is-active" : ""}
                onClick={() => navigate("recent", category)}
              >
                Recent
              </button>
              <button
                type="button"
                className={view === "starred" ? "is-active" : ""}
                onClick={() => navigate("starred", category)}
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
              {category && (
                <button type="button" onClick={() => setCategory(null)}>
                  in {category}
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
          <section
            aria-label={heading}
            className={`home-project-grid ${layout === "list" ? "is-list" : ""}`}
          >
            {!loading && !query && view === "all" && !category && (
              <button
                type="button"
                className="home-new-project-card"
                onClick={() => setShowModeDialog(true)}
              >
                <span>
                  <PlusIcon size={22} strokeWidth={1.5} />
                </span>
                <strong>Create a project</strong>
                <p></p>
              </button>
            )}
            {visible.map((project) => (
              <ProjectCard
                key={projectPathKey(project.path)}
                project={project}
                starred={starred.includes(projectPathKey(project.path))}
                busy={opening !== null || exportingPath !== null}
                opening={opening === project.path}
                onOpen={() => openProject(project)}
                onStar={() => toggleStar(project.path)}
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
          {!loading && visible.length === 0 && (
            <div className="home-empty">
              <FolderOpenIcon size={30} strokeWidth={1.2} />
              <h2>
                {query
                  ? "No projects found"
                  : view === "starred"
                    ? "No starred projects"
                    : view === "recent"
                      ? "No recent projects"
                      : "No projects yet"}
              </h2>
              <p>
                {query
                  ? "Try a different name, or clear your search."
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

      <SkillsLibraryDialog open={skillsOpen} onOpenChange={setSkillsOpen} />
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
