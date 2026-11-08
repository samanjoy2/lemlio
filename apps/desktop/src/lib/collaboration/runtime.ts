import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  SharedProject,
  REMOTE,
  fromBase64,
  toBase64,
  type SharedDiskFile,
  type SharedConflict,
  type SharedVersion,
} from "./document";
import {
  authentication,
  decryptMessage,
  encryptMessage,
  makeInvitation,
  validateEndpoint,
  type Invitation,
} from "./crypto";

interface Loaded {
  enabled: boolean;
  manifest: { id: string; title: string; driveProjectId: string };
  settings: { key?: string; endpoint?: string; name?: string };
  state: string;
  stateHash?: string;
  files: SharedDiskFile[];
  baseline: SharedDiskFile[];
}
interface CollaborationState {
  path: string | null;
  loading: boolean;
  enabled: boolean;
  generation: number;
  connecting: boolean;
  connected: boolean;
  hosting: boolean;
  saved: boolean;
  error: string;
  peers: string[];
  conflicts: SharedConflict[];
  diskConflicts: string[];
}
export const useCollaborationStore = create<CollaborationState>(() => ({
  path: null,
  loading: false,
  enabled: false,
  generation: 0,
  connecting: false,
  connected: false,
  hosting: false,
  saved: true,
  error: "",
  peers: [],
  conflicts: [],
  diskConflicts: [],
}));
const keyPath = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
const replicas = new Map<string, Promise<Replica | undefined>>();
let active: Replica | undefined;
let activation = 0;
export const activeCollaboration = () => active;
/** Capture causal parents at the user's action, before asynchronous disk I/O. */
export function planSharedFileOperation(
  path: string,
  from: string,
  to?: string,
  directory = false,
) {
  const replica = active;
  if (!replica || keyPath(replica.path) !== keyPath(path)) return () => {};
  const matches = (name: string) =>
    name === from || (directory && name.startsWith(`${from}/`));
  const plans: SharedVersion[] = [];
  for (const file of replica.project.files()) {
    const heads = replica.project.heads(file);
    if (!heads.some((head) => !head.deleted && matches(head.path))) continue;
    if (heads.length !== 1)
      throw Error(
        "Review this file's shared changes before renaming or deleting it",
      );
    const head = heads[0];
    plans.push(
      replica.project.plan(file, {
        path:
          to === undefined ? head.path : `${to}${head.path.slice(from.length)}`,
        kind: head.kind,
        data: head.data,
        deleted: to === undefined,
      }),
    );
  }
  return () => {
    replica.project.doc.transact(() =>
      plans.forEach((plan) => replica.project.commit(plan)),
    );
    void replica
      .flush()
      .catch((error) =>
        useCollaborationStore.setState({ error: String(error) }),
      );
  };
}

