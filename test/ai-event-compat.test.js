"use strict";

const assert = require("assert");
const compat = require("../public/js/ai-event-compat");
const AiChat = require("../lib/ai-chat");

function frontendCompatibility() {
  const old = compat.blocksOf({
    think: "checking",
    plan: [{ content: "work", status: "completed" }],
    tools: [{ callId: "one", name: "read", status: "completed" }],
    text: "done",
    orchestration: {
      runId: "run-old",
      status: "finished",
      workers: [{ workerId: "implementer-1", role: "implementer", phase: "implementation", status: "finished" }],
      verification: { passed: true, status: "passed", command: "npm test" },
    },
  });
  assert.deepStrictEqual(old.map((block) => block.type), [
    "think", "plan", "tool", "worker", "verification", "result", "text",
  ]);
  assert.deepStrictEqual(compat.normalizeFrame({ t: "verify", v: { status: "passed" } }), {
    type: "verification", value: { status: "passed" },
  });
  assert.deepStrictEqual(compat.normalizeFrame({ kind: "orchestration-result", val: { status: "finished" } }), {
    type: "result", value: { status: "finished" },
  });
  assert.strictEqual(compat.blocksOf({ blocks: [{ type: "text", text: "new" }], text: "legacy" })[0].text, "new");
  const legacyBlocks = compat.blocksOf({ blocks: [
    { type: "orchestration-worker", value: { role: "planner" } },
    { kind: "verify", val: { status: "passed" } },
    { type: "orchestration-result", status: "finished" },
  ] });
  assert.deepStrictEqual(legacyBlocks.map((block) => block.type), ["worker", "verification", "result"]);
  assert.strictEqual(legacyBlocks[2].value.status, "finished");

  assert.strictEqual(compat.shouldUseNarrowLayout(760, 390, 600), true);
  assert.strictEqual(compat.shouldUseNarrowLayout(580, 1440, 600), true);
  assert.strictEqual(compat.shouldUseNarrowLayout(650, 1440, 600), false);

  const lsp = compat.lspSummary({ servers: {
    ts: { status: "running" },
    py: { status: "unavailable" },
    go: { status: "failed" },
    rust: { status: "backoff" },
    html: { status: "idle" },
  } }, "en");
  assert.deepStrictEqual(lsp.counts, {
    active: 1, retrying: 1, unavailable: 1, failed: 1, starting: 0, idle: 1,
  });
  assert.strictEqual(lsp.text, "1 active \u00b7 1 retrying \u00b7 1 unavailable \u00b7 1 failed \u00b7 1 idle");

  assert.strictEqual(compat.structuredMemoryReviewCount({
    counts: { active: 2, stale: 3, invalid: 7, superseded: 4 },
  }), 3);
  assert.strictEqual(compat.structuredMemorySummary({
    counts: { active: 2, stale: 3, invalid: 7, superseded: 4 },
  }, "en"), "2 active \u00b7 3 need review");

  assert.strictEqual(compat.orchestrationLabel("role", "implementer", "id"), "Pelaksana");
  assert.strictEqual(compat.orchestrationLabel("role", "implementer", "en"), "Implementer");
  assert.strictEqual(compat.orchestrationLabel("phase", "finalization", "id"), "Finalisasi");
  assert.strictEqual(compat.orchestrationLabel("status", "verification-failed", "en"), "Verification failed");
  assert.strictEqual(compat.orchestrationLabel("status", "old_custom_status", "en"), "Old custom status");
  const progress = compat.normalizeFrame({ t: "worker", v: {
    workerId: "explorer-1", role: "explorer", phase: "exploration",
    eventKind: "progress", status: "finished", activity: "Searching the workspace",
    toolCount: 3, elapsedMs: 2400,
  } });
  assert.strictEqual(progress.value.eventKind, "progress");
  assert.strictEqual(compat.workerStatus(progress.value), "running", "progress cannot make a running worker look finished");
  assert.strictEqual(compat.workerActivity(progress.value, "id"), "Mencari di workspace");
  assert.deepStrictEqual(compat.workerMetrics(progress.value, "en"), {
    tools: 3, elapsedMs: 2400, elapsedText: "2s", toolsText: "3 tools",
  });
  const legacyEnd = compat.normalizeWorkerEvent({
    workerId: "legacy", role: "implementer", eventKind: "end",
    value: { status: "finished", touchedFiles: ["lib/old.js"] },
  });
  assert.strictEqual(compat.workerStatus(legacyEnd), "finished");
  assert.deepStrictEqual(legacyEnd.touchedFiles, ["lib/old.js"]);
}

function serverPersistence() {
  const blocks = AiChat._private.blocksFrom([
    { kind: "worker", val: { workerId: "planner-1", role: "planner", phase: "planner", eventKind: "start" } },
    { kind: "worker", val: { workerId: "planner-1", role: "planner", phase: "planner", eventKind: "progress", status: "running", activity: "Planning the work", toolCount: 0, elapsedMs: 10 } },
    { kind: "worker", val: { workerId: "planner-1", role: "planner", phase: "planner", eventKind: "progress", status: "running", activity: "Updating the work plan", toolCount: 1, elapsedMs: 20 } },
    { kind: "worker", val: { workerId: "planner-1", role: "planner", phase: "planner", eventKind: "end", status: "finished", durationMs: 30, summary: "Plan ready", touchedFiles: [] } },
    { kind: "verification", val: { runId: "run-1", attempt: 0, status: "failed", passed: false } },
    { kind: "verification", val: { runId: "run-1", attempt: 1, status: "passed", passed: true } },
    { kind: "result", val: { runId: "run-1", status: "finished" } },
  ]);
  assert.deepStrictEqual(blocks.map((block) => block.type), [
    "worker", "verification", "verification", "result",
  ]);
  assert.strictEqual(blocks[0].value.eventKind, "end");
  assert.strictEqual(blocks[0].value.toolCount, 1);
  assert.strictEqual(blocks[0].value.summary, "Plan ready");
  assert.strictEqual(blocks[2].value.attempt, 1);
  assert.strictEqual(blocks.filter((block) => block.type === "worker").length, 1,
    "history must store one compact lifecycle block per worker");
}

frontendCompatibility();
serverPersistence();
console.log("ai-event-compat: ok");
