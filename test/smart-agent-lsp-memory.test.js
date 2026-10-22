"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WorkspaceEvents = require("../lib/workspace-events");
const WorkspaceIndex = require("../lib/workspace-index");
const ContextEngine = require("../lib/context-engine");
const LspManager = require("../lib/lsp-manager");
const MemoryStore = require("../lib/memory-store");
const createMemoryTools = require("../lib/memory-tools");
const AiChat = require("../lib/ai-chat");

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-lsp-memory-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data", "context");
  const source = path.join(workspace, "src", "app.ts");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "export function AppSymbol() { return 1; }\nAppSymbol();\nBROKEN\n");

  const events = new WorkspaceEvents({ workspace, dedupeMs: 1 });
  const index = new WorkspaceIndex({ workspace, dataDir, events });
  await index.whenIdle();

  const mockServer = path.join(__dirname, "fixtures", "mock-lsp-server.js");
  const lsp = new LspManager({
    workspace,
    index,
    events,
    profiles: {
      typescript: {
        command: process.execPath,
        args: [mockServer],
        extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"],
      },
    },
    commandResolver: async (profile) => profile.command,
    requestTimeoutMs: 2000,
    backoffBaseMs: 20,
  });

  assert.strictEqual(await lsp.didOpen("src/app.ts", fs.readFileSync(source, "utf8"), 1), true);
  await waitFor(() => lsp.diagnostics("src/app.ts").length, 2000);
  assert.match(lsp.diagnostics("src/app.ts")[0].message, /version 1/);

  const symbols = await lsp.workspaceSymbols("App", "typescript");
  assert.strictEqual(symbols[0].name, "AppSymbol");
  const definitions = await lsp.definitions("src/app.ts", { line: 1, character: 3 }, "AppSymbol");
  const references = await lsp.references("src/app.ts", { line: 1, character: 3 }, { symbol: "AppSymbol" });
  assert.strictEqual(definitions.length, 1);
  assert.strictEqual(references.length, 1);

  await lsp.didChange("src/app.ts", "export function AppSymbol() { return 2; }\nBROKEN\n", 2);
  await waitFor(() => {
    const list = lsp.diagnostics("src/app.ts");
    return list.length && /version 2/.test(list[0].message);
  }, 2000);
  assert.strictEqual(lsp.status().servers.typescript.status, "running");
  await lsp.restart("typescript");
  assert.strictEqual(lsp.status().servers.typescript.status, "running");
  await waitFor(() => lsp.diagnostics("src/app.ts").length, 2000);

  const notifications = [];
  const monotonic = new LspManager({
    workspace,
    profiles: { typescript: { command: "mock", args: [], extensions: [".ts"] } },
  });
  monotonic.start = async function (key) {
    const state = this.state(key);
    if (!state.connection) {
      state.connection = {
        closed: false,
        notify: async (method, params) => { notifications.push({ method, params }); },
      };
      const doc = this.documents.get("src/app.ts");
      if (doc) {
        await state.connection.notify("textDocument/didOpen", {
          textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
        });
        state.opened.add(doc.rel);
      }
    }
    return state;
  };
  await monotonic.didOpen("src/app.ts", "first", 0);
  await monotonic.didOpen("src/app.ts", "second", 0);
  await monotonic.didChange("src/app.ts", "third", 1);
  assert.deepStrictEqual(notifications.map((item) => item.method), [
    "textDocument/didOpen", "textDocument/didChange", "textDocument/didChange",
  ]);
  assert.deepStrictEqual(notifications.map((item) => item.params.textDocument.version), [1, 2, 3]);
  monotonic.state("typescript").connection.closed = true;
  await monotonic.close();

  const unavailable = new LspManager({
    workspace,
    index,
    profiles: { typescript: { command: "not-installed", args: [], extensions: [".ts"] } },
    commandResolver: async () => "",
  });
  const lexical = await unavailable.workspaceSymbols("AppSymbol", "typescript");
  assert.ok(lexical.some((item) => item.name === "AppSymbol"));
  assert.strictEqual(unavailable.status().servers.typescript.status, "unavailable");

  const memory = new MemoryStore({ workspace, dataDir, events });
  await memory.whenIdle();
  const stored = await memory.upsert({
    kind: "architecture",
    statement: "AppSymbol is the public TypeScript entry point",
    scope: { component: "app" },
    evidence: [{ path: "src/app.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 42 } } }],
    provenance: { source: "test" },
    confidence: 0.95,
    ttlSeconds: 60,
  });
  assert.match(stored.id, /^mem-/);
  assert.strictEqual(stored.status, "active");
  assert.match(stored.evidence[0].hash, /^[a-f0-9]{64}$/);
  assert.strictEqual((await memory.search("public TypeScript")).length, 1);

  fs.writeFileSync(source, "export function AppSymbol() { return 3; }\nBROKEN\n");
  await new Promise((resolve) => setTimeout(resolve, 5));
  events.publish("test", ["src/app.ts"], { wildcard: false });
  await memory.whenIdle();
  await waitFor(() => lsp.diagnostics("src/app.ts").length, 2000);
  assert.strictEqual((await memory.search("", { status: ["stale"] }))[0].id, stored.id);

  const refreshed = await memory.revalidate(stored.id, { confidence: 0.9 });
  assert.strictEqual(refreshed.status, "active");
  assert.notStrictEqual(refreshed.evidence[0].hash, stored.evidence[0].hash);

  const engine = new ContextEngine({
    workspace, index, events, lspManager: lsp, memoryStore: memory, characterBudget: 2400,
  });
  await index.whenIdle();
  const context = await engine.retrieve("AppSymbol TypeScript entry", {
    active: ["src/app.ts"], characterBudget: 2400,
  });
  assert.ok(context.text.includes("[Active structured project memory]"));
  assert.ok(context.text.includes("AppSymbol is the public TypeScript entry point"));
  assert.ok(context.text.includes("[Cached language-server context]"));
  assert.ok(context.text.includes("mock-lsp") || context.text.includes("AppSymbol"));

  const tools = createMemoryTools(memory);
  assert.strictEqual(tools.memory_search.annotations.readOnlyHint, true);
  const ai = new AiChat({ workspace, customTools: tools });
  ai.mode = "ask";
  assert.deepStrictEqual(Object.keys(ai.customToolSet()), ["memory_search"]);
  ai.mode = "agent";
  assert.deepStrictEqual(Object.keys(ai.customToolSet()).sort(), [
    "memory_forget", "memory_revalidate", "memory_search", "memory_upsert",
  ]);
  const toolSearch = await tools.memory_search.execute({ query: "AppSymbol" });
  assert.strictEqual(toolSearch.structuredContent.count, 1);

  const forgotten = await memory.forget(stored.id);
  assert.strictEqual(forgotten.status, "invalid");
  assert.strictEqual((await memory.search("AppSymbol")).length, 0);
  assert.ok(fs.existsSync(path.join(dataDir, WorkspaceIndex.workspaceHash(workspace), "memory.json")));

  const reloaded = new MemoryStore({ workspace, dataDir });
  await reloaded.whenIdle();
  assert.strictEqual((await reloaded.search("", { status: ["invalid"] }))[0].id, stored.id);

  if (ai.unsubscribeProjectContext) ai.unsubscribeProjectContext();
  engine.close();
  await memory.close();
  await reloaded.close();
  await lsp.didClose("src/app.ts");
  await lsp.close();
  await unavailable.close();
  await index.close();
  events.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("smart-agent-lsp-memory: ok");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
