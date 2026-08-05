#!/usr/bin/env node
/**
 * VRCloud IDE
 * Backend: Express (REST file API) + WebSocket (terminal via node-pty).
 *
 * Env:
 *   PORT        port HTTP        (default 1337)
 *   HOST        bind address     (default 0.0.0.0)
 *   WORKSPACE   folder kerja     (default: cwd)
 *   AUTH_USER   username login
 *   AUTH_PASS   password login
 *   AUTH_SECRET secret penandatangan cookie
 *   SHELL_BIN   shell terminal   (default: bash)
 */
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const express = require("express");
const mime = require("mime-types");
const WebSocket = require("ws");
const SessionStore = require("./lib/session-store");
const TerminalManager = require("./lib/terminal-manager");
const RealtimeHub = require("./lib/realtime-hub");

// Muat .env tanpa dependency tambahan agar tetap kompatibel dengan Node 12.
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((line) => {
    const value = line.trim();
    if (!value || value[0] === "#") return;
    const index = value.indexOf("=");
    if (index < 1) return;
    const key = value.slice(0, index).trim();
    let parsed = value.slice(index + 1).trim();
    if ((parsed[0] === '"' && parsed[parsed.length - 1] === '"') ||
        (parsed[0] === "'" && parsed[parsed.length - 1] === "'")) parsed = parsed.slice(1, -1);
    if (process.env[key] == null) process.env[key] = parsed;
  });
} catch (e) {}

const PORT = parseInt(process.env.PORT || "1337", 10);
const HOST = process.env.HOST || "0.0.0.0";
const WORKSPACE = path.resolve(process.env.WORKSPACE || process.cwd());
const SHELL = process.env.SHELL_BIN || "bash"; // paksa bash agar prompt Cloud9 aktif
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const AUTH_SECRET = process.env.AUTH_SECRET || "";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
const SESSION_MAX_AGE = Math.max(300, parseInt(process.env.SESSION_MAX_AGE || "604800", 10));
const COOKIE_NAME = "vrcloud_session";

if (!AUTH_USER || !AUTH_PASS || AUTH_SECRET.length < 32) {
  console.error("VRCloud IDE membutuhkan AUTH_USER, AUTH_PASS, dan AUTH_SECRET (>=32 karakter) di .env");
  process.exit(1);
}

// Prompt bash bergaya Kali.
const RCFILE = path.join(__dirname, ".c9rc");
try {
  fs.writeFileSync(RCFILE,
    '[ -f /etc/profile ] && . /etc/profile 2>/dev/null\n' +
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null\n' +
    "export PS1='\\[\\e[0;36m\\]┌──(\\[\\e[1;34m\\]vrcloudproject㉿\\h\\[\\e[0;36m\\])-[\\[\\e[1;37m\\]\\w\\[\\e[0;36m\\]]\\n└─\\[\\e[1;34m\\]#\\[\\e[0m\\] '\n");
} catch (e) {}

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unbase64url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - normalized.length % 4) % 4), "base64").toString("utf8");
}
function signature(value) {
  return base64url(crypto.createHmac("sha256", AUTH_SECRET).update(value).digest());
}
function issueSession(username) {
  const payload = base64url(JSON.stringify({ username, exp: Date.now() + SESSION_MAX_AGE * 1000 }));
  return payload + "." + signature(payload);
}
function parseCookies(header) {
  const result = {};
  String(header || "").split(";").forEach((part) => {
    const index = part.indexOf("="); if (index < 1) return;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  });
  return result;
}
function safeEqual(value, expected) {
  const a = crypto.createHash("sha256").update(String(value)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
function authenticated(req) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 2 || !safeEqual(parts[1], signature(parts[0]))) return false;
    const payload = JSON.parse(unbase64url(parts[0]));
    return payload.username === AUTH_USER && Number(payload.exp) > Date.now();
  } catch (e) {
    return false;
  }
}
function sessionCookie(value, maxAge) {
  return COOKIE_NAME + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge +
    (COOKIE_SECURE ? "; Secure" : "");
}

