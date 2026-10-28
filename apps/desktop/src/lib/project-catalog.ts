export interface ProjectRecord {
  path: string;
  name: string;
  lastOpened: number;
}

export interface ImportedProject {
  name: string;
  path: string;
  mainFile: string | null;
  fileCount: number;
  texFileCount: number;
  conversationCount: number;
}

export interface ProjectCatalogData {
  projects: ImportedProject[];
  failedExportCount: number;
  failedExports?: { name: string; message: string }[];
}

export type ProjectCategory =
  | "Papers"
  | "CVs"
  | "Proposals"
  | "Posters"
  | "Other";
export interface CatalogProject extends ProjectRecord {
  mainFile?: string | null;
  fileCount?: number;
  texFileCount?: number;
  conversationCount?: number;
  imported: boolean;
  category: ProjectCategory;
}

export function projectPathKey(path: string): string {
  const key = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key;
}

export function projectCategory(
  name: string,
  mainFile?: string | null,
): ProjectCategory {
  if (/\bcv\b|resume|résumé/i.test(name)) return "CVs";
  if (/proposal|\bsop\b|statement of purpose|grant/i.test(name))
    return "Proposals";
  if (/poster/i.test(name) || /poster\.tex$/i.test(mainFile ?? ""))
    return "Posters";
  if (
    /paper|manuscript|bnmmlu|research|report/i.test(name) ||
    /acl_latex|conference|report/i.test(mainFile ?? "")
  )
    return "Papers";
  return "Other";
}

export function buildProjectCatalog(
  imported: ImportedProject[],
  known: ProjectRecord[],
  recent: ProjectRecord[],
): CatalogProject[] {
  const projects = new Map<string, CatalogProject>();
  for (const item of imported) {
    projects.set(projectPathKey(item.path), {
      ...item,
      lastOpened: 0,
      imported: true,
      category: projectCategory(item.name, item.mainFile),
    });
  }
  for (const record of [...known, ...recent]) {
    const key = projectPathKey(record.path);
    const existing = projects.get(key);
    projects.set(key, {
      ...existing,
      ...record,
      name: existing?.name ?? record.name,
      lastOpened: Math.max(record.lastOpened, existing?.lastOpened ?? 0),
      imported: existing?.imported ?? false,
      category: existing?.category ?? projectCategory(record.name),
    });
  }
  return [...projects.values()];
}
