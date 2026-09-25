"use strict";

/**
 * Provider Anthropic Claude untuk panel AI.
 *
 * Meniru antarmuka Cursor SDK Agent yang dipakai lib/ai-chat.js:
 *   Agent.create(opts) -> agent.send(payload) -> run.stream() / run.wait() / run.cancel()
 * dan menghasilkan event dengan bentuk yang sama (tool_call / usage / assistant /
 * thinking) sehingga UI, kartu tool, checkpoint, dan review perubahan tidak berubah.
 *
 * Tool workspace diimplementasikan di sini (read/write/edit/delete/ls/glob/grep/
 * shell/updateTodos/WebFetch) memakai Messages API dengan tool use + streaming.
 * Tanpa dependency tambahan: memakai fetch bawaan Node >= 18.
 *
 * Env:
 *   ANTHROPIC_API_KEY   kunci API Anthropic
 *   ANTHROPIC_BASE_URL  opsional; default https://api.anthropic.com
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const Instructions = require("./agent-instructions"); // system prompt + deskripsi tool (satu file)

const BASE_URL = String(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const API_VERSION = "2023-06-01";
const CONTEXT_1M_BETA = process.env.ANTHROPIC_CONTEXT_1M_BETA || "context-1m-2025-08-07";
const IS_WIN = process.platform === "win32";
const MAX_TOOL_ROUNDS = 80;          // batas putaran tool per satu send()
const MAX_OUTPUT_CHARS = 30000;      // output tool yang dikirim balik ke model
const HISTORY_KEEP = 60;             // pesan yang dipertahankan saat disimpan
const HISTORY_CHARS_SOFT = 480000;   // ~120K token: mulai memadatkan hasil tool lama
const HISTORY_CHARS_TARGET = 360000; // target setelah dipadatkan
const SKIP_DIRS = { node_modules: 1, ".git": 1, dist: 1, build: 1, ".next": 1, ".cache": 1, __pycache__: 1, ".venv": 1, venv: 1 };

const modelCache = new Map(); // apiKey(hash) -> { at, list }

function hashKey(k) { return crypto.createHash("sha1").update(String(k || "")).digest("hex"); }
function cap(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "\n\u2026(truncated " + (s.length - n) + " characters)" : s; }
// Potong di tengah: awal dan akhir dipertahankan (pesan error biasanya di akhir output).
function capMiddle(s, n) {
  s = String(s == null ? "" : s);
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.45), tail = n - head;
  return s.slice(0, head) + "\n\u2026(" + (s.length - n) + " characters truncated in the middle)\u2026\n" + s.slice(s.length - tail);
}
function countLines(s) { s = String(s || ""); if (!s) return 0; return s.split(/\r?\n/).length; }
function isBinary(buf) { const n = Math.min(buf.length, 4000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }
function toPosix(p) { return String(p || "").replace(/\\/g, "/"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function globToRegExp(glob) {
  let g = toPosix(glob).replace(/^\.\//, "");
  if (g.indexOf("/") === -1 && g.indexOf("**") !== 0) g = "**/" + g;
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) re += "\\{";
      else { re += "(?:" + g.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")"; i = end; }
    } else if (/[.+^$()|[\]\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$", IS_WIN ? "i" : "");
}

// ---------------------------------------------------------------- SSE reader
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let ev = null, data = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data.length) {
          let parsed = null;
          try { parsed = JSON.parse(data.join("\n")); } catch (e) { parsed = null; }
          if (parsed) yield { event: ev || (parsed && parsed.type) || "", data: parsed };
        }
        ev = null; data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}

async function apiFetch(apiKey, route, init, signal) {
  const headers = Object.assign({
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
  }, (init && init.headers) || {});
  return fetch(BASE_URL + route, Object.assign({}, init || {}, { headers, signal }));
}

async function readError(res) {
  let text = "";
  try { text = await res.text(); } catch (e) {}
  let msg = text;
  try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type)) || text; } catch (e) {}
  return new Error("Anthropic API " + res.status + ": " + cap(msg || res.statusText, 600));
}

