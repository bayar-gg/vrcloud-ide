"use strict";

const assert = require("assert");
const AgentOrchestrator = require("../lib/agent-orchestrator");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plannerText() {
  return JSON.stringify({
    summary: "test plan",
    explorers: [
      { id: "explorer-a", objective: "inspect implementation" },
      { id: "explorer-b", objective: "inspect tests" },
    ],
    todos: [
      { id: "inspect", content: "Inspect", owner: "explorers", dependencies: [] },
      { id: "change", content: "Change", owner: "implementer", dependencies: ["inspect"] },
    ],
  });
}

class MockRun {
  constructor(spec, tracker, text) {
    this.spec = spec;
    this.tracker = tracker;
    this.text = text;
    this.cancelled = false;
    this.done = false;
    this.releaseWait = null;
  }
  supports(name) { return name === "cancel"; }
  async cancel() {
    this.cancelled = true;
    if (this.releaseWait) this.releaseWait();
  }
  async *stream() {
    const role = this.spec.role;
    const delay = role === "explorer" ? this.tracker.explorerDelay
      : (this.spec.mutating ? this.tracker.writerDelay : 2);
    this.tracker.events.push(role + ":start");
    if (role === "explorer") {
      this.tracker.explorers++;
      this.tracker.maxExplorers = Math.max(this.tracker.maxExplorers, this.tracker.explorers);
    }
    if (this.spec.mutating) {
      this.tracker.writers++;
      this.tracker.maxWriters = Math.max(this.tracker.maxWriters, this.tracker.writers);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      this.releaseWait = () => { clearTimeout(timer); resolve(); };
    });
    if (!this.cancelled && role === "implementer") {
      yield { type: "tool_call", call_id: "edit-one", name: "edit", status: "running", args: { path: "lib/example.js" } };
      yield { type: "tool_call", call_id: "edit-one", name: "edit", status: "completed", args: { path: "lib/example.js" } };
    }
    if (!this.cancelled) {
      if (this.tracker.tokenBursts) {
        for (let i = 0; i < this.text.length; i++) yield { type: "assistant", text: this.text[i] };
      } else {
        yield { type: "assistant", text: this.text };
      }
    }
    if (role === "explorer") this.tracker.explorers--;
    if (this.spec.mutating) this.tracker.writers--;
    this.done = true;
    this.tracker.events.push(role + ":" + (this.cancelled ? "cancelled" : "end"));
  }
  async wait() {
    return { status: this.cancelled ? "cancelled" : "finished" };
  }
}

function mockHarness(options) {
  options = options || {};
  const tracker = {
    events: [],
    specs: [],
    explorers: 0,
    maxExplorers: 0,
    writers: 0,
    maxWriters: 0,
    explorerDelay: options.explorerDelay == null ? 25 : options.explorerDelay,
    writerDelay: options.writerDelay == null ? 15 : options.writerDelay,
    tokenBursts: !!options.tokenBursts,
  };
  const createAgent = async (spec) => {
    tracker.specs.push(spec);
    return {
      send: async () => {
        let text = spec.role + " output";
        if (spec.role === "planner") text = plannerText();
        if (spec.role === "implementer") text = "Updated `lib/example.js` with concrete lifecycle handling and compatibility behavior.";
        if (spec.role === "finalizer") text = "Canonical final answer";
        return new MockRun(spec, tracker, text);
      },
      close: async () => {},
    };
  };
  return { tracker, createAgent };
}

