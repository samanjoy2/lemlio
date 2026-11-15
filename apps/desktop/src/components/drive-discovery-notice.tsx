import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CloudDownloadIcon, XIcon } from "lucide-react";
import { Card } from "./panelui/card";
import { Badge } from "./panelui/badge";
import { Button } from "./ui/button";
import {
  dismissDriveDiscoveries,
  removeDriveDiscovery,
  reviewDriveProjects,
  useDriveDiscoveries,
  type DriveAvailableProject,
} from "@/lib/drive-discovery";
export function DriveDiscoveryNotice() {
  const projects = useDriveDiscoveries();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!projects.length) return null;
  const matches = projects.filter((p) => p.localMatches?.length);
  // The user confirms that a local project is this backed-up project. It then
  // continues the same history instead of being downloaded as a second project.
  const link = async (project: DriveAvailableProject) => {
    setBusy(project.id);
    setError("");
    try {
      await invoke("drive_link_project", {
        projectPath: project.localMatches![0],
        archiveId: project.id,
      });
      removeDriveDiscovery(project);
      window.dispatchEvent(new Event("lemlio-drive-connected"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <Card
      as="section"
      size="sm"
      className="mb-4"
      aria-label="Projects available in your backup"
    >
      <Card.Header>
        <Card.Title className="flex items-center gap-2 text-sm">
          <CloudDownloadIcon size={16} />
          New projects in your backup{" "}
          <Badge size="sm" variant="secondary">
            {projects.length}
          </Badge>
        </Card.Title>
        <Card.Action>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss new backup projects"
            onClick={dismissDriveDiscoveries}
          >
            <XIcon size={14} />
          </Button>
        </Card.Action>
        <Card.Description className="truncate">
          {projects
            .slice(0, 3)
            .map((p) => p.name)
            .join(", ")}
          {projects.length > 3 ? ` and ${projects.length - 3} more` : ""}
        </Card.Description>
      </Card.Header>
      {matches.map((p) => (
        <div
          key={p.projectId || p.id}
          className="flex items-center justify-between gap-3 px-4 pb-3 text-xs"
        >
          <span className="min-w-0 truncate" title={p.localMatches![0]}>
            “{p.name}” has the same title as a project on this computer. Link
            them if they are the same project.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void link(p)}
          >
            {busy === p.id ? "Linking…" : "Link to my project"}
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className="px-4 pb-3 text-destructive text-xs">
          {error}
        </p>
      )}
      <Card.Footer className="justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Choose which projects to download to this computer
        </p>
        <Button size="sm" onClick={reviewDriveProjects}>
          Review and download
        </Button>
      </Card.Footer>
    </Card>
  );
}
