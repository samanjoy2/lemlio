import * as Y from "yjs";
import { diff } from "@codemirror/merge";

export const REMOTE = Symbol("remote collaboration update");
const INTERNAL = Symbol("collaboration bookkeeping");
export const MAX_SHARED_BYTES = 96 * 1024 * 1024;
function randomId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export interface SharedVersion {
  id: string;
  file: string;
  path: string;
  kind: "text" | "binary";
  data?: string;
  deleted?: boolean;
  parents: string[];
  edits: Record<string, number>;
  author: string;
  time: number;
}
export interface SharedDiskFile {
  path: string;
  text?: string;
  data?: string;
  hash?: string;
}
export interface SharedConflict {
  file: string;
  reason: string;
  versions: SharedVersion[];
}
export interface SharedMaterialization {
  files: SharedDiskFile[];
  conflicts: SharedConflict[];
}
export function validSharedPath(path: string) {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    path.length <= 512 &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || '\\<>:"|?*'.includes(c)) &&
    parts.every(
      (part) =>
        !!part &&
        !part.startsWith(".") &&
        !part.endsWith(".") &&
        !part.endsWith(" ") &&
        !/^(keys|node_modules|conversations|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
          part,
        ) &&
        !/^(client_secret.*\.json|google-drive-oauth\.json|drive-client\.json)$/i.test(
          part,
        ),
    )
  );
}