async function orderingParallelismAndMetadata() {
  const harness = mockHarness();
  const emitted = [];
  let verifiedAt = -1;
  const orchestrator = new AgentOrchestrator({
    createAgent: harness.createAgent,
    disposeAgent: (agent) => agent.close(),
    verifier: async () => {
      verifiedAt = harness.tracker.events.length;
      harness.tracker.events.push("verifier");
      return { passed: true, status: "passed", issues: [] };
    },
  });
  const result = await orchestrator.run({
    sessionId: "ordering",
    request: "Implement a substantial refactor across provider modules with compatibility tests and verification.",
    fullPrompt: "full request",
    emit: (kind, value) => emitted.push({ kind, value }),
  });
  const events = harness.tracker.events;
  assert.ok(events.indexOf("planner:end") < events.indexOf("explorer:start"));
  assert.ok(events.lastIndexOf("explorer:end") < events.indexOf("implementer:start"));
  assert.ok(events.indexOf("implementer:end") < verifiedAt);
  assert.ok(events.indexOf("verifier") < events.indexOf("finalizer:start"));
  assert.strictEqual(harness.tracker.maxExplorers, 2, "explorers should overlap");
  assert.strictEqual(harness.tracker.maxWriters, 1, "one writer per workspace");
  assert.ok(result.text.includes("concrete lifecycle handling"), "generic finalizer output must not replace the implementation report");
  assert.ok(result.text.includes("Changed files"));
  assert.ok(result.text.includes("Verification"));
  assert.strictEqual(result.status, "finished");
  assert.ok(result.todos.every((todo) => todo.id && todo.owner && Array.isArray(todo.dependencies)));
  const workerEvents = emitted.filter((event) => event.kind === "worker");
  assert.ok(workerEvents.length > 0);
  workerEvents.forEach((event) => {
    ["runId", "workerId", "role", "phase", "attempt", "sequence"].forEach((key) => {
      assert.ok(Object.prototype.hasOwnProperty.call(event.value, key), "missing worker metadata " + key);
    });
    assert.ok(["start", "progress", "end"].includes(event.value.eventKind), "worker envelopes must contain lifecycle events only");
    if (event.value.eventKind !== "end") assert.strictEqual(event.value.status, "running", "a worker cannot finish before its end event");
  });
  const lifecycleRoles = ["planner", "explorer", "implementer", "verifier", "finalizer"];
  lifecycleRoles.forEach((role) => {
    const roleEvents = workerEvents.filter((event) => event.value.role === role);
    assert.ok(roleEvents.some((event) => event.value.eventKind === "start"), role + " start must be visible");
    assert.ok(roleEvents.some((event) => event.value.eventKind === "progress"), role + " progress must be visible");
    assert.ok(roleEvents.some((event) => event.value.eventKind === "end"), role + " end must be visible");
  });
  const lifecycleIndex = (role, eventKind, last) => {
    const indexes = [];
    workerEvents.forEach((event, index) => {
      if (event.value.role === role && event.value.eventKind === eventKind) indexes.push(index);
    });
    return last ? indexes[indexes.length - 1] : indexes[0];
  };
  assert.ok(lifecycleIndex("planner", "end") < lifecycleIndex("explorer", "start"),
    "planner lifecycle must finish before explorer progress begins");
  assert.ok(lifecycleIndex("explorer", "end", true) < lifecycleIndex("implementer", "start"),
    "all explorer lifecycles must finish before implementation");
  assert.ok(lifecycleIndex("implementer", "end") < lifecycleIndex("verifier", "start"),
    "verification must follow implementation");
  assert.ok(lifecycleIndex("verifier", "end") < lifecycleIndex("finalizer", "start"),
    "finalization must follow verification");
  const byWorker = {};
  workerEvents.forEach((event) => {
    const list = byWorker[event.value.workerId] || (byWorker[event.value.workerId] = []);
    list.push(event.value);
  });
  Object.keys(byWorker).forEach((id) => {
    const list = byWorker[id];
    assert.strictEqual(list[0].eventKind, "start", id + " must begin with start");
    assert.strictEqual(list[list.length - 1].eventKind, "end", id + " must finish with end");
    const end = list[list.length - 1];
    assert.strictEqual(typeof end.durationMs, "number");
    assert.strictEqual(typeof end.toolCount, "number");
    assert.ok(Array.isArray(end.touchedFiles));
    assert.strictEqual(typeof end.summary, "string");
  });
  const implementerEnd = workerEvents.find((event) => event.value.role === "implementer" && event.value.eventKind === "end");
  assert.strictEqual(implementerEnd.value.toolCount, 1, "tool calls must be counted once across running/completed updates");
  assert.ok(emitted.some((event) => event.kind === "tool" && event.value.call_id === "edit-one"),
    "implementer tool events must continue flowing");
  assert.ok(emitted.some((event) => event.kind === "plan"), "missing orchestration plan events");
  assert.ok(emitted.some((event) => event.kind === "verification"), "missing verification event");
  assert.ok(emitted.some((event) => event.kind === "result"), "missing canonical result event");
  const sequenced = emitted.filter((event) => event.value && typeof event.value.sequence === "number")
    .map((event) => event.value.sequence);
  assert.deepStrictEqual(sequenced, sequenced.slice().sort((a, b) => a - b),
    "orchestration event sequence must be monotonic");
  const explorers = harness.tracker.specs.filter((spec) => spec.role === "explorer");
  explorers.forEach((spec) => {
    assert.strictEqual(spec.restrictions.readOnly, true);
    assert.strictEqual(spec.restrictions.noShell, true);
    assert.strictEqual(spec.restrictions.noBrowser, true);
    assert.strictEqual(spec.restrictions.noDesktop, true);
    assert.strictEqual(spec.restrictions.noMemoryMutation, true);
    assert.strictEqual(spec.restrictions.noAstEdit, true);
  });
}

