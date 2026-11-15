import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TemplateVersion {
  sha: string;
  committedAt: string;
  message: string;
}
export interface TemplateInstalled extends TemplateVersion {
  fetchedAt: number;
}
export interface TemplatePack {
  id: string;
  name: string;
  description: string;
  repo: string;
  url: string;
  mainFile: string;
  tags: string[];
  installed: TemplateInstalled | null;
  latest: TemplateVersion | null;
  updateAvailable: boolean;
  checkedAt: number | null;
}
interface PackList {
  packs: TemplatePack[];
  error: string | null;
}

/** The first seven characters of a commit, as GitHub shows it. */
export const shortVersion = (sha: string) => sha.slice(0, 7);

export function formatVersionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export type TemplateState = "missing" | "update" | "current" | "unchecked";

/** Where a template stands: not downloaded, outdated, up to date, or not yet compared. */
export function templateState(pack: TemplatePack): TemplateState {
  if (!pack.installed) return "missing";
  if (pack.updateAvailable) return "update";
  return pack.latest ? "current" : "unchecked";
}

const EVENT = "lemlio-templates-changed";
const publish = () => window.dispatchEvent(new Event(EVENT));

/**
 * The templates and their update state. Opening the list asks GitHub (at most
 * every few hours, decided by the backend) whether the official files changed.
 */
export function useTemplatePacks(check = true) {
  const [packs, setPacks] = useState<TemplatePack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const apply = (result: PackList) => {
    setPacks(result.packs);
    setError(result.error);
  };

  const load = useCallback(async () => {
    try {
      apply(await invoke<PackList>("template_packs"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const checkNow = useCallback(async (force = false) => {
    setChecking(true);
    try {
      apply(await invoke<PackList>("template_check_updates", { force }));
      publish();
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (check) void checkNow(false);
    window.addEventListener(EVENT, load);
    return () => window.removeEventListener(EVENT, load);
  }, [load, checkNow, check]);

  /** Download a template for the first time, or replace it with the newest version. */
  const install = useCallback(async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      apply(await invoke<PackList>("template_install", { id }));
      publish();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  return { packs, error, checking, busyId, install, checkNow };
}

/** How many templates have a newer official version, for a badge. */
export function useTemplateUpdateCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () =>
      void invoke<PackList>("template_packs")
        .then((r) => setCount(r.packs.filter((p) => p.updateAvailable).length))
        .catch(() => {});
    refresh();
    window.addEventListener(EVENT, refresh);
    return () => window.removeEventListener(EVENT, refresh);
  }, []);
  return count;
}

/** Quietly asks once at start-up so the badge is right before anyone opens Templates. */
export function checkTemplateUpdatesInBackground() {
  void invoke<PackList>("template_check_updates", { force: false })
    .then(publish)
    .catch(() => {});
}
