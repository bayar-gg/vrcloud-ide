"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const GrokAuth = require("../lib/grok-auth");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-grok-"));
const file = path.join(dir, "grok-session.json");

function jwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return h + "." + p + ".sig";
}

let now = 1_700_000_000_000;
const calls = [];
let nextResponses = [];

async function fakeFetch(url, init) {
  calls.push({ url: String(url), method: (init && init.method) || "GET", body: (init && init.body) || "" });
  const r = nextResponses.shift();
  if (!r) throw new Error("unexpected fetch: " + url);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.statusText || "",
    async text() { return typeof r.body === "string" ? r.body : JSON.stringify(r.body || {}); },
    async json() { return typeof r.body === "string" ? JSON.parse(r.body) : (r.body || {}); },
  };
}

const auth = new GrokAuth({
  file,
  secret: "test-auth-secret-at-least-32-chars!!",
  fetch: fakeFetch,
  now: () => now,
  autoPoll: false,
  cliAuthFile: path.join(dir, "missing-cli.json"),
});

assert.strictEqual(auth.connected(), false);
let st = auth.status();
assert.strictEqual(st.connected, false);
assert.strictEqual(st.pending, null);
assert.ok(!JSON.stringify(st).includes("device_code"));
assert.ok(!JSON.stringify(st).includes("access"));

nextResponses.push({
  status: 200,
  body: {
    issuer: "https://auth.x.ai",
    device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    revocation_endpoint: "https://auth.x.ai/oauth2/revoke",
    userinfo_endpoint: "https://auth.x.ai/oauth2/userinfo",
  },
});
nextResponses.push({
  status: 200,
  body: {
    device_code: "dev-secret-xyz",
    user_code: "ABCD-EFGH",
    verification_uri: "https://auth.x.ai/activate",
    verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 1,
  },
});

auth.startLogin().then(async (started) => {
  assert.ok(started.pending);
  assert.strictEqual(started.pending.userCode, "ABCD-EFGH");
  assert.ok(started.pending.verificationUriComplete.indexOf("ABCD-EFGH") !== -1);
  assert.ok(!JSON.stringify(started).includes("dev-secret-xyz"));
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }
  const disk = fs.readFileSync(file, "utf8");
  assert.ok(!disk.includes("dev-secret-xyz"));
  assert.ok(!disk.includes("access_token"));

  nextResponses.push({ status: 200, body: { error: "authorization_pending" } });
  const pending = await auth.pollOnce();
  assert.strictEqual(pending, "pending");
  assert.ok(auth.pending);

  const access = jwt({ email: "op@example.com", sub: "u1", exp: Math.floor((now + 6 * 3600 * 1000) / 1000) });
  nextResponses.push({
    status: 200,
    body: { access_token: access, refresh_token: "ref-1", expires_in: 21600, token_type: "Bearer" },
  });
  const ok = await auth.pollOnce();
  assert.strictEqual(ok, "ok");
  assert.strictEqual(auth.connected(), true);
  assert.strictEqual(auth.pending, null);
  const live = auth.status();
  assert.strictEqual(live.connected, true);
  assert.strictEqual(live.email, "op@example.com");
  assert.ok(live.emailMasked.indexOf("@example.com") !== -1);
  assert.ok(!JSON.stringify(live).includes(access));
  assert.ok(!JSON.stringify(live).includes("ref-1"));

  const token = await auth.getAccessToken();
  assert.strictEqual(token, access);

  now += 7 * 3600 * 1000;
  const access2 = jwt({ email: "op@example.com", sub: "u1", exp: Math.floor((now + 6 * 3600 * 1000) / 1000) });
  nextResponses.push({
    status: 200,
    body: { access_token: access2, refresh_token: "ref-2", expires_in: 21600 },
  });
  const refreshed = await auth.getAccessToken();
  assert.strictEqual(refreshed, access2);
  assert.strictEqual(auth.session.refreshToken, "ref-2");

  nextResponses.push({ status: 200, body: {} });
  await auth.logout();
  assert.strictEqual(auth.connected(), false);
  assert.strictEqual(auth.status().connected, false);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(after.public.connected, false);

  const reloaded = new GrokAuth({
    file,
    secret: "test-auth-secret-at-least-32-chars!!",
    fetch: fakeFetch,
    now: () => now,
    cliAuthFile: path.join(dir, "missing-cli.json"),
  });
  assert.strictEqual(reloaded.connected(), false);

  assert.strictEqual(GrokAuth.maskEmail("ab@x.ai"), "a\u2026@x.ai");
  assert.ok(GrokAuth.jwtExp(access2) > now);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("grok-auth: ok");
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