async function writerMutexAcrossRuns() {
  const harness = mockHarness({ explorerDelay: 2, writerDelay: 35 });
  const leaseEvents = [];
  const orchestrator = new AgentOrchestrator({
    createAgent: async (spec) => {
      if (spec.mutating) leaseEvents.push("write:" + spec.sessionId);
      return harness.createAgent(spec);
    },
    disposeAgent: (agent) => agent.close(),
    verifier: {
      prepare: async (context) => {
        leaseEvents.push("prepare:" + context.sessionId);
      },
      verify: async (context) => {
        leaseEvents.push("verify:start:" + context.sessionId);
        await sleep(30);
        leaseEvents.push("verify:end:" + context.sessionId);
        return { passed: true, status: "passed", issues: [] };
      },
    },
  });
  await Promise.all([
    orchestrator.run({ sessionId: "writer-1", request: "Implement a large server refactor with tests and compatibility.", fullPrompt: "one" }),
    orchestrator.run({ sessionId: "writer-2", request: "Implement another large server refactor with tests and compatibility.", fullPrompt: "two" }),
  ]);
  assert.strictEqual(harness.tracker.maxWriters, 1, "mutating workers from concurrent sessions must serialize");
  const firstWrite = leaseEvents.find((event) => event.startsWith("write:"));
  const firstSession = firstWrite.split(":")[1];
  const secondSession = firstSession === "writer-1" ? "writer-2" : "writer-1";
  assert.ok(leaseEvents.indexOf("prepare:" + firstSession) < leaseEvents.indexOf("write:" + firstSession));
  assert.ok(leaseEvents.indexOf("verify:end:" + firstSession) < leaseEvents.indexOf("write:" + secondSession),
    "one run must retain the workspace lease through verification");
  assert.ok(leaseEvents.indexOf("verify:end:" + firstSession) < leaseEvents.indexOf("prepare:" + secondSession),
    "the next verification baseline must be prepared only after the prior writer lease ends");
}

async function cancellationFansOut() {
  const harness = mockHarness({ explorerDelay: 1000 });
  const orchestrator = new AgentOrchestrator({
    createAgent: harness.createAgent,
    disposeAgent: (agent) => agent.close(),
  });
  const pending = orchestrator.run({
    sessionId: "cancel-me",
    request: "Implement a broad architecture refactor across many files with tests and verification.",
    fullPrompt: "cancel test",
  });
  for (let i = 0; i < 100 && harness.tracker.maxExplorers < 2; i++) await sleep(5);
  assert.strictEqual(harness.tracker.maxExplorers, 2);
  assert.strictEqual(await orchestrator.cancelSession("cancel-me"), true);
  const result = await pending;
  assert.strictEqual(result.status, "cancelled");
  assert.ok(harness.tracker.events.filter((event) => event === "explorer:cancelled").length >= 2);
}

async function boundedRepairHook() {
  const harness = mockHarness({ explorerDelay: 2, writerDelay: 2 });
  const attempts = [];
  const orchestrator = new AgentOrchestrator({
    createAgent: harness.createAgent,
    disposeAgent: (agent) => agent.close(),
    config: { mode: "on", explorerCount: 2, maxRepairAttempts: 2 },
    verifier: async (context) => {
      attempts.push(context.attempt);
      return context.attempt === 0
        ? { passed: false, status: "failed", issues: ["mock failure"] }
        : { passed: true, status: "passed", issues: [], touchedFiles: ["generated/by-shell.js"] };
    },
  });
  const result = await orchestrator.run({
    sessionId: "repair",
    request: "Implement a broad provider refactor with tests and verifier integration.",
    fullPrompt: "repair test",
  });
  assert.deepStrictEqual(attempts, [0, 1]);
  assert.strictEqual(harness.tracker.specs.filter((spec) => spec.role === "repairer").length, 1);
  assert.strictEqual(result.verification.passed, true);
  assert.ok(result.touchedFiles.includes("generated/by-shell.js"), "verifier reconciliation must feed final review files");
}

async function abortableMutexWaiter() {
  const mutex = new AgentOrchestrator.Mutex();
  const release = await mutex.acquire();
  const controller = new AbortController();
  const waiting = mutex.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error && error.name === "AbortError");
  release();
  const nextRelease = await mutex.acquire();
  nextRelease();
}