export class Replica {
  readonly project: SharedProject;
  readonly awareness: Awareness;
  settings: Loaded["settings"];
  private connection = "";
  private attempt = 0;
  private stateHash: string;
  private lastTitle: string;
  private stopped = true;
  private hosting = false;
  private stops: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private savedGeneration = 0;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private network: Promise<void> = Promise.resolve();
  private conflictedDisk: string[] = [];
  private error = "";
  private reconcilePending = false;
  constructor(
    readonly path: string,
    readonly loaded: Loaded,
    private readonly io: { invoke: typeof invoke; listen: typeof listen } = {
      invoke,
      listen,
    },
  ) {
    this.settings = loaded.settings || {};
    this.stateHash = loaded.stateHash || "";
    this.lastTitle = loaded.manifest.title;
    this.project = new SharedProject(
      loaded.manifest.id,
      this.settings.name || "Writer",
    );
    if (loaded.state) this.project.load(fromBase64(loaded.state));
    else if (loaded.files.length)
      this.project.initialize(
        loaded.manifest.title,
        loaded.manifest.driveProjectId,
        loaded.files,
      );
    this.awareness = new Awareness(this.project.doc);
    this.awareness.setLocalStateField(
      "user",
      this.user(this.settings.name || "Writer"),
    );
    // Reconcile only the local delta since the last materialization, before any network merge.
    if (loaded.state)
      this.conflictedDisk = this.project.reconcile(
        loaded.files,
        loaded.baseline,
      );
    this.project.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.generation++;
      this.updateStatus();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush().catch(() => {}), 180);
      if (origin !== REMOTE && this.connection)
        this.send({ type: "update", data: toBase64(update) });
      window.dispatchEvent(
        new CustomEvent("lemlio-collaboration-changed", { detail: this.path }),
      );
    });
    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        this.updateStatus();
        if (origin !== REMOTE && this.connection)
          this.send({
            type: "awareness",
            data: toBase64(
              encodeAwarenessUpdate(this.awareness, [
                ...added,
                ...updated,
                ...removed,
              ]),
            ),
          });
      },
    );
    this.generation++;
  }
  private user(name: string) {
    const color = ["#278d80", "#5a79c3", "#b77833", "#a35f85"][
      this.project.doc.clientID % 4
    ];
    return { name, color, colorLight: `${color}33` };
  }
  private updateStatus() {
    if (active !== this) return;
    useCollaborationStore.setState({
      enabled: true,
      connected: !!this.connection,
      hosting: this.hosting,
      saved: this.savedGeneration === this.generation,
      error: this.error,
      conflicts: this.project.materialize().conflicts,
      diskConflicts: this.conflictedDisk,
      peers: [...this.awareness.getStates()]
        .filter(([id]) => id !== this.project.doc.clientID)
        .map(([, value]) => value.user?.name || "Writer"),
    });
  }
  activate() {
    active = this;
    useCollaborationStore.setState((s) => ({
      path: this.path,
      enabled: true,
      generation: s.generation + 1,
    }));
    this.updateStatus();
  }
  private enqueue<T>(work: () => Promise<T>) {
    const result = this.pending.catch(() => {}).then(work);
    this.pending = result.then(
      () => {},
      (error) => {
        this.error = String(error);
        this.updateStatus();
      },
    );
    return result;
  }
  hasConflicts() {
    return (
      this.conflictedDisk.length > 0 ||
      this.project.materialize().conflicts.length > 0
    );
  }
  async flush() {
    clearTimeout(this.timer);
    await this.enqueue(async () => {
      if (!this.project.meta.size || this.savedGeneration === this.generation)
        return;
      const gen = this.generation;
      const wasDirty = gen !== this.savedGeneration;
      const update = this.project.encode();
      this.stateHash = await this.io.invoke<string>("collaboration_persist", {
        projectPath: this.path,
        id: this.project.id,
        expectedHash: this.stateHash,
        state: toBase64(update),
        driveProjectId:
          this.project.meta.get("driveProjectId") ||
          this.loaded.manifest.driveProjectId,
        title: this.project.meta.get("title") || this.loaded.manifest.title,
      });
      if (gen !== this.generation) return;
      const value = this.project.materialize();
      const protectedPaths = [
        ...new Set(
          value.conflicts.flatMap((c) =>
            [...this.project.records.values()]
              .filter((v) => c.versions.some((h) => h.file === v.file))
              .map((v) => v.path),
          ),
        ),
      ];
      const result = await this.io.invoke<{ conflicts: string[] }>(
        "collaboration_materialize",
        {
          projectPath: this.path,
          id: this.project.id,
          expectedHash: this.stateHash,
          files: value.files,
          protected: protectedPaths,
        },
      );
      this.conflictedDisk = [
        ...new Set([...this.conflictedDisk, ...result.conflicts]),
      ];
      this.savedGeneration = gen;
      const title =
        this.project.meta.get("title") || this.loaded.manifest.title;
      if (title !== this.lastTitle) {
        this.lastTitle = title;
        window.dispatchEvent(new Event("project-library-changed"));
      }
      this.error = "";
      this.updateStatus();
      window.dispatchEvent(
        new CustomEvent("lemlio-collaboration-files", { detail: this.path }),
      );
      if (wasDirty && !value.conflicts.length && !this.conflictedDisk.length)
        window.dispatchEvent(
          new CustomEvent("lemlio-project-saved", { detail: this.path }),
        );
    });
    if (this.project.meta.size && this.savedGeneration !== this.generation)
      await this.flush();
  }
  async reconcileDisk() {
    if (this.reconcilePending) return;
    this.reconcilePending = true;
    try {
      await this.enqueue(async () => {
        const data = await this.io.invoke<{
          files: SharedDiskFile[];
          baseline: SharedDiskFile[];
        }>("collaboration_inventory", { projectPath: this.path });
        const base = new Map(data.baseline.map((f) => [f.path, f]));
        if (
          data.files.length !== data.baseline.length ||
          data.files.some((f) => {
            const old = base.get(f.path);
            return !old || old.text !== f.text || old.data !== f.data;
          })
        )
          this.generation++;
        this.conflictedDisk = [
          ...new Set([
            ...this.conflictedDisk,
            ...this.project.reconcile(data.files, data.baseline),
          ]),
        ];
        this.updateStatus();
      });
      await this.flush();
    } finally {
      this.reconcilePending = false;
    }
  }
  async configure(invitation: Invitation, name: string) {
    if (invitation.id !== this.project.id)
      throw Error(
        "This invitation belongs to another project. Join it as a separate project.",
      );
    if (this.settings.key && this.settings.key !== invitation.key)
      throw Error("The invitation key does not match the saved shared project");
    await this.io.invoke("collaboration_configure", {
      projectPath: this.path,
      id: invitation.id,
      key: invitation.key,
      endpoint: invitation.endpoint || null,
      name,
    });
    this.settings = {
      key: invitation.key,
      endpoint: invitation.endpoint,
      name,
    };
    this.awareness.setLocalStateField("user", this.user(name));
  }
  invitation(endpoint = this.settings.endpoint) {
    if (!this.settings.key)
      throw Error(
        "Use the original invitation to reconnect this restored project",
      );
    return makeInvitation({
      id: this.project.id,
      key: this.settings.key,
      endpoint,
      title: this.project.meta.get("title") || this.loaded.manifest.title,
    });
  }
  private send(value: unknown) {
    const connection = this.connection,
      secret = this.settings.key;
    if (!connection || !secret) return;
    this.network = this.network
      .catch(() => {})
      .then(async () => {
        const body = await encryptMessage(this.project.id, secret, value);
        if (this.connection === connection)
          await this.io.invoke("collaboration_send", { connection, body });
      })
      .catch((error) => {
        this.error = String(error);
        this.updateStatus();
      });
  }
  private async receive(body: string) {
    const message = await decryptMessage(
      this.project.id,
      this.settings.key!,
      body,
    );
    if (message.type === "hello") {
      this.send({ type: "state", data: toBase64(this.project.encode()) });
      this.send({
        type: "awareness",
        data: toBase64(
          encodeAwarenessUpdate(this.awareness, [this.project.doc.clientID]),
        ),
      });
    } else if (message.type === "state")
      this.project.load(fromBase64(message.data));
    else if (message.type === "update")
      this.project.applyIncrement(fromBase64(message.data));
    else if (message.type === "awareness")
      applyAwarenessUpdate(this.awareness, fromBase64(message.data), REMOTE);
  }
  async connect(endpoint: string) {
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const attempt = ++this.attempt;
    this.connection = "";
    validateEndpoint(endpoint);
    if (!this.settings.key) throw Error("Paste the original invitation first");
    this.settings.endpoint = endpoint;
    this.stopped = false;
    if (!this.stops.length) {
      let incoming = Promise.resolve();
      this.stops.push(
        await this.io.listen<{ connection: string; body: string }>(
          "lemlio-collaboration-message",
          ({ payload }) => {
            if (payload.connection !== this.connection) return;
            incoming = incoming
              .catch(() => {})
              .then(() => this.receive(payload.body))
              .catch((error) => {
                this.error = `Shared message rejected: ${String(error)}`;
                this.updateStatus();
              });
          },
        ),
      );
      this.stops.push(
        await this.io.listen<{ connection: string }>(
          "lemlio-collaboration-disconnected",
          ({ payload }) => {
            if (payload.connection !== this.connection) return;
            this.connection = "";
            removeAwarenessStates(
              this.awareness,
              [...this.awareness.getStates().keys()].filter(
                (id) => id !== this.project.doc.clientID,
              ),
              REMOTE,
            );
            this.updateStatus();
            if (!this.stopped)
              this.retry = setTimeout(
                () => void this.connect(endpoint).catch(() => {}),
                4000,
              );
          },
        ),
      );
    }
    useCollaborationStore.setState({ connecting: true });
    try {
      const connection = await this.io.invoke<string>("collaboration_connect", {
        id: this.project.id,
        auth: await authentication(this.settings.key),
        endpoint,
      });
      if (attempt !== this.attempt || this.stopped) {
        await this.io.invoke("collaboration_disconnect", { connection });
        return;
      }
      this.connection = connection;
      this.error = "";
      this.send({ type: "hello" });
      if (this.project.meta.size)
        this.send({ type: "state", data: toBase64(this.project.encode()) });
      this.send({
        type: "awareness",
        data: toBase64(
          encodeAwarenessUpdate(this.awareness, [this.project.doc.clientID]),
        ),
      });
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.connection)
          this.send({
            type: "awareness",
            data: toBase64(
              encodeAwarenessUpdate(this.awareness, [
                this.project.doc.clientID,
              ]),
            ),
          });
      }, 12000);
      this.updateStatus();
    } catch (error) {
      if (attempt !== this.attempt || this.stopped) return;
      this.connection = "";
      this.error = String(error);
      this.updateStatus();
      if (!this.stopped)
        this.retry = setTimeout(
          () => void this.connect(endpoint).catch(() => {}),
          4000,
        );
      throw error;
    } finally {
      if (active === this && attempt === this.attempt)
        useCollaborationStore.setState({ connecting: false });
    }
  }
  async host(port = 46317) {
    if (!this.settings.key)
      throw Error("Restore the original invitation key before hosting");
    if (!this.project.meta.size)
      throw Error("Receive or import the shared project before hosting it");
    await this.disconnect();
    const result = await this.io.invoke<{ port: number; address: string }>(
      "collaboration_host",
      {
        id: this.project.id,
        auth: await authentication(this.settings.key),
        port,
      },
    );
    this.hosting = true;
    await this.connect(`ws://127.0.0.1:${result.port}`);
    const endpoint = `ws://${result.address}:${result.port}`;
    await this.configure(
      { id: this.project.id, key: this.settings.key, endpoint },
      this.settings.name || "Writer",
    );
    return { ...result, endpoint };
  }
  async disconnect() {
    this.stopped = true;
    this.attempt++;
    const connection = this.connection;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.connection = "";
    for (const stop of this.stops.splice(0)) stop();
    if (connection)
      await this.io.invoke("collaboration_disconnect", { connection });
    if (this.hosting) await this.io.invoke("collaboration_stop_host");
    this.hosting = false;
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter(
        (id) => id !== this.project.doc.clientID,
      ),
      REMOTE,
    );
    this.updateStatus();
  }
  async resolveFile(
    conflict: SharedConflict,
    version: SharedVersion,
    keep: boolean,
  ) {
    this.project.doc.transact(() => {
      this.project.resolve(version.file, version, keep);
      if (conflict.reason === "Two files use the same filename")
        for (const other of conflict.versions)
          if (other.file !== version.file)
            this.project.resolve(other.file, other, false);
    });
    await this.flush();
  }
  async resolveDisk(path: string, local: boolean) {
    const data = await this.io.invoke<{ files: SharedDiskFile[] }>(
      "collaboration_inventory",
      { projectPath: this.path },
    );
    const value = data.files.find((f) => f.path === path);
    const file = this.project.fileAt(path);
    await this.io.invoke("collaboration_accept_disk", {
      projectPath: this.path,
      paths: [path],
    });
    if (local) {
      if (!value && file) this.project.remove(file);
      else if (value && !file) this.project.add(value);
      else if (value && file) {
        if (value.text !== undefined) this.project.setText(file, value.text);
        else this.project.replaceBinary(file, value.data || "");
      }
    }
    this.conflictedDisk = this.conflictedDisk.filter((p) => p !== path);
    this.generation++;
    await this.flush();
  }
  async exportChanges() {
    // A recovery export must remain available even if this PC cannot checkpoint.
    try {
      await this.reconcileDisk();
      await this.flush();
    } catch {
      /* Export the in-memory history below. */
    }
    if (!this.settings.key)
      throw Error("Paste the original invitation to export encrypted changes");
    return JSON.stringify({
      schema: 1,
      project: this.project.id,
      payload: await encryptMessage(this.project.id, this.settings.key, {
        type: "state",
        data: toBase64(this.project.encode()),
      }),
    });
  }
  async dispose() {
    await this.disconnect();
    await this.flush();
    clearTimeout(this.timer);
    this.awareness.destroy();
    this.project.destroy();
  }
  async importChanges(body: string) {
    const value = JSON.parse(body);
    if (
      value.schema !== 1 ||
      value.project !== this.project.id ||
      typeof value.payload !== "string"
    )
      throw Error("Choose a changes file from this shared project");
    if (!this.settings.key)
      throw Error("Paste the original invitation to decrypt these changes");
    const message = await decryptMessage(
      this.project.id,
      this.settings.key,
      value.payload,
    );
    if (message.type !== "state") throw Error("Invalid offline changes file");
    await this.reconcileDisk();
    this.project.load(fromBase64(message.data));
    // Imported updates are explicitly forwarded to connected peers too.
    this.send({ type: "state", data: toBase64(this.project.encode()) });
    await this.flush();
  }
}

