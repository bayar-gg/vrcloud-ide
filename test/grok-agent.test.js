"use strict";

const assert = require("assert");
const GrokAgent = require("../lib/grok-agent");
const AnthropicAgent = require("../lib/anthropic-agent");

const tools = GrokAgent.toOpenAITools(AnthropicAgent.builtinTools());
assert.ok(tools.length >= 8);
const read = tools.find((t) => t.function && t.function.name === "read");
assert.ok(read);
assert.strictEqual(read.type, "function");
assert.ok(read.function.parameters && read.function.parameters.properties.path);

const hist = GrokAgent.sanitizeHistory([
  { role: "tool", tool_call_id: "x", content: "stale" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
]);
assert.strictEqual(hist[0].role, "user");
assert.strictEqual(hist.length, 1); // trailing tool_use without result dropped

const keep = GrokAgent.sanitizeHistory([
  { role: "user", content: "hi" },
  { role: "assistant", content: "ok" },
]);
assert.strictEqual(keep.length, 2);

const models = GrokAgent.fallbackModels();
assert.ok(models.some((m) => m.id === "grok-4.6"));
assert.ok(models[0].parameters.some((p) => p.id === "effort"));

assert.strictEqual(GrokAgent.DEFAULT_MODEL, "grok-4.6");

const headers = GrokAgent.headersFor("https://cli-chat-proxy.grok.com/v1", "tok");
assert.strictEqual(headers.authorization, "Bearer tok");
assert.strictEqual(headers["x-xai-token-auth"], "xai-grok-cli");
const pub = GrokAgent.headersFor("https://api.x.ai/v1", "tok");
assert.ok(!pub["x-xai-token-auth"]);

console.log("grok-agent: ok");
