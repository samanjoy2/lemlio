import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "@/stores/project-store";
import {
  buildProjectCatalog,
  type ProjectCatalogData,
} from "@/lib/project-catalog";

export function useProjectCatalog() {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState<ProjectCatalogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const known = useProjectStore((state) => state.knownProjects);
  const recent = useProjectStore((state) => state.recentProjects);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void invoke<Record<string, string>>("project_titles")
      .then(setTitles)
      .catch(() => {});
    invoke<ProjectCatalogData>("list_imported_projects")
      .then((data) => {
        if (!disposed) setLibrary(data);
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  useEffect(() => {
    window.addEventListener("project-library-changed", refresh);
    return () => window.removeEventListener("project-library-changed", refresh);
  }, [refresh]);
  const projects = useMemo(
    () =>
      buildProjectCatalog(library?.projects ?? [], known, recent).map((p) => ({
        ...p,
        name: titles[p.path.replace(/\\/g, "/").toLowerCase()] || p.name,
      })),
    [library, known, recent, titles],
  );
  return { projects, library, loading, error, refresh };
}
