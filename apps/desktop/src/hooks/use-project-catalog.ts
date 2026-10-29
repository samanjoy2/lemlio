import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const signature = useRef("");
  useEffect(() => {
    let disposed = false;
    let busy = false;
    const load = () => {
      if (busy) return;
      busy = true;
      void invoke<Record<string, string>>("project_titles")
        .then((titles) => {
          if (!disposed) setTitles(titles);
        })
        .catch(() => {});
      void invoke<ProjectCatalogData>("list_imported_projects")
        .then((data) => {
          if (disposed) return;
          const next = JSON.stringify(data);
          const changed = signature.current && signature.current !== next;
          if (signature.current !== next) {
            signature.current = next;
            setLibrary(data);
          }
          setError(null);
          if (changed)
            window.dispatchEvent(new Event("project-library-changed"));
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        })
        .finally(() => {
          busy = false;
          if (!disposed) setLoading(false);
        });
    };
    load();
    const timer = setInterval(load, 10000);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", load);
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
