import { useEffect, useState } from "react";
import { toast } from "sonner";

export interface DriveAvailableProject {
  id: string;
  projectId?: string;
  name: string;
  localPath?: string;
  deviceName?: string;
}
const KEY = "lemlio-drive-available-projects";
const DISMISSED = "lemlio-drive-discovery-dismissed";
const SEEN = "lemlio-drive-discovery-seen";
export const DRIVE_DISCOVERED = "lemlio-drive-projects-discovered";
const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const identity = (p: DriveAvailableProject) => p.projectId || p.id;
export function availableDriveProjects(): DriveAvailableProject[] {
  const dismissed = new Set(read<string[]>(DISMISSED, []));
  return read<DriveAvailableProject[]>(KEY, []).filter(
    (p) => !dismissed.has(identity(p)),
  );
}
export const reviewDriveProjects = () =>
  window.dispatchEvent(new Event("lemlio-restore-drive"));
export function publishDriveDiscoveries(projects: DriveAvailableProject[]) {
  const missing = [
    ...new Map(
      projects
        .filter((p) => !p.localPath && p.id && p.name)
        .map((p) => [identity(p), p]),
    ).values(),
  ];
  localStorage.setItem(KEY, JSON.stringify(missing));
  const visible = availableDriveProjects();
  const seen = new Set(read<string[]>(SEEN, []));
  const fresh = visible.filter((p) => !seen.has(identity(p)));
  if (fresh.length) {
    fresh.forEach((p) => seen.add(identity(p)));
    localStorage.setItem(SEEN, JSON.stringify([...seen]));
    toast.info(
      fresh.length === 1
        ? "New project found in Drive"
        : `${fresh.length} new projects found in Drive`,
      {
        description: fresh
          .slice(0, 3)
          .map((p) => p.name)
          .join(", "),
        duration: 15000,
        action: { label: "Review and download", onClick: reviewDriveProjects },
      },
    );
  }
  window.dispatchEvent(new Event(DRIVE_DISCOVERED));
}
export function dismissDriveDiscoveries() {
  const dismissed = new Set(read<string[]>(DISMISSED, []));
  availableDriveProjects().forEach((p) => dismissed.add(identity(p)));
  localStorage.setItem(DISMISSED, JSON.stringify([...dismissed]));
  window.dispatchEvent(new Event(DRIVE_DISCOVERED));
}
export function useDriveDiscoveries() {
  const [projects, setProjects] = useState(availableDriveProjects);
  useEffect(() => {
    const refresh = () => setProjects(availableDriveProjects());
    window.addEventListener(DRIVE_DISCOVERED, refresh);
    return () => window.removeEventListener(DRIVE_DISCOVERED, refresh);
  }, []);
  return projects;
}
