"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");

const insecure = new https.Agent({ rejectUnauthorized: false });
const useHttp = process.env.C9_TEST_HTTP === "1";
const origin = (useHttp ? "http" : "https") + "://127.0.0.1:1337";
const base = process.env.C9_TEST_WS || (useHttp ? "ws" : "wss") + "://127.0.0.1:1337";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = {};
fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).forEach((line) => {
  const i = line.indexOf("="); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
});

function login() {
  return new Promise((resolve, reject) => {
    const body = "username=" + encodeURIComponent(env.AUTH_USER) + "&password=" + encodeURIComponent(env.AUTH_PASS);
    const mod = useHttp ? http : https;
    const req = mod.request(origin + "/login", {
      method: "POST",
      agent: useHttp ? undefined : insecure,
      rejectUnauthorized: false,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      const cookie = (res.headers["set-cookie"] || [])[0];
      if (!cookie) return reject(new Error("login cookie missing"));
      resolve(cookie.split(";")[0]);
    });
    req.on("error", reject); req.end(body);
  });
}

function connect(pathname, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + pathname, { headers: { Cookie: cookie }, rejectUnauthorized: false });
    const timer = setTimeout(() => reject(new Error("connect timeout: " + pathname)), 5000);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", reject);
  });
}

function nextJson(ws, wanted) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout: " + wanted)), 7000);
    const onMessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type !== wanted) return;
      clearTimeout(timer);
      ws.removeListener("message", onMessage);
      resolve(msg);
    };
    ws.on("message", onMessage);
  });
}

async function main() {
  const cookie = await login();
  const a = await connect("/sync", cookie);
  const snapshotA = await nextJson(a, "snapshot");
  const b = await connect("/sync", cookie);
  const snapshotB = await nextJson(b, "snapshot");
  assert.deepStrictEqual(snapshotA.state.layout, snapshotB.state.layout);

  a.send(JSON.stringify({ type: "terminal-create", requestId: "smoke-term", cwd: "" }));
  const created = await nextJson(a, "terminal-created");
  const id = created.terminal.id;
  const ta = await connect("/terminal?id=" + encodeURIComponent(id), cookie);
  const tb = await connect("/terminal?id=" + encodeURIComponent(id), cookie);
  const token = "C9_MULTI_" + Date.now();
  let outA = "", outB = "";
  ta.on("message", (d) => { outA += d.toString(); });
  tb.on("message", (d) => { outB += d.toString(); });
  ta.send("echo " + token + "\n");
  for (let i = 0; i < 40 && (!outA.includes(token) || !outB.includes(token)); i++) await wait(100);
  assert.ok(outA.includes(token), "terminal A did not receive shared output");
  assert.ok(outB.includes(token), "terminal B did not receive shared output");

  a.send(JSON.stringify({ type: "terminal-close", id }));
  await wait(150);
  ta.close(); tb.close(); a.close(); b.close();
  console.log("realtime-smoke: ok");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
