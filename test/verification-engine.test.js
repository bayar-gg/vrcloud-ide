"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const VerificationEngine = require("../lib/verification-engine");
const WorkspaceIndex = require("../lib/workspace-index");

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function nodeCommand(source) {
  return "node -e " + JSON.stringify(source);
}

async function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-verify-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-verify-index-"));
  try {
    write(root, "package.json", JSON.stringify({
      name: "fixture",
      scripts: { test: nodeCommand("process.exit(0)") },
    }));
    write(root, "lib/math.js", "exports.add = (a, b) => a + b;\n");
    write(root, "test/math.test.js", '"use strict";\nconst assert = require("assert");\nconst { add } = require("../lib/math");\nassert.strictEqual(add(1, 2), 3);\n');
    const index = new WorkspaceIndex({ workspace: root, dataDir });
    await index.ready;
    await fn(root, index);
    await index.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function selectionAndReconciliation() {
  await withWorkspace(async (workspace, index) => {
    const selection = VerificationEngine.selectCommands({
      workspace,
      index,
      touchedFiles: ["lib/math.js"],
    });
    assert.strictEqual(selection.source, "manifest");
    assert.deepStrictEqual(selection.commands, ["npm run test"],
      "non-node:test files must use the package runner");

    write(workspace, "test/math.test.js",
      '"use strict";\nconst test = require("node:test");\nconst assert = require("assert");\n' +
      'const { add } = require("../lib/math");\ntest("add", () => assert.strictEqual(add(1, 2), 3));\n');
    await index.rescan();
    const standalone = VerificationEngine.selectCommands({
      workspace,
      index,
      touchedFiles: ["lib/math.js"],
    });
    const quotedMath = process.platform === "win32" ? '"test/math.test.js"' : "'test/math.test.js'";
    const expectedTestCommand = "node --test " + quotedMath;
    assert.deepStrictEqual(standalone.commands, [expectedTestCommand]);

    write(workspace, "package.json", JSON.stringify({
      name: "fixture",
      scripts: { test: "jest" },
    }));
    write(workspace, "test/jest.test.js", 'test("jest case", () => expect(true).toBe(true));\n');
    const framework = VerificationEngine.selectCommands({
      workspace,
      index,
      touchedFiles: ["test/jest.test.js"],
    });
    const quotedJest = process.platform === "win32" ? '"test/jest.test.js"' : "'test/jest.test.js'";
    assert.deepStrictEqual(framework.commands, ["npm run test -- --runTestsByPath " + quotedJest]);

    const engine = new VerificationEngine({ workspace, index, timeoutMs: 3000 });
    await engine.prepare({ runId: "selection" });
    write(workspace, "lib/math.js", "exports.add = (a, b) => Number(a) + Number(b);\n");
    write(workspace, "lib/new-file.js", "module.exports = true;\n");
    const result = await engine.verify({ runId: "selection", touchedFiles: [], attempt: 0 });
    assert.strictEqual(result.status, "passed", JSON.stringify(result, null, 2));
    assert.ok(result.touchedFiles.includes("lib/math.js"));
    assert.ok(result.touchedFiles.includes("lib/new-file.js"));
    assert.strictEqual(result.command, expectedTestCommand);
    engine.complete({ runId: "selection" });
  });
}

async function overridePassAndFail() {
  await withWorkspace(async (workspace, index) => {
    const engine = new VerificationEngine({ workspace, index, timeoutMs: 3000 });
    await engine.prepare({ runId: "override-pass" });
    const passCommand = nodeCommand("process.stdout.write('verified'); process.exit(0)");
    const passed = await engine.verify({
      runId: "override-pass", touchedFiles: ["lib/math.js"], verifyCmd: passCommand,
    });
    assert.strictEqual(passed.selection, "override");
    assert.strictEqual(passed.command, passCommand);
    assert.strictEqual(passed.exitCode, 0);
    assert.strictEqual(passed.stdout, "verified");
    assert.strictEqual(passed.status, "passed");

    await engine.prepare({ runId: "override-fail" });
    const failed = await engine.verify({
      runId: "override-fail",
      touchedFiles: ["lib/math.js"],
      verifyCmd: nodeCommand("process.stderr.write('broken'); process.exit(7)"),
    });
    assert.strictEqual(failed.passed, false);
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.exitCode, 7);
    assert.strictEqual(failed.stderr, "broken");
    assert.ok(failed.issues[0].includes("broken"));
  });
}

async function skippedTimeoutCancelAndBounds() {
  await withWorkspace(async (workspace, index) => {
    const engine = new VerificationEngine({ workspace, index, timeoutMs: 120, maxOutput: 1024 });
    await engine.prepare({ runId: "skip" });
    const skipped = await engine.verify({ runId: "skip", touchedFiles: ["README.md"] });
    assert.strictEqual(skipped.passed, true);
    assert.strictEqual(skipped.status, "skipped");

    await engine.prepare({ runId: "timeout" });
    const timeout = await engine.verify({
      runId: "timeout", touchedFiles: ["lib/math.js"],
      verifyCmd: nodeCommand("setTimeout(() => {}, 5000)"),
    });
    assert.strictEqual(timeout.passed, false);
    assert.strictEqual(timeout.status, "timeout");
    assert.strictEqual(timeout.commands[0].timedOut, true);

    await engine.prepare({ runId: "cancel" });
    const controller = new AbortController();
    const pending = engine.verify({
      runId: "cancel", touchedFiles: ["lib/math.js"], signal: controller.signal,
      verifyCmd: nodeCommand("setTimeout(() => {}, 5000)"),
    });
    setTimeout(() => controller.abort(), 50);
    const cancelled = await pending;
    assert.strictEqual(cancelled.passed, false);
    assert.strictEqual(cancelled.status, "cancelled");
    assert.strictEqual(cancelled.commands[0].cancelled, true);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const preCancelled = await VerificationEngine.runCommand(nodeCommand("process.exit(0)"), {
      workspace, signal: alreadyAborted.signal, timeoutMs: 3000,
    });
    assert.strictEqual(preCancelled.status, "cancelled");
    assert.strictEqual(preCancelled.cancelled, true);

    const fakeChild = new EventEmitter();
    fakeChild.stdout = new PassThrough();
    fakeChild.stderr = new PassThrough();
    fakeChild.exitCode = null;
    let terminationRequested = false;
    let closeSynchronized = false;
    const closeController = new AbortController();
    const closePending = VerificationEngine.runCommand("fake command", {
      workspace,
      signal: closeController.signal,
      timeoutMs: 3000,
      spawn: () => fakeChild,
      terminate: () => {
        terminationRequested = true;
        return () => {};
      },
    }).then((result) => {
      closeSynchronized = true;
      return result;
    });
    closeController.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(terminationRequested, true);
    assert.strictEqual(closeSynchronized, false, "abort must wait for the child close event");
    fakeChild.emit("close", null);
    const closeResult = await closePending;
    assert.strictEqual(closeResult.status, "cancelled");

    const bounded = await VerificationEngine.runCommand(nodeCommand("process.stdout.write('x'.repeat(10000))"), {
      workspace, maxOutput: 1024, timeoutMs: 3000,
    });
    assert.strictEqual(bounded.passed, true);
    assert.ok(bounded.stdout.length < 1100);
    assert.ok(bounded.stdout.includes("truncated"));
  });
}

(async () => {
  await selectionAndReconciliation();
  await overridePassAndFail();
  await skippedTimeoutCancelAndBounds();
  console.log("verification-engine: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
