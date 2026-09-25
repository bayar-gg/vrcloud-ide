"use strict";

/**
 * AI Agent backend memakai Cursor SDK (@cursor/sdk).
 *
 * Bukan sekadar chat: setiap permintaan dijalankan oleh agent yang punya
 * tool workspace (baca/edit file, shell, pencarian, web). Untuk tugas, agent
 * menyusun rencana (todo), mengerjakannya, dan server melanjutkan otomatis
 * selama masih ada todo yang belum selesai — tanpa perintah satu per satu.
 *
 * Satu agent Cursor per percakapan (sessionId), dibagi semua browser/tab.
 * Run tidak dibatalkan saat klien putus (refresh / ganti browser) — hanya
 * tombol Stop yang memanggil cancel(). Riwayat percakapan disimpan di disk
 * supaya panel AI sama di setiap browser.
 *
 * Provider: Cursor SDK (default), Anthropic Claude langsung (lib/anthropic-agent.js),
 * atau Grok lewat login akun xAI (lib/grok-agent.js + lib/grok-auth.js). Antarmuka
 * agent sama sehingga UI/kartu/checkpoint identik.
 *
 * Env:
 *   CURSOR_API_KEY     kunci API Cursor
 *   ANTHROPIC_API_KEY  kunci API Anthropic (Claude)
 *   AI_PROVIDER        "cursor" | "anthropic" | "grok" (default: otomatis dari key / sesi)
 *   AI_MODEL           id model (default: "auto")
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AnthropicAgent = require("./anthropic-agent");
const GrokAgent = require("./grok-agent");
const GrokAuth = require("./grok-auth");
const ProjectContext = require("./project-context");
const Instructions = require("./agent-instructions"); // semua teks instruksi agent (satu file)
const BgProcs = require("./bg-procs");

const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const IMAGE_FILE_RE = /^[a-f0-9]{40}\.(png|jpg|gif|webp)$/;

let sdk = null;
let sdkError = "";
try {
  sdk = require("@cursor/sdk");
} catch (e) {
  sdkError = (e && e.message) || String(e);
}

// Tipe blok/pesan yang dianggap "thinking/reasoning".
function isThink(t) {
  return t === "thinking" || t === "reasoning" || t === "redacted_thinking" ||
    t === "thinkingMessage" || t === "thinkingDelta" || t === "reasoningDelta";
}

function normName(n) { return String(n || "").toLowerCase().replace(/[^a-z]/g, ""); }

// Tool MCP (termasuk custom tools kita): nama tool sebenarnya ada di args.toolName.
function mcpToolName(ev) {
  var a = ev && ev.args;
  if (!a || typeof a !== "object") return "";
  return String(a.toolName || a.tool_name || a.name || "");
}
function mcpArgs(ev) {
  var a = ev && ev.args;
  if (!a || typeof a !== "object") return {};
  if (a.args && typeof a.args === "object") return a.args;
  return a;
}
function mcpResultText(ev) {
  var r = ev && ev.result;
  if (!r || typeof r !== "object") return "";
  var v = r.value || r;
  if (v && Array.isArray(v.content)) {
    return v.content.map(function (c) {
      if (!c) return "";
      if (c.text && typeof c.text === "object") return c.text.text || "";
      if (typeof c.text === "string") return c.text;
      if (c.type === "text" && c.text) return c.text;
      return c.image ? "[gambar]" : "";
    }).filter(Boolean).join("\n");
  }
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch (e) { return ""; }
}

// Ringkasan singkat dari argumen tool call (mis. command/path/query).
function toolSummary(ev) {
  var a = ev && ev.args;
  if (normName(ev && ev.name) === "mcp") {
    var ma = mcpArgs(ev);
    var mk = ["to", "subject", "title", "url", "query", "prompt", "method", "message", "secret", "ref", "text_match", "selector", "from_ref", "label", "value", "paths", "text", "key", "direction", "device", "format", "path", "action", "id", "expression", "level", "url_contains", "type"];
    for (var k = 0; k < mk.length; k++) {
      var mv = ma[mk[k]];
      if (mv != null && mv !== "") { var ms = String(mv); return ms.length > 160 ? ms.slice(0, 160) + "\u2026" : ms; }
    }
    return "";
  }
  if (a && typeof a === "object") {
    var keys = ["command", "cmd", "path", "file_path", "filePath", "relativePath", "relative_path", "relativeWorkspacePath",
      "target_file", "targetFile", "target_directory", "targetDirectory", "directory", "dir", "file",
      "target", "pattern", "globPattern", "glob_pattern", "glob", "query", "url", "name", "explanation"];
    for (var i = 0; i < keys.length; i++) {
      var v = a[keys[i]];
      if (v != null && v !== "" && typeof v !== "object") { var s = String(v); return s.length > 200 ? s.slice(0, 200) + "\u2026" : s; }
    }
    // Key tak dikenal: pakai nilai string pertama, bukan JSON mentah.
    for (var k in a) {
      if (typeof a[k] === "string" && a[k].trim()) { var s2 = a[k]; return s2.length > 200 ? s2.slice(0, 200) + "\u2026" : s2; }
    }
    try { var j = JSON.stringify(a); if (j === "{}") return ""; return j.length > 160 ? j.slice(0, 160) + "\u2026" : j; } catch (e) {}
  }
  return "";
}

// Ambil nilai sukses dari result tool call (bentuk {status,value} atau langsung).
function resultValue(r) {
  if (!r || typeof r !== "object") return null;
  if (r.status === "success" && r.value) return r.value;
  if (typeof r.stdout === "string") return r;
  if (r.value && typeof r.value === "object") return r.value;
  return r;
}
function extLang(p) { var m = String(p || "").toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ""; }
function capText(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "\n\u2026(dipotong)" : s; }

// Detail lengkap untuk kartu tool: kode yang diedit / command + output.
function toolDetail(ev) {
  var name = String(ev.name || "").toLowerCase();
  var a = ev.args || {};
  var out = { detail: "", lang: "" };
  if (name === "mcp") {
    var rt = mcpResultText(ev);
    // Tool browser: detail = teks hasil saja (snapshot/console/network); screenshot ditampilkan kartu.
    if (/^browser_/i.test(mcpToolName(ev))) {
      // URL/judul sudah ada di bilah alamat kartu; placeholder gambar tidak perlu.
      var bt = rt.replace(/^\[gambar\]\s*$/gm, "").replace(/^(URL|Judul): .*$/gm, "").replace(/\n{2,}/g, "\n").trim();
      out.detail = capText(bt, 12000); out.lang = "text"; return out;
    }
    // Tool desktop_*: screenshot ditampilkan sebagai bingkai; buang placeholder [gambar] dari teks.
    if (/^desktop_/i.test(mcpToolName(ev))) {
      out.detail = capText(rt.replace(/^\[gambar\]\s*$/gm, "").replace(/\n{2,}/g, "\n").trim(), 4000); out.lang = "text"; return out;
    }
    var lines = [];
    try { lines.push("\u2192 " + mcpToolName(ev) + " " + JSON.stringify(mcpArgs(ev), null, 2)); } catch (e) {}
    if (rt) lines.push("", rt);
    out.detail = capText(lines.join("\n"), 8000); out.lang = "json"; return out;
  }
  if (name === "shell") {
    var text = "$ " + (a.command || "");
    var v = resultValue(ev.result);
    if (v) { if (v.stdout) text += "\n" + v.stdout; if (v.stderr) text += "\n" + v.stderr; }
    out.detail = capText(text, 8000); out.lang = "shell"; return out;
  }
  if (name === "edit" || name === "write" || name === "applyagentdiff" || name === "create") {
    var code = a.fileText || a.content || a.contents || a.text || a.newString || a.new_string ||
      a.code || a.code_edit || a.codeEdit || a.snippet || "";
    // Tool "edit" menaruh perubahan sebagai diff di result.value.diffString.
    if (!code) {
      var rv = resultValue(ev.result);
      if (rv && rv.diffString) code = rv.diffString;
    }
    if (!code && (a.oldString || a.old_string) && (a.newString || a.new_string)) {
      code = "- " + (a.oldString || a.old_string) + "\n+ " + (a.newString || a.new_string);
    }
    out.detail = capText(code, 8000);
    out.lang = extLang(a.path || a.relativeWorkspacePath || a.relative_workspace_path || a.file || a.filePath || "");
    return out;
  }
  try { out.detail = capText(JSON.stringify(a, null, 2), 4000); } catch (e) {}
  return out;
}

// Metadata ringkas: jumlah baris ditambah/dihapus (edit), exit code (shell).
function toolMeta(ev) {
  var name = String(ev.name || "").toLowerCase();
  var rv = resultValue(ev.result);
  var m = {};
  if (rv) {
    if (name === "edit" || name === "write" || name === "applyagentdiff" || name === "create") {
      if (typeof rv.linesAdded === "number") m.added = rv.linesAdded;
      if (typeof rv.linesRemoved === "number") m.removed = rv.linesRemoved;
    }
    if (name === "shell" && typeof rv.exitCode === "number") m.exit = rv.exitCode;
    if (name === "shell") {
      var pid = Number(rv.pid);
      if (!pid) { var pm = /(?:^|\b)pid\s+(\d+)/i.exec(String(rv.stdout || "")); if (pm) pid = Number(pm[1]); }
      if (pid > 1) m.pid = pid;
    }
    if (name === "mcp" && rv && rv.isError) m.isError = true;
  }
  // Screenshot desktop tidak diambil dari result tool. API Cursor menaruh byte JPEG mentah
  // di result (dan sering memotongnya). Kartu chat memakai file yang disimpan server.
  return m;
}

// Normalisasi daftar todo dari tool updateTodos/readTodos.
function normTodos(src) {
  if (!Array.isArray(src)) return null;
  return src.map(function (t) {
    if (!t) return null;
    var st = String(t.status || "pending");
    if (/in.?progress/i.test(st)) st = "inProgress";
    else if (/complete|done/i.test(st)) st = "completed";
    else if (/cancel/i.test(st)) st = "cancelled";
    else st = "pending";
    return { content: String(t.content || t.text || t.title || ""), status: st };
  }).filter(Boolean);
}

// Gabungkan pembaruan parsial (agent sering mengirim hanya item yang berubah)
// ke daftar sebelumnya. Hasil tool (bila ada) adalah daftar lengkap yang sah.
function todosFrom(ev, prev) {
  var rv = resultValue(ev && ev.result);
  var full = rv && Array.isArray(rv.todos) ? normTodos(rv.todos) : null;
  if (full && full.length) return full;
  var a = ev && ev.args;
  var upd = a && Array.isArray(a.todos) ? normTodos(a.todos) : null;
  if (!upd) return null;
  if (!prev || !prev.length || (a && a.merge === false)) return upd;
  var out = prev.map(function (t) { return { content: t.content, status: t.status }; });
  upd.forEach(function (u) {
    var hit = null;
    for (var i = 0; i < out.length; i++) { if (out[i].content === u.content) { hit = out[i]; break; } }
    if (hit) hit.status = u.status; else out.push(u);
  });
  return out;
}

function todosDone(todos) {
  if (!todos || !todos.length) return true;
  return todos.every(function (t) { return t.status === "completed" || t.status === "cancelled"; });
}

function addUsage(a, b) {
  a = a || {}; b = b || {};
  const out = Object.assign({}, a);
  ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].forEach((k) => {
    if (typeof b[k] === "number") out[k] = (typeof a[k] === "number" ? a[k] : 0) + b[k];
  });
  return out;
}

function trimTool(t) {
  return {
    callId: t.callId, name: t.name, tool: t.tool, status: t.status, summary: t.summary,
    lang: t.lang, meta: t.meta,
    detail: t.detail ? String(t.detail).slice(0, 2000) : undefined,
  };
}

// Susun urutan blok kronologis (think/text/tool/plan/iter) dari frame live,
// untuk direplay UI persis seperti saat streaming.
function blocksFrom(frames) {
  const blocks = [];
  const toolAt = {};
  let planAt = -1;
  (frames || []).forEach(function (f, i) {
    const last = blocks[blocks.length - 1];
    if (f.kind === "text" || f.kind === "think") {
      const v = String(f.val == null ? "" : f.val);
      if (!v) return;
      if (last && last.type === f.kind) last.text += v;
      else blocks.push({ type: f.kind, text: v });
      return;
    }
    if (f.kind === "tool" && f.val) {
      const key = f.val.callId || ("k" + i);
      if (toolAt[key] != null) {
        const t = blocks[toolAt[key]].tool;
        t.status = f.val.status;
        if (f.val.summary) t.summary = f.val.summary;
        if (f.val.name) t.name = f.val.name;
        if (f.val.tool) t.tool = f.val.tool;
        if (f.val.detail) t.detail = f.val.detail;
        if (f.val.lang) t.lang = f.val.lang;
        if (f.val.meta && Object.keys(f.val.meta).length) t.meta = f.val.meta;
      } else {
        toolAt[key] = blocks.length;
        blocks.push({ type: "tool", tool: Object.assign({}, f.val) });
      }
      return;
    }
    if (f.kind === "plan" && Array.isArray(f.val)) {
      // Rencana ditempatkan pada posisi pembaruan TERAKHIR (mengikuti progres), bukan pertama.
      if (planAt >= 0) { blocks.splice(planAt, 1); Object.keys(toolAt).forEach((k) => { if (toolAt[k] > planAt) toolAt[k]--; }); }
      planAt = blocks.length; blocks.push({ type: "plan", todos: f.val });
      return;
    }
    if (f.kind === "iter" && f.val) blocks.push({ type: "iter", n: f.val.n, max: f.val.max });
    if (f.kind === "approval" && f.val) {
      const ex = blocks.find((b) => b.type === "approval" && b.id === f.val.id);
      if (ex) ex.status = f.val.status;
      else blocks.push({ type: "approval", id: f.val.id, command: f.val.command, pattern: f.val.pattern, status: f.val.status });
    }
  });
  return blocks.map(function (b) {
    if (b.type === "tool") return { type: "tool", tool: trimTool(b.tool) };
    if (b.type === "think") return { type: "think", text: b.text.slice(0, 20000) };
    return b;
  });
}

// Path file yang disentuh tool edit/write/delete (relatif workspace, pemisah '/').
function toolPaths(ev, workspace) {
  const nn = normName(ev && ev.name);
  if (!/^(edit|write|create|delete|applyagentdiff|multiedit|strreplace|searchreplace|applypatch|notebookedit|editnotebook)$/.test(nn)) return [];
  const a = (ev && ev.args) || {};
  const cands = [a.path, a.relativeWorkspacePath, a.relative_workspace_path, a.relativePath, a.relative_path, a.file_path, a.filePath, a.file, a.target_file, a.targetFile];
  if (Array.isArray(a.paths)) cands.push.apply(cands, a.paths);
  if (Array.isArray(a.edits)) a.edits.forEach((e) => { if (e) cands.push(e.path, e.file_path, e.relativeWorkspacePath); });
  const out = [];
  cands.forEach((c) => {
    if (!c || typeof c !== "string") return;
    let p = c.replace(/\\/g, "/");
    const ws = String(workspace || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (ws && p.toLowerCase().indexOf(ws.toLowerCase() + "/") === 0) p = p.slice(ws.length + 1);
    else if (/^([a-z]:)?\//i.test(p)) return; // absolut di luar workspace
    p = p.replace(/^\.\//, "").replace(/^\/+/, "");
    if (p && p.indexOf("..") === -1 && out.indexOf(p) === -1) out.push(p);
  });
  return out;
}

const DEFAULT_GUARD_PATTERNS = [
  "\\brm\\s+-[a-z]*(rf|fr)[a-z]*\\b", "\\brm\\s+-r[a-z]*\\s+(/|~|\\*|\\.\\.)(\\s|$)", "\\bsudo\\s+rm\\b",
  "\\b(del|erase)\\b.*\\s/[sq]\\b", "\\brmdir\\s+/s\\b", "\\brd\\s+/s\\b", "\\bRemove-Item\\b.*-Recurse",
  "\\bmkfs\\b", "\\bdd\\s+if=", "\\bformat\\s+[a-z]:", "\\bFormat-Volume\\b", "\\bdiskpart\\b", ">\\s*/dev/sd",
  "\\bgit\\s+push\\b.*(--force|\\s-f\\b)", "\\bgit\\s+reset\\s+--hard\\b", "\\bgit\\s+clean\\s+-[a-z]*f", "\\bgit\\s+branch\\s+-D\\b", "\\bgit\\s+checkout\\s+--\\s+\\.",
  "\\b(drop|truncate)\\s+(database|table|schema)\\b",
  "\\b(shutdown|reboot|poweroff|halt)\\b", "\\b(Stop|Restart)-Computer\\b",
  "\\bchmod\\s+-R\\s+777\\b", "\\bchown\\s+-R\\b",
  ":\\(\\)\\s*\\{[^}]*:\\|:",
  "\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z)?sh\\b",
  "\\bnpm\\s+publish\\b", "\\bkill\\s+-9\\s+-1\\b", "\\bpkill\\b", "\\btaskkill\\b.*/f",
];

