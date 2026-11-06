// Opt-in real model/tool check. No credentials are read by this script.
// node scripts/codex-compiler-smoke.mjs --inference --app=<Lemlio executable>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const inference = process.argv.includes("--inference");
const app = process.argv.find((a) => a.startsWith("--app="))?.slice(6);
if (inference && !app)
  throw new Error("--app=<Lemlio executable> is required for inference");
const definitions = JSON.parse(
  await readFile("apps/desktop/src/lib/codex-compiler-tools.json", "utf8"),
);
await mkdir(".tools", { recursive: true });
const cwd = await mkdtemp(resolve(".tools/compiler-agent-smoke-"));
await writeFile(
  join(cwd, "main.tex"),
  "\\documentclass{article}\\usepackage{xcolor}\\begin{document}\\section*{\\color{blue}Compiler Bridge Demo}A fictional verification document.\\end{document}",
);
const child = spawn(
  process.env.CODEX_BINARY || "codex",
  ["app-server", "--listen", "stdio://"],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
const pending = new Map();
let next = 1,
  thread,
  turnCompletion,
  calls = [],
  reply = "";
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const text = (value) => ({
  type: "inputText",
  text: typeof value === "string" ? value : JSON.stringify(value),
});
let compiled = false;
async function hostTool(params) {
  calls.push(params.tool);
  if (params.tool === "lemlio_compile") {
    compiled = false;
    const output = await new Promise((resolve, reject) => {
      const proc = spawn(
        app,
        ["--compile-project", cwd, "main.tex", "--tectonic"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let log = "";
      proc.stdout.on("data", (b) => (log += b));
      proc.stderr.on("data", (b) => (log += b));
      proc.on("error", reject);
      proc.on("close", (code) => resolve({ code, log }));
    });
    compiled = output.code === 0;
    return { success: compiled, contentItems: [text(output)] };
  }
  if (params.tool === "lemlio_view_pdf_page") {
    if (!compiled)
      return {
        success: false,
        contentItems: [text("Run a successful compilation first")],
      };
    const mupdf = await import(
      pathToFileURL(resolve("apps/desktop/node_modules/mupdf/dist/mupdf.js"))
        .href
    );
    const doc = mupdf.Document.openDocument(
      new Uint8Array(await readFile(join(cwd, ".prism/build/main.pdf"))),
      "application/pdf",
    );
    try {
      const page = doc.loadPage(0);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(1.2, 1.2),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        return {
          success: true,
          contentItems: [
            text("Page 1, rendered from the actual compiled PDF"),
            {
              type: "inputImage",
              imageUrl:
                "data:image/png;base64," +
                Buffer.from(pixmap.asPNG()).toString("base64"),
            },
          ],
        };
      } finally {
        pixmap.destroy();
        page.destroy();
      }
    } finally {
      doc.destroy();
    }
  }
  return {
    success: false,
    contentItems: [text("Unsupported smoke-test tool")],
  };
}
const lines = createInterface({ input: child.stdout });
child.stderr.resume();
lines.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "item/agentMessage/delta")
    reply += message.params.delta;
  if (message.method === "turn/completed") {
    if (message.params.turn.status === "completed") turnCompletion?.resolve();
    else
      turnCompletion?.reject(
        new Error(
          message.params.turn.error?.message || message.params.turn.status,
        ),
      );
  }
  if (message.method && message.id !== undefined) {
    if (message.method === "item/tool/call") {
      try {
        send({ id: message.id, result: await hostTool(message.params) });
      } catch (error) {
        send({
          id: message.id,
          result: { success: false, contentItems: [text(String(error))] },
        });
      }
    } else
      send({
        id: message.id,
        error: { code: -32601, message: "Not available in the smoke test" },
      });
  } else if (pending.has(message.id)) {
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) p.reject(new Error(message.error.message));
    else p.resolve(message.result);
  }
});
child.on("error", (error) => {
  for (const p of pending.values()) p.reject(error);
  turnCompletion?.reject(error);
});
const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
  console.error("Compiler tool smoke test timed out");
}, 180000);
async function turn(prompt) {
  reply = "";
  const finished = new Promise((resolve, reject) => {
    turnCompletion = { resolve, reject };
  });
  await call("turn/start", {
    threadId: thread,
    input: [{ type: "text", text: prompt, text_elements: [] }],
  });
  await finished;
}
try {
  await call("initialize", {
    clientInfo: {
      name: "lemlio_compiler_smoke",
      title: "Lemlio compiler verification",
      version: "1.3.1",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const catalog = await call("model/list", { limit: 100 });
  const requested = process.argv
    .find((a) => a.startsWith("--model="))
    ?.slice(8);
  const model =
    requested ||
    catalog.data.find((m) => !m.hidden && /codex-mini/.test(m.model))?.model;
  const created = await call("thread/start", {
    cwd,
    dynamicTools: definitions,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    ...(model ? { model } : {}),
    developerInstructions:
      "Use the supplied Lemlio tools when requested. Do not edit files or run shell commands. Report only verified results.",
  });
  thread = created.thread.id;
  console.log("Compiler tool schema and experimental capability: accepted");
  if (inference) {
    await turn(
      "Call lemlio_compile, then lemlio_view_pdf_page for page 1. Inspect the image and tell me its heading and heading color. Do not edit files or use other tools.",
    );
    if (
      !calls.includes("lemlio_compile") ||
      !calls.includes("lemlio_view_pdf_page") ||
      !compiled ||
      !/Compiler Bridge Demo/i.test(reply) ||
      !/blue/i.test(reply)
    )
      throw new Error(
        `Model did not verify compilation and actual PDF image: ${reply}`,
      );
    console.log("Real model compile + image inspection: passed");
    await call("thread/resume", {
      threadId: thread,
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await writeFile(
      join(cwd, "main.tex"),
      "\\documentclass{article}\\begin{document}\\UndefinedSmokeCommand\\end{document}",
    );
    const before = calls.length;
    await turn(
      "The test host deliberately introduced a LaTeX error. Run lemlio_compile again, report whether it failed and name the error. Do not edit or fix anything; do not rely on the previous preview.",
    );
    if (
      !calls.slice(before).includes("lemlio_compile") ||
      compiled ||
      !/undefined|failed|error/i.test(reply)
    )
      throw new Error("Model did not receive the real compiler failure");
    console.log("Resumed tools + genuine compilation failure: passed");
  }
} finally {
  if (thread)
    await call("thread/archive", { threadId: thread }).catch(() => {});
  clearTimeout(timer);
  child.kill();
  lines.close();
}
