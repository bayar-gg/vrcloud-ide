"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AiChat = require("../lib/ai-chat");
const GrokAuth = require("../lib/grok-auth");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-ai-"));
const grokAuth = new GrokAuth({
  file: path.join(dir, "grok-session.json"),
  secret: "test-auth-secret-at-least-32-chars!!",
  fetch: async () => { throw new Error("network should not be used"); },
  autoPoll: false,
  cliAuthFile: path.join(dir, "no-cli.json"),
});

const chat = new AiChat({
  workspace: dir,
  configFile: path.join(dir, "ai-config.json"),
  storeFile: path.join(dir, "ai-sessions.json"),
  grokAuth,
  authSecret: "test-auth-secret-at-least-32-chars!!",
  apiKey: "cursor_test",
  anthropicKey: "sk-ant-test",
});

assert.strictEqual(chat.provider, "cursor");
chat.setConfig({ provider: "grok" }).then(async (st) => {
  assert.strictEqual(st.provider, "grok");
  assert.strictEqual(st.enabled, false);
  assert.ok(/Grok/i.test(st.reason));
  assert.ok(st.grok);
  assert.strictEqual(st.grok.connected, false);
  assert.ok(!JSON.stringify(st).includes("accessToken"));
  assert.ok(!JSON.stringify(st).includes("refreshToken"));

  const anth = await chat.setConfig({ provider: "anthropic" });
  assert.strictEqual(anth.provider, "anthropic");
  assert.strictEqual(anth.enabled, true);

  const cur = await chat.setConfig({ provider: "cursor" });
  assert.strictEqual(cur.provider, "cursor");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ai-provider-grok: ok");
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