const loginAttempts = new Map();
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.get("/login", (req, res) => {
  if (authenticated(req)) return res.redirect("/");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.post("/login", (req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let attempt = loginAttempts.get(ip) || { count: 0, first: now, blockedUntil: 0 };
  if (now - attempt.first > 15 * 60 * 1000) attempt = { count: 0, first: now, blockedUntil: 0 };
  if (attempt.blockedUntil > now) return res.redirect(303, "/login?error=locked");
  const valid = safeEqual(req.body.username || "", AUTH_USER) && safeEqual(req.body.password || "", AUTH_PASS);
  if (!valid) {
    attempt.count++;
    if (attempt.count >= 8) attempt.blockedUntil = now + 5 * 60 * 1000;
    loginAttempts.set(ip, attempt);
    return res.redirect(303, "/login?error=1");
  }
  loginAttempts.delete(ip);
  res.setHeader("Set-Cookie", sessionCookie(issueSession(AUTH_USER), SESSION_MAX_AGE));
  res.redirect(303, "/");
});
app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.redirect(303, "/login");
});
app.use((req, res, next) => {
  if (authenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Login diperlukan" });
  res.redirect(302, "/login");
});

// ---- Amankan path agar tidak keluar dari WORKSPACE ------------------------
function safe(rel) {
  const p = path.resolve(WORKSPACE, "." + path.sep + (rel || ""));
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + path.sep)) {
    throw new Error("Path di luar workspace");
  }
  return p;
}
function rel(abs) {
  return path.relative(WORKSPACE, abs).split(path.sep).join("/");
}
// Cari nama unik kalau tujuan sudah ada: "nama copy", "nama copy 2", ...
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  let i = 1, np;
  do { np = path.join(dir, base + " copy" + (i > 1 ? " " + i : "") + ext); i++; } while (fs.existsSync(np));
  return np;
}
function rmPath(p) {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) fs.rmdirSync(p, { recursive: true }); // Node 12.10+
  else fs.unlinkSync(p);
}

function archivePaths(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 500) {
    throw new Error("Pilih 1 sampai 500 file/folder");
  }
  const unique = Array.from(new Set(values.map((value) => {
    const normalized = rel(safe(String(value || "")));
    if (!normalized) throw new Error("Root workspace tidak dapat dipilih sebagai item arsip");
    return normalized;
  })));
  return unique.filter((item) => !unique.some((parent) => {
    if (parent === item || !item.startsWith(parent + "/")) return false;
    try { return fs.statSync(safe(parent)).isDirectory(); } catch (e) { return false; }
  }));
}
function archiveExtension(format) {
  if (format === "zip") return ".zip";
  if (format === "tar.gz") return ".tar.gz";
  throw new Error("Format arsip tidak didukung");
}
function createArchive(paths, format, output) {
  const parents = paths.map((item) => path.posix.dirname(item));
  const sameParent = parents.every((parent) => parent === parents[0]);
  const cwd = sameParent ? safe(parents[0] === "." ? "" : parents[0]) : WORKSPACE;
  const entries = sameParent ? paths.map((item) => path.posix.basename(item)) : paths;
  if (format === "zip") {
    execFileSync("zip", ["-q", "-r", output, "--"].concat(entries), {
      cwd, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
    });
  } else {
    execFileSync("tar", ["-czf", output, "-C", cwd, "--"].concat(entries), {
      timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
    });
  }
}
function validateArchiveEntries(file, type) {
  const command = type === "zip" ? "unzip" : "tar";
  const args = type === "zip" ? ["-Z1", file] : ["-tf", file];
  const output = execFileSync(command, args, {
    encoding: "utf8", timeout: 60 * 1000, maxBuffer: 20 * 1024 * 1024,
  });
  output.split(/\r?\n/).filter(Boolean).forEach((entry) => {
    const clean = entry.replace(/\\/g, "/");
    const normalized = path.posix.normalize(clean);
    if (clean[0] === "/" || normalized === ".." || normalized.startsWith("../") ||
        /^[a-zA-Z]:\//.test(clean) || clean.includes("\0")) {
      throw new Error("Arsip mengandung path tidak aman: " + entry);
    }
  });
}

const store = new SessionStore(path.join(__dirname, "data", "session.json"));

// ---- Static: frontend + vendor (Ace, xterm) -------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/ace", express.static(path.join(__dirname, "node_modules/ace-builds/src-min-noconflict")));
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules/xterm")));
app.use("/vendor/xterm-fit", express.static(path.join(__dirname, "node_modules/xterm-addon-fit/lib")));
// Preview: sajikan file workspace apa adanya (untuk pratinjau HTML dll)
app.use("/preview", express.static(WORKSPACE));

