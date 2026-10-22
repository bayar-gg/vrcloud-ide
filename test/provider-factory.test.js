"use strict";

const assert = require("assert");
const ProviderFactory = require("../lib/provider-factory");

function fakeProvider(label, calls) {
  return {
    create: async (options) => {
      calls.push(options);
      return { agentId: options.agentId || (label + "-new"), close: async () => {} };
    },
    listModels: async () => [{ id: label + "-model" }],
  };
}

(async () => {
  const cursorCalls = [];
  const sdk = {
    Agent: {
      resume: async (id, options) => {
        cursorCalls.push({ type: "resume", id, options });
        return { agentId: id, close: async () => {} };
      },
      create: async (options) => {
        cursorCalls.push({ type: "create", options });
        return { agentId: "cursor-new", close: async () => {} };
      },
      delete: async () => {},
    },
    Cursor: { models: { list: async () => ({ models: [{ id: "cursor-model" }] }) } },
  };
  const anthropicCalls = [];
  const grokCalls = [];
  const factory = new ProviderFactory({
    sdk,
    AnthropicAgent: fakeProvider("claude", anthropicCalls),
    GrokAgent: fakeProvider("grok", grokCalls),
  });

  const cursorMeta = { agentId: "cursor-existing" };
  const cursor = await factory.create({
    provider: "cursor",
    apiKey: "cursor-key",
    model: "selected-model",
    params: { effort: "high" },
    workspace: process.cwd(),
    mode: "agent",
    meta: cursorMeta,
    customTools: {},
  });
  assert.strictEqual(cursor.agent.agentId, "cursor-existing");
  assert.strictEqual(cursorCalls[0].type, "resume");
  assert.strictEqual(cursorCalls[0].options.model.id, "selected-model");
  assert.ok(cursorCalls[0].options.disallowedTools.indexOf("task") !== -1);

  const claudeHistory = [{ role: "user", content: [{ type: "text", text: "before" }] }];
  const claudeMeta = { claudeAgentId: "claude-existing", claudeHistory };
  await factory.create({
    provider: "anthropic",
    anthropicKey: "anthropic-key",
    model: "claude-selected",
    workspace: process.cwd(),
    mode: "agent",
    meta: claudeMeta,
    customTools: {},
  });
  assert.strictEqual(anthropicCalls[0].agentId, "claude-existing");
  assert.strictEqual(anthropicCalls[0].history, claudeHistory);
  assert.strictEqual(anthropicCalls[0].model, "claude-selected");

  const grokHistory = [{ role: "user", content: "before" }];
  const grokMeta = { grokAgentId: "grok-existing", grokHistory };
  await factory.create({
    provider: "grok",
    getGrokToken: async () => "token",
    model: "grok-selected",
    workspace: process.cwd(),
    mode: "agent",
    meta: grokMeta,
    customTools: {},
  });
  assert.strictEqual(grokCalls[0].agentId, "grok-existing");
  assert.strictEqual(grokCalls[0].history, grokHistory);
  assert.strictEqual(grokCalls[0].model, "grok-selected");

  const transient = await factory.create({
    provider: "anthropic",
    anthropicKey: "anthropic-key",
    model: "claude-selected",
    workspace: process.cwd(),
    mode: "agent",
    persistent: false,
    restrictions: { readOnly: true, noBrowser: true, noDesktop: true, noMemoryMutation: true, noAstEdit: true },
    customTools: {
      ast_search: { annotations: { readOnlyHint: true } },
      ast_edit: { annotations: { readOnlyHint: false } },
      browser_snapshot: { annotations: { readOnlyHint: true } },
      memory_search: { annotations: { readOnlyHint: true } },
      memory_upsert: { annotations: { readOnlyHint: false } },
    },
  });
  assert.strictEqual(transient.agent.agentId, "claude-new");
  const transientOptions = anthropicCalls[1];
  assert.deepStrictEqual(transientOptions.history, []);
  assert.deepStrictEqual(Object.keys(transientOptions.customTools).sort(), ["ast_search", "memory_search"]);
  ["edit", "write", "delete", "shell", "task"].forEach((tool) => {
    assert.ok(transientOptions.disallowedTools.indexOf(tool) !== -1, "missing read-only restriction " + tool);
  });

  const attempts = [];
  const rejectingFactory = new ProviderFactory({
    sdk: {
      Agent: {
        create: async (options) => {
          attempts.push(options);
          const error = new Error("unsupported tool restriction");
          error.name = "ConfigurationError";
          throw error;
        },
      },
    },
  });
  await assert.rejects(rejectingFactory.create({
    provider: "cursor",
    apiKey: "cursor-key",
    workspace: process.cwd(),
    mode: "agent",
    persistent: false,
    forceNew: true,
    restrictions: { readOnly: true },
  }), /Cannot safely create read-only worker/);
  assert.strictEqual(attempts.length, 1, "read-only creation must not retry with weaker restrictions");
  assert.deepStrictEqual(attempts[0].tools, ProviderFactory.READ_ONLY_ALLOWLIST);
  assert.deepStrictEqual(attempts[0].disallowedTools, ProviderFactory.READ_ONLY_BUILTINS);

  console.log("provider-factory: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
