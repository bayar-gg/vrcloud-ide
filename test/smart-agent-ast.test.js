"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createStructuralTools = require("../lib/structural-tools");
const AiChat = require("../lib/ai-chat");

async function rejected(promise, pattern) {
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  assert.ok(error, "expected operation to reject");
  assert.match(String(error.message || error), pattern);
}

function write(workspace, name, content) {
  const file = path.join(workspace, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function one(tools, args) {
  const result = await tools.ast_search.execute(args);
  assert.strictEqual(result.structuredContent.count, 1,
    String(args.path || ".") + ": " + JSON.stringify(result.structuredContent, null, 2));
  return result.structuredContent.matches[0];
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-ast-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  write(workspace, "src/view.jsx",
    "import React from \"react\";\n" +
    "export function View() { return <button onClick={() => renderWidget()}>ok</button>; }\n");
  write(workspace, "src/panel.tsx",
    "import type { ReactNode } from \"react\";\n" +
    "export interface PanelProps { child: ReactNode }\n" +
    "declare function decorate(child: ReactNode): ReactNode;\n" +
    "export function Panel(props: PanelProps) { return <section>{decorate(props.child)}</section>; }\n");
  write(workspace, "src/service.py",
    "from pathlib import Path\n\n" +
    "def load_service():\n" +
    "    return Path(\"data\")\n");
  write(workspace, "src/main.go",
    "package main\n\nimport \"fmt\"\n\nfunc RunServer() {\n\tfmt.Println(\"up\")\n}\n");
  write(workspace, "src/lib.rs",
    "use std::fmt;\n\npub fn run_worker() {\n    fmt::format(format_args!(\"up\"));\n}\n");

  const tools = createStructuralTools({ workspace });

  const outside = path.join(root, "outside");
  write(outside, "escaped.js", "function escaped() { return 1; }\n");
  const escapeLink = path.join(workspace, "escape-link");
  fs.symlinkSync(outside, escapeLink, process.platform === "win32" ? "junction" : "dir");
  await rejected(tools.ast_search.execute({
    kind: "declaration", name: "escaped", path: "escape-link/escaped.js",
  }), /symlink|junction/i);
  await rejected(tools.ast_edit.execute({
    path: "escape-link/escaped.js",
    match_id: "ast-" + "0".repeat(24),
    file_hash: "0".repeat(64),
    operation: "replace",
    text: "function escaped() { return 2; }",
  }), /symlink|junction/i);
  assert.match(fs.readFileSync(path.join(outside, "escaped.js"), "utf8"), /return 1/);

  const declarations = [
    ["src/view.jsx", "View", "javascript"],
    ["src/panel.tsx", "Panel", "tsx"],
    ["src/service.py", "load_service", "python"],
    ["src/main.go", "RunServer", "go"],
    ["src/lib.rs", "run_worker", "rust"],
  ];
  for (const [file, name, language] of declarations) {
    const match = await one(tools, { kind: "declaration", name, path: file });
    assert.strictEqual(match.language, language);
    assert.match(match.id, /^ast-[a-f0-9]{24}$/);
    assert.match(match.file_hash, /^[a-f0-9]{64}$/);
    assert.ok(match.end_byte > match.start_byte);
  }

  const callCases = [
    ["src/view.jsx", "renderWidget"],
    ["src/panel.tsx", "decorate"],
    ["src/service.py", "Path"],
    ["src/main.go", "Println"],
    ["src/lib.rs", "format"],
  ];
  for (const [file, name] of callCases) {
    const result = await tools.ast_search.execute({ kind: "call", name, path: file });
    assert.strictEqual(result.structuredContent.count, 1, file);
  }

  for (const [file, name] of [
    ["src/view.jsx", "react"],
    ["src/panel.tsx", "react"],
    ["src/service.py", "pathlib"],
    ["src/main.go", "fmt"],
    ["src/lib.rs", "std::fmt"],
  ]) {
    const match = await one(tools, { kind: "import", name, path: file });
    assert.strictEqual(match.kind, "import");
  }
  const bounded = await tools.ast_search.execute({ kind: "declaration", path: "src", limit: 1 });
  assert.strictEqual(bounded.structuredContent.count, 1);
  assert.strictEqual(bounded.structuredContent.truncated, true);

  const stableA = await one(tools, { kind: "declaration", name: "View", path: "src/view.jsx" });
  const stableB = await one(tools, { kind: "declaration", name: "View", path: "src/view.jsx" });
  assert.strictEqual(stableA.id, stableB.id);
  assert.strictEqual(stableA.file_hash, stableB.file_hash);

  const staleMatch = await one(tools, { kind: "declaration", name: "load_service", path: "src/service.py" });
  fs.appendFileSync(path.join(workspace, "src/service.py"), "\n# changed\n");
  await rejected(tools.ast_edit.execute({
    path: staleMatch.path,
    match_id: staleMatch.id,
    file_hash: staleMatch.file_hash,
    operation: "replace",
    text: "def load_service():\n    return None",
  }), /Stale structural match/);

  write(workspace, "src/ambiguous.js", "ping();\nping();\n");
  const duplicateSearch = await tools.ast_search.execute({ kind: "call", name: "ping", path: "src/ambiguous.js" });
  assert.strictEqual(duplicateSearch.structuredContent.count, 2);
  const firstCall = duplicateSearch.structuredContent.matches[0];
  assert.strictEqual(firstCall.id, duplicateSearch.structuredContent.matches[1].id);
  await rejected(tools.ast_edit.execute({
    path: firstCall.path,
    match_id: firstCall.id,
    file_hash: firstCall.file_hash,
    operation: "insert-before",
    text: "/* selected */ ",
  }), /Ambiguous structural match/);
  const inserted = await tools.ast_edit.execute({
    path: firstCall.path,
    match_id: firstCall.id,
    file_hash: firstCall.file_hash,
    start_byte: firstCall.start_byte,
    operation: "insert-before",
    text: "/* selected */ ",
  });
  assert.ok(fs.readFileSync(path.join(workspace, "src/ambiguous.js"), "utf8").startsWith("/* selected */ ping();"));
  assert.strictEqual(inserted.structuredContent.linesRemoved, 0);

  const afterInsert = await tools.ast_search.execute({ kind: "call", name: "ping", path: "src/ambiguous.js" });
  const secondCall = afterInsert.structuredContent.matches[1];
  await tools.ast_edit.execute({
    path: secondCall.path,
    match_id: secondCall.id,
    file_hash: secondCall.file_hash,
    start_byte: secondCall.start_byte,
    operation: "insert-after",
    text: " /* trailing */",
  });
  assert.match(fs.readFileSync(path.join(workspace, "src/ambiguous.js"), "utf8"), /ping\(\) \/\* trailing \*\/;/);

  write(workspace, "src/reject.js", "function valid() {\n  return 1;\n}\n");
  const valid = await one(tools, { kind: "declaration", name: "valid", path: "src/reject.js" });
  await rejected(tools.ast_edit.execute({
    path: valid.path,
    match_id: valid.id,
    file_hash: valid.file_hash,
    operation: "replace",
    text: "function valid(",
  }), /syntax errors would increase/);
  assert.match(fs.readFileSync(path.join(workspace, "src/reject.js"), "utf8"), /return 1/);

  const unicodePath = path.join(workspace, "src/unicode.js");
  const unicodeBefore = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("const banner = \"🙂\";\r\nfunction café() {\r\n  return say(\"hé\");\r\n}\r\n", "utf8"),
  ]);
  fs.writeFileSync(unicodePath, unicodeBefore);
  const unicodeCall = await one(tools, { kind: "call", name: "say", path: "src/unicode.js" });
  const unicodeEdit = await tools.ast_edit.execute({
    path: unicodeCall.path,
    match_id: unicodeCall.id,
    file_hash: unicodeCall.file_hash,
    operation: "replace",
    text: "say(\"雪\")",
  });
  const unicodeAfter = fs.readFileSync(unicodePath);
  assert.deepStrictEqual(Array.from(unicodeAfter.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
  const unicodeText = unicodeAfter.subarray(3).toString("utf8");
  assert.ok(unicodeText.includes("🙂"));
  assert.ok(unicodeText.includes("café"));
  assert.ok(unicodeText.includes("say(\"雪\")"));
  assert.ok(!/(^|[^\r])\n/.test(unicodeText), "CRLF file gained a bare LF");
  assert.match(unicodeEdit.structuredContent.after_hash, /^[a-f0-9]{64}$/);

  const ask = new AiChat({ workspace, customTools: tools });
  ask.mode = "ask";
  assert.deepStrictEqual(Object.keys(ask.customToolSet()), ["ast_search"]);
  ask.mode = "agent";
  assert.deepStrictEqual(Object.keys(ask.customToolSet()).sort(), ["ast_edit", "ast_search"]);

  const changed = [];
  const tracked = new AiChat({ workspace, onFsChange: (paths) => changed.push(paths) });
  const state = { live: { touched: [] }, todos: null };
  const frames = [];
  tracked.emitFromEvent({
    type: "tool_call",
    name: "mcp",
    call_id: "ast-1",
    args: { toolName: "ast_edit", args: { path: "src/unicode.js" } },
    status: "completed",
    result: {
      status: "success",
      value: {
        structuredContent: {
          path: "src/unicode.js",
          linesAdded: 1,
          linesRemoved: 1,
          diffString: "--- src/unicode.js\n+++ src/unicode.js",
        },
      },
    },
  }, (kind, value) => frames.push({ kind, value }), state);
  assert.deepStrictEqual(state.live.touched, ["src/unicode.js"]);
  assert.deepStrictEqual(changed, [["src/unicode.js"]]);
  assert.strictEqual(frames[0].value.meta.structural, true);
  assert.strictEqual(frames[0].value.meta.added, 1);
  assert.match(frames[0].value.detail, /unicode\.js/);

  const leftovers = fs.readdirSync(path.dirname(unicodePath)).filter((name) => /\.ast-.*\.tmp$/.test(name));
  assert.deepStrictEqual(leftovers, []);

  fs.rmSync(root, { recursive: true, force: true });
  console.log("smart-agent-ast: ok");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
