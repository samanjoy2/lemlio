import { CloudDownloadIcon, XIcon } from "lucide-react";
import { Card } from "./panelui/card";
import { Badge } from "./panelui/badge";
import { Button } from "./ui/button";
import {
  dismissDriveDiscoveries,
  reviewDriveProjects,
  useDriveDiscoveries,
} from "@/lib/drive-discovery";
export function DriveDiscoveryNotice() {
  const projects = useDriveDiscoveries();
  if (!projects.length) return null;
  return (
    <Card
      as="section"
      size="sm"
      className="mb-4"
      aria-label="Projects available in Google Drive"
    >
      <Card.Header>
        <Card.Title className="flex items-center gap-2 text-sm">
          <CloudDownloadIcon size={16} />
          New projects in Drive{" "}
          <Badge size="sm" variant="secondary">
            {projects.length}
          </Badge>
        </Card.Title>
        <Card.Action>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss new Drive projects"
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
      <Card.Footer className="justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          Choose which projects to download to this device
        </p>
        <Button size="sm" onClick={reviewDriveProjects}>
          Review and download
        </Button>
      </Card.Footer>
    </Card>
  );
}
