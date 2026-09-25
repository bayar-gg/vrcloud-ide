#!/usr/bin/env node
"use strict";

/**
 * Hook Cursor `beforeShellExecution` untuk VRCloud IDE.
 *
 * Dipanggil agent (lewat .cursor/hooks.json di workspace) sebelum setiap
 * perintah shell. Meneruskan perintah ke server VRCloud; server mencocokkan
 * dengan daftar pola berbahaya dan, bila cocok, meminta persetujuan pengguna
 * di panel AI. Hook menunggu jawabannya lalu mengembalikan allow/deny.
 *
 * Koneksi ke server dibaca dari data/hook.json ({host, port, token}).
 * Bila server tidak bisa dihubungi, hook mengizinkan (fail-open) agar agent
 * tidak macet karena konfigurasi.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const DATA = path.join(__dirname, "..", "..", "data");
function log(line) {
  try {
    const f = path.join(DATA, "hook.log");
    try { if (fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, ""); } catch (e) {} // rotasi sederhana
    fs.appendFileSync(f, new Date().toISOString() + " " + line + "\n");
  } catch (e) {}
}
let answered = false;
function out(obj) { if (answered) return; answered = true; log("-> " + JSON.stringify(obj)); process.stdout.write(JSON.stringify(obj)); }

// Input hook bisa lewat stdin (default) atau argumen/env; dukung keduanya.
function readInput(cb) {
  const argJson = process.argv.slice(2).find((a) => a.trim().startsWith("{"));
  if (argJson) return cb(argJson);
  if (process.env.CURSOR_HOOK_INPUT) return cb(process.env.CURSOR_HOOK_INPUT);
  let raw = "";
  let done = false;
  // stdin tak pernah ditutup: lanjutkan dengan yang ada. Timer di-unref dan
  // dibersihkan agar proses hook tidak menggantung 3 detik setelah menjawab.
  const guard = setTimeout(() => finish(), 3000);
  guard.unref();
  const finish = () => {
    if (done) return; done = true;
    clearTimeout(guard);
    try { process.stdin.destroy(); } catch (e) {}
    cb(raw);
  };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  } catch (e) { finish(); }
}

readInput((raw) => {
  let input = {};
  // PowerShell 5.1 menulis BOM UTF-8 ke stdin proses native; buang sebelum parse.
  raw = String(raw || "").replace(/^\uFEFF+/, "").replace(/^[\s\u0000]+/, "");
  try { input = JSON.parse(raw || "{}"); } catch (e) {
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) { try { input = JSON.parse(raw.slice(a, b + 1)); } catch (e2) {} }
  }
  // Nama field perintah berbeda antar versi: normalisasi ke input.command.
  if (!input.command) {
    const cands = [input.command_line, input.commandLine, input.cmd, input.tool_input && input.tool_input.command,
      input.toolInput && input.toolInput.command, input.args && input.args.command, input.input && input.input.command];
    const c = cands.find((v) => typeof v === "string" && v.trim());
    if (c) input.command = c;
  }
  log("hook beforeShellExecution len=" + (raw || "").length + " keys=" + Object.keys(input).join(",") + " cmd=" + JSON.stringify(input.command || "").slice(0, 200)
    + (input.command ? "" : " raw=" + String(raw || "").slice(0, 400).replace(/\s+/g, " ")));
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(DATA, "hook.json"), "utf8")); } catch (e) {}
  if (!cfg || !cfg.token) { out({ permission: "allow" }); return; }

  const body = JSON.stringify(input);
  const req = http.request({
    host: cfg.host || "127.0.0.1", port: cfg.port || 1337, path: "/api/ai/hook/shell", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-VRCloud-Hook": cfg.token },
    timeout: 15 * 60 * 1000,
  }, (res) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
      try {
        const r = JSON.parse(data);
        if (r && (r.permission === "allow" || r.permission === "deny")) {
          const o = { permission: r.permission };
          if (r.user_message) o.user_message = r.user_message;
          if (r.agent_message) o.agent_message = r.agent_message;
          return out(o);
        }
      } catch (e) {}
      out({ permission: "allow" });
    });
  });
  req.on("timeout", () => { req.destroy(); out({ permission: "deny", agent_message: "Menunggu persetujuan pengguna terlalu lama; perintah dibatalkan." }); });
  req.on("error", (e) => { log("error " + (e && e.message)); out({ permission: "allow" }); });
  req.write(body);
  req.end();
});
