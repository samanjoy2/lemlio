import { ProjectGroups } from "@/components/project-groups";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useCollaborationStore } from "@/lib/collaboration/runtime";
import { CollaborationBar } from "@/components/collaboration-dialog";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { useDocumentStore } from "@/stores/document-store";
import { Spinner } from "@/components/panelui/spinner";
import { DriveStatus } from "@/components/drive-status";

export function WorkspaceLayout() {
  const initialized = useDocumentStore((s) => s.initialized);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const loadingShared = useCollaborationStore(
    (s) => s.loading && s.path === projectRoot,
  );
  if (!initialized || loadingShared) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground text-sm">
          <Spinner />
          Loading project…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CollaborationBar />
      <ProjectGroups />
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={15} minSize={10} maxSize={25}>
          <Sidebar />
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

        <Panel defaultSize={42.5} minSize={25}>
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <LatexEditor />
            </div>
            <DriveStatus projectPath={projectRoot} />
          </div>
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

        <Panel defaultSize={42.5} minSize={25}>
          <PdfPreview />
        </Panel>
      </PanelGroup>
    </div>
  );
}