// Keadaan run yang sedang berjalan (frame untuk klien yang menyambung ulang, dsb.).
function newLive() {
  return { frames: [], text: "", think: "", tools: [], plan: null, usage: null, touched: [] };
}

// Pesan error yang layak ditampilkan: status HTTP + teks dari provider (API key salah, kuota, dll).
function explainError(e) {
  if (!e) return "Unknown error";
  const bits = [];
  const status = e.status || e.statusCode || (e.response && e.response.status);
  if (status) bits.push("HTTP " + status);
  const msg = e.message || (e.error && (e.error.message || (typeof e.error === "string" ? e.error : ""))) || e.error_description || "";
  if (msg) bits.push(String(msg));
  const body = typeof e.body === "string" ? e.body : (e.response && typeof e.response.body === "string" ? e.response.body : "");
  if (body && bits.join("\n").indexOf(body.slice(0, 80)) === -1) bits.push(body.slice(0, 1200));
  const cause = e.cause && (e.cause.message || (typeof e.cause === "string" ? e.cause : ""));
  if (cause && bits.join("\n").indexOf(String(cause)) === -1) bits.push(String(cause));
  const out = bits.filter(Boolean).join("\n").trim() || String(e);
  return out.length > 2000 ? out.slice(0, 2000) + "\u2026" : out;
}