export async function getReplica(path: string) {
  const key = keyPath(path);
  if (!replicas.has(key))
    replicas.set(
      key,
      (async () => {
        const loaded = await invoke<Loaded>("collaboration_load", {
          projectPath: path,
        });
        if (!loaded?.enabled) {
          replicas.delete(key);
          return undefined;
        }
        return new Replica(path, loaded);
      })().catch((error) => {
        replicas.delete(key);
        throw error;
      }),
    );
  return replicas.get(key)!;
}
export async function activateCollaboration(path: string) {
  const request = ++activation;
  const previous = active;
  if (previous && keyPath(previous.path) !== keyPath(path)) {
    active = undefined;
    await previous.dispose();
    replicas.delete(keyPath(previous.path));
  }
  const replica = await getReplica(path);
  if (request !== activation) return undefined;
  if (replica) {
    replica.activate();
    await replica.flush();
  } else {
    active = undefined;
    useCollaborationStore.setState((s) => ({
      path,
      enabled: false,
      generation: s.generation + 1,
      connected: false,
      hosting: false,
      peers: [],
      conflicts: [],
      diskConflicts: [],
      error: "",
    }));
  }
  return replica;
}
export async function enableCollaboration(path: string) {
  await invoke("collaboration_enable", { projectPath: path });
  replicas.delete(keyPath(path));
  return activateCollaboration(path);
}
export async function flushCollaboration(path?: string | null) {
  const replica = path ? await getReplica(path) : active;
  if (replica) await replica.flush();
}
export async function deactivateCollaboration() {
  activation++;
  const replica = active;
  active = undefined;
  if (replica) {
    await replica.dispose();
    replicas.delete(keyPath(replica.path));
  }
  useCollaborationStore.setState({
    path: null,
    enabled: false,
    connected: false,
    hosting: false,
    peers: [],
    conflicts: [],
    diskConflicts: [],
    error: "",
  });
}

