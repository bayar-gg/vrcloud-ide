"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WorkspaceEvents = require("../lib/workspace-events");
const WorkspaceIndex = require("../lib/workspace-index");
const ContextEngine = require("../lib/context-engine");
const AiChat = require("../lib/ai-chat");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-context-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data", "context");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "active.js"),
    "const sharedNeedle = require('./open');\nfunction activeSymbol() { return sharedNeedle; }\nmodule.exports = activeSymbol;\n");
  fs.writeFileSync(path.join(workspace, "src", "open.js"),
    "function openSymbol() { return 'sharedNeedle'; }\nmodule.exports = openSymbol;\n");
  fs.writeFileSync(path.join(workspace, "src", "explicit.js"),
    "export function explicitSymbol() { return 'sharedNeedle'; }\n");
  fs.writeFileSync(path.join(workspace, "test", "active.test.js"),
    "const test = require('node:test');\ntest('active', () => {});\n");
  fs.writeFileSync(path.join(workspace, "docs", "notes.weird"),
    "unsupportedLanguageToken lives here\nsecond line\n");

  const events = new WorkspaceEvents({ workspace, dedupeMs: 50 });
  const seen = [];
  events.onChange((event) => seen.push(event));
  const first = events.publish("editor", ["src\\active.js", "src/active.js"], { wildcard: false });
  const duplicate = events.publish("disk", ["src/active.js"], { wildcard: false });
  const wildcard = events.publish("shell", [], {});
  assert.ok(first);
  assert.strictEqual(duplicate, null);
  assert.deepStrictEqual(first.changes, ["src/active.js"]);
  assert.strictEqual(first.seq, 1);
  assert.strictEqual(typeof first.at, "number");
  assert.strictEqual(first.source, "editor");
  assert.strictEqual(first.wildcard, false);
  assert.strictEqual(wildcard.wildcard, true);
  assert.strictEqual(seen.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.strictEqual(seen.length, 3, "a deduped edit must receive a trailing flush");
  assert.strictEqual(seen[2].source, "disk");
  assert.deepStrictEqual(seen[2].changes, ["src/active.js"]);

  const index = new WorkspaceIndex({ workspace, dataDir, events });
  await index.whenIdle();
  const manifest = index.manifest();
  const active = manifest.files["src/active.js"];
  assert.ok(active);
  assert.strictEqual(active.language, "javascript");
  assert.match(active.hash, /^[a-f0-9]{64}$/);
  assert.strictEqual(typeof active.mtime, "number");
  assert.strictEqual(typeof active.size, "number");
  assert.ok(active.symbols.includes("activeSymbol"));
  assert.ok(active.imports.includes("./open"));
  assert.ok(manifest.files["test/active.test.js"].testHints.length > 0);
  assert.strictEqual(manifest.files["docs/notes.weird"].language, "plaintext");
  assert.ok(fs.existsSync(path.join(dataDir, WorkspaceIndex.workspaceHash(workspace), "index.json")));

  await new Promise((resolve) => setTimeout(resolve, 60));
  fs.writeFileSync(path.join(workspace, "src", "active.js"),
    "const rapidFirst = true;\nfunction activeSymbol() { return rapidFirst; }\n");
  events.publish("editor", ["src/active.js"], { wildcard: false });
  fs.writeFileSync(path.join(workspace, "src", "active.js"),
    "const rapidFinal = true;\nfunction activeSymbol() { return rapidFinal; }\n");
  events.publish("editor", ["src/active.js"], { wildcard: false });
  await new Promise((resolve) => setTimeout(resolve, 70));
  await index.whenIdle();
  assert.ok(index.manifest().files["src/active.js"].terms.rapidfinal,
    "the trailing event must index the final rapid edit");

  const engine = new ContextEngine({ workspace, index, events, characterBudget: 1400 });
  const ranked = await engine.retrieve("sharedNeedle in src/explicit.js", {
    active: ["src/active.js"],
    open: ["src/open.js"],
    characterBudget: 1400,
  });
  assert.deepStrictEqual(ranked.files.slice(0, 3).map((file) => file.path), [
    "src/active.js", "src/open.js", "src/explicit.js",
  ]);
  assert.ok(ranked.characterCount <= 1400);

  const fallback = await engine.retrieve("unsupportedLanguageToken", { characterBudget: 500 });
  assert.strictEqual(fallback.files[0].path, "docs/notes.weird");
  assert.ok(fallback.text.includes("unsupportedLanguageToken"));

  const readOnly = await engine.retrieve("activeSymbol", {
    active: ["src/active.js"],
    readOnly: true,
    characterBudget: 600,
  });
  assert.ok(readOnly.text.startsWith("[Read-only workspace context"));
  assert.ok(readOnly.characterCount <= 600);
  const cached = await engine.retrieve("activeSymbol", {
    active: ["src/active.js"],
    readOnly: true,
    characterBudget: 600,
  });
  assert.strictEqual(cached, readOnly);

  let releaseMemory;
  let memorySettled = false;
  const delayedMemory = {
    revision: 0,
    ready: new Promise((resolve) => { releaseMemory = resolve; }),
    cachedSearch: () => [{
      id: "ready-memory", kind: "fact", statement: "memory loaded before context caching", evidence: [],
    }],
  };
  const memoryEngine = new ContextEngine({
    workspace, index, memoryStore: delayedMemory, characterBudget: 800,
  });
  const memoryPending = memoryEngine.retrieve("memory loaded", { characterBudget: 800 })
    .then((result) => { memorySettled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(memorySettled, false, "context retrieval must await memory readiness");
  delayedMemory.revision = 1;
  releaseMemory();
  const memoryContext = await memoryPending;
  assert.ok(memoryContext.text.includes("memory loaded before context caching"));

  const ai = new AiChat({
    workspace,
    contextEngine: engine,
    workspaceEvents: events,
    openFiles: () => ({ active: "src/active.js", open: ["src/active.js"] }),
  });
  ai.mode = "ask";
  const askPrompt = await ai.agentPrompt("Where is activeSymbol defined?", "");
  assert.ok(askPrompt.includes("ASK MODE (read-only)"));
  assert.ok(askPrompt.includes("[Read-only workspace context"));
  assert.ok(askPrompt.includes("src/active.js"));

  await new Promise((resolve) => setTimeout(resolve, 60));
  fs.writeFileSync(path.join(workspace, "src", "active.js"),
    "const changedToken = true;\nfunction activeSymbol() { return changedToken; }\n");
  events.publish("editor", ["src/active.js"], { wildcard: false });
  await index.whenIdle();
  const updated = index.manifest().files["src/active.js"];
  assert.notStrictEqual(updated.hash, active.hash);
  assert.ok(updated.terms.changedtoken);
  const refreshed = await engine.retrieve("changedToken", {
    active: ["src/active.js"],
    readOnly: true,
    characterBudget: 600,
  });
  assert.notStrictEqual(refreshed, cached);
  assert.ok(refreshed.text.includes("changedToken"));

  fs.unlinkSync(path.join(workspace, "src", "open.js"));
  events.publish("delete", ["src/open.js"], { wildcard: false });
  await index.whenIdle();
  assert.strictEqual(index.manifest().files["src/open.js"], undefined);

  const reloaded = new WorkspaceIndex({ workspace, dataDir });
  await reloaded.whenIdle();
  assert.ok(reloaded.manifest().files["src/active.js"]);
  assert.strictEqual(reloaded.manifest().files["src/open.js"], undefined);

  await reloaded.close();
  if (ai.unsubscribeProjectContext) ai.unsubscribeProjectContext();
  memoryEngine.close();
  engine.close();
  await index.close();
  events.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("smart-agent-context: ok");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
