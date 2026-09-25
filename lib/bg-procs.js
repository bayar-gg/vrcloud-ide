"use strict";

// Proses shell yang dijalankan agent di latar belakang (server dev, watcher).
// Hanya PID yang terdaftar di sini yang boleh dihentikan dari UI.
const { spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const items = new Map();

function alive(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === "EPERM"); }
}

function add(info) {
  const pid = Number(info && info.pid);
  if (!alive(pid)) return null;
  const cur = items.get(pid) || {};
  items.set(pid, {
    pid,
    command: String((info && info.command) || cur.command || "").slice(0, 500),
    sessionId: String((info && info.sessionId) || cur.sessionId || ""),
    callId: String((info && info.callId) || cur.callId || ""),
    at: cur.at || Date.now(),
  });
  return items.get(pid);
}

// extraPids: PID dari kartu chat (setelah reload) yang dicek ulang apakah masih hidup.
function list(extraPids) {
  (Array.isArray(extraPids) ? extraPids : []).forEach((p) => {
    const pid = Number(p);
    if (!items.has(pid) && alive(pid)) add({ pid });
  });
  const out = [];
  for (const [pid, info] of items) {
    if (!alive(pid)) items.delete(pid);
    else out.push(info);
  }
  return out;
}

function stop(pid) {
  pid = Number(pid);
  if (!items.has(pid)) return false;
  items.delete(pid);
  if (!alive(pid)) return true;
  if (IS_WIN) {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }); } catch (e) {}
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch (e) { try { process.kill(pid, "SIGTERM"); } catch (e2) {} }
  }
  return true;
}

function stopAll() {
  list().forEach((p) => stop(p.pid));
  return list();
}

module.exports = { add, list, stop, stopAll, alive };
