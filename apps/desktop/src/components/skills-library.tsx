import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpenIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  domain: string;
  folder: string;
}

export function useInstalledSkills(projectPath: string | null, enabled = true) {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    Promise.all([
      invoke<InstalledSkill[]>("list_installed_skills", { projectPath: null }),
      projectPath
        ? invoke<InstalledSkill[]>("list_installed_skills", { projectPath })
        : Promise.resolve([]),
    ])
      .then(([personal, project]) => {
        if (disposed) return;
        const byId = new Map(
          [...personal, ...project].map((skill) => [skill.id, skill]),
        );
        setSkills(
          [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
        );
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
  }, [projectPath, enabled]);
  return { skills, loading, error };
}

export function SkillsLibrary() {
  const { skills, loading, error } = useInstalledSkills(null);
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label="Skills"
      className="w-full space-y-3 rounded-xl border border-border bg-muted/20 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BookOpenIcon className="size-4" />
          <h2 className="font-semibold text-sm">Skills</h2>
        </div>
        <span className="text-muted-foreground text-xs">
          {loading ? "Loading…" : `${skills.length} ready for Codex`}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        Your library for research, writing, analysis, and figures. Codex can use
        relevant skills as you work.
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {skills.slice(0, 4).map((skill) => (
            <span
              key={skill.id}
              className="rounded-full bg-muted px-2 py-1 text-xs"
            >
              {skill.name}
            </span>
          ))}
        </div>
      )}
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        View skills
      </Button>
      <SkillsLibraryDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}

export function SkillsLibraryDialog({
  open,
  onOpenChange,
  projectPath = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath?: string | null;
}) {
  const { skills, loading, error } = useInstalledSkills(projectPath, open);
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      skills.filter((skill) =>
        `${skill.name} ${skill.description} ${skill.domain}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [skills, query],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Available to your Codex models. Ask naturally, or type a skill's
            command in a project chat.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 rounded-md border px-3 py-2">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            aria-label="Search skills"
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Find a skill…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {loading && (
            <p className="py-4 text-muted-foreground text-sm">
              Loading your skills…
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {!loading && !error && filtered.length === 0 && (
            <p className="py-4 text-muted-foreground text-sm">
              {query ? "No matching skills." : "No skills in this library yet."}
            </p>
          )}
          {filtered.map((skill) => (
            <article
              key={skill.id}
              className="space-y-1.5 rounded-lg border p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium text-sm">{skill.name}</h3>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {skill.domain}
                </span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {skill.description}
              </p>
              <code className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs">
                /{skill.folder}
              </code>
            </article>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