// ---- API dasar ------------------------------------------------------------
app.get("/api/info", (req, res) => res.json({
  workspace: WORKSPACE,
  name: path.basename(WORKSPACE),
  product: "VRCloud IDE",
  collaboration: true,
}));

app.get("/api/list", (req, res) => {
  try {
    const dir = safe(req.query.path || "");
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); } catch (e) {} }
      return { name: d.name, path: rel(path.join(dir, d.name)), dir: isDir };
    }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    res.json(entries);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/read", (req, res) => {
  try {
    const f = safe(req.query.path);
    const st = fs.statSync(f);
    if (st.isDirectory()) return res.status(400).json({ error: "Itu folder" });
    if (st.size > 5 * 1024 * 1024) return res.status(413).json({ error: "File terlalu besar (>5MB)" });
    const buf = fs.readFileSync(f);
    const isBinary = buf.includes(0);
    res.json({ path: req.query.path, binary: isBinary, mime: mime.lookup(f) || "text/plain", content: isBinary ? "" : buf.toString("utf8") });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/save", (req, res) => {
  try {
    const f = safe(req.body.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, req.body.content, "utf8");
    if (store.state.docs[req.body.path]) {
      store.change((s) => {
        const doc = s.docs[req.body.path];
        doc.content = req.body.content;
        doc.dirty = false;
        doc.revision = (doc.revision || 0) + 1;
        doc.updatedAt = Date.now();
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/create", (req, res) => {
  try {
    const f = safe(req.body.path);
    if (req.body.dir) fs.mkdirSync(f, { recursive: true });
    else { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, ""); }
    res.json({ ok: true, path: rel(f) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/rename", (req, res) => {
  try {
    const from = safe(req.body.from);
    let to = safe(req.body.to);
    to = uniquePath(to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ ok: true, path: rel(to) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/delete", (req, res) => {
  try {
    rmPath(safe(req.body.path));
    const removed = String(req.body.path || "");
    store.change((s) => {
      Object.keys(s.docs).forEach((p) => {
        if (p === removed || p.startsWith(removed + "/")) delete s.docs[p];
      });
    });
    res.json({ ok: true });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Copy (rekursif). to = folder tujuan; nama dasal dipertahankan, dibuat unik.
app.post("/api/copy", (req, res) => {
  try {
    const from = safe(req.body.from);
    const destDir = safe(req.body.to || "");
    let to = path.join(destDir, path.basename(from));
    to = uniquePath(to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    execFileSync("cp", ["-a", from, to]);
    res.json({ ok: true, path: rel(to) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Duplicate: salin di folder yang sama dengan nama "... copy".
app.post("/api/duplicate", (req, res) => {
  try {
    const from = safe(req.body.path);
    const to = uniquePath(path.join(path.dirname(from), path.basename(from)));
    execFileSync("cp", ["-a", from, to]);
    res.json({ ok: true, path: rel(to) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Buat arsip permanen di workspace dari satu atau banyak selection.
app.post("/api/archive", (req, res) => {
  try {
    const paths = archivePaths(req.body.paths);
    const format = String(req.body.format || "");
    const ext = archiveExtension(format);
    const dest = safe(req.body.dest || "");
    let name = path.basename(String(req.body.name || "archive"));
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    const output = uniquePath(path.join(dest, name));
    createArchive(paths, format, output);
    res.json({ ok: true, path: rel(output) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Download selection langsung sebagai ZIP atau TAR.GZ tanpa meninggalkan file.
app.post("/api/archive-download", (req, res) => {
  let temporary = "";
  try {
    const paths = archivePaths(req.body.paths);
    const format = String(req.body.format || "");
    const ext = archiveExtension(format);
    const name = path.basename(String(req.body.name || "selection")) + ext;
    temporary = path.join(os.tmpdir(), "vrcloud-" + crypto.randomBytes(12).toString("hex") + ext);
    createArchive(paths, format, temporary);
    res.download(temporary, name, () => { try { fs.unlinkSync(temporary); } catch (e) {} });
  } catch (e) {
    if (temporary) { try { fs.unlinkSync(temporary); } catch (ignore) {} }
    res.status(400).json({ error: e.message });
  }
});

// Extract ZIP, TAR, TAR.GZ, atau TGZ ke folder unik di sebelah arsip.
app.post("/api/extract", (req, res) => {
  try {
    const source = safe(req.body.path);
    const lower = source.toLowerCase();
    const type = lower.endsWith(".zip") ? "zip" :
      (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) ? "tar" : "";
    if (!type) throw new Error("Format extract didukung: .zip, .tar, .tar.gz, .tgz");
    validateArchiveEntries(source, type);
    let base = path.basename(source).replace(/\.(tar\.gz|tgz|tar|zip)$/i, "") || "extracted";
    const output = uniquePath(path.join(path.dirname(source), base));
    fs.mkdirSync(output, { recursive: true });
    if (type === "zip") {
      execFileSync("unzip", ["-q", source, "-d", output], { timeout: 10 * 60 * 1000 });
    } else {
      execFileSync("tar", ["-xf", source, "-C", output, "--no-same-owner", "--no-same-permissions"], {
        timeout: 10 * 60 * 1000,
      });
    }
    res.json({ ok: true, path: rel(output) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Upload (drag & drop). Body = biner file mentah. Header X-Filename = path relatif tujuan.
app.post("/api/upload", express.raw({ type: () => true, limit: "500mb" }), (req, res) => {
  try {
    const dest = req.query.path || "";
    const name = req.header("X-Filename");
    if (!name) throw new Error("X-Filename kosong");
    const f = safe(path.join(dest, name));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, req.body);
    res.json({ ok: true, path: rel(f) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Download: file -> langsung; folder -> tar.gz streaming.
app.get("/api/download", (req, res) => {
  try {
    const f = safe(req.query.path);
    const st = fs.statSync(f);
    if (st.isDirectory()) {
      const base = path.basename(f);
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.tar.gz"`);
      const tar = spawn("tar", ["-czf", "-", "-C", path.dirname(f), base]);
      tar.stdout.pipe(res);
      tar.stderr.on("data", () => {});
      tar.on("error", () => { try { res.status(500).end(); } catch (e) {} });
    } else {
      res.download(f, path.basename(f));
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Search: pakai ripgrep (rg) kalau ada, fallback ke grep.
app.get("/api/search", (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const dir = safe(req.query.path || "");
    const maxTotal = 400;
    let bin = "rg", args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "30", "-e", q, dir];
    try { execFileSync("rg", ["--version"]); }
    catch (e) { bin = "grep"; args = ["-rIn", "--", q, dir]; }
    const child = spawn(bin, args);
    let buf = "";
    child.stdout.on("data", (d) => { buf += d.toString(); });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      const results = [];
      for (const line of buf.split("\n")) {
        if (!line) continue;
        // format: <path>:<line>:<text>
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        results.push({ path: rel(m[1]), line: parseInt(m[2], 10), text: m[3].slice(0, 300) });
        if (results.length >= maxTotal) break;
      }
      res.json(results);
    });
    child.on("error", (e) => res.status(400).json({ error: e.message }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Server + WebSocket collaboration + terminal bersama -----------------
const server = http.createServer(app);
const terminals = new TerminalManager({
  workspace: WORKSPACE,
  rcfile: RCFILE,
  store,
  safe,
});
const hub = new RealtimeHub({ server, store, workspace: WORKSPACE, safe, terminals });
const terminalWss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });

app.get("/api/session-status", (req, res) => res.json({
  revision: store.state.revision,
  connectedBrowsers: hub.clients.size,
  terminals: terminals.status(),
  updatedAt: store.state.updatedAt,
}));

server.on("upgrade", (req, socket, head) => {
  if (!authenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  let pathname = "";
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch (e) {}
  const target = pathname === "/sync" ? hub.wss : pathname === "/terminal" ? terminalWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

terminalWss.on("connection", (ws, req) => {
  let id = "";
  try { id = new URL(req.url, "http://localhost").searchParams.get("id") || ""; } catch (e) {}
  if (!id) id = terminals.create("").id;
  terminals.attach(ws, id);
});

function shutdown() {
  try { store.flush(); } catch (e) {}
}
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT", () => { shutdown(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log(`VRCloud IDE berjalan di http://${HOST}:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Login: aktif (user=${AUTH_USER})`);
});
