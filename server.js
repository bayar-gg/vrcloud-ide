#!/usr/bin/env node
/**
 * VRCloud IDE
 * Backend: Express (REST file API) + WebSocket (terminal via node-pty).
 *
 * Env:
 *   PORT        port HTTP/HTTPS  (default 1337)
 *   HOST        bind address     (default 0.0.0.0)
 *   HTTPS       true = https://IP:PORT (default). false = HTTP biasa.
 *   TLS_CERT    sertifikat PEM (opsional; kalau kosong, self-signed otomatis)
 *   TLS_KEY     kunci privat PEM (wajib bila TLS_CERT diisi)
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
const https = require("https");
const crypto = require("crypto");
const os = require("os");
const { spawn, spawnSync, execFileSync } = require("child_process");
const express = require("express");
const mime = require("mime-types");
const WebSocket = require("ws");
const SessionStore = require("./lib/session-store");
const TerminalManager = require("./lib/terminal-manager");
const RealtimeHub = require("./lib/realtime-hub");
const { ensureTlsMaterial } = require("./lib/tls-cert");
const AiChat = require("./lib/ai-chat");
const BgProcs = require("./lib/bg-procs");
const Checkpoints = require("./lib/checkpoints");
const SysMetrics = require("./lib/sys-metrics");
const BrowserAutomation = require("./lib/browser-automation");
const BrowserSecrets = require("./lib/browser-secrets");
const GitScm = require("./lib/git-scm");
let aiChat = null; // diisi di bagian AI Agent; dipakai lebih awal oleh route hook
let browser = null; // otomasi browser (CDP) untuk tool agent

// Muat .env tanpa dependency tambahan (tidak perlu paket dotenv).
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

const IS_WINDOWS = process.platform === "win32";
const PORT = parseInt(process.env.PORT || "1337", 10);
const HOST = process.env.HOST || "0.0.0.0";
const WORKSPACE = path.resolve(process.env.WORKSPACE || process.cwd());
// Default shell: bash di Unix, PowerShell di Windows. Bisa dioverride SHELL_BIN.
const SHELL = process.env.SHELL_BIN || (IS_WINDOWS ? "powershell.exe" : "bash");
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const AUTH_SECRET = process.env.AUTH_SECRET || "";
function envFlag(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}
// https://IP:PORT di port yang sama. HTTPS=false mengembalikan HTTP biasa.
const USE_HTTPS = envFlag("HTTPS", true);
const COOKIE_SECURE = USE_HTTPS || String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
const SESSION_MAX_AGE = Math.max(300, parseInt(process.env.SESSION_MAX_AGE || "604800", 10));
const COOKIE_NAME = "vrcloud_session";

if (!AUTH_USER || !AUTH_PASS || AUTH_SECRET.length < 32) {
  console.error("VRCloud IDE membutuhkan AUTH_USER, AUTH_PASS, dan AUTH_SECRET (>=32 karakter) di .env");
  process.exit(1);
}

// Prompt bash bergaya Kali. Hanya relevan untuk shell bash di Unix.
const RCFILE = path.join(__dirname, ".c9rc");
if (!IS_WINDOWS && path.basename(SHELL).toLowerCase() === "bash") {
  try {
    fs.writeFileSync(RCFILE,
      '[ -f /etc/profile ] && . /etc/profile 2>/dev/null\n' +
      '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null\n' +
      "VRCLOUD_PROMPT_SYMBOL='$'\n" +
      '[ "$(id -u)" -eq 0 ] && VRCLOUD_PROMPT_SYMBOL=\'#\'\n' +
      "export PS1='\\[\\e[0;36m\\]┌──(\\[\\e[1;34m\\]\\u㉿\\h\\[\\e[0;36m\\])-[\\[\\e[1;37m\\]\\w\\[\\e[0;36m\\]]\\n└─\\[\\e[1;34m\\]${VRCLOUD_PROMPT_SYMBOL}\\[\\e[0m\\] '\n");
  } catch (e) {}
}

const app = express();
// Parser JSON dilewati untuk /api/upload: body-nya biner mentah (file .json yang
// di-upload jangan ikut di-parse, kalau tidak writeFileSync menerima objek).
const jsonParser = express.json({ limit: "50mb" });
app.use((req, res, next) => (req.path === "/api/upload" ? next() : jsonParser(req, res, next)));
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
  // Buang catatan IP lama agar Map tidak tumbuh tanpa batas.
  for (const [k, v] of loginAttempts) if (now - v.first > 15 * 60 * 1000 && v.blockedUntil < now) loginAttempts.delete(k);
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
// Hook agent (beforeShellExecution) memanggil endpoint ini dari mesin yang sama
// tanpa cookie login; diamankan dengan token acak per proses (data/hook.json).
const HOOK_TOKEN = crypto.randomBytes(24).toString("hex");
app.post("/api/ai/hook/shell", (req, res) => {
  const tok = String(req.get("x-vrcloud-hook") || "");
  if (!tok || tok.length !== HOOK_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(HOOK_TOKEN))) {
    return res.status(401).json({ error: "token hook tidak valid" });
  }
  if (!aiChat) return res.json({ permission: "allow" });
  aiChat.reviewShell(req.body || {}).then(
    (r) => res.json(r),
    () => res.json({ permission: "allow" })
  );
});
app.use((req, res, next) => {
  if (authenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Login diperlukan" });
  res.redirect(302, "/login");
});

// ---- Amankan path agar tidak keluar dari WORKSPACE ------------------------
function safe(rel) {
  const p = path.resolve(WORKSPACE, "." + path.sep + (rel || ""));
  const workspacePrefix = WORKSPACE.endsWith(path.sep) ? WORKSPACE : WORKSPACE + path.sep;
  if (p !== WORKSPACE && !p.startsWith(workspacePrefix)) {
    throw new Error("Path di luar workspace");
  }
  return p;
}
// Seperti safe(), tetapi menolak root workspace (untuk hapus/rename/salin).
function safeNonRoot(rel) {
  const p = safe(rel);
  if (p === WORKSPACE) throw new Error("Root workspace tidak boleh dipilih");
  return p;
}
// Tujuan tidak boleh sama dengan / berada di dalam sumber (salin folder ke dirinya sendiri).
function assertNotInside(from, to) {
  if (to === from || to.startsWith(from + path.sep)) throw new Error("Tujuan berada di dalam sumber");
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
  if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  else fs.unlinkSync(p);
}
// Salin file/folder rekursif tanpa bergantung pada `cp` (dipakai di Windows).
function copyRecursive(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    try { fs.symlinkSync(fs.readlinkSync(src), dest); return; } catch (e) { /* fallback: salin target */ }
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach((name) => copyRecursive(path.join(src, name), path.join(dest, name)));
  } else {
    fs.copyFileSync(src, dest);
  }
}
// Salin lintas platform: `cp -a` di Unix, implementasi Node di Windows.
function copyPath(from, to) {
  if (IS_WINDOWS) copyRecursive(from, to);
  else execFileSync("cp", ["-a", from, to]);
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
  const opts = { cwd, timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 };
  if (format === "zip") {
    if (IS_WINDOWS) {
      // bsdtar (tar.exe bawaan Windows 10+) menulis zip via auto-format (-a).
      execFileSync("tar", ["-a", "-c", "-f", output, "-C", cwd, "--"].concat(entries), opts);
    } else {
      execFileSync("zip", ["-q", "-r", output, "--"].concat(entries), opts);
    }
  } else {
    execFileSync("tar", ["-czf", output, "-C", cwd, "--"].concat(entries), opts);
  }
}
function validateArchiveEntries(file, type) {
  // Windows: bsdtar dapat membaca daftar isi zip maupun tar dengan -tf.
  const command = (type === "zip" && !IS_WINDOWS) ? "unzip" : "tar";
  const args = (type === "zip" && !IS_WINDOWS) ? ["-Z1", file] : ["-tf", file];
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
// Spesifikasi server (platform, runtime, tool yang tersedia) — untuk panel
// "Server" di setelan AI dan diagnosa. Dihitung sekali saat start.
const hasBin = SysMetrics.hasBin; // satu implementasi, dipakai juga oleh lib/sys-metrics.js
const SERVER_SPEC = (() => {
  const nodeVer = process.versions.node.split(".").map(Number);
  const nodeOk = nodeVer[0] > 22 || (nodeVer[0] === 22 && nodeVer[1] >= 13);
  const git = hasBin("git", ["--version"]);
  const tmux = !IS_WINDOWS && hasBin("tmux", ["-V"]);
  const tarBin = IS_WINDOWS ? hasBin("tar", ["--version"]) : (hasBin("zip", ["-v"]) && hasBin("tar", ["--version"]));
  const rg = hasBin("rg", ["--version"]);
  const grep = hasBin("grep", ["--version"]);
  let osName = process.platform;
  try {
    if (IS_WINDOWS) {
      const build = parseInt(String(os.release()).split(".")[2] || "0", 10);
      osName = (build >= 22000 ? "Windows 11" : "Windows 10") + " (build " + os.release().split(".")[2] + ")";
    } else if (process.platform === "linux") {
      const rel = fs.readFileSync("/etc/os-release", "utf8");
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel);
      osName = m ? m[1] : "Linux " + os.release();
    } else if (process.platform === "darwin") osName = "macOS " + os.release();
  } catch (e) {}
  return {
    platform: process.platform, os: osName, arch: process.arch, node: process.version, nodeOk, nodeMin: "22.13",
    shell: SHELL, git, tmux, rg, grep, archives: tarBin,
    terminals: IS_WINDOWS ? "conpty" : (tmux ? "tmux" : "pty-direct"),
    persistentTerminals: !IS_WINDOWS && tmux,
    hostname: os.hostname(), cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1073741824 * 10) / 10,
  };
})();
if (!SERVER_SPEC.nodeOk) console.warn("[spec] Node.js " + process.version + " lebih lama dari minimum 22.13: agent AI (@cursor/sdk) mungkin gagal dimuat.");
if (!IS_WINDOWS && !SERVER_SPEC.tmux) console.warn("[spec] tmux tidak ditemukan: terminal tidak akan persisten melewati restart.");