class AiChat {
  constructor(options) {
    options = options || {};
    this.workspace = options.workspace || process.cwd();
    this.configFile = options.configFile || "";
    // Integrasi IDE: notifikasi perubahan file (agent mengedit) & checkpoint.
    this.onFsChange = typeof options.onFsChange === "function" ? options.onFsChange : null;
    // Konteks editor dari IDE: () => { active, open: [] } (path relatif) untuk prompt agent.
    this.openFiles = typeof options.openFiles === "function" ? options.openFiles : null;
    // Notifikasi ke IDE (lewat hub realtime): run mulai/selesai, daftar sesi berubah,
    // dan perintah shell agent (untuk tab "Agent shell" view-only di semua browser).
    this.onNotify = typeof options.onNotify === "function" ? options.onNotify : null;
    this.onShell = typeof options.onShell === "function" ? options.onShell : null;
    // Tool tambahan in-process untuk agent (SDK customTools), mis. otomasi browser.
    this.customTools = options.customTools || null;
    this.browser = options.browser || null; // BrowserAutomation: metadata langkah (screenshot) untuk kartu chat
    this.desktopStatus = typeof options.desktopStatus === "function" ? options.desktopStatus : null; // () => DesktopRemote.status()
    this.desktopShot = typeof options.desktopShot === "function" ? options.desktopShot : null; // (callId) => URL JPEG yang disimpan server
    this.checkpoints = options.checkpoints || null;
    this.approvals = new Map(); // id -> { resolve, sessionId, timer }
    // Nilai default dari environment; dapat ditimpa konfigurasi web (file).
    this.envKey = options.apiKey || process.env.CURSOR_API_KEY || "";
    this.envAnthropicKey = options.anthropicKey || process.env.ANTHROPIC_API_KEY || "";
    this.envProvider = String(options.provider || process.env.AI_PROVIDER || "").trim().toLowerCase();
    this.envModel = options.model || process.env.AI_MODEL || "auto";
    this.saved = {}; // { apiKey?, anthropicKey?, provider?, model? } tersimpan lewat web
    this.apiKey = this.envKey;
    this.anthropicKey = this.envAnthropicKey;
    this.grokAuth = options.grokAuth || new GrokAuth({
      file: options.grokAuthFile || (options.configFile ? path.join(path.dirname(options.configFile), "grok-session.json") : ""),
      secret: options.authSecret || process.env.AUTH_SECRET || "",
    });
    this.provider = "cursor";
    this.model = this.envModel;
    this.sessions = new Map(); // sessionId -> runtime { agent, busy, listeners, live, ... }
    this.idleMs = 30 * 60 * 1000;
    this.histMax = 120;
    // Maks putaran "lanjutkan" otomatis per pesan bila todo belum selesai.
    this.autoMaxIter = Math.max(1, parseInt(options.autoMaxIter, 10) || 8);
    this.storeFile = options.storeFile || (this.configFile
      ? path.join(path.dirname(this.configFile), "ai-sessions.json") : "");
    this.store = { sessions: [] }; // [{id,title,updatedAt,messages}]
    this.loadConfig();
    this.loadStore();
    const timer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  newId() {
    return "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // Muat riwayat. Gagal baca sesaat (EBUSY/EPERM di Windows saat antivirus/indexer
  // memegang file) dicoba ulang; file yang rusak dicadangkan, bukan ditimpa diam-diam.
  loadStore() {
    if (!this.storeFile) return;
    if (!fs.existsSync(this.storeFile)) return;
    let raw = null, lastErr = null;
    for (let i = 0; i < 5 && raw == null; i++) {
      try { raw = fs.readFileSync(this.storeFile, "utf8"); }
      catch (e) { lastErr = e; const until = Date.now() + 150; while (Date.now() < until) { /* tunggu sebentar (sinkron, hanya saat start) */ } }
    }
    if (raw == null) {
      // Jangan pernah menimpa file yang tidak terbaca: simpan ke file lain sampai server di-restart.
      console.warn("[ai] ai-sessions.json tidak terbaca (" + (lastErr && lastErr.message) + "); riwayat baru disimpan ke ai-sessions.recovery.json");
      this.storeFile = this.storeFile.replace(/\.json$/, ".recovery.json");
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sessions)) this.store = { sessions: parsed.sessions };
    } catch (e) {
      const bak = this.storeFile.replace(/\.json$/, ".corrupt-" + Date.now() + ".json");
      try { fs.copyFileSync(this.storeFile, bak); } catch (e2) {}
      console.warn("[ai] ai-sessions.json rusak (" + e.message + "); salinan disimpan ke " + path.basename(bak));
    }
  }

  // Gambar tempel disimpan sebagai file di data/ai-images/<sha1>.<ext>, bukan base64
  // di dalam ai-sessions.json — kalau tidak, setiap saveStore() men-serialize
  // megabyte gambar secara sinkron dan makin lambat seiring riwayat bertambah.
  imagesDir() { return this.storeFile ? path.join(path.dirname(this.storeFile), "ai-images") : null; }
  persistImages(images) {
    const dir = this.imagesDir();
    return images.map((im) => {
      const rec = { mimeType: im.mimeType, name: im.name || "" };
      const ext = IMAGE_EXT[String(im.mimeType || "").toLowerCase()];
      if (!dir || !ext) return Object.assign(rec, { data: im.data });
      try {
        fs.mkdirSync(dir, { recursive: true });
        const buf = Buffer.from(String(im.data), "base64");
        const file = crypto.createHash("sha1").update(buf).digest("hex") + "." + ext;
        const abs = path.join(dir, file);
        if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
        return Object.assign(rec, { image: "/api/ai/image/" + file });
      } catch (e) { return Object.assign(rec, { data: im.data }); }
    });
  }
  // Path absolut file gambar tersimpan (untuk rute /api/ai/image/:file); null bila nama tidak valid.
  imagePath(file) {
    const dir = this.imagesDir();
    if (!dir || !IMAGE_FILE_RE.test(String(file || ""))) return null;
    return path.join(dir, file);
  }

