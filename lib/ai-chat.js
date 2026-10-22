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
const GrokAuth = require("./grok-auth");
const ProviderFactory = require("./provider-factory");
const GrokAgent = require("./grok-agent");
const AgentOrchestrator = require("./agent-orchestrator");
const ProjectContext = require("./project-context");
const Instructions = require("./agent-instructions"); // semua teks instruksi agent (satu file)
const BgProcs = require("./bg-procs");

const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const IMAGE_FILE_RE = /^[a-f0-9]{40}\.(png|jpg|gif|webp)$/;

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
function mcpStructured(ev) {
  var r = ev && ev.result;
  if (!r || typeof r !== "object") return {};
  var v = r.value && typeof r.value === "object" ? r.value : r;
  return (v.structuredContent && typeof v.structuredContent === "object") ? v.structuredContent :
    ((v.value && v.value.structuredContent && typeof v.value.structuredContent === "object") ? v.value.structuredContent : {});
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
    if (/^ast_edit$/i.test(mcpToolName(ev))) {
      var ast = mcpStructured(ev);
      out.detail = capText(ast.diffString || ast.diff || rt, 12000);
      out.lang = extLang(ast.path || mcpArgs(ev).path || "");
      return out;
    }
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
function toolMeta(ev, workspace) {
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
  if (name === "mcp" && /^memory_/i.test(mcpToolName(ev))) {
    m.memory = true;
    m.readOnly = /^memory_search$/i.test(mcpToolName(ev));
    var memory = mcpStructured(ev);
    m.memoryAction = mcpToolName(ev).replace(/^memory_/i, "");
    m.memoryCount = typeof memory.count === "number" ? memory.count : (memory.item ? 1 : undefined);
    if (memory.item && memory.item.id) m.memoryId = memory.item.id;
  }
  if (name === "mcp" && /^ast_/i.test(mcpToolName(ev))) {
    var ast = mcpStructured(ev);
    m.structural = true;
    m.readOnly = /^ast_search$/i.test(mcpToolName(ev));
    m.astAction = mcpToolName(ev).replace(/^ast_/i, "");
    m.astCount = typeof ast.count === "number" ? ast.count : undefined;
    m.astPath = ast.path || (mcpArgs(ev).path || "");
    m.astOperation = ast.operation || (mcpArgs(ev).operation || "");
    m.astTruncated = !!ast.truncated;
    if (typeof ast.linesAdded === "number") m.added = ast.linesAdded;
    if (typeof ast.linesRemoved === "number") m.removed = ast.linesRemoved;
  }
  // web_search: kartu "Menelusuri web" dengan query, backend, dan daftar sumber (judul + URL).
  if (name === "mcp" && /^web_search$/i.test(mcpToolName(ev))) {
    var ws = mcpStructured(ev), wa = mcpArgs(ev);
    m.search = true;
    m.readOnly = true;
    m.query = String(ws.query || wa.query || "");
    if (ws.backend) m.searchBackend = ws.backend;
    if (Array.isArray(ws.results)) {
      m.searchCount = ws.results.length;
      m.sources = ws.results.slice(0, 10).map(function (r) { return { title: r.title || r.url || "", url: r.url || "" }; });
    }
  }
  // Gambar hasil generate_image (xAI) atau generateImage (bawaan Cursor): URL /preview/... di
  // workspace untuk ditampilkan di kartu chat.
  if ((name === "mcp" && /^generate_image$/i.test(mcpToolName(ev))) || name === "generateimage") {
    var imgs = [];
    var gs = name === "mcp" ? mcpStructured(ev) : {};
    if (Array.isArray(gs.images)) gs.images.forEach(function (im) { if (im && im.url) imgs.push({ url: im.url, path: im.path || "" }); });
    if (!imgs.length) imagePathsOf(ev, workspace).forEach(function (p) { imgs.push({ url: previewUrlOf(p), path: p }); });
    m.image = true;
    if (imgs.length) m.images = imgs.slice(0, 8);
    if (gs.model) m.imageModel = gs.model;
    if (gs.mode) m.imageMode = gs.mode;
  }
  // Screenshot desktop tidak diambil dari result tool. API Cursor menaruh byte JPEG mentah
  // di result (dan sering memotongnya). Kartu chat memakai file yang disimpan server.
  return m;
}

function previewUrlOf(rel) {
  return "/preview/" + String(rel || "").replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}
// Path gambar (relatif workspace) dari argumen/hasil tool pembuat gambar. Nama field hasil
// generateImage Cursor tidak terdokumentasi, jadi beberapa bentuk umum diperiksa.
function imagePathsOf(ev, workspace) {
  var out = [];
  var ws = String(workspace || "").replace(/\\/g, "/").replace(/\/+$/, "");
  var add = function (p) {
    if (!p || typeof p !== "string" || !/\.(png|jpe?g|webp|gif)$/i.test(p) || /^https?:|^data:/i.test(p)) return;
    p = p.replace(/\\/g, "/");
    if (ws && p.toLowerCase().indexOf(ws.toLowerCase() + "/") === 0) p = p.slice(ws.length + 1);
    else if (/^([a-z]:)?\//i.test(p)) return;
    p = p.replace(/^\.\//, "");
    if (p.indexOf("..") === -1 && out.indexOf(p) === -1) out.push(p);
  };
  var scan = function (o, depth) {
    if (!o || typeof o !== "object" || depth > 3) return;
    ["path", "filePath", "file_path", "imagePath", "image_path", "outputPath", "output_path", "savedPath", "file", "relativeWorkspacePath"].forEach(function (k) { add(o[k]); });
    ["paths", "files", "images", "outputs"].forEach(function (k) { if (Array.isArray(o[k])) o[k].forEach(function (x) { if (typeof x === "string") add(x); else scan(x, depth + 1); }); });
    if (o.value && typeof o.value === "object") scan(o.value, depth + 1);
  };
  scan(ev && ev.args, 0);
  scan(resultValue(ev && ev.result), 0);
  return out;
}

// Normalisasi daftar todo dari tool updateTodos/readTodos.
function normTodos(src) {
  if (!Array.isArray(src)) return null;
  return src.map(function (t, index) {
    if (!t) return null;
    var st = String(t.status || "pending");
    if (/in.?progress/i.test(st)) st = "inProgress";
    else if (/complete|done/i.test(st)) st = "completed";
    else if (/cancel/i.test(st)) st = "cancelled";
    else st = "pending";
    var deps = Array.isArray(t.dependencies) ? t.dependencies : (Array.isArray(t.dependsOn) ? t.dependsOn : []);
    var out = {
      content: String(t.content || t.text || t.title || ""),
      status: st,
      id: String(t.id || ("todo-" + (index + 1))),
    };
    if (t.owner != null) out.owner = String(t.owner);
    if (deps.length) out.dependencies = deps.map(String);
    if (t.runId != null) out.runId = String(t.runId);
    return out;
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
  var out = prev.map(function (t) { return Object.assign({}, t); });
  upd.forEach(function (u) {
    var hit = null;
    for (var i = 0; i < out.length; i++) {
      if ((u.id && out[i].id === u.id) || out[i].content === u.content) { hit = out[i]; break; }
    }
    if (hit) Object.assign(hit, u); else out.push(u);
  });
  return out;
}

function todosDone(todos) {
  if (!todos || !todos.length) return true;
  return todos.every(function (t) { return t.status === "completed" || t.status === "cancelled"; });
}

// Perkiraan jendela konteks per model (token), untuk bar progres token di panel AI dan
// untuk memberi tahu agent saat ruangnya menipis. Angka resmi tidak tersedia lewat API
// mana pun yang dipakai di sini, jadi pola nama model dipakai; yang tak dikenal memakai
// DEFAULT_CONTEXT_LIMIT. Salah tebak hanya menggeser bar, tidak memutus run.
const CONTEXT_LIMITS = [
  [/claude[-.]?(opus|sonnet|haiku)?[-.]?4|claude[-.]?4/i, 200000],
  [/claude[-.]?3/i, 200000],
  [/grok[-.]?4/i, 256000],
  [/grok/i, 131072],
  [/gpt[-.]?4\.1/i, 1047576],
  [/gpt[-.]?4o|gpt[-.]?4(?![.\d])/i, 128000],
  [/gpt[-.]?5|^o[34]/i, 200000],
  [/gemini/i, 1048576],
  [/deepseek/i, 131072],
];
const DEFAULT_CONTEXT_LIMIT = 200000;

function contextLimitFor(provider, model, params) {
  const id = String(model || "").toLowerCase();
  if (provider === "anthropic") {
    const ctx = String((params && params.context) || "").toLowerCase();
    if (/^(1m|1000k|1000000|large|long)$/.test(ctx)) return 1000000;
  }
  for (let i = 0; i < CONTEXT_LIMITS.length; i++) {
    if (CONTEXT_LIMITS[i][0].test(id)) return CONTEXT_LIMITS[i][1];
  }
  return DEFAULT_CONTEXT_LIMIT;
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
  const workerBlocks = {};
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
    if (f.kind === "gate" && f.val) blocks.push({ type: "gate", orchestrated: !!f.val.orchestrated, reason: f.val.reason, source: f.val.source });
    // Rotasi konteks: hanya status akhirnya yang disimpan (satu catatan kecil di alur chat).
    if (f.kind === "handoff" && f.val && f.val.status !== "writing") blocks.push({ type: "handoff", status: f.val.status, usedPercent: f.val.usedPercent, message: f.val.message });
    if (f.kind === "worker" && f.val) {
      const value = f.val;
      const key = String(value.workerId || ((value.role || "worker") + "-" + (value.phase || "") + "-" + (value.attempt || 0)));
      let block = workerBlocks[key];
      if (!block) {
        block = { type: "worker", value: {} };
        workerBlocks[key] = block;
        blocks.push(block);
      }
      const nested = block.value.value && typeof block.value.value === "object" ? block.value.value : {};
      Object.assign(block.value, value);
      if (value.value && typeof value.value === "object") block.value.value = Object.assign({}, nested, value.value);
    }
    if ((f.kind === "verification" || f.kind === "result") && f.val) {
      blocks.push({ type: f.kind, value: f.val });
    }
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

// Path file yang disentuh tool mutasi (relatif workspace, pemisah '/').
// Shell dan custom tool tanpa path yang dapat dibuktikan memakai "*" agar checkpoint
// akhir tetap dipaksa menghitung diff workspace secara konservatif.
function toolPaths(ev, workspace, customTools) {
  const nn = normName(ev && ev.name);
  const customName = nn === "mcp" ? mcpToolName(ev) : "";
  const customAstEdit = /^ast_edit$/i.test(customName);
  const customDef = customName && customTools && customTools[customName];
  const knownReadOnly = /^ast_search$|^memory_search$|^diagnostics$/i.test(customName) ||
    !!(customDef && customDef.annotations && customDef.annotations.readOnlyHint === true);
  const customMutation = nn === "mcp" && !!customName && !knownReadOnly;
  const builtinMutation = /^(edit|write|create|delete|applyagentdiff|multiedit|strreplace|searchreplace|applypatch|notebookedit|editnotebook)$/.test(nn);
  if (nn === "shell") return ["*"];
  // generateImage bawaan Cursor menulis berkas; bentuk hasilnya tidak terdokumentasi, jadi
  // pakai path yang bisa ditemukan (lihat imagePathsOf) atau diff workspace penuh.
  if (nn === "generateimage") { const found = imagePathsOf(ev, workspace); return found.length ? found : ["*"]; }
  if (!customMutation && !builtinMutation) return [];
  const a = (ev && ev.args) || {};
  const cands = [a.path, a.relativeWorkspacePath, a.relative_workspace_path, a.relativePath, a.relative_path, a.file_path, a.filePath, a.file, a.target_file, a.targetFile];
  if (customName) {
    const ma = mcpArgs(ev);
    const ms = mcpStructured(ev);
    cands.push(ma.path, ma.file, ma.filePath, ma.target, ma.to, ms.path, ms.file, ms.filePath, ms.target, ms.to);
    if (Array.isArray(ms.paths)) cands.push.apply(cands, ms.paths);
  }
  // Tool memory menulis memory.json di data/ (di luar workspace) DAN merender blok
  // bertanda di .vrcloud-agent/memory.md — itulah satu-satunya file workspace yang berubah.
  if (/^memory_(upsert|forget|revalidate)$/i.test(customName)) {
    cands.push(".vrcloud-agent/memory.md");
  }
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
  if (!out.length && (customMutation || customAstEdit)) out.push("*");
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
    this.contextEngine = options.contextEngine || null;
    this.workspaceEvents = options.workspaceEvents || null;
    this.unsubscribeProjectContext = this.workspaceEvents && typeof this.workspaceEvents.onChange === "function"
      ? this.workspaceEvents.onChange(() => ProjectContext.invalidate(this.workspace)) : null;
    // Notifikasi ke IDE (lewat hub realtime): run mulai/selesai, daftar sesi berubah,
    // dan perintah shell agent (untuk tab "Agent shell" view-only di semua browser).
    this.onNotify = typeof options.onNotify === "function" ? options.onNotify : null;
    this.onShell = typeof options.onShell === "function" ? options.onShell : null;
    // Tool tambahan in-process untuk agent (SDK customTools), mis. otomasi browser.
    this.customTools = options.customTools || null;
    this.providerFactory = options.providerFactory || new ProviderFactory(options.providerFactoryOptions);
    this.verifier = (typeof options.verifier === "function" ||
      (options.verifier && typeof options.verifier.verify === "function")) ? options.verifier : null;
    this.orchestrationOption = options.orchestration;
    this.browser = options.browser || null; // BrowserAutomation: metadata langkah (screenshot) untuk kartu chat
    this.desktopStatus = typeof options.desktopStatus === "function" ? options.desktopStatus : null; // () => DesktopRemote.status()
    this.desktopShot = typeof options.desktopShot === "function" ? options.desktopShot : null; // (callId) => URL JPEG yang disimpan server
    this.checkpoints = options.checkpoints || null;
    this.approvals = new Map(); // id -> { resolve, sessionId, timer }
    // Nilai default dari environment; dapat ditimpa konfigurasi web (file).
    this.envKey = options.apiKey || process.env.CURSOR_API_KEY || "";
    this.envAnthropicKey = options.anthropicKey || process.env.ANTHROPIC_API_KEY || "";
    // Kunci pencarian web (opsional): Tavily ("tvly-…") atau Brave Search. Tanpa kunci: DuckDuckGo.
    this.envSearchKey = options.searchKey || process.env.SEARCH_API_KEY || process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY || "";
    this.searchKey = this.envSearchKey;
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
    // Satu lock penulis untuk seluruh proses: run biasa (mode agent) dan implementer
    // orkestrasi tidak boleh mengedit workspace bersamaan, apa pun sesinya.
    this.writerMutex = new AgentOrchestrator.Mutex();
    this.orchestrator = options.orchestrator || new AgentOrchestrator({
      config: this.orchestrationConfig(),
      verifier: this.verifier || undefined,
      writerMutex: this.writerMutex,
      createAgent: (worker) => this.createOrchestratorAgent(worker),
      disposeAgent: (agent) => this.dispose(agent),
      eventAdapter: (event, emit, worker) => this.emitFromEvent(event, emit, worker && worker.runtime),
    });
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    if (this.sweepTimer && typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
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
        if (val.meta && Object.keys(val.meta).length) t.meta = val.meta;
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
    this.searchKey = (this.saved.searchKey && String(this.saved.searchKey)) || this.envSearchKey || "";
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
    // Pembuatan gambar: auto (agent membuat gambar bila tugas memerlukannya dan model mendukung) / off.
    this.imageTools = this.saved.imageTools === "off" ? "off" : "auto";
    if (this.saved.autoMaxIter) this.autoMaxIter = Math.max(1, Math.min(30, parseInt(this.saved.autoMaxIter, 10) || 8));
  }

  /**
   * Apakah model aktif bisa membuat gambar, dan lewat jalur apa.
   *   cursor    -> tool generateImage bawaan SDK Cursor ("native")
   *   grok      -> Grok Imagine (API xAI) dengan sesi login Grok ("xai")
   *   anthropic -> Claude tidak membuat gambar; hanya bila XAI_API_KEY diisi ("xai-key")
   */
  imageSupport() {
    const xaiKey = !!String(process.env.XAI_API_KEY || "").trim();
    if (this.provider === "cursor") return { supported: true, via: "native", reason: "Cursor model generateImage tool" };
    if (this.provider === "grok") {
      const connected = !!(this.grokAuth && this.grokAuth.status && this.grokAuth.status().connected);
      if (connected || xaiKey) return { supported: true, via: "xai", reason: "Grok Imagine" };
      return { supported: false, via: "", reason: "sign in with Grok first" };
    }
    if (xaiKey) return { supported: true, via: "xai-key", reason: "Grok Imagine via XAI_API_KEY" };
    return { supported: false, via: "", reason: "Claude models cannot generate images (set XAI_API_KEY to use Grok Imagine)" };
  }
  imagesOn() { return this.imageTools !== "off" && this.imageSupport().supported; }
  // Backend pencarian web yang akan dipakai tool web_search (lihat lib/web-search.js).
  webSearchStatus() {
    const key = this.searchKey || "";
    const backend = !key ? "duckduckgo" : (/^tvly-/i.test(key) ? "tavily" : "brave");
    const mask = (k) => (k ? k.slice(0, 6) + "\u2026" + k.slice(-3) : "");
    return { backend, hasKey: !!key, keyMasked: mask(key), source: this.saved.searchKey ? "web" : (this.envSearchKey ? "env" : "none") };
  }

  // Kredensial untuk lib/image-tools.js. XAI_API_KEY (bila ada) didahulukan: kunci API
  // pasti berlaku di api.x.ai, sedangkan token login Grok bisa saja hanya diterima proxy CLI.
  async imageAuth() {
    const key = String(process.env.XAI_API_KEY || "").trim();
    const base = String(process.env.XAI_API_BASE || "https://api.x.ai/v1").replace(/\/+$/, "");
    if (key) return { token: key, bases: [base] };
    if (this.provider !== "grok" || !this.grokAuth) return null;
    const token = await this.grokAuth.getAccessToken();
    if (!token) return null;
    return { token, bases: GrokAgent.apiBases(), headers: (b, t) => GrokAgent.headersFor(b, t) };
  }
  // Batasan tambahan dari sakelar pengguna, digabung ke restrictions setiap agent.
  imageRestrictions() { return this.imagesOn() ? {} : { noImage: true }; }
  // Tool browser tersedia untuk agent? (browser ada di server dan tidak dimatikan pengguna)
  browserOn() { return this.browserTools !== "off" && !!(this.browser && this.browser.exe); }
  // Remote desktop tersedia di server? (dari opsi desktopStatus, bila diberikan)
  desktopAvailable() { try { const s = this.desktopStatus ? this.desktopStatus() : null; return !s || s.ok !== false; } catch (e) { return true; } }
  desktopOn() { return this.desktopTools !== "off" && this.desktopAvailable(); }
  orchestrationConfig() {
    const value = Object.prototype.hasOwnProperty.call(this.saved || {}, "orchestration")
      ? this.saved.orchestration : this.orchestrationOption;
    return AgentOrchestrator.normalizeConfig(value);
  }
  setVerifier(verifier) {
    this.verifier = (typeof verifier === "function" ||
      (verifier && typeof verifier.verify === "function")) ? verifier : null;
    if (this.orchestrator && typeof this.orchestrator.setVerifier === "function") this.orchestrator.setVerifier(this.verifier);
  }
  customToolSet(restrictions) {
    const source = typeof this.customTools === "function" ? this.customTools() : this.customTools;
    const filtered = {};
    Object.keys(source || {}).forEach((name) => {
      if (this.browserTools === "off" && /^browser_/i.test(name)) return;
      if (this.desktopTools === "off" && /^desktop_/i.test(name)) return;
      // generate_image hanya untuk jalur xAI; Cursor memakai generateImage bawaan SDK.
      if (/^generate_image$/i.test(name) && (!this.imagesOn() || this.imageSupport().via === "native")) return;
      if (this.mode === "ask" && /^memory_(upsert|forget|revalidate)$/i.test(name)) return;
      if (this.mode === "ask" && /^ast_edit$/i.test(name)) return;
      // Mode Chat: ngobrol & diskusi. Boleh riset web, mengingat fakta, membuat gambar;
      // tidak menyentuh workspace (edit/AST) dan tidak mengendalikan desktop.
      if (this.mode === "chat" && /^(ast_edit|desktop_)/i.test(name)) return;
      filtered[name] = source[name];
    });
    return ProviderFactory.filterCustomTools(filtered, restrictions || {});
  }

  // ---- Pengaman perintah berbahaya ------------------------------------
  // Batas tunggu izin harus lebih pendek dari timeout hook di .vrcloud-agent/hooks.json
  // (900 s): kalau hook dibunuh Cursor lebih dulu, perintah justru DIIZINKAN.
  static get GUARD_TIMEOUT_MAX() { return 840; }
  getGuard() {
    const g = (this.saved.guard && typeof this.saved.guard === "object") ? this.saved.guard : {};
    return {
      // Aktif kecuali dimatikan eksplisit: instalasi default berjalan sebagai root dan
      // verifikasi otomatis menjalankan skrip proyek, jadi default yang aman adalah "tanya".
      enabled: g.enabled !== false,
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

  /**
   * Gerbang persetujuan perintah shell. Dipanggil oleh hook Cursor (lib/hooks/shell-guard.js
   * lewat /api/ai/hook/shell) dan langsung oleh tool shell provider Anthropic/Grok (beforeShell).
   * Perintah yang cocok salah satu pola pengaman menampilkan kartu izin di panel AI dan
   * menunggu jawabannya; habis waktu atau run berakhir berarti DITOLAK, bukan diizinkan.
   * opts.sessionId: sesi pemilik perintah bila diketahui; hook Cursor tidak membawanya,
   * jadi semua sesi yang sedang berjalan ditanya dan jawaban pertama yang menang.
   */
  async reviewShell(input, opts) {
    input = input || {}; opts = opts || {};
    const command = String(input.command || "").trim();
    if (!command) return { permission: "allow" };
    const pattern = this.guardMatch(command);
    if (!pattern) return { permission: "allow" };
    let sessionIds = [];
    if (opts.sessionId && this.sessions.has(String(opts.sessionId))) sessionIds = [String(opts.sessionId)];
    else this.sessions.forEach((s, id) => { if (s.busy && s.live) sessionIds.push(id); });
    if (!sessionIds.length) {
      return { permission: "deny", agent_message: "Command blocked by the safety guard (pattern " + pattern + ") and no active session could ask the user. Choose a safer approach." };
    }
    const g = this.getGuard();
    const id = "ap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const payload = {
      id, command: command.slice(0, 2000), pattern, status: "pending",
      cwd: String(input.cwd || input.workingDirectory || input.working_directory || ""),
      timeoutSec: g.timeoutSec,
    };
    const allowed = await new Promise((resolve) => {
      const timer = setTimeout(() => this.decideApproval(id, false, "timeout"), g.timeoutSec * 1000);
      if (timer.unref) timer.unref();
      this.approvals.set(id, { resolve, sessionIds, timer, payload });
      sessionIds.forEach((sid) => { const s = this.sessions.get(sid); if (s && s.live) this.emitTo(s, "approval", payload); });
    });
    if (allowed) return { permission: "allow" };
    return {
      permission: "deny",
      user_message: "Perintah ditolak: " + command.slice(0, 200),
      agent_message: "The user did not approve this command (it matched the safety pattern " + pattern + "). " +
        "Do not run it again or try to achieve the same effect another way without asking; pick a safer approach or report the blocker.",
    };
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
    if (Object.prototype.hasOwnProperty.call(config, "searchKey")) {
      // Dibaca saat tool web_search dipanggil (closure), jadi agent tidak perlu dibuat ulang.
      const sk = String(config.searchKey == null ? "" : config.searchKey).trim();
      if (sk) this.saved.searchKey = sk.slice(0, 200); else delete this.saved.searchKey;
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
      if (["agent", "plan", "ask", "chat"].indexOf(md || "agent") === -1) throw new Error("Mode tidak dikenal: " + md);
      if (md) this.saved.mode = md; else delete this.saved.mode;
      recreate = true;
    }
    // Perintah verifikasi setelah edit (mis. "npm test"); hanya memengaruhi prompt.
    if (Object.prototype.hasOwnProperty.call(config, "verifyCmd")) {
      const v = String(config.verifyCmd == null ? "" : config.verifyCmd).trim();
      if (v) this.saved.verifyCmd = v.slice(0, 300); else delete this.saved.verifyCmd;
    }
    // Orkestrasi server: auto | on | off, jumlah explorer, dan batas repair.
    // Tidak perlu membuat ulang provider; konfigurasi dibaca saat run berikutnya.
    if (Object.prototype.hasOwnProperty.call(config, "orchestration")) {
      const value = config.orchestration;
      if (value == null || value === "") delete this.saved.orchestration;
      else if (typeof value === "boolean" || ["auto", "on", "off"].indexOf(String(value).toLowerCase()) !== -1) {
        this.saved.orchestration = value;
      } else if (value && typeof value === "object") {
        this.saved.orchestration = AgentOrchestrator.normalizeConfig(value);
      } else throw new Error("Konfigurasi orchestration tidak valid");
    }
    // Tool browser: auto (agent memutuskan), on (diutamakan untuk tugas web), off (tool tidak didaftarkan).
    if (Object.prototype.hasOwnProperty.call(config, "browserTools")) {
      const b = String(config.browserTools == null ? "" : config.browserTools).trim().toLowerCase();
      if (["", "auto", "on", "off"].indexOf(b) === -1) throw new Error("Nilai browserTools tidak dikenal: " + b);
      const prev = this.browserTools;
      if (b && b !== "auto") this.saved.browserTools = b; else delete this.saved.browserTools;
      if ((this.saved.browserTools || "auto") !== prev) recreate = true; // set tool agent berubah → buat ulang agent
    }
    // Pembuatan gambar: auto / off. Mengubahnya mengubah set tool → agent dibuat ulang.
    if (Object.prototype.hasOwnProperty.call(config, "imageTools")) {
      const im = String(config.imageTools == null ? "" : config.imageTools).trim().toLowerCase();
      if (["", "auto", "off"].indexOf(im) === -1) throw new Error("Nilai imageTools tidak dikenal: " + im);
      const prevI = this.imageTools;
      if (im === "off") this.saved.imageTools = "off"; else delete this.saved.imageTools;
      if ((this.saved.imageTools || "auto") !== prevI) recreate = true;
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
    if (this.orchestrator) this.orchestrator.config = this.orchestrationConfig();
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
    const cursor = this.providerFactory.cursorStatus();
    if (!cursor.available) return { ok: false, reason: "Modul @cursor/sdk belum terpasang di server (jalankan: npm install @cursor/sdk). Detail: " + cursor.error };
    if (!this.apiKey) return { ok: false, reason: "API key belum diisi. Set lewat panel AI (tombol \u2699) atau CURSOR_API_KEY di .env." };
    return { ok: true, reason: "" };
  }

  status() {
    const mask = (k) => (k ? (k.length > 4 ? "\u2026" + k.slice(-4) : "\u2022\u2022\u2022\u2022") : "");
    const rd = this.readiness();
    const isAnth = this.provider === "anthropic";
    const isGrok = this.provider === "grok";
    const grok = this.grokAuth ? this.grokAuth.status() : { connected: false, source: "none" };
    const cursor = this.providerFactory.cursorStatus();
    const hasSdk = isAnth || isGrok ? true : cursor.available;
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
        cursor: { hasSdk: cursor.available, hasKey: !!this.apiKey, keyMasked: mask(this.apiKey), source: this.saved.apiKey ? "web" : (this.envKey ? "env" : "none") },
        anthropic: { hasSdk: true, hasKey: !!this.anthropicKey, keyMasked: mask(this.anthropicKey), source: this.saved.anthropicKey ? "web" : (this.envAnthropicKey ? "env" : "none") },
        grok: { hasSdk: true, hasKey: !!grok.connected, keyMasked: grok.emailMasked || "", source: grok.source || "none" },
      },
      autoMaxIter: this.autoMaxIter, verifyCmd: this.saved.verifyCmd || "",
      contextLimit: this.contextLimit(),
      browserTools: this.browserTools, browserAvailable: !!(this.browser && this.browser.exe),
      desktopTools: this.desktopTools, desktopAvailable: this.desktopAvailable(),
      imageTools: this.imageTools, imageSupport: this.imageSupport(),
      webSearch: this.webSearchStatus(),
      promptCache: this.promptCache,
      promptCacheControllable: isAnth, // Cursor: caching otomatis di sisi layanan
      memory: this.memoryEnabled,
      orchestration: this.orchestrationConfig(),
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

  /**
   * Indeks pesan pengguna yang ditekan tombol "Kembalikan"-nya. -1 bila tidak ada.
   * Hash checkpoint saja TIDAK unik: snapshot memakai ulang checkpoint lama bila tidak ada file
   * yang berubah, jadi "halo" lalu "buat skrip X" bisa berbagi hash yang sama. Mencari kecocokan
   * pertama berarti tombol di pesan kedua menghapus seluruh chat dari pesan pertama. Maka:
   *   1) hint.ordinal (urutan pesan pengguna ke-n di UI) + hash cocok (+ teks cocok bila ada);
   *   2) teks + hash, kecocokan TERAKHIR;
   *   3) hash saja, kecocokan TERAKHIR — tidak pernah menghapus lebih banyak dari yang dimaksud.
   */
  rewindIndex(sessionId, hash, hint) {
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    const h = String(hash || "").toLowerCase();
    if (!meta || !/^[0-9a-f]{7,64}$/.test(h)) return -1;
    hint = hint || {};
    const users = [];
    (meta.messages || []).forEach((m, i) => { if (m && m.role === "user") users.push({ m, i }); });
    const hashOk = (m) => { const c = m.checkpoint ? String(m.checkpoint).toLowerCase() : ""; return !!c && (c.startsWith(h) || h.startsWith(c)); };
    const hasText = typeof hint.text === "string";
    const textOk = (m) => !hasText || String(m.text || "") === hint.text;
    const ord = Number(hint.ordinal);
    if (Number.isInteger(ord) && ord >= 0 && users[ord] && hashOk(users[ord].m) && textOk(users[ord].m)) return users[ord].i;
    if (hasText) for (let k = users.length - 1; k >= 0; k--) if (hashOk(users[k].m) && textOk(users[k].m)) return users[k].i;
    for (let k = users.length - 1; k >= 0; k--) if (hashOk(users[k].m)) return users[k].i;
    return -1;
  }
  // Pemeriksaan sebelum file dipulihkan: kalau percakapan tidak bisa dimundurkan, jangan
  // sentuh workspace sama sekali (jangan sampai file kembali tetapi chat tidak).
  assertCanRewind(sessionId, hash, hint) {
    const s = this.sessions.get(sessionId);
    if (s && s.busy) throw Object.assign(new Error("Agent masih bekerja. Hentikan dulu (tombol \u25a0) sebelum mengembalikan."), { status: 409 });
    if (this.rewindIndex(sessionId, hash, hint) === -1) throw Object.assign(new Error("Pesan dengan checkpoint ini tidak ditemukan di percakapan."), { status: 404 });
  }

  /**
   * Mundurkan percakapan ke sebelum pesan pengguna yang checkpoint-nya `hash`: pesan itu
   * dan semua pesan sesudahnya dihapus (file dipulihkan terpisah oleh pemanggil).
   * Ingatan agent ikut dibuang — riwayat Anthropic/Grok, agent Cursor tersimpan, okupansi
   * konteks — lalu agent berikutnya dimulai dari transkrip percakapan yang tersisa. Tanpa
   * ini agent tetap "ingat" giliran yang sudah dihapus pengguna.
   * Mengembalikan teks pesan yang dihapus agar UI bisa menaruhnya kembali di kotak input.
   */
  async rewind(sessionId, hash, hint) {
    this.assertCanRewind(sessionId, hash, hint);
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    const idx = this.rewindIndex(sessionId, hash, hint);
    const msgs = meta.messages || [];
    const target = msgs[idx];
    const removed = msgs.length - idx;
    meta.messages = msgs.slice(0, idx);
    meta.updatedAt = Date.now();
    const s = this.sessions.get(sessionId);
    const stale = s ? s.agent : null;
    if (s) { s.agent = null; s.prelude = ""; s.todos = null; }
    const cursorAgentId = meta.agentId;
    delete meta.agentId; delete meta.claudeAgentId; delete meta.grokAgentId;
    delete meta.claudeHistory; delete meta.grokHistory;
    if (meta.usage) delete meta.usage.contextTokens;
    if (!this.preludes) this.preludes = {};
    const transcript = this.sessionTranscript(sessionId, AiChat.REWIND_HEADER);
    if (transcript) this.preludes[sessionId] = transcript; else delete this.preludes[sessionId];
    this.saveStore();
    if (stale) { try { await this.dispose(stale); } catch (e) {} }
    if (cursorAgentId) this.providerFactory.deleteCursorAgent(cursorAgentId, { workspace: this.workspace, apiKey: this.apiKey }).catch(() => {});
    this.notify("sessions-changed", { sessionId, rewound: true });
    return { removed, text: (target && target.text) || "", hadImages: !!(target && target.images && target.images.length) };
  }
  static get REWIND_HEADER() {
    return "[Previous conversation in this chat \u2014 the user rewound the chat and restored the workspace files to this point. " +
      "Everything after it was discarded and never happened; do not assume any of those changes exist. Continue from here; do not repeat this transcript back to the user.]";
  }

  // Ringkasan percakapan yang tersimpan, supaya agent baru (key/provider berganti) bisa melanjutkan.
  sessionTranscript(sessionId, header) {
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
    return (header || "[Previous conversation in this chat \u2014 the API key or provider just changed. Continue the same task from here; do not repeat this transcript back to the user.]") +
      "\n\n" + lines.join("\n\n");
  }

  async createAgent(s, sessionId) {
    const prelude = this.preludes && this.preludes[sessionId];
    if (prelude) delete this.preludes[sessionId];
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    const made = await this.providerFactory.create({
      provider: this.provider,
      apiKey: this.apiKey,
      anthropicKey: this.anthropicKey,
      getGrokToken: () => this.grokAuth.getAccessToken(),
      model: this.model,
      params: this.params,
      workspace: this.workspace,
      shell: process.env.SHELL_BIN,
      customTools: this.customToolSet(),
      promptCache: this.promptCache,
      mode: this.mode,
      restrictions: this.mode === "ask" ? AgentOrchestrator.READ_ONLY_RESTRICTIONS
        : this.mode === "chat" ? Object.assign({}, AiChat.CHAT_RESTRICTIONS, this.imageRestrictions())
        : this.imageRestrictions(),
      meta,
      prelude,
      persistent: true,
      sessionTranscript: this.sessionTranscript(sessionId),
      save: () => this.saveStore(),
      beforeShell: (p) => this.reviewShell(p, { sessionId }),
      onTodos: (todos) => this.enforceTodos(s, todos),
      contextLimit: this.contextLimit(),
    });
    s.agent = made.agent;
    if (made.prelude) s.prelude = made.prelude;
  }

  async createOrchestratorAgent(worker) {
    const meta = this.store.sessions.find((m) => m.id === worker.sessionId);
    const selected = worker.providerConfig || {};
    worker = Object.assign({}, worker, { restrictions: Object.assign({}, worker.restrictions || {}, this.imageRestrictions()) });
    const made = await this.providerFactory.create({
      provider: selected.provider || this.provider,
      apiKey: selected.apiKey || this.apiKey,
      anthropicKey: selected.anthropicKey || this.anthropicKey,
      getGrokToken: () => this.grokAuth.getAccessToken(),
      model: selected.model || this.model,
      params: selected.params || this.params,
      workspace: this.workspace,
      shell: process.env.SHELL_BIN,
      customTools: this.customToolSet(worker.restrictions),
      promptCache: this.promptCache,
      mode: "agent",
      restrictions: worker.restrictions || {},
      meta,
      // Worker IDs are adopted only after successful finalization; transient or
      // cancelled workers must never replace the persisted conversation agent.
      persistent: false,
      forceNew: true,
      sessionTranscript: this.sessionTranscript(worker.sessionId),
      save: () => this.saveStore(),
      beforeShell: (p) => this.reviewShell(p, { sessionId: worker.sessionId }),
      contextLimit: this.contextLimit(),
    });
    return made.agent;
  }

  // Instruksi kerja agent yang disisipkan (tak terlihat di UI) di depan pesan
  // pengguna. Pertanyaan biasa dijawab langsung; tugas dikerjakan tuntas.
  // Semua teks instruksi ada di lib/agent-instructions.js; di sini hanya dikumpulkan konteksnya.
  /**
   * Tugas atau percakapan? Pesan tugas memakai playbook engineering penuh (todo, verifikasi,
   * snapshot proyek); percakapan memakai prompt ringan yang membuat agent jadi teman diskusi.
   * Mode Chat memaksa "chat"; mode Plan memaksa "task". Selebihnya heuristik: kata kerja
   * perintah, path/ekstensi file, blok kode, @mention, atau kosakata kode berarti tugas.
   */
  intentOf(text, extra) {
    extra = extra || {};
    if (extra.intent === "chat" || extra.intent === "task") return extra.intent;
    if (this.mode === "chat") return "chat";
    if (this.mode === "plan") return "task";
    const t = String(text || "");
    if (Array.isArray(extra.skills) && extra.skills.length) return "task";
    if (/```|@[\w./-]+|[\w-]+\.(jsx?|tsx?|mjs|cjs|py|go|rs|java|kt|c|cpp|h|cs|php|rb|json|ya?ml|toml|md|css|scss|html?|sh|ps1|sql|env)\b|(^|[\s"'`(])(\.{0,2}\/|[A-Za-z]:\\)[\w.-]+[\/\\]/i.test(t)) return "task";
    if (/\b(add|build|change|create|debug|delete|fix|implement|integrate|migrate|refactor|remove|rename|replace|run|test|update|write|wire|install|deploy|generate|setup|configure|optimi[sz]e|continue|tambah(?:kan)?|buat(?:kan|lah)?|bangun|ubah|ganti|perbaiki|benerin|hapus|implementasikan|integrasikan|migrasi|refaktor|uji|tes|jalankan|pasang|tulis(?:kan)?|kerjakan|cek|periksa|lanjutkan|lanjut|rapikan|rapihkan|optimalkan|deploy|push|commit)\b/i.test(t)) return "task";
    if (/\b(file|folder|function|fungsi|kode|code|error|bug|script|skrip|compile|npm|git|terminal|workspace|repo|server|database|endpoint|api|class|komponen|component|variabel|variable|lint|test|unit)\b/i.test(t)) return "task";
    return "chat";
  }

  // Fakta tentang pengguna (kind "user") dari memori terstruktur, untuk disuntikkan ke setiap prompt.
  async userProfileText() {
    const store = this.contextEngine && this.contextEngine.memoryStore;
    if (!store || !this.memoryEnabled) return "";
    try {
      if (store.ready) await store.ready;
      const items = await store.search("", { kind: "user", limit: 25 });
      const lines = (items || []).filter((it) => it && it.status === "active" && it.statement)
        .map((it) => "- " + String(it.statement).replace(/\s+/g, " ").trim());
      return lines.join("\n");
    } catch (e) { return ""; }
  }

  // opts.noEditor: pengguna mengecualikan file aktif & tab terbuka untuk pesan ini (pill konteks di panel AI).
  // opts.intent: "chat" | "task" (lihat intentOf).
  async agentPrompt(userText, priorTranscript, opts) {
    opts = opts || {};
    const editor = opts.noEditor ? { active: "", open: [] } : this.editorContext();
    const userProfile = await this.userProfileText();
    if (opts.intent === "chat") {
      return Instructions.agentPrompt({
        intent: "chat",
        workspace: this.workspace,
        editorContext: this.editorContextText(editor),
        browser: { on: this.browserOn(), mode: this.browserTools },
        images: { on: this.imagesOn(), mode: this.imageTools, via: this.imageSupport().via },
        userProfile,
        priorTranscript: priorTranscript || "",
        userText,
      });
    }
    let indexedContext = "";
    if (this.contextEngine) {
      try {
        indexedContext = await this.contextEngine.buildContext({
          query: userText,
          active: editor.active ? [editor.active] : [],
          open: editor.open,
          readOnly: this.mode === "ask",
        });
      } catch (e) { indexedContext = ""; }
    }
    if (this.mode === "ask") {
      const readOnlyContext = [indexedContext, priorTranscript || ""].filter(Boolean).join("\n\n");
      return Instructions.agentPrompt({ workspace: this.workspace, mode: "ask", priorTranscript: readOnlyContext, userText, userProfile });
    }
    const snap = this.projectSnapshot();
    const verify = this.saved.verifyCmd || (snap && snap.verify && snap.verify.length ? snap.verify.slice(0, 2).join(" && ") : "");
    const projectContext = [this.projectContextText(), indexedContext].filter(Boolean).join("\n\n");
    return Instructions.agentPrompt({
      workspace: this.workspace,
      mode: this.mode,
      platform: process.platform,
      // Provider Anthropic sudah membawa blok statis (cara kerja, keamanan) di system prompt-nya.
      includeStatic: this.provider !== "anthropic" && this.provider !== "grok",
      verify, verifyIsCustom: !!this.saved.verifyCmd,
      editorContext: this.editorContextText(editor),
      snapshotText: snap && snap.text ? snap.text : "",
      browser: { on: this.browserOn(), mode: this.browserTools },
      desktop: { on: this.desktopOn(), mode: this.desktopTools },
      images: { on: this.imagesOn(), mode: this.imageTools, via: this.imageSupport().via, reason: this.imageSupport().reason },
      memoryEnabled: this.memoryEnabled,
      memoryText: this.memoryEnabled ? this.memoryText() : "",
      userProfile,
      // Fallback: the Cursor SDK reads `.cursor/`; when the .cursor -> .vrcloud-agent link cannot be
      // created (e.g. exFAT), rules and the skills index are injected directly into the prompt.
      projectContext,
      priorTranscript: priorTranscript || "",
      userText,
    });
  }
  // Snapshot proyek (stack, skrip, git, struktur, file terbaru) — lihat lib/project-context.js.
  projectSnapshot() {
    try { return ProjectContext.snapshot(this.workspace); } catch (e) { return null; }
  }
  // File yang sedang dibuka di editor IDE: agent tahu konteks kerja pengguna tanpa ditanya.
  editorContext() {
    if (!this.openFiles) return { active: "", open: [] };
    let ctx = null;
    try { ctx = this.openFiles(); } catch (e) { return { active: "", open: [] }; }
    if (!ctx) return { active: "", open: [] };
    return {
      active: ctx.active ? String(ctx.active) : "",
      open: Array.isArray(ctx.open) ? ctx.open.filter(Boolean).map(String).slice(0, 12) : [],
    };
  }
  editorContextText(ctx) {
    ctx = ctx || this.editorContext();
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
      // Hanya SDK Cursor yang membaca `.cursor/` sendiri; untuk provider itu, jika tautannya ada,
      // jangan duplikasi di prompt. Anthropic/Grok tak punya pembaca semacam itu, jadi rules +
      // indeks skills HARUS selalu disisipkan ke prompt agar agent tahu & memakai skill.
      if (this.provider === "cursor" && fs.existsSync(path.join(ws, ".cursor"))) return "";
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
      let t = fs.readFileSync(file, "utf8");
      // Blok terstruktur yang dirender MemoryStore sudah dipilih dan dibatasi oleh context
      // engine; jangan dikirim dua kali. Yang tersisa adalah catatan bebas di luar penanda.
      t = t.replace(/<!-- vrcloud:structured-memory start -->[\s\S]*?<!-- vrcloud:structured-memory end -->/g, "").trim();
      if (!t) return "";
      const max = Instructions.MEMORY.maxChars;
      if (t.length > max) t = t.slice(0, max) + Instructions.MEMORY.truncated;
      return t;
    } catch (e) { return ""; }
  }

  // Jendela konteks model aktif (token). Dipakai bar progres di panel AI dan peringatan
  // "konteks menipis" yang dikirim ke agent.
  contextLimit() {
    return contextLimitFor(this.provider, this.model, this.params);
  }

  // Berapa banyak jendela konteks yang terpakai pada putaran terakhir. Akumulasi token
  // lintas putaran BUKAN ukurannya: tiap putaran mengirim ulang seluruh riwayat, jadi yang
  // menentukan adalah permintaan terakhir.
  contextUsedPercent(s) {
    const u = s && s.live && s.live.usage;
    const used = u && typeof u.contextTokens === "number" ? u.contextTokens : 0;
    const limit = this.contextLimit();
    if (!used || !limit) return 0;
    return Math.min(100, (used / limit) * 100);
  }

  /**
   * Ringkasan kemajuan run yang sedang berjalan: permintaan asli, todo beserta statusnya,
   * file yang sudah diubah, hasil verifikasi terakhir. Dikirim ulang pada setiap putaran
   * lanjutan supaya agent menyambung dari langkah terakhir, bukan mengulang dari awal
   * ketika riwayatnya sendiri sudah dipadatkan.
   */
  taskState(s, request) {
    const live = (s && s.live) || {};
    let verification = "";
    const frames = Array.isArray(live.frames) ? live.frames : [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (!f || f.kind !== "verification" || !f.val) continue;
      const v = f.val;
      verification = (v.passed ? "passed" : "FAILED") + (v.command ? ": " + v.command : "") +
        (v.summary ? " \u2014 " + v.summary : "");
      break;
    }
    return {
      request: request || "",
      todos: s && s.todos ? s.todos : null,
      files: live.touched || [],
      verification,
      usedPercent: this.contextUsedPercent(s),
      // Catatan penegak bukti (todo yang dikembalikan ke in_progress) — satu-satunya jalur
      // untuk provider Cursor, yang tool todo-nya tidak bisa kita balas langsung.
      warnings: s && s.evidence && s.evidence.notes ? s.evidence.notes.slice(-2) : [],
    };
  }

  // Frame usage untuk UI. u boleh membawa `measured: true` (hasil count_tokens: okupansi
  // persis, tidak menambah akumulasi biaya) atau hasil putaran biasa (diakumulasi).
  usageFrame(s, u) {
    const cur = (s && s.live && s.live.usage) || null;
    if (u && u.measured) {
      const next = Object.assign({}, cur || {});
      next.contextTokens = Math.max(0, u.contextTokens | 0);
      next.contextLimit = this.contextLimit();
      next.measured = true;
      return next;
    }
    const next = addUsage(cur, u);
    // inputTokens/outputTokens diakumulasi lintas putaran (itu total biaya). Yang mengisi
    // jendela konteks adalah permintaan TERAKHIR, karena tiap putaran mengirim ulang
    // seluruh riwayat — jadi dicatat terpisah untuk bar progres dan peringatan konteks.
    const occupancy = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) + (u.outputTokens || 0);
    if (occupancy > 0) next.contextTokens = occupancy;
    next.contextLimit = this.contextLimit();
    delete next.measured;
    return next;
  }

  /**
   * Penegak bukti. Sebuah todo hanya boleh berpindah ke "completed" bila sejak ia menjadi
   * in_progress (atau sejak pembaruan todo terakhir, bila melompat dari pending) ada paling
   * sedikit satu tool pemeriksaan yang benar-benar selesai: shell, browser_*, desktop_*,
   * diagnostics, readLints. Tanpa itu statusnya dikembalikan ke in_progress dan modelnya
   * diberi tahu lewat hasil tool updateTodos (Anthropic/Grok) atau prompt lanjutan (Cursor).
   */
  enforceTodos(s, todos) {
    if (!s || !s.evidence || !Array.isArray(todos)) return { todos, note: "" };
    const ev = s.evidence;
    // Pembanding = daftar terakhir yang DISETUJUI penegak, bukan s.todos: event "running"
    // sudah menulis s.todos dari argumen tool sebelum tool-nya dieksekusi.
    const prevById = {};
    (ev.accepted || []).forEach((t) => { if (t && t.id) prevById[t.id] = t; });
    const reverted = [];
    // Provider Cursor menormalkan status lewat normTodos ("inProgress"); Anthropic/Grok
    // memakai string dari model ("in_progress"). Kembalikan dengan ejaan yang sama.
    const progress = todos.some((t) => t && t.status === "inProgress") ? "inProgress" : "in_progress";
    const isProgress = (v) => /^in.?progress$/i.test(String(v || ""));
    const out = todos.map((t) => {
      if (!t || !t.id) return t;
      const prev = prevById[t.id];
      const prevStatus = prev ? String(prev.status || "pending") : "";
      const status = String(t.status || "pending");
      if (isProgress(status) && !isProgress(prevStatus)) ev.started[t.id] = ev.count;
      if (status !== "completed" || prevStatus === "completed") return t;
      // Baseline: hitungan bukti saat todo ini mulai dikerjakan (atau saat daftar terakhir
      // diperbarui bila tidak pernah in_progress) — dan tidak lebih rendah dari bukti yang
      // sudah "dipakai" untuk menyelesaikan todo lain. Satu pemeriksaan tidak boleh
      // menyelesaikan dua langkah: tiap penyelesaian butuh pemeriksaan baru.
      const base = Math.max(ev.started[t.id] != null ? ev.started[t.id] : ev.lastPlan, ev.lastAccepted || 0);
      if (ev.count > base) { ev.lastAccepted = ev.count; return t; }
      reverted.push(String(t.content || t.title || t.id).replace(/\s+/g, " ").slice(0, 120));
      ev.started[t.id] = ev.count;
      return Object.assign({}, t, { status: progress });
    });
    ev.lastPlan = ev.count;
    ev.accepted = out.map((t) => Object.assign({}, t));
    if (!reverted.length) return { todos: out, note: "" };
    const note = "[Verification required] " + (reverted.length === 1 ? "This step was" : "These steps were") + " NOT marked completed because no check ran since " +
      (reverted.length === 1 ? "it" : "they") + " started: " + reverted.map((r) => "\u201c" + r + "\u201d").join(", ") + ". " +
      "Run the narrowest check that proves the step works (syntax check, test, build, running the script, a screenshot for UI work), read its output, then mark it completed.";
    ev.notes = (ev.notes || []).concat([note]).slice(-5);
    return { todos: out, note };
  }
  // Tool yang hasilnya dihitung sebagai bukti pemeriksaan.
  static isEvidenceTool(name) {
    // generate_image/generateImage: berkas gambar yang tersimpan adalah bukti langkah "buat gambar".
    return /^(shell|diagnostics|readLints|browser_|desktop_|generate_?image$)/i.test(String(name || ""));
  }

  continuePrompt(state) { return Instructions.continuePrompt(state); }

  // Ambang okupansi konteks (persen) yang memicu handoff + rotasi agent.
  static get HANDOFF_PERCENT() { return 80; }
  // Mode Chat: tool bawaan yang mengubah workspace / menjalankan perintah dilarang (seperti Ask),
  // tetapi tool kustom baca-tulis yang tidak menyentuh workspace (browser, memori, gambar) tetap ada.
  static get CHAT_RESTRICTIONS() { return Object.freeze({ readOnlyBuiltins: true, noShell: true, noDesktop: true, noAstEdit: true, noNativeTask: true }); }

  /**
   * Zona abu-abu gating Smart Agent: tanya model (worker baca-saja sekali pakai, satu
   * jawaban satu kata). Gagal/timeout → jalur langsung, bukan error; keputusan dan
   * sumbernya (classifier|heuristic) ditampilkan di UI.
   */
  async classifyOrchestration(sessionId, text) {
    const fallback = (why) => ({ decision: false, reason: why, source: "heuristic" });
    let agent = null;
    try {
      agent = await this.createOrchestratorAgent({ sessionId, restrictions: AgentOrchestrator.READ_ONLY_RESTRICTIONS, providerConfig: null });
      const run = await agent.send(Instructions.orchestrationClassifierPrompt(text));
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { run.cancel(); } catch (e) {} }, AiChat.CLASSIFIER_TIMEOUT_MS);
      try {
        for await (const ev of run.stream()) {
          this.emitFromEvent(ev, (kind, val) => { if (kind === "text") out += String(val == null ? "" : val); }, null);
        }
        try { await run.wait(); } catch (e) { /* timeout membatalkan run */ }
      } finally { clearTimeout(timer); }
      if (timedOut && !/\b(MULTI|SINGLE)\b/.test(out)) return fallback("classifier timed out: direct agent");
      const m = /\b(MULTI|SINGLE)\b\s*[-:\u2014]?\s*([^\n]*)/i.exec(out);
      if (!m) return fallback("classifier gave no verdict: direct agent");
      const reason = String(m[2] || "").trim().slice(0, 120);
      return { decision: m[1].toUpperCase() === "MULTI", reason: reason || (m[1].toUpperCase() === "MULTI" ? "several code areas involved" : "one agent can do this directly"), source: "classifier" };
    } catch (e) {
      return fallback("classifier failed (" + String((e && e.message) || e).slice(0, 80) + "): direct agent");
    } finally {
      if (agent) { try { await this.dispose(agent); } catch (e) {} }
    }
  }
  static get CLASSIFIER_TIMEOUT_MS() { return 12000; }

  /**
   * Ringkasan bergulir. Minta agent yang hampir kehabisan konteks menulis handoff
   * (tujuan, yang selesai + buktinya, yang sedang dikerjakan, temuan, sisa langkah), lalu
   * buang agent itu dan buat agent baru yang riwayatnya diawali handoff + state tugas.
   * Teks handoff tidak ditampilkan sebagai jawaban di chat; UI mendapat frame "handoff".
   */
  async rotateAgent(s, sessionId, request, emit) {
    const agent = s.agent;
    if (!agent || s.stopRequested) return false;
    const pct = Math.round(this.contextUsedPercent(s));
    emit("handoff", { status: "writing", usedPercent: pct });
    let handoff = "";
    const collect = (kind, val) => {
      if (kind === "text") { handoff += String(val == null ? "" : val); return; }
      if (kind === "think") return;
      emit(kind, val);
    };
    try { await this.runOnce(s, Instructions.handoffRequest(this.taskState(s, request)), collect); }
    catch (e) { handoff = ""; }
    if (s.stopRequested) return false;
    s.agent = null;
    try { await this.dispose(agent); } catch (e) {}
    if (!this.preludes) this.preludes = {};
    this.preludes[sessionId] = Instructions.handoffPrelude(handoff, this.taskState(s, request));
    try { await this.ensureAgent(sessionId); }
    catch (e) { emit("handoff", { status: "error", message: explainError(e) }); throw e; }
    // Okupansi lama milik agent yang sudah dibuang; agent baru melaporkan angkanya sendiri.
    if (s.live && s.live.usage) { s.live.usage.contextTokens = 0; delete s.live.usage.measured; }
    emit("handoff", { status: "done", usedPercent: pct, chars: handoff.length });
    return true;
  }

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
    let resolveDone;
    s.done = new Promise((resolve) => { resolveDone = resolve; });
    // Keputusan Smart Agent: kasus jelas dari heuristik; zona abu-abu ditanyakan ke model.
    // Alasannya dikirim ke UI sebagai frame "gate" supaya terlihat kenapa jalur ini dipilih.
    // Percakapan (bukan tugas) tidak pernah diorkestrasi dan tidak memakai mesin tugas sama sekali.
    const intent = this.intentOf(text, extra);
    let gate = this.orchestrator && intent !== "chat" ? this.orchestrator.explain({
      mode: this.mode,
      text,
      hasImages: images.length > 0,
      force: typeof extra.orchestrate === "boolean" ? extra.orchestrate : undefined,
      config: this.orchestrationConfig(),
    }) : { decision: false, reason: intent === "chat" ? "conversation" : "no orchestrator" };
    let gateSource = "heuristic";
    if (gate.decision === "ambiguous") {
      if (gate.config && gate.config.classifier !== false && this.readiness().ok) {
        const verdict = await this.classifyOrchestration(sessionId, text);
        gate = { decision: verdict.decision, reason: verdict.reason, config: gate.config };
        gateSource = verdict.source;
      } else gate = { decision: false, reason: gate.reason + " (classifier off: direct agent)", config: gate.config };
    }
    const orchestrated = gate.decision === true;
    const providerSnapshot = orchestrated ? {
      provider: this.provider,
      model: this.model,
      params: Object.assign({}, this.params || {}),
      apiKey: this.apiKey,
      anthropicKey: this.anthropicKey,
    } : null;
    const priorConversation = orchestrated ? this.sessionTranscript(sessionId) : "";
    if (!orchestrated) {
      try { await this.ensureAgent(sessionId); }
      catch (e) {
        s.busy = false;
        s.done = null;
        resolveDone();
        throw e;
      }
    }
    s.stopRequested = false;
    s.live = newLive();
    s.todos = null;
    // Penegak bukti hanya untuk run agent biasa; orkestrasi punya fase/verifier sendiri,
    // dan mode plan/ask tidak mengerjakan apa pun.
    s.evidence = (!orchestrated && this.mode === "agent" && intent !== "chat") ? { count: 0, started: {}, lastPlan: 0, lastAccepted: 0, accepted: null, notes: [] } : null;
    s.intent = intent;
    s.onEvent = typeof onEvent === "function" ? onEvent : null;
    s.lastUsed = Date.now();
    // Lock penulis global: run biasa dalam mode agent menulis ke workspace, jadi harus
    // menunggu implementer orkestrasi (atau run agent sesi lain) selesai lebih dulu.
    // Orkestrasi mengambil lock-nya sendiri di fase implementasi — jangan diambil dua kali.
    let releaseWriter = null;
    s.lockAbort = new AbortController();
    if (!orchestrated && this.mode === "agent" && intent !== "chat") {
      try { releaseWriter = await this.writerMutex.acquire(s.lockAbort.signal); }
      catch (e) {
        s.busy = false; s.live = null; s.evidence = null; s.done = null; s.lockAbort = null;
        resolveDone();
        throw new Error("Dibatalkan saat menunggu giliran menulis ke workspace");
      }
    }
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
    if (this.mode === "agent" && intent !== "chat" && gate.reason) emit("gate", { orchestrated, reason: gate.reason, source: gateSource });

    try {
      // Checkpoint workspace sebelum agent menyentuh apa pun.
      let before = null;
      if (this.checkpoints && this.checkpoints.available) {
        try { before = await this.checkpoints.snapshot("sebelum: " + display.slice(0, 60)); } catch (e) { before = null; }
        if (before) { userMsg.checkpoint = before; this.saveStore(); emit("checkpoint", { before }); }
      }

      let status = "finished";
      let orchestrationResult = null;
      if (orchestrated) {
        const fullPrompt = await this.agentPrompt(text, priorConversation, { noEditor: !!extra.noEditorContext, intent });
        orchestrationResult = await this.orchestrator.run({
          sessionId,
          request: text,
          fullPrompt,
          config: this.orchestrationConfig(),
          providerConfig: providerSnapshot,
          verifyCmd: this.saved.verifyCmd || "",
          emit,
        });
        status = orchestrationResult.status;
        (orchestrationResult.touchedFiles || []).forEach((p) => {
          if (s.live && s.live.touched.indexOf(p) === -1) s.live.touched.push(p);
        });
      } else {
        // Satu putaran, tanpa lanjut otomatis: rencana, tanya-jawab, dan percakapan biasa.
        const planOnly = this.mode === "plan" || this.mode === "ask" || this.mode === "chat" || intent === "chat";
        let prevTodos = "";
        let idle = 0;
        let rotated = false; // agent baru saja diganti (handoff): kirim ulang instruksi penuh
        for (let i = 0; i < this.autoMaxIter; i++) {
          if (!s.agent || s.stopRequested) break;
          if (i > 0) emit("iter", { n: i + 1, max: this.autoMaxIter });
          // Prelude: transkrip saat provider berganti, atau handoff setelah rotasi konteks.
          // Provider Cursor menerimanya sebagai teks (Anthropic/Grok sudah menaruhnya di riwayat).
          const prior = s.prelude || "";
          if (prior) s.prelude = "";
          let payload;
          if (i === 0 || rotated) {
            payload = await this.agentPrompt(text || "(see the attached image)", prior, { noEditor: !!extra.noEditorContext, intent });
            if (rotated) payload += "\n\n" + this.continuePrompt(this.taskState(s, text));
            rotated = false;
          } else {
            payload = (prior ? prior + "\n\n" : "") + this.continuePrompt(this.taskState(s, text));
          }
          if (i === 0 && images.length) payload = { text: payload, images: images.map((im) => ({ data: im.data, mimeType: im.mimeType })) };
          const r = await this.runOnce(s, payload, emit);
          status = r.status;
          if (planOnly || status === "cancelled" || status === "error" || s.stopRequested) break;
          if (todosDone(s.todos)) break;
          // Konteks hampir penuh dan tugas belum selesai: handoff + agent baru, bukan
          // memotong riwayat diam-diam sampai agent lupa apa yang sedang dikerjakannya.
          if (this.contextUsedPercent(s) >= AiChat.HANDOFF_PERCENT) {
            rotated = await this.rotateAgent(s, sessionId, text, emit);
            if (s.stopRequested) break;
          }
          const sig = JSON.stringify(s.todos || []);
          idle = (sig === prevTodos && r.toolEvents === 0) ? idle + 1 : 0;
          prevTodos = sig;
          if (idle >= 2) break; // dua putaran tanpa kemajuan: berhenti
        }
      }
      // Provider tanpa memori sisi server (Anthropic / Grok): simpan riwayat percakapan ringkas.
      if (!orchestrated && s.agent && typeof s.agent.getHistory === "function") {
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
        orchestration: orchestrationResult ? {
          runId: orchestrationResult.runId,
          status: orchestrationResult.status,
          verification: orchestrationResult.verification,
          todos: orchestrationResult.todos,
          workers: orchestrationResult.workers,
        } : undefined,
      };
      if (live.usage) {
        meta.usage = addUsage(meta.usage, live.usage);
        // Okupansi konteks menggambarkan keadaan terakhir, bukan jumlah lintas pesan:
        // timpa, jangan akumulasi, supaya bar konteks tetap benar saat chat dibuka lagi.
        if (live.usage.contextTokens) meta.usage.contextTokens = live.usage.contextTokens;
        if (live.usage.contextLimit) meta.usage.contextLimit = live.usage.contextLimit;
      }
      if (before && live.touched && live.touched.length && this.checkpoints) {
        try {
          aiMsg.after = await this.checkpoints.snapshot("setelah: " + display.slice(0, 60));
          if (aiMsg.after && aiMsg.after !== before) {
            const stat = await this.checkpoints.diffStat(before, aiMsg.after);
            if (stat.length) {
              aiMsg.changes = stat.slice(0, 200);
              aiMsg.files = stat.map((item) => item.path).slice(0, 200);
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
      if (orchestrated) {
        // Finalizer sengaja read-only, jadi agent itu tidak boleh dipakai ulang
        // untuk giliran Agent berikutnya. Rehidrasi agent unrestricted dari
        // transkrip kanonik pada pesan selanjutnya.
        const stale = s.agent;
        s.agent = null;
        if (stale) await this.dispose(stale);
        if (!this.preludes) this.preludes = {};
        this.preludes[sessionId] = this.sessionTranscript(sessionId);
      }
      this.broadcast(s, "done", status, 1e9);
      if (!orchestrated) this.refreshCost(sessionId, s.agent);
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
      if (releaseWriter) { try { releaseWriter(); } catch (e) {} }
      s.lockAbort = null;
      s.run = null;
      s.busy = false;
      s.live = null;
      s.evidence = null;
      s.onEvent = null;
      s.lastUsed = Date.now();
      this.notify("run-end", { sessionId });
      // Persetujuan yang masih menggantung untuk sesi ini: tolak.
      this.approvals.forEach((e, id) => { if (e.sessionIds.indexOf(sessionId) !== -1) this.decideApproval(id, false, "ended"); });
      s.done = null;
      resolveDone();
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
    var sessionId = s && s.sessionId ? String(s.sessionId) : null;
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
        let todos = todosFrom(event, s ? s.todos : null);
        if (todos) {
          // Provider Cursor memakai tool todo milik SDK, jadi penegak bukti tidak bisa
          // menyentuh hasil tool-nya; cukup koreksi daftar yang dilihat UI dan prompt lanjutan.
          // Anthropic/Grok sudah ditegakkan di dalam tool (onTodos) — hasilnya sudah terkoreksi.
          if (s && s.evidence && this.provider === "cursor" && event.status !== "running") todos = this.enforceTodos(s, todos).todos;
          if (s) s.todos = todos;
          emit("plan", todos);
        }
        return;
      }
      // Pemeriksaan yang benar-benar selesai = bukti untuk penegak todo.
      if (s && s.evidence && event.status === "completed" && AiChat.isEvidenceTool(nn === "mcp" ? mcpToolName(event) : nn)) s.evidence.count++;
      var d = toolDetail(event);
      var meta = toolMeta(event, this.workspace);
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
        const paths = toolPaths(event, this.workspace, this.customToolSet());
        if (paths.length) {
          if (s && s.live) paths.forEach((p) => { if (s.live.touched.indexOf(p) === -1) s.live.touched.push(p); });
          if (this.onFsChange) { try { this.onFsChange(paths.indexOf("*") !== -1 ? [] : paths); } catch (e) {} }
        } else if (nn === "shell" && this.onFsChange && event.status === "completed") {
          try { this.onFsChange([]); } catch (e) {} // shell bisa mengubah file apa saja: segarkan editor yang terbuka + tree
        }
      }
      return;
    }
    // Pemakaian token per putaran.
    if (type === "usage" && event.usage && typeof event.usage === "object") {
      emit("usage", this.usageFrame(s, event.usage));
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
    const done = s.done;
    s.stopRequested = true; // hentikan juga loop otonom
    if (s.lockAbort) { try { s.lockAbort.abort(); } catch (e) {} } // masih mengantre lock penulis
    this.approvals.forEach((e, id) => { if (e.sessionIds.indexOf(sessionId) !== -1) this.decideApproval(id, false, "stopped"); });
    const orchestrated = this.orchestrator ? await this.orchestrator.cancelSession(sessionId) : false;
    if (!s.run) {
      if (done) await done;
      return orchestrated;
    }
    const run = s.run;
    try {
      if (typeof run.supports !== "function" || run.supports("cancel")) {
        await run.cancel();
        if (done) await done;
        return true;
      }
    } catch (e) { /* abaikan */ }
    return orchestrated;
  }

  async reset(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) this.broadcast(s, "error", "Percakapan dihapus", 1e9);
    if (s) await this.stop(sessionId);
    else if (this.orchestrator) await this.orchestrator.cancelSession(sessionId);
    const meta = this.store.sessions.find((m) => m.id === sessionId);
    this.sessions.delete(sessionId);
    this.store.sessions = this.store.sessions.filter((m) => m.id !== sessionId);
    this.saveStore();
    this.notify("sessions-changed", { sessionId, removed: true });
    if (s && s.agent) await this.dispose(s.agent);
    // Hapus juga agent tersimpan di SDK agar tidak menumpuk.
    if (meta && meta.agentId) {
      this.providerFactory.deleteCursorAgent(meta.agentId, { workspace: this.workspace, apiKey: this.apiKey }).catch(() => {});
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
    if (this.orchestrator) {
      const ids = Array.from(this.orchestrator.activeRuns.keys());
      await Promise.all(ids.map((id) => this.orchestrator.cancel(id)));
    }
    const cancellations = [];
    const completions = [];
    this.sessions.forEach((s) => {
      s.stopRequested = true;
      if (s.run && typeof s.run.cancel === "function") {
        try {
          if (typeof s.run.supports !== "function" || s.run.supports("cancel")) {
            cancellations.push(Promise.resolve(s.run.cancel()).catch(() => {}));
          }
        } catch (e) {}
      }
      if (s.done) completions.push(s.done);
    });
    await Promise.all(cancellations);
    await Promise.all(completions);
    this.sessions.forEach((s) => {
      if (s.agent) agents.push(s.agent);
      s.agent = null;
      s.run = null;
      s.busy = false;
      s.live = null;
      s.listeners.clear();
    });
    this.sessions.clear();
    for (const a of agents) await this.dispose(a);
  }

  async close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.unsubscribeProjectContext) this.unsubscribeProjectContext();
    this.unsubscribeProjectContext = null;
    this.approvals.forEach((entry, id) => this.decideApproval(id, false, "ended"));
    await this.disposeAll();
    this.saveStore();
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
      return this.providerFactory.listModels({
        provider: "grok",
        getGrokToken: () => this.grokAuth.getAccessToken(),
        refresh: !!refresh,
      });
    }
    const key = (apiKey && String(apiKey).trim()) || (prov === "anthropic" ? this.anthropicKey : this.apiKey);
    if (!key) throw new Error(prov === "anthropic" ? "API key Anthropic belum diisi" : "API key belum diisi");
    const res = await this.providerFactory.listModels({ provider: prov, apiKey: key, refresh: !!refresh });
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

AiChat._private = {
  blocksFrom,
  toolPaths,
};

module.exports = AiChat;