export interface ReviewedHead {
  id: string;
  hash: string;
}
export async function prepareCollaborationBackup(
  path: string,
): Promise<ReviewedHead[] | undefined> {
  const replica = await getReplica(path);
  if (!replica) return undefined;
  await replica.reconcileDisk();
  const remote = await invoke<{ heads: (ReviewedHead & { state?: string })[] }>(
    "drive_collaboration_updates",
    { projectPath: path },
  );
  for (const head of remote.heads)
    if (head.state) replica.project.load(fromBase64(head.state));
  await replica.flush();
  if (replica.hasConflicts())
    throw Error("Review shared file conflicts before backing up this project");
  return remote.heads.map(({ id, hash }) => ({ id, hash }));
}
export async function backupProject<T>(options: {
  projectPath: string;
  expectedRemoteHash?: string;
  renameBackup?: boolean;
}): Promise<T> {
  const replica = await getReplica(options.projectPath);
  try {
    const heads = await prepareCollaborationBackup(options.projectPath);
    return await invoke<T>("drive_backup_project", {
      ...options,
      ...(heads ? { collaborationHeads: heads } : {}),
    });
  } finally {
    if (replica && replica !== active) {
      await replica.dispose();
      replicas.delete(keyPath(replica.path));
    }
  }
}

/** Fold ordinary agent filesystem edits into shared history without consulting Drive. */
export async function reconcileCollaborationSource(path: string) {
  const replica = await getReplica(path);
  if (!replica) return;
  try {
    await replica.reconcileDisk();
    if (replica.hasConflicts())
      throw Error(
        "Review shared-file conflicts in Collaboration before continuing: " +
          path,
      );
  } finally {
    if (replica !== active) {
      await replica.dispose();
      replicas.delete(keyPath(path));
    }
  }
}