  saveStore() {
    if (!this.storeFile) return;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const tmp = this.storeFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.store), "utf8");
      fs.renameSync(tmp, this.storeFile);
      if (process.platform !== "win32") { try { fs.chmodSync(this.storeFile, 0o600); } catch (e) {} }
    } catch (e) { /* abaikan kegagalan tulis */ }
  }

  meta(id) {
    let m = this.store.sessions.find((s) => s.id === id);
    if (!m) {
      m = { id: id, title: "Chat baru", updatedAt: Date.now(), messages: [] };
      this.store.sessions.unshift(m);
    }
    return m;
  }

  touchMeta(id, title) {
    const m = this.meta(id);
    if (title) m.title = title;
    m.updatedAt = Date.now();
    this.store.sessions = this.store.sessions.filter((s) => s.id !== id);
    this.store.sessions.unshift(m);
    return m;
  }
  notify(event, extra) {
    if (!this.onNotify) return;
    try { this.onNotify(Object.assign({ event }, extra || {})); } catch (e) { /* IDE tidak wajib mendengar */ }
  }

  titleFrom(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "Chat baru";
    return t.length > 42 ? t.slice(0, 42) + "\u2026" : t;
  }

  runtime(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { agent: null, busy: false, lastUsed: Date.now(), run: null, listeners: new Set(), live: null };
      this.sessions.set(sessionId, s);
    }
    if (!s.listeners) s.listeners = new Set();
    return s;
  }

  isBusy(sessionId) {
    const s = this.sessions.get(sessionId);
    return !!(s && s.busy);
  }

  listSessions() {
    return this.store.sessions.map((m) => {
      const s = this.sessions.get(m.id);
      // Statistik perubahan file sepanjang percakapan (untuk daftar riwayat).
      let added = 0, removed = 0; const files = {};
      (m.messages || []).forEach((msg) => {
        (msg.changes || []).forEach((c) => { added += c.added || 0; removed += c.removed || 0; files[c.path] = 1; });
      });
      const nf = Object.keys(files).length;
      return {
        id: m.id, title: m.title, updatedAt: m.updatedAt, busy: !!(s && s.busy), usage: m.usage || undefined,
        stats: nf ? { added, removed, files: nf } : undefined,
      };
    });
  }

  getSession(id) {
    const m = this.store.sessions.find((s) => s.id === id);
    if (!m) return null;
    const s = this.sessions.get(id);
    return {
      id: m.id,
      title: m.title,
      updatedAt: m.updatedAt,
      messages: m.messages || [],
      busy: !!(s && s.busy),
      usage: m.usage || undefined,
      checkpoints: !!(this.checkpoints && this.checkpoints.available),
    };
  }

  renameSession(id, title) {
    const m = this.store.sessions.find((s) => s.id === id);
    if (!m) return null;
    const t = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
    if (t) m.title = t.length > 80 ? t.slice(0, 80) : t;
    this.saveStore();
    this.notify("sessions-changed", { sessionId: id });
    return { id: m.id, title: m.title };
  }

  // Simpan keputusan review (terima/tolak per file) pada pesan AI yang punya snapshot `after`.
  setReview(id, after, review) {
    const m = this.store.sessions.find((s) => s.id === id);
    if (!m) return null;
    const hash = String(after || "");
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) return null;
    const msg = (m.messages || []).slice().reverse().find((x) => x && x.role === "ai" && x.after === hash);
    if (!msg) return null;
    const out = {};
    Object.keys(review && typeof review === "object" ? review : {}).forEach((k) => {
      const v = review[k];
      if (v === "accepted" || v === "rejected") out[String(k).replace(/\\/g, "/").slice(0, 400)] = v;
    });
    msg.review = out;
    this.saveStore();
    return out;
  }

  createSession(id) {
    const sid = (id && String(id).trim()) || this.newId();
    this.meta(sid);
    this.saveStore();
    this.notify("sessions-changed", { sessionId: sid });
    return this.getSession(sid);
  }

  importSessions(list) {
    if (!Array.isArray(list)) return this.listSessions();
    list.forEach((c) => {
      if (!c || !c.id) return;
      let m = this.store.sessions.find((s) => s.id === c.id);
      const msgs = Array.isArray(c.messages) ? c.messages.slice(-this.histMax) : [];
      if (!m) {
        m = { id: String(c.id), title: c.title || "Chat", updatedAt: c.updatedAt || Date.now(), messages: msgs };
        this.store.sessions.push(m);
      } else if ((!m.messages || !m.messages.length) && msgs.length) {
        m.messages = msgs;
        if (c.title) m.title = c.title;
        if (c.updatedAt) m.updatedAt = c.updatedAt;
      }
    });
    this.store.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.saveStore();
    return this.listSessions();
  }

  recordLive(s, kind, val) {
    if (!s.live) s.live = newLive();
    s.live.frames.push({ kind: kind, val: val });
    if (kind === "text") s.live.text += String(val == null ? "" : val);
    else if (kind === "think") s.live.think += String(val == null ? "" : val);
    else if (kind === "plan") s.live.plan = val;
    else if (kind === "usage" && val) s.live.usage = val;
    else if (kind === "tool" && val) {
      const tools = s.live.tools;
      let t = null;
      for (let i = 0; i < tools.length; i++) {
        if (tools[i].callId && tools[i].callId === val.callId) { t = tools[i]; break; }
      }
      if (t) {
        t.status = val.status;
        if (val.summary) t.summary = val.summary;
        if (val.name) t.name = val.name;
        if (val.tool) t.tool = val.tool;
        if (val.detail) t.detail = val.detail;
        if (val.lang) t.lang = val.lang;
        if (val.meta && (val.meta.added != null || val.meta.removed != null || val.meta.exit != null || val.meta.isError)) t.meta = val.meta;
      } else {
        tools.push({
          callId: val.callId, name: val.name, tool: val.tool, status: val.status, summary: val.summary,
          detail: val.detail, lang: val.lang, meta: val.meta,
        });
      }
    }
  }

  broadcast(s, kind, val, idx) {
    s.listeners.forEach((fn) => {
      try { fn(kind, val, idx); } catch (e) { /* klien putus */ }
    });
  }

  // Langganan stream live. Replay frame yang sudah ada, lalu teruskan yang baru.
  // Putusnya klien hanya unsubscribe — run tetap jalan.
  subscribe(sessionId, onEvent) {
    const s = this.runtime(sessionId);
    const start = (s.live && s.live.frames) ? s.live.frames.length : 0;
    if (s.live && s.live.frames) {
      for (let i = 0; i < start; i++) {
        const f = s.live.frames[i];
        try { onEvent(f.kind, f.val); } catch (e) {}
      }
    }
    if (!s.busy) {
      try { onEvent("done", "idle"); } catch (e) {}
      return function () {};
    }
    const wrapped = function (kind, val, idx) {
      if (idx != null && idx < start) return;
      onEvent(kind, val);
    };
    s.listeners.add(wrapped);
    return function () { s.listeners.delete(wrapped); };
  }

  recompute() {
    this.apiKey = (this.saved.apiKey && String(this.saved.apiKey)) || this.envKey || "";
    this.anthropicKey = (this.saved.anthropicKey && String(this.saved.anthropicKey)) || this.envAnthropicKey || "";
    // Provider: pilihan web > AI_PROVIDER > otomatis (key / sesi Grok yang tersedia).
    const pv = String(this.saved.provider || this.envProvider || "").toLowerCase();
    if (pv === "anthropic" || pv === "cursor" || pv === "grok") this.provider = pv;
    else if (this.apiKey) this.provider = "cursor";
    else if (this.anthropicKey) this.provider = "anthropic";
    else if (this.grokAuth && this.grokAuth.connected()) this.provider = "grok";
    else this.provider = "cursor";
    this.model = (this.saved.model && String(this.saved.model)) || this.envModel || "auto";
    this.params = (this.saved.params && typeof this.saved.params === "object") ? this.saved.params : {};
    // Prompt caching (default aktif). Anthropic: cache breakpoint pada system/tools/pesan terakhir.
    // Cursor: dikelola otomatis oleh layanan Cursor (toggle hanya berpengaruh ke provider yang mendukung).
    this.promptCache = this.saved.promptCache !== false;
    // Memori proyek (.vrcloud-agent/memory.md) disisipkan ke prompt; bisa dimatikan dari pengaturan.
    this.memoryEnabled = this.saved.memory !== false;
    this.mode = this.saved.mode || "agent";
    this.browserTools = ["on", "off"].indexOf(this.saved.browserTools) !== -1 ? this.saved.browserTools : "auto";
    // Computer use (desktop_*): auto (agent memutuskan), on (utamakan GUI desktop), off (tool dimatikan).
    this.desktopTools = ["on", "off"].indexOf(this.saved.desktopTools) !== -1 ? this.saved.desktopTools : "auto";
    if (this.saved.autoMaxIter) this.autoMaxIter = Math.max(1, Math.min(30, parseInt(this.saved.autoMaxIter, 10) || 8));
  }
  // Tool browser tersedia untuk agent? (browser ada di server dan tidak dimatikan pengguna)
  browserOn() { return this.browserTools !== "off" && !!(this.browser && this.browser.exe); }
  // Remote desktop tersedia di server? (dari opsi desktopStatus, bila diberikan)
  desktopAvailable() { try { const s = this.desktopStatus ? this.desktopStatus() : null; return !s || s.ok !== false; } catch (e) { return true; } }
  desktopOn() { return this.desktopTools !== "off" && this.desktopAvailable(); }

  // ---- Pengaman perintah berbahaya ------------------------------------
  // Batas tunggu izin harus lebih pendek dari timeout hook di .vrcloud-agent/hooks.json
  // (900 s): kalau hook dibunuh Cursor lebih dulu, perintah justru DIIZINKAN.
  static get GUARD_TIMEOUT_MAX() { return 840; }
  getGuard() {
    const g = (this.saved.guard && typeof this.saved.guard === "object") ? this.saved.guard : {};
    return {
      enabled: g.enabled === true,
      patterns: Array.isArray(g.patterns) ? g.patterns : DEFAULT_GUARD_PATTERNS.slice(),
      timeoutSec: Math.min(AiChat.GUARD_TIMEOUT_MAX, Math.max(30, parseInt(g.timeoutSec, 10) || 300)),
      timeoutMax: AiChat.GUARD_TIMEOUT_MAX,
      isDefault: !Array.isArray(g.patterns),
    };
  }

  setGuard(input) {
    input = input || {};
    const g = Object.assign({}, (this.saved.guard && typeof this.saved.guard === "object") ? this.saved.guard : {});
    if (Object.prototype.hasOwnProperty.call(input, "enabled")) g.enabled = !!input.enabled;
    if (Object.prototype.hasOwnProperty.call(input, "patterns")) {
      if (input.patterns == null) delete g.patterns;
      else {
        const list = (Array.isArray(input.patterns) ? input.patterns : String(input.patterns).split(/\r?\n/))
          .map((p) => String(p).trim()).filter(Boolean);
        list.forEach((p) => { try { new RegExp(p, "i"); } catch (e) { throw new Error("Pola regex tidak valid: " + p); } });
        g.patterns = list;
      }
    }
    if (Object.prototype.hasOwnProperty.call(input, "timeoutSec")) {
      const n = parseInt(input.timeoutSec, 10);
      if (n >= 30) g.timeoutSec = Math.min(AiChat.GUARD_TIMEOUT_MAX, n); else delete g.timeoutSec;
    }
    this.saved.guard = g;
    this.saveConfig();
    return this.getGuard();
  }

  guardMatch(command) {
    const g = this.getGuard();
    if (!g.enabled) return null;
    const cmd = String(command || "");
    for (const p of g.patterns) {
      try { if (new RegExp(p, "i").test(cmd)) return p; } catch (e) { /* pola rusak: lewati */ }
    }
    return null;
  }

  // Hook beforeShellExecution: selalu izinkan. Tidak ada deny / kartu izin.
  async reviewShell() {
    return { permission: "allow" };
  }

  decideApproval(id, allow, by) {
    const entry = this.approvals.get(id);
    if (!entry) return false;
    this.approvals.delete(id);
    clearTimeout(entry.timer);
    const status = allow ? "allowed" : (by === "timeout" ? "timeout" : "denied");
    entry.sessionIds.forEach((sid) => {
      const s = this.sessions.get(sid);
      if (s) this.emitTo(s, "approval", Object.assign({}, entry.payload, { status }));
    });
    entry.resolve(!!allow);
    return true;
  }

  // Emit frame ke sebuah sesi (dicatat di live + broadcast ke listener).
  emitTo(s, kind, val) {
    if (!s.live) return;
    this.recordLive(s, kind, val);
    this.broadcast(s, kind, val, s.live.frames.length - 1);
    if (typeof s.onEvent === "function") { try { s.onEvent(kind, val); } catch (e) {} }
  }

  loadConfig() {
    if (this.configFile) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
        if (parsed && typeof parsed === "object") this.saved = parsed;
      } catch (e) { /* file belum ada / rusak: pakai env */ }
    }
    this.recompute();
  }

  saveConfig() {
    if (!this.configFile) return;
    try {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      const tmp = this.configFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2), "utf8");
      fs.renameSync(tmp, this.configFile);
      if (process.platform !== "win32") { try { fs.chmodSync(this.configFile, 0o600); } catch (e) {} }
    } catch (e) { /* abaikan kegagalan tulis */ }
  }

  // Perbarui konfigurasi dari web. Field yang tidak disertakan tidak diubah.
  // apiKey/model kosong ("") berarti hapus override -> kembali ke nilai .env.
  async setConfig(config) {
    config = config || {};
    let providerChanged = false;
    if (Object.prototype.hasOwnProperty.call(config, "provider")) {
      const p = String(config.provider == null ? "" : config.provider).trim().toLowerCase();
      if (["", "cursor", "anthropic", "grok"].indexOf(p) === -1) throw new Error("Provider tidak dikenal: " + p);
      const prev = this.provider;
      if (p) this.saved.provider = p; else delete this.saved.provider;
      this.recompute();
      if (this.provider !== prev) {
        providerChanged = true;
        this.continueChat = true; // provider baru tetap membaca sesi chat yang sedang terbuka
        // Model/params milik provider lama tidak berlaku: kembali ke default.
        if (!Object.prototype.hasOwnProperty.call(config, "model")) delete this.saved.model;
        if (!Object.prototype.hasOwnProperty.call(config, "params")) delete this.saved.params;
      }
    }
    if (Object.prototype.hasOwnProperty.call(config, "anthropicKey")) {
      const ak = String(config.anthropicKey == null ? "" : config.anthropicKey).trim();
      if (ak) this.saved.anthropicKey = ak; else delete this.saved.anthropicKey;
      this.continueChat = true;
    }
    if (Object.prototype.hasOwnProperty.call(config, "apiKey")) {
      const k = String(config.apiKey == null ? "" : config.apiKey).trim();
      if (k) this.saved.apiKey = k; else delete this.saved.apiKey;
      this.continueChat = true; // key baru: agent dibuat ulang, isi chat yang sama dilanjutkan
    }
    if (Object.prototype.hasOwnProperty.call(config, "model")) {
      const m = String(config.model == null ? "" : config.model).trim();
      const changed = m !== (this.saved.model || "");
      if (m) this.saved.model = m; else delete this.saved.model;
      // Ganti model: reset params (kecuali params disertakan sekaligus).
      if (changed && !Object.prototype.hasOwnProperty.call(config, "params")) delete this.saved.params;
    }
    if (Object.prototype.hasOwnProperty.call(config, "params")) {
      if (config.params && typeof config.params === "object") this.saved.params = config.params;
      else delete this.saved.params;
    }
    let recreate = providerChanged || ["apiKey", "anthropicKey", "model", "params"].some((k) => Object.prototype.hasOwnProperty.call(config, k));
    if (Object.prototype.hasOwnProperty.call(config, "promptCache")) {
      const on = !(config.promptCache === false || String(config.promptCache).toLowerCase() === "false" || config.promptCache === 0);
      if (on) delete this.saved.promptCache; else this.saved.promptCache = false;
      recreate = true;
    }
    if (Object.prototype.hasOwnProperty.call(config, "memory")) {
      const on = !(config.memory === false || String(config.memory).toLowerCase() === "false" || config.memory === 0);
      if (on) delete this.saved.memory; else this.saved.memory = false;
      this.memoryEnabled = on; // hanya memengaruhi prompt; agent tidak perlu dibuat ulang
    }
    if (Object.prototype.hasOwnProperty.call(config, "mode")) {
      const md = String(config.mode == null ? "" : config.mode).trim();
      if (["agent", "plan", "ask"].indexOf(md || "agent") === -1) throw new Error("Mode tidak dikenal: " + md);
      if (md) this.saved.mode = md; else delete this.saved.mode;
      recreate = true;
    }
    // Perintah verifikasi setelah edit (mis. "npm test"); hanya memengaruhi prompt.
    if (Object.prototype.hasOwnProperty.call(config, "verifyCmd")) {
      const v = String(config.verifyCmd == null ? "" : config.verifyCmd).trim();
      if (v) this.saved.verifyCmd = v.slice(0, 300); else delete this.saved.verifyCmd;
    }
    // Tool browser: auto (agent memutuskan), on (diutamakan untuk tugas web), off (tool tidak didaftarkan).
    if (Object.prototype.hasOwnProperty.call(config, "browserTools")) {
      const b = String(config.browserTools == null ? "" : config.browserTools).trim().toLowerCase();
      if (["", "auto", "on", "off"].indexOf(b) === -1) throw new Error("Nilai browserTools tidak dikenal: " + b);
      const prev = this.browserTools;
      if (b && b !== "auto") this.saved.browserTools = b; else delete this.saved.browserTools;
      if ((this.saved.browserTools || "auto") !== prev) recreate = true; // set tool agent berubah → buat ulang agent
    }
    // Computer use (desktop_*): auto / on / off — sama polanya dengan browserTools.
    if (Object.prototype.hasOwnProperty.call(config, "desktopTools")) {
      const d = String(config.desktopTools == null ? "" : config.desktopTools).trim().toLowerCase();
      if (["", "auto", "on", "off"].indexOf(d) === -1) throw new Error("Nilai desktopTools tidak dikenal: " + d);
      const prevD = this.desktopTools;
      if (d && d !== "auto") this.saved.desktopTools = d; else delete this.saved.desktopTools;
      if ((this.saved.desktopTools || "auto") !== prevD) recreate = true;
    }
    this.recompute();
    this.saveConfig();
    if (recreate) await this.disposeAll(); // agent dibuat ulang; ganti key/provider menyimpan transkrip chat untuk dilanjutkan
    return this.status();
  }

  // Kesiapan provider aktif: { ok, reason }.
  readiness() {
    if (this.provider === "grok") {
      if (this.grokAuth && this.grokAuth.pending) {
        return { ok: false, reason: "Menunggu persetujuan masuk Grok di browser. Buka tautan di setelan AI dan konfirmasi kodenya." };
      }
      if (!this.grokAuth || !this.grokAuth.connected()) {
        return { ok: false, reason: "Belum masuk ke akun Grok. Buka setelan AI (tombol \u2699) dan klik Masuk dengan Grok." };
      }
      return { ok: true, reason: "" };
    }
    if (this.provider === "anthropic") {
      if (!this.anthropicKey) return { ok: false, reason: "API key Anthropic belum diisi. Set lewat panel AI (tombol \u2699) atau ANTHROPIC_API_KEY di .env." };
      return { ok: true, reason: "" };
    }
    if (!sdk) return { ok: false, reason: "Modul @cursor/sdk belum terpasang di server (jalankan: npm install @cursor/sdk). Detail: " + sdkError };
    if (!this.apiKey) return { ok: false, reason: "API key belum diisi. Set lewat panel AI (tombol \u2699) atau CURSOR_API_KEY di .env." };
    return { ok: true, reason: "" };
  }

  status() {
    const mask = (k) => (k ? (k.length > 4 ? "\u2026" + k.slice(-4) : "\u2022\u2022\u2022\u2022") : "");
    const rd = this.readiness();
    const isAnth = this.provider === "anthropic";
    const isGrok = this.provider === "grok";
    const grok = this.grokAuth ? this.grokAuth.status() : { connected: false, source: "none" };
    const hasSdk = isAnth || isGrok ? true : !!sdk;
    const hasKey = isGrok ? !!grok.connected : (isAnth ? !!this.anthropicKey : !!this.apiKey);
    const source = isGrok
      ? (grok.source || "none")
      : (isAnth
        ? (this.saved.anthropicKey ? "web" : (this.envAnthropicKey ? "env" : "none"))
        : (this.saved.apiKey ? "web" : (this.envKey ? "env" : "none")));
    return {
      enabled: rd.ok, hasSdk, hasKey, model: this.model, params: this.params, mode: this.mode,
      source, keyMasked: isGrok ? (grok.emailMasked || (grok.connected ? "connected" : "")) : mask(isAnth ? this.anthropicKey : this.apiKey), reason: rd.reason,
      provider: this.provider,
      grok,
      providers: {
        cursor: { hasSdk: !!sdk, hasKey: !!this.apiKey, keyMasked: mask(this.apiKey), source: this.saved.apiKey ? "web" : (this.envKey ? "env" : "none") },
        anthropic: { hasSdk: true, hasKey: !!this.anthropicKey, keyMasked: mask(this.anthropicKey), source: this.saved.anthropicKey ? "web" : (this.envAnthropicKey ? "env" : "none") },
        grok: { hasSdk: true, hasKey: !!grok.connected, keyMasked: grok.emailMasked || "", source: grok.source || "none" },
      },
      autoMaxIter: this.autoMaxIter, verifyCmd: this.saved.verifyCmd || "",
      browserTools: this.browserTools, browserAvailable: !!(this.browser && this.browser.exe),
      desktopTools: this.desktopTools, desktopAvailable: this.desktopAvailable(),
      promptCache: this.promptCache,
      promptCacheControllable: isAnth, // Cursor: caching otomatis di sisi layanan
      memory: this.memoryEnabled,
    };
  }

  async ensureAgent(sessionId) {
    const s = this.runtime(sessionId);
    if (s.agent) { s.lastUsed = Date.now(); return s; }
    // Single-flight: dua permintaan hampir bersamaan untuk sesi yang sama tidak
    // boleh membuat dua agent (yang kedua menimpa yang pertama di tengah run).
    if (!s.creating) s.creating = this.createAgent(s, sessionId).finally(() => { s.creating = null; });
    await s.creating;
    s.lastUsed = Date.now();
    return s;
  }

  // Ringkasan percakapan yang tersimpan, supaya agent baru (key/provider berganti) bisa melanjutkan.
  sessionTranscript(sessionId) {
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    const msgs = meta && Array.isArray(meta.messages) ? meta.messages : [];
    const lines = [];
    let budget = 7000;
    msgs.slice(-16).forEach((m) => {
      if (!m || !m.text || budget <= 0) return;
      let t = String(m.text).replace(/\s+/g, " ").trim();
      if (t.length > 1200) t = t.slice(0, 1200) + "\u2026";
      t = t.slice(0, budget);
      budget -= t.length;
      lines.push((m.role === "user" ? "User" : "Assistant") + ": " + t);
    });
    if (!lines.length) return "";
    return "[Previous conversation in this chat \u2014 the API key or provider just changed. Continue the same task from here; do not repeat this transcript back to the user.]\n\n" + lines.join("\n\n");
  }

  async createAgent(s, sessionId) {
    const params = Object.keys(this.params || {})
      .map((id) => ({ id: id, value: String(this.params[id]) }))
      .filter((p) => p.value !== "");
    const model = { id: this.model };
    if (params.length) model.params = params;
    // settingSources "project": AGENTS.md, .vrcloud-agent/rules, skills, dan hooks
    // (pengaman perintah) di workspace ikut dimuat.
    const opts = { apiKey: this.apiKey, model: model, local: { cwd: this.workspace, settingSources: ["project"] } };
    // Tool browser (browser_*) tidak didaftarkan sama sekali saat pengguna memilih "Off".
    const ct = typeof this.customTools === "function" ? this.customTools() : this.customTools;
    if (ct && Object.keys(ct).length) {
      const filtered = {};
      Object.keys(ct).forEach((k) => {
        if (this.browserTools === "off" && /^browser_/i.test(k)) return;
        if (this.desktopTools === "off" && /^desktop_/i.test(k)) return; // computer use dimatikan: tool tidak didaftarkan
        filtered[k] = ct[k];
      });
      if (Object.keys(filtered).length) opts.local.customTools = filtered;
    }
    // ---- Provider Anthropic Claude: agent lokal dengan tool workspace sendiri ----
    const prelude = this.preludes && this.preludes[sessionId];
    if (prelude) delete this.preludes[sessionId];
    if (this.provider === "anthropic") {
      const metaA = this.store.sessions.find((m) => m.id === sessionId);
      let history = metaA && Array.isArray(metaA.claudeHistory) ? metaA.claudeHistory : [];
      // Ganti key/provider: baca ulang teks chat yang tersimpan, bukan memori agent yang lama.
      if (prelude) {
        history = [
          { role: "user", content: [{ type: "text", text: prelude }] },
          { role: "assistant", content: [{ type: "text", text: "I have the conversation so far and will continue the same task." }] },
        ];
      }
      s.agent = await AnthropicAgent.create({
        apiKey: this.anthropicKey,
        model: this.model,
        params: this.params,
        workspace: this.workspace,
        shell: process.env.SHELL_BIN,
        customTools: opts.local.customTools || {},
        promptCache: this.promptCache,
        // Mode ask = baca-saja: matikan tool pengubah & shell.
        disallowedTools: this.mode === "ask" ? ["edit", "write", "delete", "shell"] : [],
        history,
        agentId: prelude ? undefined : (metaA && metaA.claudeAgentId),
      });
      if (metaA) { metaA.claudeAgentId = s.agent.agentId; this.saveStore(); }
      return;
    }
    if (this.provider === "grok") {
      const metaG = this.store.sessions.find((m) => m.id === sessionId);
      let history = metaG && Array.isArray(metaG.grokHistory) ? metaG.grokHistory : [];
      if (prelude) {
        history = [
          { role: "user", content: prelude },
          { role: "assistant", content: "I have the conversation so far and will continue the same task." },
        ];
      }
      const auth = this.grokAuth;
      s.agent = await GrokAgent.create({
        getToken: () => auth.getAccessToken(),
        model: this.model,
        params: this.params,
        workspace: this.workspace,
        shell: process.env.SHELL_BIN,
        customTools: opts.local.customTools || {},
        promptCache: this.promptCache,
        disallowedTools: this.mode === "ask" ? ["edit", "write", "delete", "shell"] : [],
        history,
        agentId: prelude ? undefined : (metaG && metaG.grokAgentId),
      });
      if (metaG) { metaG.grokAgentId = s.agent.agentId; this.saveStore(); }
      return;
    }
    if (!sdk) throw new Error("Modul @cursor/sdk belum terpasang di server");
    // Mode "ask" = agent baca-saja: SDK tetap mode agent, tool pengubah dimatikan.
    opts.mode = this.mode === "ask" ? "agent" : (this.mode || "agent");
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    // askQuestion tidak bisa dijawab dari UI headless ini: matikan agar agent
    // memutuskan sendiri. Untuk mode ask, matikan juga edit/shell/hapus.
    // Coba daftar terlengkap dulu; bila SDK menolak sebuah nama tool, pakai
    // daftar yang lebih konservatif — tapi jangan pernah hilangkan pembatas ask.
    const candidates = this.mode === "ask"
      ? [["askQuestion", "edit", "write", "delete", "shell", "applyAgentDiff", "generateImage", "task"],
         ["askQuestion", "edit", "delete", "shell", "applyAgentDiff"],
         ["edit", "delete", "shell"]]
      : [["askQuestion"], []];
    const make = async (fn) => {
      let lastErr = null;
      for (const list of candidates) {
        try { return await fn(list.length ? Object.assign({}, opts, { disallowedTools: list }) : opts); }
        catch (e) {
          lastErr = e;
          if (!/tool|disallowed|ConfigurationError/i.test(String((e && e.message) || e))) throw e;
        }
      }
      throw lastErr || new Error("Gagal membuat agent");
    };
    // Lanjutkan agent lama (konteks percakapan tetap) bila ada; kalau gagal
    // (dihapus SDK, workspace pindah) buat baru.
    // Ganti key/provider: jangan resume agent lama (terikat key lama). Transkrip chat disisipkan di pesan berikutnya.
    if (!prelude && meta && meta.agentId && typeof sdk.Agent.resume === "function") {
      try { s.agent = await make((o) => sdk.Agent.resume(meta.agentId, o)); }
      catch (e) { s.agent = null; s.prelude = this.sessionTranscript(sessionId); }
    }
    if (prelude) s.prelude = prelude;
    if (!s.agent) {
      s.agent = await make((o) => sdk.Agent.create(o));
      if (meta) { meta.agentId = s.agent.agentId || meta.agentId; this.saveStore(); }
    }
  }

  // Instruksi kerja agent yang disisipkan (tak terlihat di UI) di depan pesan
  // pengguna. Pertanyaan biasa dijawab langsung; tugas dikerjakan tuntas.
  // Semua teks instruksi ada di lib/agent-instructions.js; di sini hanya dikumpulkan konteksnya.
  agentPrompt(userText, priorTranscript) {
    if (this.mode === "ask") return Instructions.agentPrompt({ workspace: this.workspace, mode: "ask", priorTranscript: priorTranscript || "", userText });
    const snap = this.projectSnapshot();
    const verify = this.saved.verifyCmd || (snap && snap.verify && snap.verify.length ? snap.verify.slice(0, 2).join(" && ") : "");
    return Instructions.agentPrompt({
      workspace: this.workspace,
      mode: this.mode,
      platform: process.platform,
      // Provider Anthropic sudah membawa blok statis (cara kerja, keamanan) di system prompt-nya.
      includeStatic: this.provider !== "anthropic" && this.provider !== "grok",
      verify, verifyIsCustom: !!this.saved.verifyCmd,
      editorContext: this.editorContextText(),
      snapshotText: snap && snap.text ? snap.text : "",
      browser: { on: this.browserOn(), mode: this.browserTools },
      desktop: { on: this.desktopOn(), mode: this.desktopTools },
      memoryEnabled: this.memoryEnabled,
      memoryText: this.memoryEnabled ? this.memoryText() : "",
      // Fallback: the Cursor SDK reads `.cursor/`; when the .cursor -> .vrcloud-agent link cannot be
      // created (e.g. exFAT), rules and the skills index are injected directly into the prompt.
      projectContext: this.projectContextText(),
      priorTranscript: priorTranscript || "",
      userText,
    });
  }
  // Snapshot proyek (stack, skrip, git, struktur, file terbaru) — lihat lib/project-context.js.
  projectSnapshot() {
    try { return ProjectContext.snapshot(this.workspace); } catch (e) { return null; }
  }
  // File yang sedang dibuka di editor IDE: agent tahu konteks kerja pengguna tanpa ditanya.
  editorContextText() {
    if (!this.openFiles) return "";
    let ctx = null;
    try { ctx = this.openFiles(); } catch (e) { return ""; }
    if (!ctx) return "";
    const open = Array.isArray(ctx.open) ? ctx.open.filter(Boolean).slice(0, 12) : [];
    if (!ctx.active && !open.length) return "";
    const L = [Instructions.EDITOR.header];
    if (ctx.active) L.push(Instructions.EDITOR.activeFile(ctx.active));
    if (open.length) L.push(Instructions.EDITOR.openTabs(open));
    return L.join("\n");
  }
  // Rules (.vrcloud-agent/rules/*.mdc) + indeks skills untuk prompt, hanya bila SDK tidak
  // bisa membacanya sendiri lewat `.cursor` (tautan tidak ada).
  projectContextText() {
    try {
      const ws = this.workspace;
      if (fs.existsSync(path.join(ws, ".cursor"))) return "";
      const agentDir = path.join(ws, ".vrcloud-agent");
      if (!fs.existsSync(agentDir)) return "";
      const out = [];
      // Frontmatter YAML sederhana; nilai lipat (`>-`, `|`) diambil dari baris menjorok berikutnya.
      const fm = (t) => {
        const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t); const meta = {};
        if (m) {
          const ls = m[1].split(/\r?\n/);
          for (let i = 0; i < ls.length; i++) {
            const k = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(ls[i]); if (!k) continue;
            let v = k[2].trim();
            if (/^[>|][-+]?$/.test(v)) {
              const acc = [];
              while (i + 1 < ls.length && /^\s+\S/.test(ls[i + 1])) acc.push(ls[++i].trim());
              v = acc.join(" ");
            }
            meta[k[1]] = v.replace(/^["']|["']$/g, "");
          }
        }
        return { meta, body: m ? m[2] : t };
      };
      const rulesDir = path.join(agentDir, "rules");
      if (fs.existsSync(rulesDir)) {
        let budget = 12000;
        fs.readdirSync(rulesDir).filter((f) => /\.(mdc|md)$/i.test(f)).sort().forEach((f) => {
          if (budget <= 0) return;
          const { meta, body } = fm(fs.readFileSync(path.join(rulesDir, f), "utf8"));
          const always = /^(true|yes|1)$/i.test(String(meta.alwaysApply || ""));
          const head = Instructions.PROJECT.rule(f, meta.globs, meta.description && !always ? meta.description : "");
          if (always || !meta.globs) { const t = body.trim().slice(0, Math.min(4000, budget)); out.push(head + "\n" + t); budget -= t.length; }
          else out.push(head + Instructions.PROJECT.ruleDeferred);
        });
      }
      const skillsDir = path.join(agentDir, "skills");
      if (fs.existsSync(skillsDir)) {
        const sk = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
          const f = path.join(skillsDir, d.name, "SKILL.md"); if (!fs.existsSync(f)) return null;
          const { meta } = fm(fs.readFileSync(f, "utf8"));
          return Instructions.PROJECT.skill(d.name, (meta.description || "").slice(0, 200));
        }).filter(Boolean);
        if (sk.length) out.push(Instructions.PROJECT.skillsHeader + "\n" + sk.join("\n"));
      }
      return out.join("\n\n");
    } catch (e) { return ""; }
  }
  // Isi memori proyek untuk disisipkan ke prompt (dibatasi agar hemat token).
  memoryText() {
    try {
      const file = path.join(this.workspace, ".vrcloud-agent", "memory.md");
      if (!fs.existsSync(file)) return "";
      let t = fs.readFileSync(file, "utf8").trim();
      const max = Instructions.MEMORY.maxChars;
      if (t.length > max) t = t.slice(0, max) + Instructions.MEMORY.truncated;
      return t;
    } catch (e) { return ""; }
  }

  continuePrompt() { return Instructions.continuePrompt(); }

  // Satu putaran agent.send + stream. Mengisi s.live lewat emit.
  async runOnce(s, text, emit, sendOpts) {
    const run = await s.agent.send(text, sendOpts || undefined);
    s.run = run;
    let toolEvents = 0;
    const wrapped = (kind, val) => {
      if (kind === "tool") toolEvents++;
      emit(kind, val);
    };
    for await (const event of run.stream()) {
      this.emitFromEvent(event, wrapped, s);
    }
    const result = await run.wait();
    s.run = null;
    return { status: (result && result.status) || "finished", toolEvents };
  }

  /**
   * Kirim pesan ke agent. Event di-broadcast ke semua listener (tab/browser);
   * onEvent opsional untuk klien pengirim.
   * Perilaku agent: bila agent membuat todo dan belum semuanya selesai saat
   * run berakhir, server otomatis mengirim "lanjutkan" (maks autoMaxIter
   * putaran) — pengguna tidak perlu memerintah langkah demi langkah.
   * Mode "plan" hanya menyusun rencana: tidak dilanjutkan otomatis.
   */
  async send(sessionId, message, onEvent, extra) {
    extra = extra || {};
    const rd = this.readiness();
    if (!rd.ok) throw new Error(rd.reason);
    const text = String(message == null ? "" : message).trim();
    const images = Array.isArray(extra.images) ? extra.images.filter((im) => im && im.data && im.mimeType).slice(0, 4) : [];
    if (!text && !images.length) throw new Error("Pesan kosong");

    // Tandai sibuk SEBELUM menunggu agent dibuat, supaya permintaan kedua yang
    // datang saat pembuatan agent masih berjalan langsung ditolak.
    const s = this.runtime(sessionId);
    if (s.busy) throw new Error("Masih memproses pesan sebelumnya, tunggu sebentar");
    s.busy = true;
    try { await this.ensureAgent(sessionId); }
    catch (e) { s.busy = false; throw e; }
    s.stopRequested = false;
    s.live = newLive();
    s.todos = null;
    s.onEvent = typeof onEvent === "function" ? onEvent : null;
    s.lastUsed = Date.now();
    if (this.browser && typeof this.browser.beginRun === "function") this.browser.beginRun(); // reset batas langkah browser per run

    const display = String(extra.display == null ? text : extra.display);
    const meta = this.touchMeta(sessionId);
    const isFirst = !(meta.messages || []).some((m) => m.role === "user");
    const userMsg = { role: "user", text: display };
    if (Array.isArray(extra.skills) && extra.skills.length) userMsg.skills = extra.skills.map(String).slice(0, 3);
    if (images.length) userMsg.images = this.persistImages(images);
    meta.messages = (meta.messages || []).concat([userMsg]);
    if (meta.messages.length > this.histMax) meta.messages = meta.messages.slice(-this.histMax);
    if (isFirst) meta.title = extra.title || this.titleFrom(display || (images.length ? "Gambar" : "Chat"));
    // Browser lain: tampilkan pesan pengguna + sambung ke stream sekarang juga (bukan menunggu polling).
    this.notify("run-start", { sessionId, title: meta.title });
    this.saveStore();

    const emit = (kind, val) => {
      this.recordLive(s, kind, val);
      const idx = s.live.frames.length - 1;
      this.broadcast(s, kind, val, idx);
      if (typeof onEvent === "function") {
        try { onEvent(kind, val); } catch (e) {}
      }
    };

    try {
      // Checkpoint workspace sebelum agent menyentuh apa pun.
      let before = null;
      if (this.checkpoints && this.checkpoints.available) {
        try { before = await this.checkpoints.snapshot("sebelum: " + display.slice(0, 60)); } catch (e) { before = null; }
        if (before) { userMsg.checkpoint = before; this.saveStore(); emit("checkpoint", { before }); }
      }

      let status = "finished";
      const planOnly = this.mode === "plan" || this.mode === "ask"; // satu putaran, tanpa lanjut otomatis
      let prevTodos = "";
      let idle = 0;
      for (let i = 0; i < this.autoMaxIter; i++) {
        if (!s.agent || s.stopRequested) break;
        if (i > 0) emit("iter", { n: i + 1, max: this.autoMaxIter });
        const prior = i === 0 && s.prelude ? s.prelude : "";
        if (prior) s.prelude = "";
        let payload = i === 0 ? this.agentPrompt(text || "(see the attached image)", prior) : this.continuePrompt();
        if (i === 0 && images.length) payload = { text: payload, images: images.map((im) => ({ data: im.data, mimeType: im.mimeType })) };
        const r = await this.runOnce(s, payload, emit);
        status = r.status;
        if (planOnly || status === "cancelled" || status === "error" || s.stopRequested) break;
        if (todosDone(s.todos)) break;
        const sig = JSON.stringify(s.todos || []);
        idle = (sig === prevTodos && r.toolEvents === 0) ? idle + 1 : 0;
        prevTodos = sig;
        if (idle >= 2) break; // dua putaran tanpa kemajuan: berhenti
      }
      // Provider tanpa memori sisi server (Anthropic / Grok): simpan riwayat percakapan ringkas.
      if (s.agent && typeof s.agent.getHistory === "function") {
        try {
          const hist = s.agent.getHistory();
          if (this.provider === "grok") meta.grokHistory = hist;
          else meta.claudeHistory = hist;
        } catch (e) {}
      }
      const live = s.live || {};
      const tools = (live.tools || []).map(trimTool);
      const blocks = blocksFrom(live.frames);
      const aiMsg = {
        role: "ai",
        text: live.text || "",
        think: live.think || undefined,
        tools: tools.length ? tools : undefined,
        plan: live.plan && live.plan.length ? live.plan : undefined,
        blocks: blocks.length ? blocks : undefined, // urutan kronologis untuk UI
        before: before || undefined,                 // checkpoint sebelum pesan (untuk "Kembalikan")
        files: live.touched && live.touched.length ? live.touched.slice() : undefined,
        usage: live.usage || undefined,
      };
      if (live.usage) meta.usage = addUsage(meta.usage, live.usage);
      if (before && live.touched && live.touched.length && this.checkpoints) {
        try {
          aiMsg.after = await this.checkpoints.snapshot("setelah: " + display.slice(0, 60));
          if (aiMsg.after && aiMsg.after !== before) {
            const stat = await this.checkpoints.diffStat(before, aiMsg.after);
            if (stat.length) {
              aiMsg.changes = stat.slice(0, 200);
              // Kartu "Tinjau perubahan" di UI (juga untuk klien yang masih tersambung).
              this.emitTo(s, "changes", { before: before, after: aiMsg.after, files: aiMsg.changes });
            }
          }
        } catch (e) {}
      }
      meta.messages = (meta.messages || []).concat([aiMsg]);
      if (meta.messages.length > this.histMax) meta.messages = meta.messages.slice(-this.histMax);
      meta.updatedAt = Date.now();
      this.saveStore();
      this.broadcast(s, "done", status, 1e9);
      this.refreshCost(sessionId, s.agent);
      return status;
    } catch (e) {
      const msg = explainError(e);
      this.broadcast(s, "error", msg, 1e9);
      try {
        const saved = this.touchMeta(sessionId);
        saved.messages = (saved.messages || []).concat([{ role: "ai", text: msg, err: true }]);
        if (saved.messages.length > this.histMax) saved.messages = saved.messages.slice(-this.histMax);
        this.saveStore();
      } catch (e2) {}
      throw new Error(msg);
    } finally {
      s.run = null;
      s.busy = false;
      s.live = null;
      s.onEvent = null;
      s.lastUsed = Date.now();
      this.notify("run-end", { sessionId });
      // Persetujuan yang masih menggantung untuk sesi ini: tolak.
      this.approvals.forEach((e, id) => { if (e.sessionIds.indexOf(sessionId) !== -1) this.decideApproval(id, false, "ended"); });
    }
  }

  // Biaya (USD) dari SDK bersifat eventually-consistent: ambil belakangan, simpan bila ada.
  refreshCost(sessionId, agent) {
    if (!agent || typeof agent.getUsage !== "function") return;
    const timer = setTimeout(() => {
      agent.getUsage().then((u) => {
        const meta = this.store.sessions.find((m) => m.id === sessionId);
        if (!meta || !u) return;
        const cur = meta.usage || {};
        const next = Object.assign({}, cur);
        if (u.usage && typeof u.usage.totalTokens === "number") {
          next.inputTokens = u.usage.inputTokens; next.outputTokens = u.usage.outputTokens; next.totalTokens = u.usage.totalTokens;
          if (u.usage.cacheReadTokens != null) next.cacheReadTokens = u.usage.cacheReadTokens;
        }
        if (u.cost && typeof u.cost.chargedCents === "number") next.costCents = u.cost.chargedCents;
        meta.usage = next;
        this.saveStore();
      }).catch(() => {});
    }, 4000);
    if (timer.unref) timer.unref();
  }

  // Cerminkan perintah shell agent ke tab "Agent shell" (view-only) di IDE:
  // header "$ cmd" saat mulai, output + exit code saat selesai.
  mirrorShell(s, event, meta) {
    if (!this.onShell) return;
    var sessionId = null;
    this.sessions.forEach((rt, id) => { if (rt === s) sessionId = id; });
    if (!sessionId) return;
    var a = event.args || {};
    var v = resultValue(event.result);
    var payload = {
      sessionId, callId: event.call_id || "", status: event.status || "running",
      command: String(a.command || ""), cwd: String(a.workingDirectory || a.working_directory || a.cwd || ""),
      background: !!meta.background,
    };
    if (event.status === "completed" || event.status === "error") {
      payload.stdout = v && typeof v.stdout === "string" ? v.stdout : "";
      payload.stderr = v && typeof v.stderr === "string" ? v.stderr : "";
      payload.exitCode = typeof meta.exit === "number" ? meta.exit : (event.status === "error" ? 1 : null);
      // Proses latar belakang hanya dicatat bila PID-nya masih hidup, supaya indikator
      // tidak menampilkan terminal yang sudah selesai.
      if (meta.background && meta.pid) BgProcs.add({ pid: meta.pid, command: payload.command, sessionId, callId: payload.callId });
    }
    try { this.onShell(payload); } catch (e) {}
  }

  // Ekstrak teks jawaban dan reasoning dari sebuah event stream, lalu emit.
  emitFromEvent(event, emit, s) {
    if (!event || typeof emit !== "function") return;
    const type = event.type;
    // Tool call (buat file, jalankan perintah, edit, dsb.).
    if (type === "tool_call") {
      const nn = normName(event.name);
      // Rencana kerja (todo) -> frame "plan", bukan kartu tool.
      if (nn === "updatetodos" || nn === "readtodos" || nn === "todowrite") {
        const todos = todosFrom(event, s ? s.todos : null);
        if (todos) {
          if (s) s.todos = todos;
          emit("plan", todos);
        }
        return;
      }
      var d = toolDetail(event);
      var meta = toolMeta(event);
      // Tool browser (customTools): lampirkan langkah (url, judul, screenshot) untuk kartu browser di chat.
      if (nn === "mcp" && /^desktop_/i.test(mcpToolName(event)) && this.desktopShot && event.status !== "running") {
        const shot = this.desktopShot(event.call_id);
        if (shot) meta.desktopShot = shot;
      }
      if (nn === "mcp" && this.browser && /^browser_/i.test(mcpToolName(event))) {
        const step = this.browser.stepFor(event.call_id) || (event.status !== "running" ? this.browser.lastStep : null);
        meta.browserTool = mcpToolName(event);
        if (step) meta.browser = { n: step.n, action: step.action, url: step.url, title: step.title, shot: step.shot, shotError: step.shotError || "", args: step.args, tab: step.tab, tabs: step.tabs || 1, wall: step.wall || "" };
      }
      if (nn === "shell") {
        var a = event.args || {};
        // Perintah latar belakang (server dev, watcher): agent tidak menunggu selesai.
        if (a.isBackground || a.is_background || a.background || a.runInBackground || a.run_in_background) meta.background = true;
        this.mirrorShell(s, event, meta);
      }
      emit("tool", {
        callId: event.call_id || "",
        name: event.name || "tool",
        tool: nn === "mcp" ? mcpToolName(event) : undefined,
        status: event.status || "running",
        summary: toolSummary(event),
        detail: d.detail,
        lang: d.lang,
        meta: meta,
      });
      // File berubah oleh agent -> beri tahu IDE (tree, tab editor) & catat untuk checkpoint.
      if (event.status === "completed" || event.status === "error") {
        const paths = toolPaths(event, this.workspace);
        if (paths.length) {
          if (s && s.live) paths.forEach((p) => { if (s.live.touched.indexOf(p) === -1) s.live.touched.push(p); });
          if (this.onFsChange) { try { this.onFsChange(paths); } catch (e) {} }
        } else if (nn === "shell" && this.onFsChange && event.status === "completed") {
          try { this.onFsChange([]); } catch (e) {} // shell bisa mengubah file apa saja: segarkan editor yang terbuka + tree
        }
      }
      return;
    }
    // Pemakaian token per putaran.
    if (type === "usage" && event.usage && typeof event.usage === "object") {
      const u = event.usage;
      const cur = (s && s.live && s.live.usage) || null;
      emit("usage", addUsage(cur, u));
      return;
    }
    const msg = event.message;
    // Bentuk 1: message.content berupa array blok.
    if (msg && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === "text" && b.text) emit("text", b.text);
        else if (isThink(b.type) && (b.text || b.thinking)) emit("think", b.text || b.thinking);
      }
      return;
    }
    // Bentuk 2: pesan tunggal dengan .text.
    const text = (msg && typeof msg.text === "string") ? msg.text
      : (typeof event.text === "string" ? event.text : "");
    if (!text) return;
    if (isThink(type)) emit("think", text);
    else if (type === "assistant" || type === "assistantMessage" || type === "text" || type === "message") emit("text", text);
  }

  // Hentikan run yang sedang berjalan — hanya tombol Stop, bukan refresh/putus koneksi.
  async stop(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.stopRequested = true; // hentikan juga loop otonom
    this.approvals.forEach((e, id) => { if (e.sessionIds.indexOf(sessionId) !== -1) this.decideApproval(id, false, "stopped"); });
    if (!s.run) return false;
    const run = s.run;
    try {
      if (typeof run.supports !== "function" || run.supports("cancel")) {
        await run.cancel();
        return true;
      }
    } catch (e) { /* abaikan */ }
    return false;
  }

  async reset(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) this.broadcast(s, "error", "Percakapan dihapus", 1e9);
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    this.sessions.delete(sessionId);
    this.store.sessions = this.store.sessions.filter((m) => m.id !== sessionId);
    this.saveStore();
    this.notify("sessions-changed", { sessionId, removed: true });
    if (s && s.agent) await this.dispose(s.agent);
    // Hapus juga agent tersimpan di SDK agar tidak menumpuk.
    if (meta && meta.agentId && sdk && typeof sdk.Agent.delete === "function") {
      sdk.Agent.delete(meta.agentId, { cwd: this.workspace, apiKey: this.apiKey }).catch(() => {});
    }
  }

  async disposeAll() {
    // Ganti API key / provider: simpan teks chat dulu, agent berikutnya membacanya lagi.
    if (this.continueChat) {
      this.preludes = {};
      this.store.sessions.forEach((m) => {
        const t = this.sessionTranscript(m.id);
        if (t) this.preludes[m.id] = t;
      });
      this.continueChat = false;
    }
    const agents = [];
    this.sessions.forEach((s) => {
      if (s.agent) agents.push(s.agent);
      s.agent = null;
      s.stopRequested = true;
      s.run = null;
      s.busy = false;
      s.live = null;
      s.listeners.clear();
    });
    this.sessions.clear();
    for (const a of agents) await this.dispose(a);
  }

  // Ambil daftar model yang tersedia untuk key ini (dari Cursor SDK).
  // apiKey opsional: dipakai untuk menguji key yang baru diketik tanpa menyimpan.
  async startGrokLogin() {
    if (!this.grokAuth) throw new Error("Grok auth tidak tersedia");
    await this.grokAuth.startLogin();
    return this.status();
  }
  async cancelGrokLogin() {
    if (!this.grokAuth) return this.status();
    this.grokAuth.cancelLogin();
    return this.status();
  }
  async logoutGrok() {
    if (this.grokAuth) await this.grokAuth.logout();
    if (this.provider === "grok") await this.disposeAll();
    return this.status();
  }

  async listModels(apiKey, provider, refresh) {
    const prov = String(provider || this.provider || "").toLowerCase();
    if (prov === "grok") {
      if (!this.grokAuth || !this.grokAuth.connected()) throw new Error("Belum masuk ke akun Grok");
      return GrokAgent.listModels(() => this.grokAuth.getAccessToken(), { refresh: !!refresh });
    }
    if (prov === "anthropic") {
      const ak = (apiKey && String(apiKey).trim()) || this.anthropicKey;
      if (!ak) throw new Error("API key Anthropic belum diisi");
      return AnthropicAgent.listModels(ak, { refresh: !!refresh });
    }
    if (!sdk) throw new Error("Modul @cursor/sdk belum terpasang di server");
    const key = (apiKey && String(apiKey).trim()) || this.apiKey;
    if (!key) throw new Error("API key belum diisi");
    if (!sdk.Cursor || !sdk.Cursor.models || typeof sdk.Cursor.models.list !== "function") {
      throw new Error("SDK ini tidak mendukung daftar model");
    }
    const res = await sdk.Cursor.models.list({ apiKey: key });
    return this.normalizeModels(res);
  }

  normalizeModels(res) {
    let arr = [];
    if (Array.isArray(res)) arr = res;
    else if (res && Array.isArray(res.models)) arr = res.models;
    else if (res && Array.isArray(res.data)) arr = res.data;
    else if (res && typeof res === "object") arr = Object.values(res);
    const out = [], seen = {};
    arr.forEach((m) => {
      if (!m) return;
      let item;
      if (typeof m === "string") item = { id: m, displayName: m, parameters: [], variants: [] };
      else {
        const id = m.id || m.name;
        if (!id) return;
        item = {
          id: String(id),
          displayName: m.displayName || String(id),
          parameters: Array.isArray(m.parameters) ? m.parameters : [],
          variants: Array.isArray(m.variants) ? m.variants : [],
        };
      }
      if (seen[item.id]) return;
      seen[item.id] = true;
      out.push(item);
    });
    return out;
  }

  async dispose(agent) {
    try {
      if (typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
      else if (typeof agent.close === "function") await agent.close();
    } catch (e) { /* abaikan */ }
  }

  sweep() {
    const now = Date.now();
    this.sessions.forEach((s, id) => {
      if (s.busy) return;
      if (s.listeners && s.listeners.size) return;
      if (now - s.lastUsed > this.idleMs) {
        this.sessions.delete(id);
        this.dispose(s.agent);
      }
    });
  }
}

module.exports = AiChat;