// ---------------------------------------------------------------- Tools
class Workspace {
  constructor(root, shellBin) {
    this.root = path.resolve(root || process.cwd());
    this.shellBin = shellBin || process.env.SHELL_BIN || (IS_WIN ? "powershell.exe" : "bash");
    this.rgPath = null;
    this.rgChecked = false;
  }
  resolve(p) {
    const s = String(p == null ? "" : p).trim();
    const abs = !s || s === "." ? this.root : (path.isAbsolute(s) ? s : path.resolve(this.root, s));
    const rel = path.relative(this.root, abs);
    if (rel && (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel))) throw new Error("Path is outside the workspace: " + s);
    return abs;
  }
  rel(abs) { return toPosix(path.relative(this.root, abs)) || "."; }

  read(a) {
    const abs = this.resolve(a.path);
    const st = fs.statSync(abs);
    if (st.isDirectory()) return this.ls({ path: a.path });
    if (st.size > 5 * 1024 * 1024) throw new Error("File too large (" + st.size + " bytes)");
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return "(binary file, " + st.size + " bytes)";
    const lines = buf.toString("utf8").split(/\r?\n/);
    const off = Math.max(1, parseInt(a.offset, 10) || 1);
    const lim = Math.min(2000, Math.max(1, parseInt(a.limit, 10) || 2000));
    const slice = lines.slice(off - 1, off - 1 + lim);
    const w = String(off - 1 + slice.length).length;
    const out = slice.map((l, i) => String(off + i).padStart(w, " ") + "| " + l).join("\n");
    const more = lines.length > off - 1 + slice.length ? "\n\u2026(" + (lines.length - (off - 1 + slice.length)) + " more lines; use offset=" + (off + slice.length) + ")" : "";
    return cap(out, MAX_OUTPUT_CHARS) + more;
  }

  write(a) {
    const abs = this.resolve(a.path);
    const content = String(a.content == null ? "" : a.content);
    let removed = 0;
    const existed = fs.existsSync(abs);
    if (existed) { try { removed = countLines(fs.readFileSync(abs, "utf8")); } catch (e) {} }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { text: (existed ? "Overwritten: " : "Created: ") + this.rel(abs) + " (" + countLines(content) + " lines)", value: { linesAdded: countLines(content), linesRemoved: removed } };
  }

  edit(a) {
    const abs = this.resolve(a.path);
    if (!fs.existsSync(abs)) throw new Error("File does not exist: " + a.path + " (use write to create a new file)");
    const oldS = String(a.old_string == null ? "" : a.old_string);
    const newS = String(a.new_string == null ? "" : a.new_string);
    if (!oldS) throw new Error("old_string is empty");
    let src = fs.readFileSync(abs, "utf8");
    // Toleransi CRLF: cocokkan juga bila file memakai \r\n.
    let hay = src, needle = oldS;
    let count = hay.split(needle).length - 1;
    if (count === 0 && src.indexOf("\r\n") !== -1) { hay = src.replace(/\r\n/g, "\n"); needle = oldS.replace(/\r\n/g, "\n"); count = hay.split(needle).length - 1; }
    if (count === 0) {
      // Toleransi spasi/tab di awal-akhir tiap baris: sering meleset karena indentasi.
      const norm = (t) => t.split(/\r?\n/).map((l) => l.trim()).join("\n");
      const hn = norm(src), nn0 = norm(oldS);
      if (nn0 && hn.split(nn0).length - 1 === 1) {
        const srcLines = src.split(/\r?\n/);
        const want = nn0.split("\n");
        let at = -1;
        for (let i = 0; i + want.length <= srcLines.length; i++) {
          let ok = true;
          for (let j = 0; j < want.length; j++) if (srcLines[i + j].trim() !== want[j]) { ok = false; break; }
          if (ok) { at = i; break; }
        }
        if (at >= 0) {
          const eol = src.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
          const indentOf = (l) => (String(l).match(/^[ \t]*/) || [""])[0];
          const oldIndents = want.map((_, j) => indentOf(srcLines[at + j]));
          const newLines = newS.split(/\r?\n/);
          const nonBlank = newLines.filter((l) => l.trim());
          const minIndent = nonBlank.length ? Math.min.apply(null, nonBlank.map((l) => indentOf(l).length)) : 0;
          const base = oldIndents[0] || "";
          const rep = newLines.map((l, i) => {
            if (!l.trim()) return "";
            // Jumlah baris sama: pakai indentasi baris lama yang sepadan; selain itu indentasi dasar + relatif dari new_string.
            if (newLines.length === want.length) return oldIndents[i] + l.trim();
            return base + l.slice(Math.min(minIndent, indentOf(l).length));
          });
          srcLines.splice.apply(srcLines, [at, want.length].concat(rep));
          fs.writeFileSync(abs, srcLines.join(eol), "utf8");
          const diff = oldS.split(/\r?\n/).map((l) => "- " + l).concat(newS.split(/\r?\n/).map((l) => "+ " + l)).join("\n");
          return { text: "Diedit: " + this.rel(abs) + " (indentation adjusted; verify with read around line " + (at + 1) + ")", value: { diffString: cap(diff, 8000), linesAdded: countLines(newS), linesRemoved: countLines(oldS) } };
        }
      }
      const first = oldS.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
      const hintLines = [];
      if (first) {
        src.split(/\r?\n/).forEach((l, i) => { if (hintLines.length < 5 && l.indexOf(first) !== -1) hintLines.push((i + 1) + ": " + l.trim().slice(0, 120)); });
      }
      throw new Error("old_string not found in " + this.rel(abs) + ". Re-read the file (read with offset) and copy the text verbatim." +
        (hintLines.length ? "\nLines containing the first line of old_string:\n" + hintLines.join("\n") : "\nThe first line of old_string does not appear in the file; the file may have changed or the path is wrong."));
    }
    if (count > 1 && !a.replace_all) {
      const first = oldS.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
      const where = [];
      if (first) src.split(/\r?\n/).forEach((l, i) => { if (where.length < 8 && l.indexOf(first) !== -1) where.push(i + 1); });
      throw new Error("old_string occurs " + count + " times (around lines " + where.join(", ") + "); add surrounding context to make it unique or set replace_all=true.");
    }
    const nn = hay === src ? newS : newS.replace(/\r\n/g, "\n");
    const out = a.replace_all ? hay.split(needle).join(nn) : hay.replace(needle, () => nn);
    const finalText = hay === src ? out : out.replace(/\n/g, "\r\n");
    fs.writeFileSync(abs, finalText, "utf8");
    const diff = oldS.split(/\r?\n/).map((l) => "- " + l).concat(newS.split(/\r?\n/).map((l) => "+ " + l)).join("\n");
    return { text: "Edited: " + this.rel(abs) + (a.replace_all ? " (" + count + " occurrences)" : ""), value: { diffString: cap(diff, 8000), linesAdded: countLines(newS), linesRemoved: countLines(oldS) } };
  }

  delete(a) {
    const abs = this.resolve(a.path);
    if (abs === this.root) throw new Error("Refusing to delete the workspace root");
    if (!fs.existsSync(abs)) throw new Error("Not found: " + a.path);
    const st = fs.statSync(abs);
    fs.rmSync(abs, { recursive: st.isDirectory(), force: true });
    return "Deleted: " + this.rel(abs);
  }

  ls(a) {
    const abs = this.resolve(a.path);
    const ents = fs.readdirSync(abs, { withFileTypes: true }).sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
    const lines = ents.slice(0, 500).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    if (ents.length > 500) lines.push("\u2026(" + (ents.length - 500) + " more entries)");
    return (this.rel(abs) + "/\n" + lines.join("\n")).trim();
  }

  walk(dirAbs, onFile, budget) {
    const stack = [dirAbs];
    while (stack.length && budget.files > 0) {
      const d = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        if (e.isDirectory()) { if (!SKIP_DIRS[e.name]) stack.push(path.join(d, e.name)); }
        else if (e.isFile()) { budget.files--; if (onFile(path.join(d, e.name)) === false) return; if (budget.files <= 0) return; }
      }
    }
  }

  glob(a) {
    const base = this.resolve(a.path);
    const re = globToRegExp(a.pattern || "*");
    const hits = [];
    this.walk(base, (f) => {
      const rel = toPosix(path.relative(base, f));
      if (re.test(rel)) { hits.push(this.rel(f)); if (hits.length >= 500) return false; }
    }, { files: 60000 });
    return hits.length ? hits.join("\n") : "(no matching files)";
  }

  rg() {
    if (this.rgChecked) return this.rgPath;
    this.rgChecked = true;
    const r = spawnSync(IS_WIN ? "where" : "which", ["rg"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) this.rgPath = r.stdout.trim().split(/\r?\n/)[0];
    return this.rgPath;
  }

  grep(a) {
    const base = this.resolve(a.path);
    const pattern = String(a.pattern || "");
    if (!pattern) throw new Error("pattern is empty");
    const rg = this.rg();
    const ctxN = Math.min(5, Math.max(0, parseInt(a.context, 10) || 0));
    if (rg) {
      const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "50", "--max-columns", "300", "-e", pattern];
      if (a.case_insensitive) args.push("-i"); else args.push("-S");
      if (ctxN) args.push("-C", String(ctxN));
      if (a.glob) args.push("--glob", String(a.glob));
      args.push(base);
      const r = spawnSync(rg, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, cwd: this.root });
      if (r.status === 2) throw new Error(cap(r.stderr || "rg gagal", 1000));
      const out = String(r.stdout || "").split(/\r?\n/).filter(Boolean).slice(0, 300)
        .map((l) => l.replace(/^((?:[A-Za-z]:[\\/])?.+?)([:-])(\d+)[:-]/, (m, f, sep, n) => this.rel(path.resolve(this.root, f)) + ":" + n + (sep === "-" ? "-" : ":"))).join("\n");
      return out || "(no results)";
    }
    const re = new RegExp(pattern, a.case_insensitive ? "i" : "");
    const gre = a.glob ? globToRegExp(a.glob) : null;
    const hits = [];
    this.walk(base, (f) => {
      if (gre && !gre.test(toPosix(path.relative(base, f)))) return;
      let buf; try { if (fs.statSync(f).size > 1024 * 1024) return; buf = fs.readFileSync(f); } catch (e) { return; }
      if (isBinary(buf)) return;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { hits.push(this.rel(f) + ":" + (i + 1) + ":" + lines[i].slice(0, 300)); if (hits.length >= 300) return false; }
      }
    }, { files: 30000 });
    return hits.length ? hits.join("\n") : "(no results)";
  }

  shell(a, signal) {
    const command = String(a.command || "").trim();
    if (!command) throw new Error("command is empty");
    const cwd = this.resolve(a.cwd || a.workingDirectory || "");
    const timeoutMs = Math.min(900, Math.max(5, parseInt(a.timeout_sec, 10) || 180)) * 1000;
    const bin = this.shellBin;
    const isPs = /powershell|pwsh/i.test(bin);
    // PowerShell: keluaran UTF-8 agar teks non-ASCII dari tool/compiler tidak rusak.
    const psCmd = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; " + command;
    const args = isPs ? ["-NoProfile", "-NonInteractive", "-Command", psCmd]
      : (/cmd(\.exe)?$/i.test(bin) ? ["/d", "/s", "/c", command] : ["-c", command]);
    const env = Object.assign({}, process.env, { TERM: "dumb", NO_COLOR: "1", CI: "1", GIT_TERMINAL_PROMPT: "0" });
    if (a.background) {
      const child = spawn(bin, args, { cwd, env, detached: !IS_WIN, stdio: "ignore", windowsHide: true });
      child.unref();
      return Promise.resolve({ stdout: "Started in the background (pid " + child.pid + ").", stderr: "", exitCode: 0, pid: child.pid, background: true });
    }
    return new Promise((resolve) => {
      let out = "", err = "", done = false;
      const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const finish = (code, note) => {
        if (done) return; done = true; clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve({ stdout: capMiddle(out, MAX_OUTPUT_CHARS), stderr: capMiddle(err + (note ? "\n" + note : ""), 8000), exitCode: typeof code === "number" ? code : 1 });
      };
      const kill = () => { try { if (!IS_WIN) process.kill(-child.pid, "SIGKILL"); } catch (e) {} try { child.kill("SIGKILL"); } catch (e) {} };
      const onAbort = () => { kill(); finish(130, "(cancelled)"); };
      const timer = setTimeout(() => { kill(); finish(124, "(timed out after " + timeoutMs / 1000 + "s; use background=true for long-running processes)"); }, timeoutMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => { if (out.length < 400000) out += d.toString("utf8"); });
      child.stderr.on("data", (d) => { if (err.length < 200000) err += d.toString("utf8"); });
      child.on("error", (e) => finish(127, String(e.message || e)));
      child.on("close", (code) => finish(code));
    });
  }

  async webFetch(a, signal) {
    const url = String(a.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("URL must be http/https");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 25000);
    if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 VRCloud-IDE-Agent", accept: "text/html,application/json,text/plain,*/*" } });
      const ct = String(res.headers.get("content-type") || "");
      let text = await res.text();
      if (/html/i.test(ct) || /^\s*</.test(text)) {
        text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
          .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
      }
      return "HTTP " + res.status + " " + ct + "\n\n" + cap(text, 20000);
    } finally { clearTimeout(t); }
  }
}

const OBJ = (props, required) => ({ type: "object", properties: props, required: required || [] });
// Deskripsi tool: lib/agent-instructions.js (TOOLS). Di sini hanya skema input.
function builtinTools() {
  const T = Instructions.tool;
  return [
    { name: "read", description: T("read"),
      input_schema: OBJ({ path: { type: "string", description: "Path relative to the workspace" }, offset: { type: "integer", description: "First line (1-based)" }, limit: { type: "integer", description: "Number of lines (max 2000)" } }, ["path"]) },
    { name: "write", description: T("write"),
      input_schema: OBJ({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) },
    { name: "edit", description: T("edit"),
      input_schema: OBJ({ path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_string", "new_string"]) },
    { name: "delete", description: T("delete"), input_schema: OBJ({ path: { type: "string" } }, ["path"]) },
    { name: "ls", description: T("ls"), input_schema: OBJ({ path: { type: "string", description: "Default: workspace root" } }) },
    { name: "glob", description: T("glob"),
      input_schema: OBJ({ pattern: { type: "string" }, path: { type: "string", description: "Starting folder (default root)" } }, ["pattern"]) },
    { name: "grep", description: T("grep"),
      input_schema: OBJ({ pattern: { type: "string", description: "Regex (Rust/JS syntax)" }, path: { type: "string" }, glob: { type: "string", description: "File filter, e.g. *.js" }, case_insensitive: { type: "boolean" }, context: { type: "integer", description: "Context lines before/after (0-5)" } }, ["pattern"]) },
    { name: "shell", description: T("shell"),
      input_schema: OBJ({ command: { type: "string" }, cwd: { type: "string", description: "Working directory relative to the workspace" }, timeout_sec: { type: "integer", description: "Default 180, max 900" }, background: { type: "boolean" } }, ["command"]) },
    { name: "updateTodos", description: T("updateTodos"),
      input_schema: OBJ({ todos: { type: "array", items: OBJ({ content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] } }, ["content", "status"]) }, merge: { type: "boolean" } }, ["todos"]) },
    { name: "WebFetch", description: T("WebFetch"),
      input_schema: OBJ({ url: { type: "string" } }, ["url"]) },
  ];
}

// ---------------------------------------------------------------- Run
class Run {
  constructor(agent, payload) {
    this.agent = agent;
    this.queue = [];
    this.waiters = [];
    this.done = false;
    this.status = "finished";
    this.error = null;
    this.cancelled = false;
    this.ac = new AbortController();
    this.promise = agent._exec(this, payload)
      .catch((e) => { if (!this.cancelled) { this.status = "error"; this.error = e; } })
      .finally(() => { this.done = true; this._wake(); });
  }
  push(ev) { this.queue.push(ev); this._wake(); }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
  supports(name) { return name === "cancel"; }
  async cancel() { this.cancelled = true; this.status = "cancelled"; try { this.ac.abort(); } catch (e) {} }
  async *stream() {
    let i = 0;
    for (;;) {
      if (i < this.queue.length) { yield this.queue[i++]; continue; }
      if (this.done) return;
      await new Promise((r) => this.waiters.push(r));
    }
  }
  async wait() {
    await this.promise;
    if (this.error && !this.cancelled) throw this.error;
    return { status: this.status };
  }
}

// ---------------------------------------------------------------- Agent
class AnthropicAgent {
  static async create(opts) {
    opts = opts || {};
    if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY belum disetel");
    const agent = new AnthropicAgent(opts);
    await agent._resolveModel();
    return agent;
  }

  static async listModels(apiKey, opts) {
    if (!apiKey) throw new Error("API key Anthropic belum diisi");
    const h = hashKey(apiKey);
    const c = modelCache.get(h);
    if (!(opts && opts.refresh) && c && Date.now() - c.at < 10 * 60 * 1000) return c.list;
    const res = await apiFetch(apiKey, "/v1/models?limit=100", { method: "GET" });
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    const list = (Array.isArray(j.data) ? j.data : []).map((m) => ({
      id: String(m.id),
      displayName: m.display_name || String(m.id),
      parameters: [
        { id: "thinking", displayName: "Thinking", values: [{ value: "off", displayName: "Off" }, { value: "on", displayName: "On" }] },
        { id: "effort", displayName: "Effort", values: [{ value: "default", displayName: "Default" }, { value: "low", displayName: "Low" }, { value: "medium", displayName: "Medium" }, { value: "high", displayName: "High" }] },
        { id: "context", displayName: "Context", values: [{ value: "default", displayName: "Standar (200K)" }, { value: "1m", displayName: "1M token" }] },
      ],
      variants: [],
    }));
    modelCache.set(h, { at: Date.now(), list });
    return list;
  }

  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.modelId = String((opts.model && opts.model.id) || opts.model || "auto");
    this.params = (opts.params && typeof opts.params === "object") ? opts.params : {};
    this.workspace = new Workspace(opts.workspace || (opts.local && opts.local.cwd) || process.cwd(), opts.shell);
    this.customTools = (opts.customTools && typeof opts.customTools === "object") ? opts.customTools : {};
    this.disallowed = {};
    (opts.disallowedTools || []).forEach((n) => { this.disallowed[String(n).toLowerCase()] = 1; });
    this.messages = AnthropicAgent.sanitizeHistory(Array.isArray(opts.history) ? opts.history : []);
    // Prompt caching (default aktif): breakpoint ephemeral pada system prompt, definisi tool
    // terakhir, dan blok terakhir pesan terakhir → seluruh prefix percakapan di-cache.
    this.promptCache = opts.promptCache !== false;
    this.agentId = opts.agentId || ("claude-" + crypto.randomBytes(6).toString("hex"));
    this.todos = null;
    this.closed = false;
  }

  async _resolveModel() {
    if (this.modelId && this.modelId !== "auto" && this.modelId !== "default") return;
    let list = [];
    try { list = await AnthropicAgent.listModels(this.apiKey); }
    catch (e) {
      // Key salah / ditolak: jangan ditelan, supaya pengguna melihat respons API-nya.
      if (/401|403|authentication|api[_ ]key|invalid x-api-key|permission/i.test(String(e && e.message))) throw e;
      list = [];
    }
    const pick = list.find((m) => /sonnet/i.test(m.id)) || list[0];
    this.modelId = pick ? pick.id : "claude-sonnet-4-5";
  }

  // Bersihkan riwayat: mulai dari pesan pengguna biasa; buang thinking lama & rapikan.
  static sanitizeHistory(msgs) {
    let out = (msgs || []).filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content);
    // Harus mulai dari pesan user yang bukan tool_result.
    while (out.length) {
      const m = out[0];
      const isToolResult = Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result");
      if (m.role === "user" && !isToolResult) break;
      out.shift();
    }
    // Pasangan tool_use <-> tool_result harus utuh; buang assistant tool_use tanpa jawaban di akhir.
    if (out.length) {
      const last = out[out.length - 1];
      if (last.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b && b.type === "tool_use")) out.pop();
    }
    return out.map((m) => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
      const c = m.content.filter((b) => b && b.type !== "thinking" && b.type !== "redacted_thinking");
      return { role: "assistant", content: c.length ? c : [{ type: "text", text: "(empty)" }] };
    });
  }

  // Riwayat ringkas untuk disimpan di ai-sessions.json.
  getHistory() {
    const msgs = this.messages.slice(-HISTORY_KEEP).map((m) => {
      if (!Array.isArray(m.content)) return m;
      return { role: m.role, content: m.content.map((b) => {
        if (!b) return b;
        if (b.type === "tool_result") {
          const content = Array.isArray(b.content) ? b.content.map((x) => (x && x.type === "image") ? { type: "text", text: "[image]" } : (x && x.type === "text" ? { type: "text", text: cap(x.text, 6000) } : x)).filter(Boolean)
            : (typeof b.content === "string" ? cap(b.content, 6000) : b.content);
          return Object.assign({}, b, { content });
        }
        if (b.type === "image") return { type: "text", text: "[attached image]" };
        if (b.type === "text") return { type: "text", text: cap(b.text, 20000) };
        return b;
      }) };
    });
    return AnthropicAgent.sanitizeHistory(msgs);
  }

  async close() { this.closed = true; }

  send(payload) {
    if (this.closed) throw new Error("Agent sudah ditutup");
    return new Run(this, payload);
  }

  // ---- system prompt: info workspace + AGENTS.md / .vrcloud-agent/rules ----
  systemPrompt() {
    const ws = this.workspace.root;
    // Teks instruksi: lib/agent-instructions.js (satu sumber untuk semua provider).
    const lines = Instructions.anthropicSystem({ workspace: ws, platform: process.platform });
    const extra = [];
    const add = (file, label) => {
      try {
        if (!fs.existsSync(file)) return;
        const t = fs.readFileSync(file, "utf8").trim();
        if (t) extra.push("[" + label + "]\n" + cap(t, 6000));
      } catch (e) {}
    };
    add(path.join(ws, "AGENTS.md"), "AGENTS.md");
    try {
      const rulesDir = path.join(ws, ".vrcloud-agent", "rules");
      if (fs.existsSync(rulesDir)) {
        fs.readdirSync(rulesDir).filter((f) => /\.(md|mdc)$/i.test(f)).slice(0, 10).forEach((f) => add(path.join(rulesDir, f), ".vrcloud-agent/rules/" + f));
      }
    } catch (e) {}
    const text = lines.join("\n") + (extra.length ? "\n\n" + extra.join("\n\n") : "");
    const block = { type: "text", text: cap(text, 30000) };
    if (this.promptCache) block.cache_control = { type: "ephemeral" };
    return [block];
  }

  toolDefs() {
    const defs = builtinTools().filter((t) => !this.disallowed[t.name.toLowerCase()]);
    Object.keys(this.customTools).forEach((name) => {
      const t = this.customTools[name];
      if (!t || typeof t.execute !== "function") return;
      if (this.disallowed[name.toLowerCase()]) return;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return;
      defs.push({ name, description: cap(t.description || name, 2000), input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} } });
    });
    // Breakpoint pada tool terakhir: seluruh definisi tool masuk cache (definisi stabil antar-request).
    if (this.promptCache && defs.length) defs[defs.length - 1].cache_control = { type: "ephemeral" };
    return defs;
  }

  // Pasang breakpoint cache pada blok terakhir pesan terakhir (dan cabut yang lama) supaya
  // prefix percakapan yang sudah dikirim dibaca dari cache pada request berikutnya.
  // Maks 4 breakpoint per request: system (1) + tools (1) + pesan terakhir (1).
  applyMessageCache(messages) {
    const CACHEABLE = { text: 1, image: 1, tool_use: 1, tool_result: 1, document: 1 };
    messages.forEach((m) => {
      if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }];
      if (Array.isArray(m.content)) m.content.forEach((b) => { if (b && b.cache_control) delete b.cache_control; });
    });
    if (!this.promptCache || !messages.length) return;
    const last = messages[messages.length - 1];
    if (!Array.isArray(last.content) || !last.content.length) return;
    for (let i = last.content.length - 1; i >= 0; i--) {
      const b = last.content[i];
      if (b && CACHEABLE[b.type]) { b.cache_control = { type: "ephemeral" }; break; }
    }
  }

  thinkingOn() { return /^(on|true|1|yes|enabled)$/i.test(String(this.params.thinking || "")); }

  userContent(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const blocks = [];
      (payload.images || []).forEach((im) => {
        if (im && im.data && im.mimeType) blocks.push({ type: "image", source: { type: "base64", media_type: String(im.mimeType).toLowerCase(), data: String(im.data) } });
      });
      blocks.push({ type: "text", text: String(payload.text == null ? "" : payload.text) || "(see the attached image)" });
      return blocks;
    }
    return [{ type: "text", text: String(payload == null ? "" : payload) || "(kosong)" }];
  }

  // Jalankan satu tool. Mengembalikan { content: [...], isError, value }.
  async runTool(name, input, callId, signal) {
    return executeWorkspaceTool(this, name, input, callId, signal);
  }

  // Satu panggilan Messages API (streaming). Mengisi run.queue dan mengembalikan blok konten assistant + stop_reason.
  async _callModel(run, tools, system) {
    const thinking = this.thinkingOn();
    const effort = String(this.params.effort || "").trim().toLowerCase();
    let useEffort = !!effort && ["", "off", "default", "auto"].indexOf(effort) === -1 && !this.effortUnsupported;
    let maxTokens = parseInt(this.params.max_tokens, 10) || (thinking ? 24000 : 8192);
    let budget = thinking ? Math.max(1024, Math.min(parseInt(this.params.thinking_budget, 10) || 10000, maxTokens - 2000)) : 0;
    // Model baru (Claude 4.7+) memakai thinking "adaptive" + output_config.effort;
    // model lama memakai "enabled" + budget_tokens. Coba adaptive dulu, lalu jatuh ke
    // enabled bila API menolak; gaya yang berhasil diingat per agent.
    let style = this.thinkingStyle || "adaptive";
    let flips = 0;
    // Context 1M token (beta) bila dipilih pengguna dan model mendukung.
    const ctx = String(this.params.context || "").trim().toLowerCase();
    let use1m = /^(1m|1000k|1000000|large|long)$/.test(ctx) && !this.ctx1mUnsupported;
    const build = () => {
      this.applyMessageCache(this.messages);
      const body = { model: this.modelId, max_tokens: maxTokens, system, messages: this.messages, tools, stream: true };
      if (thinking) body.thinking = style === "adaptive" ? { type: "adaptive" } : { type: "enabled", budget_tokens: budget };
      if (useEffort) body.output_config = { effort };
      return body;
    };
    const headers = () => (use1m ? { "anthropic-beta": CONTEXT_1M_BETA } : {});
    let attempt = 0;
    for (;;) {
      if (run.cancelled) return { blocks: [], stopReason: "cancelled" };
      let res;
      try { res = await apiFetch(this.apiKey, "/v1/messages", { method: "POST", headers: headers(), body: JSON.stringify(build()) }, run.ac.signal); }
      catch (e) {
        if (run.cancelled) return { blocks: [], stopReason: "cancelled" };
        if (attempt++ < 3) { await sleep(800 * attempt); continue; }
        throw new Error("Gagal menghubungi Anthropic API: " + (e.message || e));
      }
      if (!res.ok) {
        const err = await readError(res);
        const msg = err.message || "";
        if (res.status === 400 && thinking && /thinking/i.test(msg) && flips < 2) {
          if (style === "adaptive" && /enabled|budget/i.test(msg)) { style = "enabled"; this.thinkingStyle = style; flips++; continue; }
          if (style === "enabled" && /adaptive/i.test(msg)) { style = "adaptive"; this.thinkingStyle = style; flips++; continue; }
        }
        // Model ini tidak mengenal output_config.effort: kirim ulang tanpa effort.
        if (res.status === 400 && useEffort && /output_config|effort/i.test(msg)) { useEffort = false; this.effortUnsupported = true; continue; }
        // Context 1M tidak tersedia untuk model/akun ini: kirim ulang tanpa header beta.
        if ((res.status === 400 || res.status === 403) && use1m && /context|beta|1m|long/i.test(msg)) { use1m = false; this.ctx1mUnsupported = true; continue; }
        // max_tokens terlalu besar untuk model ini: kecilkan dan coba lagi sekali.
        if (res.status === 400 && /max_tokens/i.test(msg) && maxTokens > 8192) { maxTokens = 8192; budget = thinking ? Math.min(budget, 4000) : 0; continue; }
        if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt++ < 4) { await sleep(1500 * attempt); continue; }
        throw err;
      }
      const blocks = []; // konten assistant yang sedang dibangun (index -> blok)
      let stopReason = null;
      let inTokens = 0, outTokens = 0, cacheRead = 0, cacheWrite = 0;
      let streamErr = null;
      for await (const ev of sseEvents(res)) {
        const d = ev.data;
        const t = d && d.type;
        if (t === "message_start") {
          const u = (d.message && d.message.usage) || {};
          inTokens = u.input_tokens || 0; cacheRead = u.cache_read_input_tokens || 0; cacheWrite = u.cache_creation_input_tokens || 0;
        } else if (t === "content_block_start") {
          const cb = d.content_block || {};
          const b = { type: cb.type };
          if (cb.type === "text") b.text = cb.text || "";
          else if (cb.type === "thinking") { b.thinking = cb.thinking || ""; b.signature = ""; }
          else if (cb.type === "redacted_thinking") b.data = cb.data;
          else if (cb.type === "tool_use") { b.id = cb.id; b.name = cb.name; b.input = {}; b._json = ""; }
          blocks[d.index] = b;
        } else if (t === "content_block_delta") {
          const b = blocks[d.index]; const dl = d.delta || {};
          if (!b) continue;
          if (dl.type === "text_delta") { b.text += dl.text || ""; if (dl.text) run.push({ type: "assistant", text: dl.text }); }
          else if (dl.type === "thinking_delta") { b.thinking += dl.thinking || ""; if (dl.thinking) run.push({ type: "thinking", text: dl.thinking }); }
          else if (dl.type === "signature_delta") b.signature = (b.signature || "") + (dl.signature || "");
          else if (dl.type === "input_json_delta") b._json += dl.partial_json || "";
        } else if (t === "content_block_stop") {
          const b = blocks[d.index];
          if (b && b.type === "tool_use") {
            try { b.input = b._json ? JSON.parse(b._json) : {}; } catch (e) { b.input = { _raw: b._json }; }
            delete b._json;
            // Kartu tool "running" muncul segera setelah argumen lengkap.
            run.push(this._toolEvent(b, "running", null));
          }
        } else if (t === "message_delta") {
          if (d.delta && d.delta.stop_reason) stopReason = d.delta.stop_reason;
          if (d.usage && typeof d.usage.output_tokens === "number") outTokens = d.usage.output_tokens;
        } else if (t === "error") {
          streamErr = new Error("Anthropic stream error: " + ((d.error && d.error.message) || JSON.stringify(d)));
        }
      }
      if (streamErr) {
        if (/overloaded/i.test(streamErr.message) && attempt++ < 3 && !blocks.some((b) => b && b.type === "tool_use")) { await sleep(1500 * attempt); continue; }
        throw streamErr;
      }
      run.push({ type: "usage", usage: { inputTokens: inTokens, outputTokens: outTokens, totalTokens: inTokens + outTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } });
      return { blocks: blocks.filter(Boolean), stopReason: stopReason || "end_turn" };
    }
  }

  _toolEvent(b, status, result) {
    const isCustom = !!this.customTools[b.name];
    const ev = {
      type: "tool_call",
      call_id: b.id,
      name: isCustom ? "mcp" : b.name,
      args: isCustom ? { toolName: b.name, args: b.input || {} } : (b.input || {}),
      status,
    };
    if (result) ev.result = result;
    return ev;
  }

  // Riwayat panjang: hasil tool lama dipadatkan supaya konteks tidak meledak di tugas panjang.
  // Blok terakhir tetap utuh (dipakai model saat ini); yang lebih tua diringkas.
  compactHistory() {
    const size = (m) => { try { return JSON.stringify(m.content).length; } catch (e) { return 0; } };
    let total = this.messages.reduce((n, m) => n + size(m), 0);
    if (total < HISTORY_CHARS_SOFT) return;
    const keepTail = 6; // tiga putaran tool terakhir tidak disentuh
    for (let i = 0; i < this.messages.length - keepTail && total > HISTORY_CHARS_TARGET; i++) {
      const m = this.messages[i];
      if (!Array.isArray(m.content)) continue;
      let changed = false;
      m.content = m.content.map((b) => {
        if (!b || b.type !== "tool_result") return b;
        const txt = Array.isArray(b.content) ? b.content.map((x) => (x && x.type === "text") ? x.text : "").join("\n") : String(b.content || "");
        if (txt.length <= 600) return b;
        changed = true;
        return Object.assign({}, b, { content: [{ type: "text", text: txt.slice(0, 400) + "\n\u2026(older tool output compacted; re-read if needed)\u2026\n" + txt.slice(-150) }] });
      });
      if (changed) total = this.messages.reduce((n, mm) => n + size(mm), 0);
    }
  }

  async _exec(run, payload) {
    // Buang thinking blok lama agar hemat token (Anthropic mengabaikannya juga).
    this.messages = AnthropicAgent.sanitizeHistory(this.messages);
    this.messages.push({ role: "user", content: this.userContent(payload) });
    const tools = this.toolDefs();
    const system = this.systemPrompt();
    const failStreak = {}; // tool+args -> jumlah gagal berturut-turut (deteksi berputar-putar)
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (run.cancelled) { run.status = "cancelled"; return; }
      this.compactHistory();
      const { blocks, stopReason } = await this._callModel(run, tools, system);
      if (run.cancelled) { run.status = "cancelled"; return; }
      // Simpan giliran assistant apa adanya (termasuk thinking+signature bila ada, wajib saat tool use).
      const assistantContent = blocks.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text || "" };
        if (b.type === "thinking") return { type: "thinking", thinking: b.thinking || "", signature: b.signature || "" };
        if (b.type === "redacted_thinking") return { type: "redacted_thinking", data: b.data };
        if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input || {} };
        return null;
      }).filter((b) => b && !(b.type === "text" && !b.text));
      if (!assistantContent.length) assistantContent.push({ type: "text", text: "" });
      this.messages.push({ role: "assistant", content: assistantContent });

      const uses = blocks.filter((b) => b.type === "tool_use");
      if (stopReason !== "tool_use" || !uses.length) {
        if (stopReason === "max_tokens") run.push({ type: "assistant", text: "\n\n_(reply cut off: token limit reached)_" });
        run.status = "finished";
        return;
      }
      // Jalankan tool berurutan (aman untuk edit file & shell).
      const results = [];
      for (const b of uses) {
        if (run.cancelled) break;
        let r, isError = false;
        try { r = await this.runTool(b.name, b.input, b.id, run.ac.signal); isError = !!r.isError; }
        catch (e) { r = { content: [{ type: "text", text: "Error: " + ((e && e.message) || String(e)) }] }; isError = true; }
        // Shell dengan exit code bukan nol dihitung sebagai kegagalan untuk deteksi pengulangan.
        const failed = isError || (String(b.name).toLowerCase() === "shell" && r.value && typeof r.value.exitCode === "number" && r.value.exitCode !== 0);
        let sig = "";
        try { sig = String(b.name) + ":" + JSON.stringify(b.input || {}); } catch (e) { sig = String(b.name); }
        if (failed) {
          failStreak[sig] = (failStreak[sig] || 0) + 1;
          if (failStreak[sig] >= 2) {
            r.content = (r.content || []).concat([{ type: "text", text: "\n[System note] Tool " + b.name + " has failed " + failStreak[sig] +
              " times with identical arguments. Do not repeat it; re-read the relevant context, change approach, or report the blocker to the user." }]);
          }
        } else delete failStreak[sig];
        const content = (r.content || []).map((c) => {
          if (c && c.type === "image" && c.data) return { type: "image", source: { type: "base64", media_type: c.mimeType || "image/jpeg", data: c.data } };
          if (c && c.type === "text") return { type: "text", text: cap(c.text, MAX_OUTPUT_CHARS) };
          return null;
        }).filter(Boolean);
        if (!content.length) content.push({ type: "text", text: "(no output)" });
        results.push({ type: "tool_result", tool_use_id: b.id, content, is_error: isError || undefined });
        const value = r.value != null ? r.value : { content: r.content, isError };
        run.push(this._toolEvent(b, isError ? "error" : "completed", { status: isError ? "error" : "success", value }));
      }
      if (run.cancelled) { run.status = "cancelled"; return; }
      this.messages.push({ role: "user", content: results });
    }
    run.push({ type: "assistant", text: "\n\n_(stopped: limit of " + MAX_TOOL_ROUNDS + " tool rounds per message reached; send \u201ccontinue\u201d to keep going)_" });
    run.status = "finished";
  }
}

// Tool workspace dipakai bersama provider Grok (lib/grok-agent.js).
async function executeWorkspaceTool(ctx, name, input, callId, signal) {
  const ws = ctx.workspace;
  input = (input && typeof input === "object") ? input : {};
  const lname = String(name).toLowerCase();
  if (ctx.customTools && ctx.customTools[name]) {
    const r = await ctx.customTools[name].execute(input, { toolCallId: callId });
    const content = (r && Array.isArray(r.content)) ? r.content : [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r || {}) }];
    return { content, isError: !!(r && r.isError), value: { content, isError: !!(r && r.isError), structuredContent: r && r.structuredContent } };
  }
  switch (lname) {
    case "read": return { content: [{ type: "text", text: ws.read(input) }] };
    case "write": { const r = ws.write(input); return { content: [{ type: "text", text: r.text }], value: r.value }; }
    case "edit": { const r = ws.edit(input); return { content: [{ type: "text", text: r.text }], value: r.value }; }
    case "delete": return { content: [{ type: "text", text: ws.delete(input) }] };
    case "ls": return { content: [{ type: "text", text: ws.ls(input) }] };
    case "glob": return { content: [{ type: "text", text: ws.glob(input) }] };
    case "grep": return { content: [{ type: "text", text: ws.grep(input) }] };
    case "shell": {
      const r = await ws.shell(input, signal);
      const txt = (r.stdout || "") + (r.stderr ? (r.stdout ? "\n" : "") + "[stderr]\n" + r.stderr : "") + "\n[exit code " + r.exitCode + "]";
      return { content: [{ type: "text", text: txt.trim() }], value: r, isError: false };
    }
    case "updatetodos": {
      const list = Array.isArray(input.todos) ? input.todos : [];
      let out;
      if (input.merge && ctx.todos && ctx.todos.length) {
        out = ctx.todos.map((t) => ({ content: t.content, status: t.status }));
        list.forEach((u) => { const hit = out.find((t) => t.content === u.content); if (hit) hit.status = u.status; else out.push({ content: String(u.content || ""), status: String(u.status || "pending") }); });
      } else out = list.map((u) => ({ content: String(u.content || ""), status: String(u.status || "pending") }));
      ctx.todos = out;
      return { content: [{ type: "text", text: "Todos updated (" + out.length + " items)." }], value: { todos: out } };
    }
    case "webfetch": return { content: [{ type: "text", text: await ws.webFetch(input, signal) }] };
    default: throw new Error("Unknown tool: " + name);
  }
}

AnthropicAgent.Workspace = Workspace;
AnthropicAgent.builtinTools = builtinTools;
AnthropicAgent.executeWorkspaceTool = executeWorkspaceTool;
AnthropicAgent.cap = cap;
module.exports = AnthropicAgent;