// Metrik live (CPU/RAM/GPU) untuk indikator di menubar.
const sysMetrics = new SysMetrics();

app.get("/api/info", (req, res) => res.json({
  workspace: WORKSPACE,
  name: path.basename(WORKSPACE),
  product: "VRCloud IDE",
  collaboration: true,
  version: (() => { try { return require("./package.json").version; } catch (e) { return ""; } })(),
  spec: Object.assign({}, SERVER_SPEC, {
    checkpoints: !!(checkpoints && checkpoints.available),
    aiEnabled: !!(aiChat && aiChat.status().enabled),
    shellGuard: !!(aiChat && aiChat.getGuard().enabled),
    gpu: sysMetrics.info(),
    browser: browser ? browser.info() : { available: false },
  }),
}));

app.get("/api/metrics", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(sysMetrics.snapshot());
});

// Self-update dari dalam IDE (tombol ⟳ Update di menubar): cek commit remote & jalankan
// updater terpisah yang me-restart service tanpa perlu SSH.
const Updater = require("./lib/updater");
const updater = new Updater({ appDir: __dirname, dataDir: path.join(__dirname, "data") });
updater.clearStaleLock();
app.get("/api/update/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  updater.status({ force: String(req.query.force || "") === "1" }).then((s) => res.json(s), (e) => res.status(500).json({ error: e.message }));
});
app.post("/api/update/run", (req, res) => {
  updater.start("web").then((r) => res.json(r), (e) => res.status(400).json({ error: e.message }));
});
// Log proses update (sesi terakhir) untuk panel live di IDE.
app.get("/api/update/log", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(Object.assign(updater.logView(), { pid: process.pid, commit: updater.local().short })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Runner "Jalankan" per ekstensi sesuai interpreter/compiler yang terpasang di server.
// ?refresh=1 mendeteksi ulang (setelah memasang bahasa baru).
const Runners = require("./lib/runners");
// Remote desktop (mirip VNC) dari IDE: status/kemampuan, pemasangan desktop virtual (Linux, root).
const DesktopRemote = require("./lib/desktop-remote");
const desktop = new DesktopRemote({ dataDir: path.join(__dirname, "data"), log: (m) => console.warn(m) });
app.get("/api/desktop/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(desktop.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/desktop/setup", (req, res) => {
  try { res.json(desktop.startSetup()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/desktop/setup", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(desktop.setup); });
const desktopWss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
desktopWss.on("connection", (ws) => desktop.attach(ws));

app.get("/api/runners", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const refresh = String(req.query.refresh || "") === "1";
    const ext = String(req.query.ext || "");
    res.json(ext ? Runners.probe(ext, refresh) : Runners.detect(refresh));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Status git workspace: ringkas (status bar, cache 4 dtk) atau detail (panel Source Control).
const gitScm = new GitScm({ workspace: WORKSPACE, git: SERVER_SPEC.git });
let gitCache = { at: 0, value: null, pending: null };
function invalidateGit() { gitCache = { at: 0, value: null, pending: null }; }
function gitErr(e) { return (e && e.message) || "git gagal"; }
app.get("/api/git/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const detail = String(req.query.detail || "") === "1";
  if (!detail) {
    const now = Date.now();
    if (gitCache.value && now - gitCache.at < 4000) return res.json(gitCache.value);
    if (!gitCache.pending) {
      gitCache.pending = gitScm.summary().then((v) => { gitCache = { at: Date.now(), value: v, pending: null }; return v; },
        (e) => { gitCache.pending = null; return { repo: false, error: gitErr(e) }; });
    }
    return gitCache.pending.then((v) => res.json(v));
  }
  gitScm.status().then((v) => res.json(v), (e) => res.status(400).json({ repo: false, error: gitErr(e) }));
});
app.get("/api/git/diff", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  gitScm.diff(req.query.path, String(req.query.staged || "") === "1").then(
    (diff) => res.json({ diff }),
    (e) => res.status(400).json({ error: gitErr(e) })
  );
});
function gitMutate(fn) {
  return (req, res) => {
    fn(req.body || {}).then((v) => {
      invalidateGit();
      if (v && v.changed && v.changed.length) filesChanged(v.changed, "git");
      res.json(v);
    }, (e) => res.status(400).json({ error: gitErr(e) }));
  };
}
app.post("/api/git/stage", gitMutate((b) => gitScm.stage(b.paths, !!b.all)));
app.post("/api/git/unstage", gitMutate((b) => gitScm.unstage(b.paths, !!b.all)));
app.post("/api/git/discard", gitMutate((b) => gitScm.discard(b.paths)));
app.post("/api/git/commit", gitMutate((b) => gitScm.commit(b.message)));
app.post("/api/git/checkout", gitMutate((b) => gitScm.checkout(b.branch, !!b.create)));
app.post("/api/git/init", gitMutate(() => gitScm.init()));
app.get("/api/git/log", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  gitScm.log(req.query.n).then((log) => res.json({ log }), (e) => res.status(400).json({ error: gitErr(e) }));
});
app.get("/api/git/branches", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  gitScm.branches().then((branches) => res.json({ branches }), (e) => res.status(400).json({ error: gitErr(e) }));
});

app.get("/api/list", (req, res) => {
  try {
    const dir = safe(req.query.path || "");
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => {
      // Tautan kompatibilitas `.cursor` -> `.vrcloud-agent` di root workspace tidak ditampilkan (isinya sama).
      return !(dir === WORKSPACE && d.name === ".cursor" && d.isSymbolicLink());
    }).map((d) => {
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

// Simpan file selalu lewat WebSocket "doc-save" (realtime-hub) agar revisi dokumen
// bersama ikut naik; tidak ada rute HTTP terpisah supaya logikanya satu.

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
    const from = safeNonRoot(req.body.from);
    let to = safeNonRoot(req.body.to);
    // Nama tidak berubah: jangan dibuat "nama copy". Perubahan huruf besar/kecil saja
    // di Windows (a.txt -> A.txt) juga bukan tabrakan nama.
    if (to === from) return res.json({ ok: true, path: rel(from) });
    const caseOnly = IS_WINDOWS && to.toLowerCase() === from.toLowerCase();
    if (!caseOnly) { assertNotInside(from, to); to = uniquePath(to); }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ ok: true, path: rel(to) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/delete", (req, res) => {
  try {
    rmPath(safeNonRoot(req.body.path));
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
    const from = safeNonRoot(req.body.from);
    const destDir = safe(req.body.to || "");
    assertNotInside(from, destDir);
    let to = path.join(destDir, path.basename(from));
    to = uniquePath(to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyPath(from, to);
    res.json({ ok: true, path: rel(to) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Duplicate: salin di folder yang sama dengan nama "... copy".
app.post("/api/duplicate", (req, res) => {
  try {
    const from = safeNonRoot(req.body.path);
    const to = uniquePath(path.join(path.dirname(from), path.basename(from)));
    copyPath(from, to);
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
    if (type === "zip" && !IS_WINDOWS) {
      execFileSync("unzip", ["-q", source, "-d", output], { timeout: 10 * 60 * 1000 });
    } else if (IS_WINDOWS) {
      // bsdtar mengekstrak zip maupun tar; flag ownership Unix tidak dipakai.
      execFileSync("tar", ["-xf", source, "-C", output], { timeout: 10 * 60 * 1000 });
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
    let name = req.header("X-Filename");
    if (!name) throw new Error("X-Filename kosong");
    try { name = decodeURIComponent(name); } catch (e) { /* nama lama tanpa encode */ }
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
      // Browser membatalkan download: hentikan tar agar tidak menggantung dengan buffer penuh.
      res.on("close", () => { if (tar.exitCode == null) { try { tar.kill(); } catch (e) {} } });
    } else {
      res.download(f, path.basename(f));
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Pencarian ala VS Code: opsi case/word/regex, include/exclude glob, rg > grep > Node ----
function globRe(glob) {
  let g = String(glob || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g) return null;
  if (g.indexOf("/") === -1 && g.indexOf("**") !== 0) g = "**/" + g;
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") { if (g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; } else re += "[^/]*"; }
    else if (ch === "?") re += "[^/]";
    else if (/[.+^$()|[\]\\{}]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  // Nama folder polos (mis. "dist") juga cocok dengan seluruh isinya.
  return new RegExp(re + "(?:/.*)?$", IS_WINDOWS ? "i" : "");
}
function parseGlobs(s) { return String(s || "").split(",").map((x) => x.trim()).filter(Boolean); }
function searchOpts(q) {
  const on = (v) => v === "1" || v === "true";
  return {
    q: String(q.q || ""), regex: on(q.regex), matchCase: on(q.case), word: on(q.word),
    include: parseGlobs(q.include), exclude: parseGlobs(q.exclude),
  };
}
function searchRegex(o, global) {
  let src = o.regex ? o.q : o.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.word) src = "\\b(?:" + src + ")\\b";
  return new RegExp(src, (o.matchCase ? "" : "i") + (global ? "g" : ""));
}
function pathAllowed(relPath, o) {
  const p = relPath.replace(/\\/g, "/");
  if (o.exclude.length && o.exclude.some((g) => { const r = globRe(g); return r && r.test(p); })) return false;
  if (o.include.length && !o.include.some((g) => { const r = globRe(g); return r && r.test(p); })) return false;
  return true;
}
// Fallback pencarian murni Node bila rg/grep tidak tersedia.
function jsSearch(dir, o, maxTotal) {
  const results = [];
  let re; try { re = searchRegex(o, false); } catch (e) { throw new Error("Regex tidak valid: " + e.message); }
  const stack = [dir];
  while (stack.length && results.length < maxTotal) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (e) { continue; }
    for (const d of entries) {
      if (results.length >= maxTotal) break;
      const full = path.join(current, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch (e) { continue; } }
      if (isDir) { if (SKIP_DIRS.has(d.name)) continue; stack.push(full); continue; }
      const relp = rel(full);
      if (!pathAllowed(relp, o)) continue;
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      let buf; try { buf = fs.readFileSync(full); } catch (e) { continue; }
      if (buf.includes(0)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { results.push({ path: relp, line: i + 1, text: lines[i].slice(0, 400) }); if (results.length >= maxTotal) break; }
      }
    }
  }
  return results;
}

// GET /api/search?q=&path=&regex=1&case=1&word=1&include=a,b&exclude=c
app.get("/api/search", (req, res) => {
  try {
    const o = searchOpts(req.query);
    if (!o.q) return res.json([]);
    const dir = safe(req.query.path || "");
    const maxTotal = 2000;
    try { searchRegex(o, false); } catch (e) { return res.status(400).json({ error: "Regex tidak valid: " + e.message }); }
    let bin = null, args = null;
    if (SERVER_SPEC.rg) {
      bin = "rg";
      args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "200", "--max-columns", "400", "--max-filesize", "2M"];
      if (!o.matchCase) args.push("-i");
      if (!o.regex) args.push("-F");
      if (o.word) args.push("-w");
      o.include.forEach((g) => args.push("--glob", g.indexOf("/") === -1 && g.indexOf("**") !== 0 ? "**/" + g : g));
      o.exclude.forEach((g) => args.push("--glob", "!" + (g.indexOf("/") === -1 && g.indexOf("**") !== 0 ? "**/" + g : g)));
      args.push("-e", o.q, dir);
    } else if (SERVER_SPEC.grep) {
      bin = "grep";
      args = ["-rIn", "--exclude-dir=node_modules", "--exclude-dir=.git"];
      if (!o.matchCase) args.push("-i");
      if (!o.regex) args.push("-F"); else args.push("-E");
      if (o.word) args.push("-w");
      o.include.forEach((g) => args.push("--include=" + g.split("/").pop()));
      o.exclude.forEach((g) => { args.push("--exclude=" + g.split("/").pop()); args.push("--exclude-dir=" + g.split("/").pop()); });
      args.push("--", o.q, dir);
    }
    if (!bin) return res.json(jsSearch(dir, o, maxTotal));
    const child = spawn(bin, args, { windowsHide: true });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d.toString(); });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      const results = [];
      for (const raw of buf.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, "");
        if (!line) continue;
        // <path>:<baris>:<teks>. Drive Windows (C:\) ikut di path, bukan pemisah kolom.
        const m = line.match(/^((?:[A-Za-z]:[\\/])?.+?):(\d+):(.*)$/);
        if (!m) continue;
        const relp = rel(m[1]);
        if (bin === "grep" && !pathAllowed(relp, o)) continue; // grep tidak paham glob berjalur
        results.push({ path: relp, line: parseInt(m[2], 10), text: m[3].slice(0, 400) });
        if (results.length >= maxTotal) break;
      }
      res.json(results);
    });
    child.on("error", (e) => res.status(400).json({ error: e.message }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/replace { q, replace, regex, case, word, files: [{ path, lines?: [n] }] }
// Mengganti di file yang disebut (hasil pencarian klien); lines membatasi ke baris tertentu.
app.post("/api/replace", (req, res) => {
  try {
    const b = req.body || {};
    const o = searchOpts({ q: b.q, regex: b.regex ? "1" : "0", case: b.case ? "1" : "0", word: b.word ? "1" : "0" });
    if (!o.q) return res.status(400).json({ error: "Teks pencarian kosong" });
    let re; try { re = searchRegex(o, true); } catch (e) { return res.status(400).json({ error: "Regex tidak valid: " + e.message }); }
    const rep = String(b.replace == null ? "" : b.replace);
    const repl = o.regex ? rep : rep.replace(/\$/g, "$$$$"); // literal: '$' tidak jadi referensi grup
    const files = Array.isArray(b.files) ? b.files.slice(0, 500) : [];
    let replaced = 0; const changed = [];
    files.forEach((f) => {
      const relp = String((f && f.path) || ""); if (!relp) return;
      const abs = safe(relp);
      let text; try { text = fs.readFileSync(abs, "utf8"); } catch (e) { return; }
      const eol = text.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
      const lines = text.split(/\r?\n/);
      const only = Array.isArray(f.lines) && f.lines.length ? new Set(f.lines.map(Number)) : null;
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (only && !only.has(i + 1)) continue;
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        re.lastIndex = 0;
        const before = lines[i];
        lines[i] = before.replace(re, repl);
        re.lastIndex = 0; n += (before.match(re) || []).length;
      }
      if (n) { fs.writeFileSync(abs, lines.join(eol), "utf8"); replaced += n; changed.push(relp); }
    });
    if (changed.length) filesChanged(changed, "search");
    res.json({ replaced, files: changed.length, changed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ---- AI Agent (Cursor SDK / Anthropic Claude) -----------------------------
// Checkpoint workspace (shadow git di data/) untuk tombol "Kembalikan".
const checkpoints = new Checkpoints({ workspace: WORKSPACE, gitDir: path.join(__dirname, "data", "checkpoints.git") });
// Hub realtime dibuat belakangan; panggil lewat fungsi agar terikat saat dipakai.
let hubRef = null;
function filesChanged(paths, source) {
  if (hubRef) { try { hubRef.filesChangedOnDisk(paths || [], source || "agent"); } catch (e) {} }
}
// Brankas rahasia browser (kata sandi/token) — agent hanya tahu namanya.
const browserSecrets = new BrowserSecrets({ file: path.join(__dirname, "data", "browser-secrets.json"), secret: AUTH_SECRET });
// Browser headless (Chrome/Edge/Chromium via CDP) sebagai tool agent: navigate, tabs,
// click, type, select, upload, extract, screenshot, download, pdf, emulate, console,
// network, evaluate. Langkah + frame live + tab disiarkan ke IDE lewat hub.
browser = new BrowserAutomation({
  dataDir: path.join(__dirname, "data"),
  workspace: WORKSPACE,
  secrets: browserSecrets,
  onStep: (step) => { if (hubRef) { try { hubRef.broadcast({ type: "browser-step", step }); } catch (e) {} } },
  onEvent: (type, payload) => { if (hubRef) { try { hubRef.browserEvent(type, payload); } catch (e) {} } },
});
aiChat = new AiChat({
  workspace: WORKSPACE,
  configFile: path.join(__dirname, "data", "ai-config.json"),
  storeFile: path.join(__dirname, "data", "ai-sessions.json"),
  grokAuthFile: path.join(__dirname, "data", "grok-session.json"),
  authSecret: AUTH_SECRET,
  checkpoints,
  browser,
  // Tool agent: otomasi browser headless + kelola/kendalikan remote desktop server.
  customTools: () => Object.assign({}, browser.tools(), desktop.tools()),
  desktopStatus: () => desktop.status(), // untuk chip "Computer use" (tersedia/tidak) & prompt agent
  desktopShot: (callId) => desktop.shotFor(callId), // screenshot computer use untuk kartu chat (Cursor SDK)
  onFsChange: (paths) => filesChanged(paths, "agent"),
  // File yang terbuka di editor (tab aktif + tab lain) untuk konteks prompt agent.
  openFiles: () => {
    const st = store.state || {};
    const open = [];
    let active = "";
    const walk = (node) => {
      if (!node) return;
      if (node.type === "leaf") {
        (node.tabs || []).forEach((t) => {
          if (!t || t.kind !== "file" || !t.path) return;
          if (open.indexOf(t.path) === -1) open.push(t.path);
          if (node._id === st.activeLeafId && t.id === node.active) active = t.path;
        });
      } else (node.children || []).forEach(walk);
    };
    walk(st.layout);
    return { active, open };
  },
  // Event sesi (run mulai/selesai, daftar berubah) & cermin shell agent → semua browser.
  onNotify: (ev) => { if (hubRef) { try { hubRef.aiEvent(ev); } catch (e) {} } },
  onShell: (p) => { if (hubRef) { try { hubRef.agentShell(p); } catch (e) {} } },
});

// Hook pengaman perintah tidak dipasang: agent tidak di-deny / tidak diminta izin.
function uninstallShellGuardHook() {
  try {
    const file = path.join(WORKSPACE, ".vrcloud-agent", "hooks.json");
    if (!fs.existsSync(file)) return;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return; }
    if (!cfg || !cfg.hooks || !Array.isArray(cfg.hooks.beforeShellExecution)) return;
    const next = cfg.hooks.beforeShellExecution.filter((h) => !(h && typeof h.command === "string" && /shell-guard\.js/.test(h.command)));
    if (next.length === cfg.hooks.beforeShellExecution.length) return;
    if (next.length) cfg.hooks.beforeShellExecution = next;
    else delete cfg.hooks.beforeShellExecution;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  } catch (e) { /* abaikan */ }
}
uninstallShellGuardHook();

app.get("/api/ai/status", (req, res) => {
  const st = aiChat.status();
  st.checkpoints = checkpoints.status();
  st.guard = aiChat.getGuard();
  res.json(st);
});

// Persetujuan perintah berisiko dari UI.
app.post("/api/ai/approve", (req, res) => {
  const id = String((req.body && req.body.id) || "");
  const ok = aiChat.decideApproval(id, !!(req.body && req.body.allow), "user");
  res.json({ ok });
});
// Screenshot langkah browser agent (data/browser-shots/<n>.jpg) untuk kartu di chat.
app.get("/api/ai/browser/shot/:n", (req, res) => {
  const abs = browser && browser.shotPath(req.params.n);
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "Screenshot tidak ditemukan" });
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.type("image/jpeg").sendFile(abs);
});
// Screenshot computer use (data/desktop-shots/<id>.jpg). Kartu chat memuat URL ini, bukan byte dari event Cursor.
app.get("/api/ai/desktop/shot/:name", (req, res) => {
  const abs = desktop && desktop.shotFile(req.params.name);
  if (!abs) return res.status(404).json({ error: "Screenshot tidak ditemukan" });
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.type("image/jpeg").sendFile(abs);
});
// Status browser otomasi + langkah terakhir (untuk panel/status).
app.get("/api/ai/browser", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(Object.assign({}, browser ? browser.info() : { available: false }, { steps: browser ? browser.steps.slice(-30) : [] }));
});
app.post("/api/ai/browser/close", (req, res) => {
  if (!browser) return res.json({ ok: true });
  browser.close().then(() => res.json({ ok: true }), (e) => res.status(500).json({ error: e.message }));
});
// Ekspor langkah browser → skrip Playwright. steps dari klien (riwayat chat) supaya tetap bisa setelah server restart.
app.post("/api/ai/browser/script", (req, res) => {
  try {
    const b = req.body || {};
    const steps = Array.isArray(b.steps) && b.steps.length ? b.steps.map((s) => ({ action: String(s.action || ""), url: s.url || "", title: s.title || "", args: s.args && typeof s.args === "object" ? s.args : {} })) : (browser ? browser.steps : []);
    if (!steps.length) return res.status(400).json({ error: "Tidak ada langkah browser untuk diekspor" });
    const rel = String(b.path || ("tests/browser-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".spec.js")).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!/\.(spec|test)\.[cm]?js$/.test(rel)) return res.status(400).json({ error: "Nama file harus berakhiran .spec.js / .test.js" });
    const abs = safe(rel);
    const script = BrowserAutomation.toPlaywright(steps, { file: rel, title: b.title });
    if (b.preview) return res.json({ path: rel, script, steps: steps.length });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, script, "utf8");
    filesChanged([rel], "export");
    res.json({ ok: true, path: rel, steps: steps.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Unduh Chrome for Testing ke data/browser/ bila tidak ada browser terpasang (progres via hub: browser-install).
app.post("/api/ai/browser/install", (req, res) => {
  if (!browser) return res.status(400).json({ error: "Browser otomasi tidak aktif" });
  browser.installChromium().catch(() => {});
  res.json({ ok: true, install: browser.install });
});
// Pengguna selesai membantu (login/CAPTCHA) → tool browser_request_user kembali ke agent.
app.post("/api/ai/browser/handoff-done", (req, res) => {
  res.json({ ok: !!(browser && browser.finishHandoff("done")) });
});
// Brankas rahasia browser: hanya nama yang keluar dari server.
app.get("/api/ai/browser/secrets", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(browserSecrets.describe()); });
app.post("/api/ai/browser/secrets", (req, res) => {
  try { browserSecrets.set(req.body && req.body.name, req.body && req.body.value, req.body && req.body.note); res.json({ ok: true, items: browserSecrets.describe() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/ai/browser/secrets/:name", (req, res) => {
  res.json({ ok: browserSecrets.remove(req.params.name), items: browserSecrets.describe() });
});

// Gambar tempel yang tersimpan di riwayat percakapan (data/ai-images).
app.get("/api/ai/image/:file", (req, res) => {
  const abs = aiChat.imagePath(req.params.file);
  if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "Gambar tidak ditemukan" });
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(abs);
});

// Pengaman perintah berbahaya: aktif/nonaktif + daftar pola (dibaca klien lewat /api/ai/status → guard).
app.post("/api/ai/guard", (req, res) => {
  try { res.json(aiChat.setGuard(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Kembalikan workspace / satu file ke checkpoint.
app.post("/api/ai/restore", (req, res) => {
  const hash = String((req.body && req.body.hash) || "");
  const p = req.body && req.body.path ? String(req.body.path) : "";
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) return res.status(400).json({ error: "hash tidak valid" });
  const op = p ? checkpoints.restoreFile(hash, p) : checkpoints.restoreAll(hash);
  op.then((r) => {
    filesChanged(r.changed, "restore");
    res.json(r);
  }, (e) => res.status(400).json({ error: (e && e.stderr) ? String(e.stderr).trim() || e.message : e.message }));
});

// Diff satu file antara dua checkpoint (kartu "Tinjau perubahan").
app.get("/api/ai/diff", (req, res) => {
  const from = String(req.query.from || ""), to = String(req.query.to || ""), p = String(req.query.path || "");
  if (!/^[0-9a-f]{7,64}$/i.test(from) || !/^[0-9a-f]{7,64}$/i.test(to)) return res.status(400).json({ error: "hash tidak valid" });
  checkpoints.diffFile(from, to, p).then(
    (diff) => res.json({ diff }),
    (e) => res.status(400).json({ error: (e && e.stderr) ? String(e.stderr).trim() || e.message : e.message })
  );
});

// ---- Folder agent: <workspace>/.vrcloud-agent (rules, skills, memory.md, hooks.json) ----
// Cursor SDK membaca `.cursor/` dari cwd; agar rules/skills/hooks tetap terbaca, `.cursor`
// dibuat sebagai tautan (symlink / junction di Windows) ke `.vrcloud-agent`. Instalasi lama
// yang masih punya folder `.cursor` sungguhan dimigrasikan (rename) sekali.
function ensureAgentDir() {
  const agentDir = path.join(WORKSPACE, ".vrcloud-agent");
  const legacy = path.join(WORKSPACE, ".cursor");
  try {
    const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
    const a = lst(agentDir), c = lst(legacy);
    if (!a && c && c.isDirectory() && !c.isSymbolicLink()) { fs.renameSync(legacy, agentDir); console.log("[agent] .cursor dipindahkan menjadi .vrcloud-agent"); }
    if (!lst(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    const c2 = lst(legacy);
    if (!c2) {
      let err = null;
      try { fs.symlinkSync(IS_WINDOWS ? agentDir : ".vrcloud-agent", legacy, IS_WINDOWS ? "junction" : "dir"); }
      catch (e) {
        err = e;
        // Windows: fs.symlinkSync junction kadang gagal (EISDIR); mklink /J tidak butuh hak admin.
        if (IS_WINDOWS) { const r = spawnSync("cmd", ["/c", "mklink", "/J", legacy, agentDir], { encoding: "utf8", windowsHide: true }); if (r.status === 0) err = null; }
      }
      if (err) console.warn("[agent] tautan .cursor -> .vrcloud-agent tidak bisa dibuat (" + err.message.split("\n")[0] + "); rules/skills untuk provider Cursor disisipkan lewat prompt. Filesystem tanpa symlink (mis. exFAT)?");
      else console.log("[agent] tautan kompatibilitas .cursor -> .vrcloud-agent dibuat");
    } else if (c2.isDirectory() && !c2.isSymbolicLink() && lst(agentDir)) {
      console.warn("[agent] .cursor dan .vrcloud-agent sama-sama ada; Cursor SDK membaca .cursor, IDE memakai .vrcloud-agent.");
    }
  } catch (e) { console.warn("[agent] ensureAgentDir: " + e.message); }
}
ensureAgentDir();

// ---- Rules agent: AGENTS.md + .vrcloud-agent/rules/*.mdc ---------------------------
const RULES_DIR = path.join(WORKSPACE, ".vrcloud-agent", "rules");
const RULE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(mdc|md)$/;
function ruleEntry(relPath, abs) {
  let text = "";
  try { text = fs.readFileSync(abs, "utf8"); } catch (e) { return null; }
  const fm = parseFrontmatter(text);
  const isAgents = relPath === "AGENTS.md";
  return {
    path: relPath, name: isAgents ? "AGENTS.md" : path.basename(relPath),
    description: isAgents ? "Instruksi proyek untuk agent (selalu dimuat)" : (fm.meta.description || ""),
    globs: fm.meta.globs || "", alwaysApply: isAgents ? true : String(fm.meta.alwaysApply || "").toLowerCase() === "true",
    size: text.length, updatedAt: fs.statSync(abs).mtimeMs,
  };
}
function listRules() {
  const out = [];
  const agents = path.join(WORKSPACE, "AGENTS.md");
  if (fs.existsSync(agents)) { const e = ruleEntry("AGENTS.md", agents); if (e) out.push(e); }
  if (fs.existsSync(RULES_DIR)) {
    fs.readdirSync(RULES_DIR).filter((f) => RULE_FILE_RE.test(f)).sort().forEach((f) => {
      const e = ruleEntry(".vrcloud-agent/rules/" + f, path.join(RULES_DIR, f)); if (e) out.push(e);
    });
  }
  return out;
}
function ruleAbs(relPath) {
  relPath = String(relPath || "").replace(/\\/g, "/");
  if (relPath === "AGENTS.md") return path.join(WORKSPACE, "AGENTS.md");
  const m = /^\.vrcloud-agent\/rules\/([^/]+)$/.exec(relPath);
  if (m && RULE_FILE_RE.test(m[1])) return path.join(RULES_DIR, m[1]);
  return null;
}
app.get("/api/ai/rules", (req, res) => res.json({ rules: listRules() }));
app.get("/api/ai/rules/file", (req, res) => {
  const abs = ruleAbs(req.query.path);
  if (!abs) return res.status(400).json({ error: "Path rule tidak valid" });
  if (!fs.existsSync(abs)) return res.json({ path: String(req.query.path), content: "", exists: false });
  const text = fs.readFileSync(abs, "utf8");
  const fm = parseFrontmatter(text);
  res.json({ path: String(req.query.path), exists: true, content: fm.body, description: fm.meta.description || "", globs: fm.meta.globs || "",
    alwaysApply: String(fm.meta.alwaysApply || "").toLowerCase() === "true", raw: text });
});
app.post("/api/ai/rules", (req, res) => {
  try {
    const b = req.body || {};
    let relPath = String(b.path || "").replace(/\\/g, "/").trim();
    if (!relPath && b.name) {
      let n = String(b.name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!n) return res.status(400).json({ error: "Nama rule tidak valid" });
      if (!/\.(mdc|md)$/.test(n)) n += ".mdc";
      relPath = ".vrcloud-agent/rules/" + n;
    }
    const abs = ruleAbs(relPath);
    if (!abs) return res.status(400).json({ error: "Path rule tidak valid (AGENTS.md atau .vrcloud-agent/rules/<nama>.mdc)" });
    const content = String(b.content || "").replace(/\r\n/g, "\n");
    let text = content;
    if (relPath !== "AGENTS.md") {
      const fmLines = ["---"];
      if (b.description) fmLines.push("description: " + yamlStr(b.description));
      if (b.globs) fmLines.push("globs: " + String(b.globs).trim());
      fmLines.push("alwaysApply: " + (b.alwaysApply ? "true" : "false"), "---", "");
      text = fmLines.join("\n") + content.trim() + "\n";
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
    filesChanged([relPath], "rules");
    res.json(ruleEntry(relPath, abs));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/ai/rules", (req, res) => {
  const abs = ruleAbs(req.query.path);
  if (!abs) return res.status(400).json({ error: "Path rule tidak valid" });
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (e) { return res.status(400).json({ error: e.message }); }
  filesChanged([String(req.query.path)], "rules");
  res.json({ ok: true });
});

// ---- Memori proyek agent: .vrcloud-agent/memory.md (dimuat ke prompt setiap run; agent boleh memperbarui) ----
const MEMORY_FILE = path.join(WORKSPACE, ".vrcloud-agent", "memory.md");
const MEMORY_MAX = 64 * 1024;
app.get("/api/ai/memory", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!fs.existsSync(MEMORY_FILE)) return res.json({ exists: false, content: "", size: 0, path: ".vrcloud-agent/memory.md" });
    const text = fs.readFileSync(MEMORY_FILE, "utf8");
    res.json({ exists: true, content: text, size: text.length, updatedAt: fs.statSync(MEMORY_FILE).mtimeMs, path: ".vrcloud-agent/memory.md" });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/ai/memory", (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "").replace(/\r\n/g, "\n");
    if (content.length > MEMORY_MAX) return res.status(400).json({ error: "Memori terlalu besar (maks 64 KB)" });
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (content.trim()) fs.writeFileSync(MEMORY_FILE, content, "utf8");
    else if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
    filesChanged([".vrcloud-agent/memory.md"], "memory");
    res.json({ ok: true, exists: !!content.trim(), size: content.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/ai/session/rename", (req, res) => {
  const r = aiChat.renameSession(String((req.body && req.body.id) || ""), req.body && req.body.title);
  if (!r) return res.status(404).json({ error: "Percakapan tidak ditemukan" });
  res.json(r);
});
// Keputusan review perubahan agent (terima/tolak per file) — disimpan di pesan AI.
app.post("/api/ai/review", (req, res) => {
  const b = req.body || {};
  const r = aiChat.setReview(String(b.id || b.sessionId || ""), String(b.after || ""), b.review);
  if (!r) return res.status(404).json({ error: "Pesan tidak ditemukan" });
  res.json({ ok: true, review: r });
});

// ---- Skills agent: <workspace>/.vrcloud-agent/skills/<nama>/SKILL.md --------------
const SKILLS_DIR = path.join(WORKSPACE, ".vrcloud-agent", "skills");
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null, buf = [];
  const flush = () => { if (key) meta[key] = buf.join(" ").trim().replace(/^["']|["']$/g, ""); key = null; buf = []; };
  m[1].split(/\r?\n/).forEach((line) => {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) { flush(); key = kv[1]; if (kv[2] && kv[2] !== ">-" && kv[2] !== ">" && kv[2] !== "|") buf.push(kv[2]); }
    else if (key) buf.push(line.trim());
  });
  flush();
  return { meta, body: m[2] || "" };
}
function readSkill(name) {
  if (!SKILL_NAME_RE.test(name)) return null;
  const file = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  const extras = fs.readdirSync(path.join(SKILLS_DIR, name)).filter((f) => f !== "SKILL.md");
  return {
    name, description: fm.meta.description || "", content: fm.body,
    autoInvoke: String(fm.meta["disable-model-invocation"] || "").toLowerCase() !== "true",
    path: ".vrcloud-agent/skills/" + name + "/SKILL.md", extras, size: text.length,
    updatedAt: fs.statSync(file).mtimeMs,
  };
}
function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SKILL_NAME_RE.test(d.name))
    .map((d) => readSkill(d.name)).filter(Boolean)
    .map((s) => ({ name: s.name, description: s.description, autoInvoke: s.autoInvoke, path: s.path, extras: s.extras, updatedAt: s.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function yamlStr(s) { s = String(s || "").replace(/\s+/g, " ").trim(); return /[:#"'{}\[\],&*?|<>=!%@`]/.test(s) ? JSON.stringify(s) : s; }
app.get("/api/ai/skills", (req, res) => res.json({ skills: listSkills(), dir: ".vrcloud-agent/skills" }));
app.get("/api/ai/skills/:name", (req, res) => {
  const s = readSkill(String(req.params.name || ""));
  if (!s) return res.status(404).json({ error: "Skill tidak ditemukan" });
  res.json(s);
});
app.post("/api/ai/skills", (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim().toLowerCase();
    if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: "Nama skill: huruf kecil/angka/tanda hubung, maks 64 karakter" });
    const description = String(b.description || "").trim();
    if (!description) return res.status(400).json({ error: "Deskripsi wajib diisi (kapan skill ini dipakai)" });
    if (description.length > 1024) return res.status(400).json({ error: "Deskripsi maks 1024 karakter" });
    const content = String(b.content || "").replace(/\r\n/g, "\n").trim();
    const autoInvoke = !!b.autoInvoke;
    const dir = path.join(SKILLS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    const fmLines = ["---", "name: " + name, "description: " + yamlStr(description)];
    if (!autoInvoke) fmLines.push("disable-model-invocation: true");
    fmLines.push("---", "");
    fs.writeFileSync(path.join(dir, "SKILL.md"), fmLines.join("\n") + (content || "# " + name + "\n\n## Instructions\n") + "\n", "utf8");
    filesChanged([".vrcloud-agent/skills/" + name + "/SKILL.md"], "skills");
    res.json(readSkill(name));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/ai/skills/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: "Nama tidak valid" });
  const dir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return res.status(404).json({ error: "Skill tidak ditemukan" });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return res.status(400).json({ error: e.message }); }
  filesChanged([".vrcloud-agent/skills/" + name + "/SKILL.md"], "skills");
  res.json({ ok: true });
});
// Nama skill dari klien: valid, maks 3.
function skillNamesFrom(names) {
  return Array.isArray(names) ? names.map(String).filter((n) => SKILL_NAME_RE.test(n)).slice(0, 3) : [];
}
// Sisipkan isi skill yang dipilih pengguna (chip "/skill") ke depan pesan.
function withSkills(message, list) {
  if (!list.length) return message;
  const blocks = [];
  list.forEach((n) => {
    const s = readSkill(n);
    if (!s) return;
    blocks.push("[Skill: " + n + "] " + (s.description || "") + "\nFollow this skill's instructions for the request below. Supporting files live in " +
      ".vrcloud-agent/skills/" + n + "/ (read them when referenced).\n\n" + String(s.content || "").slice(0, 20000));
  });
  if (!blocks.length) return message;
  return blocks.join("\n\n---\n\n") + "\n\n---\n\nUser request:\n" + message;
}

// Daftar file untuk autocomplete "@" di chat (cache singkat, folder berat dilewati).
const SKIP_DIRS = new Set(Checkpoints.HEAVY_DIRS.concat([".idea", ".vscode"]));
let fileIndex = { at: 0, list: [] };
function buildFileIndex() {
  if (Date.now() - fileIndex.at < 20000) return fileIndex.list;
  const list = [];
  const walk = (dir, relDir, depth) => {
    if (list.length >= 20000 || depth > 14) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of ents) {
      if (list.length >= 20000) return;
      const relp = relDir ? relDir + "/" + d.name : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), relp, depth + 1); }
      else if (d.isFile()) list.push(relp);
    }
  };
  walk(WORKSPACE, "", 0);
  fileIndex = { at: Date.now(), list };
  return list;
}
app.get("/api/files", (req, res) => {
  const q = String(req.query.q || "").toLowerCase().replace(/\\/g, "/").trim();
  const limit = Math.min(60, parseInt(req.query.limit, 10) || 30);
  const list = buildFileIndex();
  if (!q) return res.json({ files: list.slice(0, limit) });
  const scored = [];
  for (const p of list) {
    const lp = p.toLowerCase();
    const base = lp.slice(lp.lastIndexOf("/") + 1);
    let score = -1;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.indexOf(q) !== -1) score = 2;
    else if (lp.indexOf(q) !== -1) score = 3;
    else {
      let i = 0;
      for (let j = 0; j < lp.length && i < q.length; j++) if (lp[j] === q[i]) i++;
      if (i === q.length) score = 4;
    }
    if (score >= 0) scored.push({ p, score, len: p.length });
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len);
  res.json({ files: scored.slice(0, limit).map((x) => x.p) });
});

app.get("/api/ai/sessions", (req, res) => res.json({ sessions: aiChat.listSessions() }));

app.get("/api/ai/session", (req, res) => {
  const id = String((req.query && req.query.id) || "");
  if (!id) return res.status(400).json({ error: "id wajib" });
  const session = aiChat.getSession(id);
  if (!session) return res.status(404).json({ error: "Percakapan tidak ditemukan" });
  res.json(session);
});

app.post("/api/ai/session", (req, res) => {
  const id = req.body && req.body.id;
  res.json(aiChat.createSession(id));
});

app.post("/api/ai/sessions/import", (req, res) => {
  const list = (req.body && req.body.sessions) || [];
  res.json({ sessions: aiChat.importSessions(list) });
});

// Simpan setelan API dari web (key/model). Field yang absen tidak diubah.
app.post("/api/ai/config", (req, res) => {
  const body = req.body || {};
  const config = {};
  if (Object.prototype.hasOwnProperty.call(body, "apiKey")) config.apiKey = body.apiKey;
  if (Object.prototype.hasOwnProperty.call(body, "anthropicKey")) config.anthropicKey = body.anthropicKey;
  if (Object.prototype.hasOwnProperty.call(body, "provider")) config.provider = body.provider;
  if (Object.prototype.hasOwnProperty.call(body, "model")) config.model = body.model;
  if (Object.prototype.hasOwnProperty.call(body, "params")) config.params = body.params;
  if (Object.prototype.hasOwnProperty.call(body, "mode")) config.mode = body.mode;
  if (Object.prototype.hasOwnProperty.call(body, "verifyCmd")) config.verifyCmd = body.verifyCmd;
  if (Object.prototype.hasOwnProperty.call(body, "browserTools")) config.browserTools = body.browserTools;
  if (Object.prototype.hasOwnProperty.call(body, "desktopTools")) config.desktopTools = body.desktopTools;
  if (Object.prototype.hasOwnProperty.call(body, "promptCache")) config.promptCache = body.promptCache;
  if (Object.prototype.hasOwnProperty.call(body, "memory")) config.memory = body.memory;
  aiChat.setConfig(config).then(
    (status) => res.json(status),
    (e) => res.status(400).json({ error: e.message })
  );
});

// Login akun Grok/xAI (device-code OAuth). Token disimpan di server, bukan di browser.
app.post("/api/ai/grok/login", (req, res) => {
  const cancel = !!(req.body && req.body.cancel);
  const op = cancel ? aiChat.cancelGrokLogin() : aiChat.startGrokLogin();
  Promise.resolve(op).then(
    (status) => res.json(status),
    (e) => res.status(400).json({ error: e.message })
  );
});
app.post("/api/ai/grok/logout", (req, res) => {
  aiChat.logoutGrok().then(
    (status) => res.json(status),
    (e) => res.status(400).json({ error: e.message })
  );
});

// Daftar model untuk key aktif (atau key yang dikirim di body untuk uji coba).
app.post("/api/ai/models", (req, res) => {
  const apiKey = req.body && req.body.apiKey;
  const provider = req.body && req.body.provider;
  const refresh = !!(req.body && req.body.refresh);
  aiChat.listModels(apiKey, provider, refresh).then(
    (models) => res.json({ models }),
    (e) => res.status(400).json({ error: e.message })
  );
});

app.post("/api/ai/reset", (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || "default");
  aiChat.reset(sessionId).then(
    () => res.json({ ok: true }),
    (e) => res.status(400).json({ error: e.message })
  );
});

function ndjson(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  return (t, v) => { try { res.write(JSON.stringify({ t: t, v: v }) + "\n"); } catch (e) {} };
}

// Stream balasan. Putusnya klien (refresh / ganti tab) TIDAK membatalkan run.
app.post("/api/ai/chat", (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || "default");
  const skillNames = skillNamesFrom(req.body && req.body.skills);
  const message = withSkills((req.body && req.body.message) || "", skillNames);
  const display = (req.body && req.body.display) || "";
  const title = (req.body && req.body.title) || "";
  // Gambar tempel: [{ data(base64), mimeType, name }], maks 4 x ~2MB.
  const images = Array.isArray(req.body && req.body.images) ? req.body.images.filter((im) =>
    im && typeof im.data === "string" && im.data.length < 3 * 1024 * 1024 && /^image\/(png|jpe?g|gif|webp)$/i.test(String(im.mimeType || ""))
  ).slice(0, 4) : [];
  const avail = aiChat.status();
  if (!avail.enabled) return res.status(503).json({ error: avail.reason || "AI Chat tidak aktif" });
  if (aiChat.isBusy(sessionId)) return res.status(409).json({ error: "Masih memproses pesan sebelumnya, tunggu sebentar", busy: true });
  const frame = ndjson(res);
  aiChat.send(sessionId, message, (kind, text) => frame(kind, text), { display: display, title: title, images: images, skills: skillNames }).then(
    // Frame penutup sama seperti /api/ai/live: klien tahu run berakhir "finished",
    // "cancelled" (Stop dari tab lain), atau "error".
    (status) => { frame("done", status || "finished"); res.end(); },
    (e) => {
      if (e && /Masih memproses/.test(e.message)) {
        if (!res.headersSent) return res.status(409).json({ error: e.message, busy: true });
      }
      if (!res.headersSent) res.status(500).json({ error: e.message });
      else { frame("error", e.message); res.end(); }
    }
  );
});

// Sambung ke run yang sedang berjalan (setelah refresh / browser lain).
app.post("/api/ai/live", (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || "default");
  const frame = ndjson(res);
  let unsub = function () {};
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    try { unsub(); } catch (e) {}
    try { res.end(); } catch (e) {}
  };
  unsub = aiChat.subscribe(sessionId, (kind, text) => {
    frame(kind, text);
    if (kind === "done" || kind === "error") finish();
  });
  // Klien putus: res 'close'. (req 'close' di Node >= 16 menyala begitu body selesai
  // dibaca — itu yang dulu memutus stream live seketika.)
  res.on("close", finish);
});

// Proses shell latar belakang milik agent: hanya yang masih hidup.
app.get("/api/ai/procs", (req, res) => {
  const extra = String(req.query.pids || "").split(/[,\s]+/).map((n) => Number(n)).filter((n) => n > 1);
  res.setHeader("Cache-Control", "no-store");
  res.json({ procs: BgProcs.list(extra) });
});
app.post("/api/ai/procs/stop", (req, res) => {
  const body = req.body || {};
  if (body.all) BgProcs.stopAll();
  else BgProcs.stop(body.pid);
  res.json({ procs: BgProcs.list() });
});

// Hentikan run yang sedang berjalan.
app.post("/api/ai/stop", (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || "default");
  aiChat.stop(sessionId).then(
    (stopped) => res.json({ ok: true, stopped }),
    (e) => res.status(400).json({ error: e.message })
  );
});

// ---- Server + WebSocket collaboration + terminal bersama -----------------
let tlsInfo = null;
let server;
if (USE_HTTPS) {
  tlsInfo = ensureTlsMaterial(path.join(__dirname, "data", "tls"));
  const opts = tlsInfo.pfx
    ? { pfx: tlsInfo.pfx, passphrase: tlsInfo.passphrase }
    : { cert: tlsInfo.cert, key: tlsInfo.key };
  server = https.createServer(opts, app);
} else {
  server = http.createServer(app);
}
const terminals = new TerminalManager({
  workspace: WORKSPACE,
  rcfile: RCFILE,
  shell: SHELL,
  store,
  safe,
});
const hub = new RealtimeHub({ server, store, workspace: WORKSPACE, safe, terminals, browser });
hubRef = hub; // agent AI & restore checkpoint memakai ini untuk menyegarkan editor/tree
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
  const target = pathname === "/sync" ? hub.wss : pathname === "/terminal" ? terminalWss : pathname === "/desktop" ? desktopWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

terminalWss.on("connection", (ws, req) => {
  let id = "";
  try { id = new URL(req.url, "http://localhost").searchParams.get("id") || ""; } catch (e) {}
  if (!id) return ws.close(1008, "Parameter id wajib");
  // Gagal spawn shell/tmux tidak boleh menjatuhkan proses server.
  try { terminals.attach(ws, id); }
  catch (e) { console.warn("[terminal] gagal attach " + id + ": " + e.message); try { ws.close(1011, String(e.message || "gagal membuka terminal").slice(0, 120)); } catch (e2) {} }
});

function shutdown() {
  try { store.flush(); } catch (e) {}
  try { if (browser) browser.cleanupConnection(); } catch (e) {} // matikan Chrome headless
}
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT", () => { shutdown(); process.exit(0); });
function logFatal(kind, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  console.error("[vrcloud] " + kind + ": " + msg);
}
// Stay up and leave a line in the log. A phone "white crash" is usually the
// Ace theme; if the process does die, this is how we tell the two apart.
process.on("uncaughtException", (err) => { logFatal("uncaughtException", err); });
process.on("unhandledRejection", (err) => { logFatal("unhandledRejection", err); });

server.listen(PORT, HOST, () => {
  const scheme = USE_HTTPS ? "https" : "http";
  const bindAll = HOST === "0.0.0.0" || HOST === "::";
  const ips = bindAll && tlsInfo && tlsInfo.ips && tlsInfo.ips.length ? tlsInfo.ips : [bindAll ? "127.0.0.1" : HOST];
  const urls = ips.filter((ip, i, a) => a.indexOf(ip) === i).map((ip) => scheme + "://" + ip + ":" + PORT + "/");
  console.log("VRCloud IDE berjalan di " + urls.join("  "));
  if (USE_HTTPS && tlsInfo && tlsInfo.selfSigned) console.log("Sertifikat self-signed: browser meminta konfirmasi sekali saat membuka https://IP:" + PORT);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Login: aktif (user=${AUTH_USER})`);
});
