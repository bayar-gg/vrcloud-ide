"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AiChat = require("../lib/ai-chat");

class MockRun {
  async *stream() {
    yield {
      type: "tool_call",
      name: "edit",
      call_id: "edit-1",
      args: { path: "src/file.js", old_string: "old", new_string: "new" },
      status: "completed",
      result: { status: "success", value: { path: "src/file.js", linesAdded: 1, linesRemoved: 1 } },
    };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } };
    yield { type: "assistant", text: "updated" };
  }
  async wait() {
    return { status: "finished" };
  }
  supports(name) {
    return name === "cancel";
  }
  async cancel() {}
}

class MockAgent {
  constructor(provider) {
    this.provider = provider;
    this.agentId = provider + "-agent";
    this.closed = false;
  }
  async send() {
    return new MockRun();
  }
  getHistory() {
    return [{ role: "assistant", content: "updated" }];
  }
  async close() {
    this.closed = true;
  }
}

class MockProviderFactory {
  constructor() {
    this.calls = [];
    this.agents = [];
  }
  cursorStatus() {
    return { available: true, error: "" };
  }
  async create(options) {
    this.calls.push(options);
    const agent = new MockAgent(options.provider);
    this.agents.push(agent);
    return { agent, prelude: "" };
  }
  async deleteCursorAgent() {}
}

function grokAuth() {
  return {
    pending: null,
    connected: () => true,
    status: () => ({ connected: true, source: "mock", emailMasked: "m\u2026@example.com" }),
    getAccessToken: async () => "mock-token",
  };
}

async function providerContract(provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-contract-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "file.js"), "module.exports = \"old\";\n");
  const factory = new MockProviderFactory();
  let snapshot = 0;
  const checkpoints = {
    available: true,
    snapshot: async () => (++snapshot === 1 ? "aaaaaaa" : "bbbbbbb"),
    diffStat: async () => [{ path: "src/file.js", added: 1, removed: 1 }],
  };
  const events = [];
  const changed = [];
  const chat = new AiChat({
    workspace,
    configFile: path.join(root, "ai-config.json"),
    storeFile: path.join(root, "ai-sessions.json"),
    provider,
    apiKey: "cursor-test-key",
    anthropicKey: "anthropic-test-key",
    grokAuth: grokAuth(),
    providerFactory: factory,
    checkpoints,
    orchestration: "off",
    onFsChange: (paths) => changed.push(paths),
  });
  try {
    const sessionId = provider + "-session";
    const status = await chat.send(sessionId, "Update src/file.js", (kind, value) => {
      events.push({ kind, value });
    }, { orchestrate: false });
    assert.strictEqual(status, "finished");
    assert.strictEqual(factory.calls.length, 1);
    assert.strictEqual(factory.calls[0].provider, provider);
    assert.strictEqual(typeof factory.agents[0].send, "function");
    assert.strictEqual(typeof factory.agents[0].close, "function");

    const session = chat.getSession(sessionId);
    const message = session.messages.find((item) => item.role === "ai");
    assert.ok(message);
    assert.strictEqual(message.text, "updated");
    assert.strictEqual(message.before, "aaaaaaa");
    assert.strictEqual(message.after, "bbbbbbb");
    assert.deepStrictEqual(message.files, ["src/file.js"]);
    assert.deepStrictEqual(message.changes, [{ path: "src/file.js", added: 1, removed: 1 }]);
    // inputTokens/outputTokens/totalTokens diakumulasi lintas putaran; contextTokens adalah
    // okupansi jendela konteks pada putaran terakhir (input + cache + output) dan contextLimit
    // jendela model aktif — keduanya dipakai bar konteks di panel AI.
    assert.deepStrictEqual(message.usage, {
      inputTokens: 12, outputTokens: 5, totalTokens: 17,
      contextTokens: 17, contextLimit: 200000,
    });
    assert.ok(events.some((event) => event.kind === "checkpoint"));
    assert.ok(events.some((event) => event.kind === "changes"));
    assert.ok(changed.some((paths) => paths.includes("src/file.js")));

    const review = chat.setReview(sessionId, "bbbbbbb", {
      "src\\file.js": "accepted",
      "ignored.js": "pending",
    });
    assert.deepStrictEqual(review, { "src/file.js": "accepted" });
    const reviewed = chat.getSession(sessionId).messages.find((item) => item.role === "ai");
    assert.deepStrictEqual(reviewed.review, { "src/file.js": "accepted" });
  } finally {
    await chat.disposeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function resetCancelsBeforeDeletion() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-reset-"));
  let chat = null;
  let cancelled = false;
  const orchestrator = {
    activeRuns: new Map(),
    shouldRun: () => false,
    cancel: async () => true,
    cancelSession: async (sessionId) => {
      assert.ok(chat.sessions.has(sessionId), "runtime was deleted before orchestration cancellation");
      assert.ok(chat.getSession(sessionId), "stored session was deleted before orchestration cancellation");
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancelled = true;
      return true;
    },
  };
  chat = new AiChat({
    workspace: root,
    storeFile: path.join(root, "ai-sessions.json"),
    orchestrator,
    providerFactory: new MockProviderFactory(),
  });
  const sessionId = "reset-active";
  chat.createSession(sessionId);
  chat.runtime(sessionId);
  await chat.reset(sessionId);
  assert.strictEqual(cancelled, true);
  assert.strictEqual(chat.sessions.has(sessionId), false);
  assert.strictEqual(chat.getSession(sessionId), null);
  await chat.close();
  fs.rmSync(root, { recursive: true, force: true });
}

(async () => {
  for (const provider of ["cursor", "anthropic", "grok"]) {
    await providerContract(provider);
  }
  await resetCancelsBeforeDeletion();
  console.log("smart-agent-contracts: ok");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
