import { webcrypto, createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Replica } from "@/lib/collaboration/runtime";
import {
  SharedProject,
  fromBase64,
  toBase64,
  type SharedDiskFile,
} from "@/lib/collaboration/document";
import type { invoke } from "@tauri-apps/api/core";
import type { listen } from "@tauri-apps/api/event";
beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());
const id = "48b69ae1-ea1a-4718-8fc5-385757d4b8b5",
  key = "12".repeat(32);
const seed = () => {
  const p = new SharedProject(id, "Alex");
  p.initialize("Paper", "cloud-project", [
    { path: "main.tex", text: "A shared introduction.\nA shared ending." },
  ]);
  const state = toBase64(p.encode());
  p.destroy();
  return state;
};
type Receiver = (event: { payload: unknown }) => void;
function lab() {
  const connections = new Map<
    string,
    { endpoint: string; client: ReturnType<typeof device> }
  >();
  function device(path: string, state = seed()) {
    const loaded = {
      enabled: true,
      manifest: { id, title: "Paper", driveProjectId: "cloud-project" },
      settings: { key, name: path },
      state,
      stateHash: createHash("sha256").update(fromBase64(state)).digest("hex"),
      files: [] as SharedDiskFile[],
      baseline: [] as SharedDiskFile[],
    };
    const original = new SharedProject(id, path);
    original.load(fromBase64(state));
    loaded.files = original.materialize().files;
    loaded.baseline = loaded.files.map((f) => ({ ...f }));
    original.destroy();
    const callbacks = new Map<string, Set<Receiver>>();
    let connection = "",
      saved = state;
    const client = {
      loaded,
      get saved() {
        return saved;
      },
      failSaving: false,
      io: {
        listen: (async (event: string, cb: Receiver) => {
          const list = callbacks.get(event) || new Set();
          list.add(cb);
          callbacks.set(event, list);
          return () => list.delete(cb);
        }) as unknown as typeof listen,
        invoke: (async (command: string, args: any = {}) => {
          if (command === "collaboration_connect") {
            connection = crypto.randomUUID();
            connections.set(connection, { endpoint: args.endpoint, client });
            return connection;
          }
          if (command === "collaboration_send") {
            const source = connections.get(args.connection);
            if (!source) throw Error("Disconnected");
            for (const [other, destination] of connections)
              if (
                other !== args.connection &&
                destination.endpoint === source.endpoint
              )
                destination.client.emit("lemlio-collaboration-message", {
                  connection: other,
                  body: args.body,
                });
            return;
          }
          if (command === "collaboration_disconnect") {
            connections.delete(connection);
            return;
          }
          if (command === "collaboration_persist") {
            if (client.failSaving) throw Error("Disk full");
            expect(args.expectedHash).toBe(
              createHash("sha256").update(fromBase64(saved)).digest("hex"),
            );
            saved = args.state;
            return createHash("sha256").update(fromBase64(saved)).digest("hex");
          }
          if (command === "collaboration_inventory")
            return { files: loaded.files, baseline: loaded.baseline };
          if (command === "collaboration_materialize") {
            loaded.files = args.files;
            loaded.baseline = args.files.map((f: SharedDiskFile) => ({ ...f }));
            return { conflicts: [] };
          }
          if (
            command === "collaboration_configure" ||
            command === "collaboration_stop_host"
          )
            return;
          throw Error(`Unexpected native command: ${command}`);
        }) as typeof invoke,
      },
      emit(event: string, payload: unknown) {
        for (const cb of callbacks.get(event) || []) cb({ payload });
      },
    };
    return client;
  }
  return { device };
}
async function eventually(assertion: () => void) {
  let error: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      assertion();
      return;
    } catch (e) {
      error = e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw error;
}
it("syncs encrypted live edits, restarts from disk, exchanges offline files, and switches hosts", async () => {
  const sandbox = lab(),
    initial = seed();
  const da = sandbox.device("Alex", initial),
    db = sandbox.device("Jordan", initial);
  const a = new Replica("Alex", da.loaded, da.io),
    b = new Replica("Jordan", db.loaded, db.io);
  const file = a.project.fileAt("main.tex")!;
  let restarted: Replica | undefined;
  try {
    await a.connect("ws://host-a:46317/");
    await b.connect("ws://host-a:46317/");
    a.project.text(file).insert(0, "Alex's live edit. ");
    await eventually(() =>
      expect(b.project.text(file).toString()).toContain("Alex's live edit"),
    );
    await b.disconnect();
    b.project
      .text(file)
      .insert(b.project.text(file).length, " Offline Jordan contribution.");
    a.project.text(file).insert(0, "Another Alex edit. ");
    await b.flush();
    const restartDevice = sandbox.device("Jordan restarted", db.saved);
    restarted = new Replica(
      "Jordan restarted",
      restartDevice.loaded,
      restartDevice.io,
    );
    // Jordan is the next reachable host. Both retain independent histories.
    await a.disconnect();
    await restarted.connect("ws://host-b:46317/");
    await a.connect("ws://host-b:46317/");
    await eventually(() =>
      expect(a.project.text(file).toString()).toContain(
        "Offline Jordan contribution",
      ),
    );
    await eventually(() =>
      expect(restarted!.project.text(file).toString()).toContain(
        "Another Alex edit",
      ),
    );
    expect(a.project.text(file).toString()).toBe(
      restarted.project.text(file).toString(),
    );
    await a.disconnect();
    await restarted.disconnect();
    restarted.project.text(file).insert(0, "No overlapping online hours. ");
    const bundle = await restarted.exportChanges();
    expect(bundle).not.toContain("No overlapping online hours");
    await a.importChanges(bundle);
    expect(a.project.text(file).toString()).toContain(
      "No overlapping online hours",
    );
    const persisted = new SharedProject(id, "Recovered");
    persisted.load(fromBase64(da.saved));
    expect(persisted.text(file).toString()).toBe(
      a.project.text(file).toString(),
    );
    persisted.destroy();
  } finally {
    for (const peer of [a, b, restarted])
      if (peer) {
        await peer.disconnect();
        await peer.flush();
        peer.awareness.destroy();
        peer.project.destroy();
      }
  }
});
it("reports a persistence failure without treating the replica as saved or discarding its text", async () => {
  const d = lab().device("Failing disk"),
    replica = new Replica("Failing disk", d.loaded, d.io);
  try {
    const file = replica.project.fileAt("main.tex")!;
    replica.project.text(file).insert(0, "Keep this text. ");
    d.failSaving = true;
    await expect(replica.flush()).rejects.toThrow("Disk full");
    expect(replica.project.text(file).toString()).toContain("Keep this text");
    d.failSaving = false;
    await replica.flush();
    const restored = new SharedProject(id, "Restored");
    restored.load(fromBase64(d.saved));
    expect(restored.text(file).toString()).toContain("Keep this text");
    restored.destroy();
  } finally {
    await replica.disconnect();
    replica.awareness.destroy();
    replica.project.destroy();
  }
});