/** All peers hold this history. No timestamp or hosting role decides a winner. */
export class SharedProject {
  readonly doc = new Y.Doc();
  readonly meta = this.doc.getMap<string>("project");
  readonly records = this.doc.getMap<SharedVersion>("versions");
  readonly edits = this.doc.getMap<number>("edits");
  private observed = new Set<string>();
  constructor(
    readonly id: string,
    public author: string,
  ) {
    this.records.observe(() => this.observeTexts());
  }
  initialize(title: string, driveProjectId: string, files: SharedDiskFile[]) {
    if (this.meta.size)
      throw Error("This shared project already has a history");
    this.doc.transact(() => {
      this.meta.set("id", this.id);
      this.meta.set("schema", "1");
      this.meta.set("title", title);
      this.meta.set("driveProjectId", driveProjectId);
      for (const file of files) this.add(file);
    });
    this.observeTexts();
  }
  load(update: Uint8Array) {
    // Validate on a temporary document before changing the live replica.
    if (update.byteLength > MAX_SHARED_BYTES)
      throw Error("Shared history exceeds 96 MB");
    const check = new Y.Doc();
    try {
      Y.applyUpdate(check, update);
      const meta = check.getMap<string>("project");
      if (meta.get("id") !== this.id || meta.get("schema") !== "1")
        throw Error(
          "This update belongs to a different project or unsupported format",
        );
      const records = check.getMap<SharedVersion>("versions");
      if (records.size > 100000) throw Error("Too many shared file revisions");
      records.forEach((v, key) => {
        if (
          !v ||
          v.id !== key ||
          typeof v.file !== "string" ||
          !validSharedPath(v.path) ||
          !["text", "binary"].includes(v.kind) ||
          !Array.isArray(v.parents) ||
          !v.edits ||
          typeof v.edits !== "object"
        )
          throw Error("Invalid shared file record");
      });
    } finally {
      check.destroy();
    }
    Y.applyUpdate(this.doc, update, REMOTE);
    this.observeTexts();
  }
  applyIncrement(update: Uint8Array) {
    // The merged state is validated too; incremental messages may not contain project metadata.
    const check = new Y.Doc();
    try {
      Y.applyUpdate(check, this.encode());
      Y.applyUpdate(check, update);
      this.load(Y.encodeStateAsUpdate(check));
    } finally {
      check.destroy();
    }
  }
  encode() {
    // Keep revision links, but discard payloads superseded by a known descendant.
    // Every unresolved head retains its complete binary data.
    const parents = new Set(
      [...this.records.values()].flatMap((v) => v.parents),
    );
    const obsolete = [...this.records.values()].filter(
      (v) => v.kind === "binary" && v.data && parents.has(v.id),
    );
    if (obsolete.length)
      this.doc.transact(() => {
        for (const version of obsolete) {
          const { data: _data, ...metadata } = version;
          this.records.set(version.id, metadata);
        }
      }, INTERNAL);
    return Y.encodeStateAsUpdate(this.doc);
  }
  text(file: string) {
    return this.doc.getText(`text:${file}`);
  }
  heads(file: string) {
    const versions = [...this.records.values()].filter((v) => v.file === file);
    const parents = new Set(versions.flatMap((v) => v.parents));
    return versions.filter((v) => !parents.has(v.id));
  }
  files() {
    return [...new Set([...this.records.values()].map((v) => v.file))];
  }
  private vector(file: string) {
    return Object.fromEntries(
      [...this.edits.entries()].filter(([k]) => k.startsWith(`${file}:`)),
    );
  }
  private changedAfterDelete(v: SharedVersion) {
    return [...this.edits.entries()].some(
      ([key, count]) =>
        key.startsWith(`${v.file}:`) && count > (v.edits[key] || 0),
    );
  }
  plan(
    file: string,
    value: Pick<SharedVersion, "path" | "kind" | "data" | "deleted">,
  ) {
    if (!validSharedPath(value.path)) throw Error("Invalid shared filename");
    const id = randomId();
    const version: SharedVersion = {
      ...value,
      id,
      file,
      parents: this.heads(file).map((v) => v.id),
      edits: this.vector(file),
      author: this.author,
      time: Date.now(),
    };
    return version;
  }
  commit(version: SharedVersion) {
    if (!validSharedPath(version.path)) throw Error("Invalid shared filename");
    this.records.set(version.id, version);
    return version;
  }
  private record(
    file: string,
    value: Pick<SharedVersion, "path" | "kind" | "data" | "deleted">,
  ) {
    return this.commit(this.plan(file, value));
  }
  add(file: SharedDiskFile) {
    if (!validSharedPath(file.path))
      throw Error(`Cannot share this path: ${file.path}`);
    const id = randomId();
    this.doc.transact(() => {
      this.record(id, {
        path: file.path,
        kind: file.text === undefined ? "binary" : "text",
        ...(file.text === undefined ? { data: file.data || "" } : {}),
      });
      if (file.text) this.text(id).insert(0, file.text.replace(/\r\n?/g, "\n"));
    });
    this.observeTexts();
    return id;
  }
  setText(file: string, content: string) {
    content = content.replace(/\r\n?/g, "\n");
    const text = this.text(file),
      before = text.toString();
    if (before === content) return;
    const changes = diff(before, content);
    this.doc.transact(() => {
      for (const c of [...changes].reverse()) {
        if (c.toA > c.fromA) text.delete(c.fromA, c.toA - c.fromA);
        if (c.toB > c.fromB)
          text.insert(c.fromA, content.slice(c.fromB, c.toB));
      }
    });
  }
  rename(file: string, path: string) {
    if (!validSharedPath(path)) throw Error("Invalid shared filename");
    const head = this.heads(file)[0];
    if (head) this.record(file, { path, kind: head.kind, data: head.data });
  }
  replaceBinary(file: string, data: string) {
    const head = this.heads(file)[0];
    if (head) this.record(file, { path: head.path, kind: "binary", data });
  }
  remove(file: string) {
    const head = this.heads(file)[0];
    if (head)
      this.record(file, {
        path: head.path,
        kind: head.kind,
        data: head.data,
        deleted: true,
      });
  }
  resolve(file: string, chosen: SharedVersion, keep: boolean) {
    this.record(file, {
      path: chosen.path,
      kind: chosen.kind,
      data: chosen.data,
      deleted: !keep,
    });
  }
  fileAt(path: string) {
    return this.files().find((file) => {
      const h = this.heads(file);
      return h.length === 1 && !h[0].deleted && h[0].path === path;
    });
  }
  materialize(): SharedMaterialization {
    const files: SharedDiskFile[] = [],
      conflicts: SharedConflict[] = [];
    const byPath = new Map<
      string,
      { file: string; version: SharedVersion }[]
    >();
    for (const file of this.files()) {
      const heads = this.heads(file);
      if (!heads.length) continue;
      if (
        heads.length > 1 ||
        (heads[0].deleted && this.changedAfterDelete(heads[0]))
      ) {
        conflicts.push({
          file,
          reason:
            heads.length > 1
              ? "Concurrent file changes"
              : "This file was edited while another person deleted it",
          versions: heads,
        });
        continue;
      }
      if (heads[0].deleted) continue;
      const list = byPath.get(heads[0].path.toLowerCase()) || [];
      list.push({ file, version: heads[0] });
      byPath.set(heads[0].path.toLowerCase(), list);
    }
    for (const entries of byPath.values()) {
      if (entries.length > 1) {
        conflicts.push({
          file: entries[0].file,
          reason: "Two files use the same filename",
          versions: entries.map((e) => e.version),
        });
        continue;
      }
      const { file, version: v } = entries[0];
      files.push(
        v.kind === "text"
          ? { path: v.path, text: this.text(file).toString() }
          : { path: v.path, data: v.data || "" },
      );
    }
    return { files, conflicts };
  }
  /** Reconcile an ordinary local save against the last materialized source. */
  reconcile(disk: SharedDiskFile[], baseline: SharedDiskFile[]) {
    const current = new Map(disk.map((f) => [f.path, f]));
    const base = new Map(baseline.map((f) => [f.path, f]));
    const conflicts: string[] = [];
    const blocked = new Set(
      this.materialize().conflicts.flatMap((c) =>
        [...this.records.values()]
          .filter((v) => c.versions.some((h) => h.file === v.file))
          .map((v) => v.path),
      ),
    );
    const normalized = (value?: string) => value?.replace(/\r\n?/g, "\n");
    const same = (a?: SharedDiskFile, b?: SharedDiskFile) =>
      normalized(a?.text) === normalized(b?.text) && a?.data === b?.data;
    this.doc.transact(() => {
      const renamed = new Set<string>(),
        consumed = new Set<string>();
      for (const [path, old] of base) {
        if (current.has(path) || blocked.has(path)) continue;
        const file = this.fileAt(path);
        const next = [...current].find(
          ([name, value]) =>
            !base.has(name) && !consumed.has(name) && same(old, value),
        );
        if (file && next) {
          this.rename(file, next[0]);
          renamed.add(path);
          consumed.add(next[0]);
        }
      }
      for (const [path, old] of base) {
        if (renamed.has(path) || blocked.has(path)) continue;
        const value = current.get(path);
        if (same(old, value)) continue;
        const file = this.fileAt(path);
        if (!file) {
          // A crash may have written the source change before updating its baseline.
          const historical = [...this.records.values()].find(
            (v) => v.path === path,
          );
          const heads = historical ? this.heads(historical.file) : [];
          if (!value && heads.length === 1) {
            if (heads[0].deleted && !this.changedAfterDelete(heads[0]))
              continue;
            const existing = current.get(heads[0].path);
            const projected = this.materialize().files.find(
              (f) => f.path === heads[0].path,
            );
            if (existing && projected && same(existing, projected)) continue;
          }
          conflicts.push(path);
          continue;
        }
        if (!value) {
          this.remove(file);
          continue;
        }
        if (value.text !== undefined) {
          const shared = this.text(file).toString();
          if (
            shared !== normalized(old.text) &&
            shared !== normalized(value.text)
          ) {
            conflicts.push(path);
            continue;
          }
          this.setText(file, value.text);
        } else this.replaceBinary(file, value.data || "");
      }
      for (const [path, value] of current) {
        if (base.has(path) || consumed.has(path) || blocked.has(path)) continue;
        const file = this.fileAt(path);
        if (file) {
          const shared = this.materialize().files.find((f) => f.path === path);
          if (!same(shared, value)) conflicts.push(path);
        } else this.add(value);
      }
    });
    return conflicts;
  }
  private observeTexts() {
    for (const record of this.records.values()) {
      if (record.kind !== "text" || this.observed.has(record.file)) continue;
      this.observed.add(record.file);
      this.text(record.file).observe((_event, transaction) => {
        if (
          !transaction.local ||
          transaction.origin === INTERNAL ||
          transaction.origin === REMOTE
        )
          return;
        const key = `${record.file}:${this.doc.clientID}`;
        this.doc.transact(
          () => this.edits.set(key, (this.edits.get(key) || 0) + 1),
          INTERNAL,
        );
      });
    }
  }
  destroy() {
    this.doc.destroy();
  }
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(text: string) {
  if (text.length > 192 * 1024 * 1024)
    throw Error("Shared message exceeds the size limit");
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
