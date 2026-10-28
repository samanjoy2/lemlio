import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

// Uses the same documented stdio protocol as the desktop backend.
// Never reads or prints credential files. Inference runs only with --inference.
const child = spawn(process.env.CODEX_BINARY || "codex", ["app-server", "--listen", "stdio://"], {
  windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let nextId = 1;
let threadId;
let response = "";
let completed;
const completion = new Promise((resolve, reject) => { completed = { resolve, reject }; });
completion.catch(() => {});
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "item/agentMessage/delta" && msg.params.threadId === threadId) response += msg.params.delta;
  if (msg.method === "turn/completed" && msg.params.threadId === threadId) {
    if (msg.params.turn.status === "completed") completed.resolve();
    else completed.reject(new Error(msg.params.turn.error?.message || msg.params.turn.status));
  }
  if (msg.method && msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: "Smoke test does not execute tools" } });
  } else if (pending.has(msg.id)) {
    const request = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) request.reject(new Error(msg.error.message)); else request.resolve(msg.result);
  }
});
child.stderr.resume();
child.on("error", (error) => { for (const request of pending.values()) request.reject(error); completed.reject(error); });
child.on("exit", () => { for (const request of pending.values()) request.reject(new Error("Codex disconnected")); });
const timeout = setTimeout(() => { console.error("Codex smoke test timed out"); child.kill(); process.exitCode = 1; }, 120_000);
try {
  await call("initialize", { clientInfo: { name: "prismpro", title: "PrismPro", version: "1.1.6" } });
  send({ method: "initialized", params: {} });
  const account = await call("account/read", { refreshToken: false });
  if (!account.account && account.requiresOpenaiAuth) throw new Error("Codex is not signed in. Run codex login.");
  console.log(`Authentication: ${account.account?.type || "configured provider"}`);
  const models = await call("model/list", { limit: 100 });
  console.log(`Model catalog: ${models.data.length} models`);
  if(process.argv.includes("--models"))console.log(JSON.stringify(models.data.map(m=>({model:m.model,name:m.displayName,hidden:m.hidden}))));
  if (process.argv.includes("--skills")) {
    const expected = ["scientific-writing", "citation-management", "literature-review", "peer-review", "scientific-critical-thinking", "statistical-analysis", "statistical-power", "scientific-visualization", "latex-posters", "research-grants", "transformers", "scikit-learn"];
    const catalog = await call("skills/list", { cwds: [resolve("examples/welcome")], forceReload: true });
    const skills = catalog.data.flatMap((entry) => entry.skills);
    const missing = expected.filter((name) => !skills.some((skill) => skill.name === name && skill.enabled !== false));
    if (missing.length) throw new Error(`Codex could not discover: ${missing.join(", ")}`);
    console.log(`Codex skill discovery: ${expected.length}/${expected.length} selected skills available`);
  }
  if (process.argv.includes("--inference")) {
    const cwd = resolve(process.argv.find((arg) => arg.startsWith("--cwd="))?.slice(6) || ".");
    const thread = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "on-request" });
    threadId = thread.thread.id;
    await call("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly PRISM_CODEX_OK. Do not use tools or edit files.", text_elements: [] }] });
    await completion;
    if (response.trim() !== "PRISM_CODEX_OK") throw new Error(`Unexpected response: ${response}`);
    const history = await call("thread/read", { threadId, includeTurns: true });
    if (!history.thread.turns.length) throw new Error("Session history was not saved");
    await call("thread/resume", { threadId, cwd, sandbox: "read-only", approvalPolicy: "on-request" });
    await call("thread/archive", { threadId });
    console.log("Inference, saved history, and resume: passed (test chat archived)");
  }
  console.log("Codex connection: passed");
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { clearTimeout(timeout); child.kill(); lines.close(); }