async function failedProviderStatusRejects() {
  for (const status of ["failed", "error"]) {
    const orchestrator = new AgentOrchestrator({
      createAgent: async () => ({
        send: async () => ({
          stream: async function* () {},
          wait: async () => ({ status, message: "provider terminal failure" }),
        }),
        close: async () => {},
      }),
    });
    await assert.rejects(orchestrator.run({
      sessionId: "provider-" + status,
      request: "Implement a broad provider refactor across modules with tests and verification.",
      fullPrompt: "failure test",
    }), new RegExp("Provider worker ended with status " + status));
  }
}

async function progressIsThrottled() {
  const harness = mockHarness({ explorerDelay: 1, writerDelay: 1, tokenBursts: true });
  const emitted = [];
  const orchestrator = new AgentOrchestrator({
    createAgent: harness.createAgent,
    disposeAgent: (agent) => agent.close(),
    progressThrottleMs: 100000,
    verifier: async () => ({ passed: true, status: "passed", issues: [] }),
  });
  await orchestrator.run({
    sessionId: "throttle",
    request: "Implement a broad provider refactor across modules with tests and compatibility.",
    fullPrompt: "throttle test",
    emit: (kind, value) => emitted.push({ kind, value }),
  });
  const workers = emitted.filter((event) => event.kind === "worker");
  const plannerProgress = workers.filter((event) => event.value.role === "planner" && event.value.eventKind === "progress");
  assert.ok(plannerProgress.length >= 1);
  assert.ok(plannerProgress.length <= 2, "per-token output must collapse into throttled progress");
  assert.ok(plannerProgress.every((event) => !Object.prototype.hasOwnProperty.call(event.value, "text") &&
    !Object.prototype.hasOwnProperty.call(event.value, "think")),
  "progress must never expose raw model output or reasoning");
}

function fallbackPolicy() {
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({ mode: "ask", text: "Implement everything", config: "on" }), false);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({ mode: "plan", text: "Implement everything", config: "on" }), false);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({ mode: "agent", text: "What does this function do?", config: "auto" }), false);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({ mode: "agent", text: "Fix typo", config: "auto" }), false);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({
    mode: "agent",
    text: "Implement a provider architecture refactor across several modules, preserve backward compatibility, add parallel workers, and add hermetic tests.",
    config: "auto",
  }), true);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({
    mode: "agent",
    text: "Implement a provider architecture refactor across several modules with tests.",
    hasImages: true,
    config: "on",
  }), false);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({
    mode: "agent",
    text: "Tambahkan dukungan autentikasi di beberapa modul backend dan frontend, pertahankan kompatibilitas lama, lalu buat tes integrasi untuk seluruh alur.",
    config: "auto",
  }), true);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({
    mode: "agent",
    text: "Refaktor penyedia API lintas beberapa modul backend serta uji migrasi, perbaiki kompatibilitas file lama, dan pertahankan seluruh perilaku frontend.",
    config: "auto",
  }), true);
  assert.strictEqual(AgentOrchestrator.shouldOrchestrate({
    mode: "agent",
    text: "Buat tombol",
    config: "auto",
  }), false);
}

function finalResponseQualityGate() {
  const implementation = [
    "Implemented lifecycle aggregation in `lib/agent-orchestrator.js`.",
    "- Added throttled worker progress and retained implementer tool events.",
    "- Updated `public/js/ai-chat.js` to reuse one worker card.",
    "Verification evidence: `npm test` passed.",
  ].join("\n");
  const composed = AgentOrchestrator.composeFinalResponse(
    "Implementation completed.",
    implementation,
    { passed: true, status: "passed", command: "npm test", issues: [] },
    ["lib/agent-orchestrator.js", "public/js/ai-chat.js"]
  );
  assert.ok(composed.includes("Added throttled worker progress"));
  assert.ok(composed.includes("`lib/agent-orchestrator.js`"));
  assert.ok(composed.includes("`public/js/ai-chat.js`"));
  assert.ok(composed.includes("Verification"));
  assert.strictEqual((composed.match(/Changed files/g) || []).length, 1);

  const failed = AgentOrchestrator.composeFinalResponse(
    "Updated `lib/a.js` with concrete behavior.",
    "",
    { passed: false, status: "failed", issues: ["npm test: assertion failed"] },
    ["lib/a.js"]
  );
  assert.ok(failed.includes("Failures/limitations"));
  assert.ok(failed.includes("assertion failed"));
}

(async () => {
  fallbackPolicy();
  finalResponseQualityGate();
  await orderingParallelismAndMetadata();
  await writerMutexAcrossRuns();
  await cancellationFansOut();
  await boundedRepairHook();
  await abortableMutexWaiter();
  await failedProviderStatusRejects();
  await progressIsThrottled();
  console.log("agent-orchestrator: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
