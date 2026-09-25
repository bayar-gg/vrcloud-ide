"use strict";

/**
 * Otomasi browser untuk agent AI lewat Chrome DevTools Protocol (CDP).
 *
 * - Browser: Chrome / Edge / Chromium / Brave yang terpasang (Windows, Linux,
 *   macOS), atau Chrome for Testing yang diunduh ke data/browser/. Headless,
 *   --remote-debugging-port, klien CDP kecil di atas paket `ws`.
 * - Multi-tab: setiap tab punya sesi CDP sendiri (log console/network per tab);
 *   satu tab "aktif" yang dikenai tool. Popup (target=_blank) jadi tab baru.
 * - Setiap aksi menghasilkan "langkah" (url, judul, screenshot JPEG di
 *   data/browser-shots) untuk kartu di chat, tampilan live, dan model.
 * - Live view: Page.startScreencast dikirim ke IDE selama ada yang menonton;
 *   pengguna bisa mengambil alih (mouse/keyboard diteruskan ke CDP).
 * - Ketahanan: crash target/koneksi → peluncuran ulang otomatis; galat jaringan
 *   sementara dicoba ulang; pelacak/iklan diblokir agar halaman lebih ringan.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const Instructions = require("./agent-instructions"); // tool descriptions live in one file
const WebSocket = require("ws");

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const MAX_LOG = 300;
const MAX_SHOTS = 200;
const SHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHOT_MAX_BYTES = 200 * 1024;
const MAX_STEPS_PER_RUN = 80;
const MAX_TABS = 8;
const LIVE_MIN_INTERVAL_MS = 125;
const TRACKER_BLOCKLIST = [
  "*://*.doubleclick.net/*", "*://*.googlesyndication.com/*", "*://*.googleadservices.com/*", "*://*.google-analytics.com/*",
  "*://*.googletagmanager.com/*", "*://*.facebook.net/*", "*://connect.facebook.net/*", "*://*.hotjar.com/*", "*://*.adnxs.com/*",
  "*://*.scorecardresearch.com/*", "*://*.criteo.com/*", "*://*.taboola.com/*", "*://*.outbrain.com/*", "*://*.adsrvr.org/*",
  "*://*.quantserve.com/*", "*://*.moatads.com/*", "*://*.rubiconproject.com/*", "*://*.pubmatic.com/*",
];
const DEVICES = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  android: { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36" },
};

function which(bin) {
  try {
    const r = spawnSync(IS_WINDOWS ? "where" : "which", [bin], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    if (r.status !== 0) return "";
    return String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  } catch (e) { return ""; }
}

// Chrome for Testing yang diunduh ke data/browser/ (lihat installChromium()).
function downloadedBrowser(dataDir) {
  const root = path.join(dataDir, "browser");
  if (!fs.existsSync(root)) return "";
  const names = IS_WINDOWS ? ["chrome.exe"] : process.platform === "darwin" ? ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"] : ["chrome"];
  try {
    for (const dir of fs.readdirSync(root)) {
      for (const n of names) { const p = path.join(root, dir, n); if (fs.existsSync(p)) return p; }
    }
  } catch (e) {}
  return "";
}

// Cari executable browser berbasis Chromium di OS ini.
function findBrowser(dataDir) {
  if (process.env.VRCLOUD_BROWSER && fs.existsSync(process.env.VRCLOUD_BROWSER)) return process.env.VRCLOUD_BROWSER;
  const dl = dataDir ? downloadedBrowser(dataDir) : "";
  if (dl) return dl;
  const cands = [];
  if (IS_WINDOWS) {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    cands.push(
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      local && path.join(local, "Chromium", "Application", "chrome.exe"),
    );
  } else if (process.platform === "darwin") {
    cands.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else {
    ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "chrome"]
      .forEach((b) => { const p = which(b); if (p) cands.push(p); });
    cands.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/opt/google/chrome/chrome");
  }
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return "";
}

function browserVersion(exe) {
  if (!exe) return "";
  try {
    if (IS_WINDOWS) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Item '" + exe.replace(/'/g, "''") + "').VersionInfo.ProductVersion"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
      return String(r.stdout || "").trim();
    }
    const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 8000 });
    return String(r.stdout || "").trim();
  } catch (e) { return ""; }
}

// ---- Skrip di halaman -------------------------------------------------------
// Ringkasan elemen interaktif (+ heading) dengan ref [eN] untuk tool klik/ketik.
const SNAPSHOT_JS = `(function (withText, max) {
  function vis(el) { var r = el.getBoundingClientRect(); if (!r.width && !r.height) return false; var cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"; }
  function txt(s) { return String(s || "").replace(/\\s+/g, " ").trim().slice(0, 80); }
  var sel = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=textbox],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=option],[onclick],[contenteditable=true],h1,h2,h3,[role=heading]";
  var els = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(vis);
  var n = 0, out = [];
  document.querySelectorAll("[data-vrc-ref]").forEach(function (e) { e.removeAttribute("data-vrc-ref"); });
  els.forEach(function (el) {
    if (out.length >= max) return;
    var tag = el.tagName.toLowerCase(); var role = el.getAttribute("role");
    var isHead = /^h[1-3]$/.test(tag) || role === "heading";
    var label = txt(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.alt || "");
    if (tag === "input" || tag === "textarea" || tag === "select") {
      var lab = el.labels && el.labels[0] ? txt(el.labels[0].innerText) : "";
      label = txt(el.getAttribute("aria-label") || lab || el.placeholder || el.name || el.id || "");
    }
    if (isHead) { out.push(tag + " \\"" + label + "\\""); return; }
    var ref = "e" + (++n); el.setAttribute("data-vrc-ref", ref);
    var d = "[" + ref + "] " + (role || tag);
    if (tag === "input") d += "(type=" + (el.type || "text") + ")";
    if (label) d += " \\"" + label + "\\"";
    if (tag === "input" || tag === "textarea") { if (el.placeholder) d += " placeholder=\\"" + txt(el.placeholder) + "\\""; if (el.value && el.type !== "password") d += " value=\\"" + txt(el.value) + "\\""; }
    if (tag === "a" && el.getAttribute("href")) d += " -> " + String(el.getAttribute("href")).slice(0, 100);
    if (tag === "select") d += " [" + Array.prototype.slice.call(el.options).slice(0, 8).map(function (o) { return txt(o.text); }).join(" | ") + "]";
    if (el.disabled) d += " (disabled)";
    if (el.checked) d += " (checked)";
    out.push(d);
  });
  var res = { url: location.href, title: document.title, count: n, outline: out.join("\\n") };
  if (withText) res.text = String(document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").replace(/[ \\t]+/g, " ").trim().slice(0, 4000);
  return res;
})`;

// Cari satu elemen (ref / selector CSS / teks) lalu kembalikan titik tengahnya.
const LOCATE_JS = `(function (ref, selector, text) {
  var el = null;
  if (ref) el = document.querySelector('[data-vrc-ref="' + ref + '"]');
  if (!el && selector) { try { el = document.querySelector(selector); } catch (e) {} }
  if (!el && text) {
    var t = String(text).trim().toLowerCase();
    var cands = Array.prototype.slice.call(document.querySelectorAll("a,button,input,textarea,select,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],li,span,div"));
    el = cands.find(function (e) { var s = (e.innerText || e.value || e.getAttribute("aria-label") || e.placeholder || "").trim().toLowerCase(); return s === t; })
      || cands.find(function (e) { var s = (e.innerText || e.value || e.getAttribute("aria-label") || e.placeholder || "").trim().toLowerCase(); return s && s.length < 200 && s.indexOf(t) !== -1; });
  }
  if (!el) return null;
  if (el.tagName === "LABEL" && el.control) el = el.control;
  el.scrollIntoView({ block: "center", inline: "center" });
  var r = el.getBoundingClientRect();
  var desc = (el.tagName || "").toLowerCase() + (el.id ? "#" + el.id : "") + " \\"" + String(el.innerText || el.value || el.getAttribute("aria-label") || el.placeholder || "").replace(/\\s+/g, " ").trim().slice(0, 60) + "\\"";
  if (!el.getAttribute("data-vrc-ref")) el.setAttribute("data-vrc-ref", "loc" + Date.now().toString(36));
  // Petunjuk selector stabil untuk ekspor skrip Playwright (id / name / placeholder / aria-label / data-testid).
  var sel = "";
  var q = function (v) { return String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"'); };
  if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) sel = "#" + el.id;
  else if (el.getAttribute("data-testid")) sel = '[data-testid="' + q(el.getAttribute("data-testid")) + '"]';
  else if (el.getAttribute("name")) sel = el.tagName.toLowerCase() + '[name="' + q(el.getAttribute("name")) + '"]';
  else if (el.getAttribute("placeholder")) sel = el.tagName.toLowerCase() + '[placeholder="' + q(el.getAttribute("placeholder")) + '"]';
  else if (el.getAttribute("aria-label")) sel = '[aria-label="' + q(el.getAttribute("aria-label")) + '"]';
  var txt = /^(a|button|summary|label|li|span|div)$/i.test(el.tagName) || el.getAttribute("role") ? String(el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60) : "";
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, desc: desc, tag: (el.tagName || "").toLowerCase(), type: el.type || "", ref: el.getAttribute("data-vrc-ref"), editable: !!(el.isContentEditable || /^(input|textarea)$/i.test(el.tagName)), sel: sel, txt: txt };
})`;

// Label [eN] di atas elemen untuk screenshot beranotasi (Set-of-Mark).
const ANNOTATE_JS = `(function (on) {
  var old = document.getElementById("__vrc_marks"); if (old) old.remove();
  if (!on) return 0;
  var box = document.createElement("div"); box.id = "__vrc_marks"; box.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;font:11px/1 Arial,sans-serif";
  var n = 0;
  document.querySelectorAll("[data-vrc-ref^=e]").forEach(function (el) {
    var r = el.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    var m = document.createElement("div"); m.textContent = el.getAttribute("data-vrc-ref");
    m.style.cssText = "position:fixed;left:" + Math.max(0, r.left) + "px;top:" + Math.max(0, r.top - 14) + "px;background:#ffd400;color:#000;padding:1px 4px;border-radius:3px;font-weight:bold;box-shadow:0 0 0 1px #000";
    var o = document.createElement("div"); o.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;outline:2px solid rgba(255,212,0,.9)";
    box.appendChild(o); box.appendChild(m); n++;
  });
  document.documentElement.appendChild(box);
  return n;
})`;

// DOM -> Markdown/teks/tabel/link untuk ekstraksi konten hemat token.
const EXTRACT_JS = `(function (selector, format, maxChars) {
  var root = selector ? document.querySelector(selector) : (document.querySelector("main, article, [role=main]") || document.body);
  if (!root) return { error: "Elemen tidak ditemukan: " + selector };
  function clean(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }
  if (format === "html") return { content: root.outerHTML.slice(0, maxChars) };
  if (format === "text") return { content: (root.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, maxChars) };
  if (format === "links") {
    var links = Array.prototype.slice.call(root.querySelectorAll("a[href]")).map(function (a) { return { text: clean(a.innerText), href: a.href }; }).filter(function (l) { return l.href && !/^javascript:/.test(l.href); });
    var seen = {}; links = links.filter(function (l) { var k = l.href + "|" + l.text; if (seen[k]) return false; seen[k] = 1; return true; });
    return { content: JSON.stringify(links.slice(0, 500), null, 1).slice(0, maxChars), count: links.length };
  }
  if (format === "table") {
    var tables = Array.prototype.slice.call(root.tagName === "TABLE" ? [root] : root.querySelectorAll("table")).map(function (t) {
      var rows = Array.prototype.slice.call(t.querySelectorAll("tr")).map(function (tr) { return Array.prototype.slice.call(tr.querySelectorAll("th,td")).map(function (c) { return clean(c.innerText); }); }).filter(function (r) { return r.length; });
      if (!rows.length) return [];
      var hasHead = t.querySelector("thead th, tr:first-child th");
      if (!hasHead) return rows;
      var head = rows[0]; return rows.slice(1).map(function (r) { var o = {}; r.forEach(function (v, i) { o[head[i] || ("col" + (i + 1))] = v; }); return o; });
    });
    return { content: JSON.stringify(tables.length === 1 ? tables[0] : tables, null, 1).slice(0, maxChars), tables: tables.length };
  }
  // markdown
  function md(node, depth) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\\s+/g, " ");
    if (node.nodeType !== 1) return "";
    var cs = getComputedStyle(node); if (cs.display === "none" || cs.visibility === "hidden") return "";
    var tag = node.tagName.toLowerCase();
    if (/^(script|style|noscript|svg|nav|footer|aside|iframe|template)$/.test(tag)) return "";
    var kids = function () { return Array.prototype.map.call(node.childNodes, function (c) { return md(c, depth); }).join(""); };
    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "\\n\\n" + "#".repeat(+tag[1]) + " " + clean(kids()) + "\\n\\n";
      case "p": return "\\n\\n" + clean(kids()) + "\\n\\n";
      case "br": return "\\n";
      case "hr": return "\\n\\n---\\n\\n";
      case "strong": case "b": return "**" + clean(kids()) + "**";
      case "em": case "i": return "_" + clean(kids()) + "_";
      case "code": return node.parentElement && node.parentElement.tagName === "PRE" ? kids() : "\`" + clean(kids()) + "\`";
      case "pre": return "\\n\\n\`\`\`\\n" + node.innerText.replace(/\\n$/, "") + "\\n\`\`\`\\n\\n";
      case "a": { var t = clean(kids()); return t ? "[" + t + "](" + node.href + ")" : ""; }
      case "img": return node.alt ? "![" + clean(node.alt) + "](" + node.src + ")" : "";
      case "ul": case "ol": return "\\n" + Array.prototype.map.call(node.children, function (li, i) { return "  ".repeat(depth) + (tag === "ol" ? (i + 1) + ". " : "- ") + clean(md(li, depth + 1)) + "\\n"; }).join("") + "\\n";
      case "li": return kids();
      case "blockquote": return "\\n> " + clean(kids()) + "\\n";
      case "table": {
        var rows = Array.prototype.slice.call(node.querySelectorAll("tr")).map(function (tr) { return Array.prototype.slice.call(tr.querySelectorAll("th,td")).map(function (c) { return clean(c.innerText).replace(/\\|/g, "\\\\|"); }); }).filter(function (r) { return r.length; });
        if (!rows.length) return "";
        var w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
        var line = function (r) { while (r.length < w) r.push(""); return "| " + r.join(" | ") + " |"; };
        return "\\n\\n" + line(rows[0]) + "\\n" + line(rows[0].map(function () { return "---"; })) + "\\n" + rows.slice(1).map(line).join("\\n") + "\\n\\n";
      }
      default: return kids();
    }
  }
  var out = md(root, 0).replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { content: out.slice(0, maxChars), truncated: out.length > maxChars, chars: out.length };
})`;

// Deteksi CAPTCHA / verifikasi manusia / tembok login.
const WALL_JS = `(function () {
  var t = ((document.title || "") + " " + (document.body ? document.body.innerText.slice(0, 4000) : "")).toLowerCase();
  if (/captcha|verify (that )?you are (a )?human|are you a robot|unusual traffic|just a moment|checking your browser|access denied|attention required|bots use/.test(t) || document.querySelector("iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[src*=turnstile],#challenge-form,.g-recaptcha,.h-captcha")) return "captcha";
  var pw = document.querySelector("input[type=password]");
  if (pw && /sign in|log ?in|masuk|login|password|kata sandi/.test(t) && document.querySelectorAll("a[href],button").length < 60) return "login";
  return "";
})`;

class BrowserAutomation {
  constructor(options) {
    options = options || {};
    // Absolut: --user-data-dir relatif membuat Chrome memakai profil default (yang mungkin
    // sedang dipakai Chrome pengguna) lalu keluar dengan kode 21.
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data"));
    this.workspace = options.workspace ? path.resolve(options.workspace) : null;
    this.shotDir = path.join(this.dataDir, "browser-shots");
    this.profileDir = path.join(this.dataDir, "browser-profile");
    this.onStep = typeof options.onStep === "function" ? options.onStep : null;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : null; // frame live, tabs, handoff, install
    this.secrets = options.secrets || null; // { list(): string[], get(name): string|null }
    this.exe = findBrowser(this.dataDir);
    this.version = "";
    this.proc = null; this.ws = null;
    this.msgId = 0; this.pending = new Map(); this.handlers = new Map();
    this.pages = new Map(); this.pageSeq = 0; this.active = null; // tab kerja agent
    this.viewTab = null; this.pinned = false; // tab yang tampil live; pinned = pengguna memilih sendiri
    this.steps = []; this.stepSeq = 0; this.stepByCall = new Map();
    this.runSteps = 0;
    this.lastUsed = 0; this.idleTimer = null; this.launching = null;
    this.queue = Promise.resolve();
    this.dialogs = [];
    this.blockTrackers = options.blockTrackers !== false;
    this.emulation = { viewport: Object.assign({}, DEFAULT_VIEWPORT), device: "desktop" };
    this.live = { watchers: 0, running: false, lastFrame: null };
    this.handoff = null; // { message, resolve }
    this.downloads = new Map(); // guid -> { suggested, state, resolve }
    this.install = null; // { stage, percent, error }
    this.pruneShots();
    const t = setInterval(() => this.pruneShots(), 60 * 60 * 1000); if (t.unref) t.unref();
  }

  info() {
    if (this.exe && !this.version) this.version = browserVersion(this.exe);
    const tabs = this.tabList();
    return {
      available: !!this.exe, exe: this.exe, version: this.version, running: this.browserAlive(),
      downloaded: !!downloadedBrowser(this.dataDir), tabs, active: this.active, view: this.viewTab, device: this.emulation.device,
      viewport: this.emulation.viewport, live: this.live.running, handoff: this.handoff ? { message: this.handoff.message, since: this.handoff.since } : null,
      install: this.install,
    };
  }
  // Tab dibagi dua pemilik: "agent" (dikenai tool browser_*) dan "user" (dibuka pengguna dari
  // panel Browser agent). Agent tidak melihat/menyentuh tab pengguna; pengguna bebas berpindah
  // tab tanpa mengubah tab kerja agent. `active` = tab kerja agent, `viewTab` = yang tampil live.
  browserAlive() { return !!(this.ws && this.ws.readyState === WebSocket.OPEN); }
  connected() { return this.browserAlive() && !!this.active && this.pages.has(this.active); }
  page() { return this.pages.get(this.active) || null; }
  viewPage() { return this.pages.get(this.viewTab) || null; }
  agentTabs() { return [...this.pages.values()].filter((p) => p.owner === "agent"); }
  tabList() { return [...this.pages.values()].map((p) => ({ id: p.id, url: p.url, title: p.title, owner: p.owner, active: p.id === this.active, view: p.id === this.viewTab })); }
  tabsPayload() { return { tabs: this.tabList(), active: this.active, view: this.viewTab }; }
  emitTabs() { this.emit("tabs", this.tabsPayload()); }
  emit(type, payload) { if (this.onEvent) { try { this.onEvent(type, payload); } catch (e) {} } }

  // Serialisasi: satu aksi browser pada satu waktu.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
  beginRun() { this.runSteps = 0; }

  pruneShots() {
    try {
      if (!fs.existsSync(this.shotDir)) return;
      const now = Date.now();
      fs.readdirSync(this.shotDir).forEach((f) => {
        const p = path.join(this.shotDir, f);
        try { if (now - fs.statSync(p).mtimeMs > SHOT_MAX_AGE_MS) fs.unlinkSync(p); } catch (e) {}
      });
    } catch (e) {}
  }

  // ---- Peluncuran & koneksi CDP -----------------------------------------
  // Siapkan browser + tab kerja agent (dipakai semua tool browser_*).
  async ensure() {
    if (this.connected()) { this.touch(); return; }
    await this.ensureBrowser();
    if (!this.connected()) {
      // Browser hidup tapi agent belum punya tab (pertama kali, atau tabnya ditutup): buka tab agent.
      if (this.launching) return this.launching;
      this.launching = this.newTab("about:blank", "agent").then(() => { this.touch(); }).finally(() => { this.launching = null; });
      return this.launching;
    }
  }
  // Siapkan proses browser saja (tanpa tab agent) — untuk tab pengguna dari panel Browser agent.
  async ensureBrowser() {
    if (this.browserAlive()) return;
    if (this.launching) return this.launching;
    if (this.ws) this.cleanupConnection(); // koneksi mati: mulai bersih
    this.launching = this.launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  async launch() {
    if (!this.exe) this.exe = findBrowser(this.dataDir);
    if (!this.exe) throw new Error("Browser tidak ditemukan. Pasang Google Chrome / Microsoft Edge / Chromium, unduh Chromium dari Preferences → Server, atau set VRCLOUD_BROWSER=<path executable>.");
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.shotDir, { recursive: true });
    const vp = this.emulation.viewport;
    const args = [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--disable-background-networking", "--disable-sync", "--mute-audio", "--hide-scrollbars", "--disable-dev-shm-usage",
      "--disable-features=TranslateUI", "--remote-debugging-port=0", "--user-data-dir=" + this.profileDir,
      "--window-size=" + vp.width + "," + vp.height, "--lang=id-ID,id,en",
    ];
    if (!IS_WINDOWS && typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
    args.push("about:blank");
    const proc = spawn(this.exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = ""; let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("Browser tidak memberi alamat DevTools dalam 20 detik")); } }, 20000);
      const onData = (d) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
        if (m && !done) { done = true; clearTimeout(timer); resolve(m[1]); }
      };
      proc.stderr.on("data", onData); proc.stdout.on("data", onData);
      proc.on("exit", (code) => {
        if (done) return; done = true; clearTimeout(timer);
        const tail = buf.trim().split(/\r?\n/).slice(-3).join(" | ");
        reject(new Error("Browser keluar (kode " + code + ") saat diluncurkan" + (code === 21 ? " — profil sedang dipakai instance lain" : "") + (tail ? ": " + tail : "")));
      });
      proc.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
    proc.on("exit", () => { if (this.proc === proc) this.cleanupConnection(); });
    await this.connect(wsUrl);
    await this.send("Target.setDiscoverTargets", { discover: true }, null);
    await this.setupDownloads();
    // Tab awal (about:blank) disimpan sebagai cadangan untuk tab pertama — menutupnya bisa
    // mematikan browser (window terakhir). Tab berikutnya dibuat sebagai window sendiri.
    const all = await this.send("Target.getTargets", {}, null);
    const first = (all.targetInfos || []).find((x) => x.type === "page");
    this.spareTarget = first ? first.targetId : null;
    this.touch();
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.on("open", () => { this.ws = ws; resolve(); });
      ws.on("error", (e) => { if (this.ws !== ws) reject(e); });
      ws.on("close", () => { if (this.ws === ws) this.cleanupConnection(); });
      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || "CDP error")); else p.resolve(msg.result || {});
          return;
        }
        if (msg.method) {
          const hs = this.handlers.get(msg.method);
          if (hs) hs.forEach((h) => { try { h(msg.params || {}, msg.sessionId); } catch (e) {} });
        }
      });
    });
  }

  cleanupConnection() {
    this.pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error("Koneksi browser terputus")); });
    this.pending.clear();
    try { if (this.ws) this.ws.terminate(); } catch (e) {}
    this.ws = null; this.pages.clear(); this.active = null; this.viewTab = null; this.pinned = false; this.spareTarget = null;
    this.handlers.clear(); this.listenersInstalled = false;
    this.live.running = false;
    if (this.proc) { try { this.proc.kill(); } catch (e) {} this.proc = null; }
    this.emitTabs();
  }

  // sessionId: undefined = tab aktif, null = level browser, string = tab tertentu.
  send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error("Browser belum tersambung"));
      const id = ++this.msgId;
      const msg = { id, method, params: params || {} };
      if (sessionId !== null) { const sid = sessionId === undefined ? (this.page() && this.page().sessionId) : sessionId; if (sid) msg.sessionId = sid; }
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); } }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => { const hs = this.handlers.get(method); if (hs) { const i = hs.indexOf(fn); if (i >= 0) hs.splice(i, 1); } };
  }
  pageBySession(sid) { for (const p of this.pages.values()) if (p.sessionId === sid) return p; return null; }

  // ---- Tab -----------------------------------------------------------------
  // Setiap tab adalah window headless sendiri: tab di window yang sama saling menyembunyikan
  // (visibilityState hidden, tanpa frame), padahal tab agent dan tab pengguna harus hidup bersamaan.
  async newTab(url, owner) {
    owner = owner === "user" ? "user" : "agent";
    if (this.pages.size >= MAX_TABS) throw new Error("Maksimal " + MAX_TABS + " tab; tutup tab lain dulu (browser_tabs close)");
    let targetId = this.spareTarget; this.spareTarget = null;
    if (!targetId) {
      const vp = this.emulation.viewport;
      const t = await this.send("Target.createTarget", { url: "about:blank", newWindow: true, width: vp.width, height: vp.height }, null);
      targetId = t.targetId;
    }
    const page = await this.attachPage(targetId, true, owner);
    if (url && url !== "about:blank") await this.send("Page.navigate", { url }, page.sessionId).catch(() => {});
    return page;
  }
  async attachPage(targetId, activate, owner) {
    const a = await this.send("Target.attachToTarget", { targetId, flatten: true }, null);
    const page = { id: ++this.pageSeq, targetId, sessionId: a.sessionId, owner: owner === "user" ? "user" : "agent", url: "about:blank", title: "", console: [], network: [], requests: new Map(), crashed: false };
    this.pages.set(page.id, page);
    if (!this.listenersInstalled) { this.listenersInstalled = true; this.installListeners(); }
    const sid = page.sessionId;
    await this.send("Page.enable", {}, sid); await this.send("Runtime.enable", {}, sid);
    await this.send("Network.enable", { maxTotalBufferSize: 10 * 1024 * 1024 }, sid);
    await this.send("Log.enable", {}, sid).catch(() => {});
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true }, sid).catch(() => {});
    await this.send("Inspector.enable", {}, sid).catch(() => {});
    await this.applyEmulation(sid, page.owner);
    if (this.blockTrackers) await this.send("Network.setBlockedURLs", { urls: TRACKER_BLOCKLIST }, sid).catch(() => {});
    if (activate && page.owner === "agent") await this.activate(page.id);
    else if (activate) await this.setView(page.id, true); // tab pengguna: langsung ditampilkan & dipin
    else this.emitTabs();
    return page;
  }
  // Tab kerja agent. Tampilan live mengikuti agent kecuali pengguna sedang memilih tab lain (pinned).
  async activate(id) {
    const p = this.pages.get(id); if (!p) throw new Error("Tab #" + id + " tidak ada");
    if (p.owner !== "agent") throw new Error("Tab #" + id + " milik pengguna — agent hanya mengendalikan tab miliknya sendiri (buka tab baru dengan browser_tabs new)");
    this.active = id;
    if (!this.pinned || !this.pages.has(this.viewTab)) await this.setView(id, false);
    else this.emitTabs();
    return p;
  }
  // Tab yang tampil di panel Browser agent (screencast + input ambil alih).
  async setView(id, pinned) {
    const p = this.pages.get(id); if (!p) return;
    const prev = this.viewTab; this.viewTab = id; this.pinned = !!pinned;
    if (this.live.running && prev !== id) { await this.stopScreencast(prev).catch(() => {}); this.live.running = false; }
    // Ada penonton (tab Browser agent terbuka) → screencast harus jalan di tab tampilan, termasuk saat browser baru diluncurkan.
    if (this.live.watchers > 0 && !this.live.running) await this.startScreencast().catch(() => {});
    this.emitTabs();
  }
  // by: "agent" hanya boleh menutup tab agent; pengguna boleh menutup tab mana pun.
  async closeTab(id, by) {
    const p = this.pages.get(id); if (!p) return;
    if (by === "agent" && p.owner !== "agent") throw new Error("Tab #" + id + " milik pengguna, tidak bisa ditutup agent");
    await this.send("Target.closeTarget", { targetId: p.targetId }, null).catch(() => {});
    await this.dropPage(id);
  }
  // Lepas tab dari daftar (ditutup kita / menutup dirinya) dan rapikan tab kerja & tampilan.
  async dropPage(id) {
    if (!this.pages.has(id)) return;
    this.pages.delete(id);
    if (this.active === id) { const ag = this.agentTabs(); this.active = ag.length ? ag[ag.length - 1].id : null; } // tab agent baru dibuat lazim saat tool berikutnya (ensure)
    if (this.viewTab === id) {
      if (this.live.running) this.live.running = false;
      const next = this.active || ([...this.pages.keys()].pop() || null);
      if (next) await this.setView(next, next !== this.active); else { this.viewTab = null; this.pinned = false; this.emitTabs(); }
    } else this.emitTabs();
  }

  installListeners() {
    const push = (arr, item) => { arr.push(item); if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG); };
    const pg = (sid) => this.pageBySession(sid);
    this.on("Runtime.consoleAPICalled", (p, sid) => {
      const page = pg(sid); if (!page) return;
      const text = (p.args || []).map((a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description || a.type)).join(" ");
      push(page.console, { t: Date.now(), level: p.type || "log", text: String(text).slice(0, 2000) });
    });
    this.on("Runtime.exceptionThrown", (p, sid) => {
      const page = pg(sid); if (!page) return; const d = p.exceptionDetails || {};
      push(page.console, { t: Date.now(), level: "error", text: String(d.text || "") + " " + String((d.exception && d.exception.description) || "").slice(0, 1500) });
    });
    this.on("Log.entryAdded", (p, sid) => { const page = pg(sid); if (!page) return; const e = p.entry || {}; push(page.console, { t: Date.now(), level: e.level || "log", text: "[" + (e.source || "log") + "] " + String(e.text || "").slice(0, 1500) + (e.url ? " (" + e.url + ")" : "") }); });
    this.on("Network.requestWillBeSent", (p, sid) => {
      const page = pg(sid); if (!page) return;
      const r = { id: p.requestId, t: Date.now(), method: p.request.method, url: String(p.request.url).slice(0, 500), type: p.type || "", status: null, mime: "", size: 0, failed: "" };
      page.requests.set(p.requestId, r); push(page.network, r);
    });
    this.on("Network.responseReceived", (p, sid) => { const page = pg(sid); const r = page && page.requests.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType || ""; } });
    this.on("Network.loadingFinished", (p, sid) => { const page = pg(sid); const r = page && page.requests.get(p.requestId); if (r) { r.size = p.encodedDataLength || 0; page.requests.delete(p.requestId); } });
    this.on("Network.loadingFailed", (p, sid) => { const page = pg(sid); const r = page && page.requests.get(p.requestId); if (r) { r.failed = p.errorText || "failed"; page.requests.delete(p.requestId); } });
    this.on("Page.javascriptDialogOpening", (p, sid) => {
      this.dialogs.push({ t: Date.now(), type: p.type, message: p.message });
      this.send("Page.handleJavaScriptDialog", { accept: true, promptText: p.defaultPrompt || "" }, sid).catch(() => {});
    });
    this.on("Page.frameNavigated", (p, sid) => {
      const page = pg(sid); if (!page || !p.frame || p.frame.parentId) return;
      page.url = p.frame.url || page.url; page.frameId = p.frame.id;
      this.emitTabs();
      // Navigasi history/bfcache tidak memicu load: segarkan judul sesaat kemudian.
      const t = setTimeout(() => this.refreshTitle(page), 600); if (t.unref) t.unref();
    });
    this.on("Inspector.targetCrashed", (p, sid) => { const page = pg(sid); if (page) page.crashed = true; });
    // Judul tab untuk strip tab di IDE (frameNavigated hanya membawa URL).
    this.on("Page.loadEventFired", (p, sid) => { const page = pg(sid); if (page) this.refreshTitle(page); });
    this.on("Page.screencastFrame", (p, sid) => {
      this.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
      const page = pg(sid); if (!page || page.id !== this.viewTab) return;
      const meta = p.metadata || {};
      this.pushFrame({ data: p.data, w: meta.deviceWidth, h: meta.deviceHeight, url: page.url, title: page.title, tab: page.id, owner: page.owner, t: Date.now() });
    });
    // Popup / target=_blank: jadi tab baru dengan pemilik yang sama dengan tab pembukanya.
    this.on("Target.targetCreated", (p) => {
      const info = p.targetInfo || {};
      if (info.type !== "page" || !info.openerId) return;
      if ([...this.pages.values()].some((x) => x.targetId === info.targetId)) return;
      const opener = [...this.pages.values()].find((x) => x.targetId === info.openerId);
      this.attachPage(info.targetId, true, opener ? opener.owner : "agent").catch(() => {});
    });
    this.on("Target.targetDestroyed", (p) => {
      if (this.spareTarget === p.targetId) this.spareTarget = null;
      for (const [id, page] of this.pages) if (page.targetId === p.targetId) this.dropPage(id).catch(() => {});
    });
    // URL/judul dari level browser: akurat juga untuk popup yang bernavigasi sebelum kita attach.
    this.on("Target.targetInfoChanged", (p) => {
      const info = p.targetInfo || {}; if (info.type !== "page") return;
      const page = [...this.pages.values()].find((x) => x.targetId === info.targetId); if (!page) return;
      const url = info.url || page.url, title = info.title && info.title !== info.url ? info.title : page.title;
      if (url !== page.url || title !== page.title) { page.url = url; page.title = title; this.emitTabs(); }
    });
    this.on("Browser.downloadWillBegin", (p) => { const d = this.downloads.get(p.guid) || {}; d.suggested = p.suggestedFilename; d.url = p.url; d.state = "inProgress"; this.downloads.set(p.guid, d); });
    this.on("Browser.downloadProgress", (p) => {
      const d = this.downloads.get(p.guid) || {}; d.state = p.state; d.received = p.receivedBytes; d.total = p.totalBytes; this.downloads.set(p.guid, d);
      if (p.state !== "inProgress" && d.resolve) d.resolve(d);
    });
  }

  refreshTitle(page) {
    if (!page || !this.pages.has(page.id)) return;
    this.evaluate("document.title", false, page.sessionId)
      .then((t) => { t = String(t || ""); if (t !== page.title) { page.title = t; this.emitTabs(); } })
      .catch(() => {});
  }

  async setupDownloads() {
    this.downloadDir = path.join(this.dataDir, "browser-downloads");
    fs.mkdirSync(this.downloadDir, { recursive: true });
    await this.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloadDir, eventsEnabled: true }, null).catch(() => {});
  }

  // Emulasi (device/locale/timezone) hanya untuk tab agent; tab pengguna selalu desktop standar.
  async applyEmulation(sid, owner) {
    const em = owner === "user" ? { viewport: Object.assign({}, DEFAULT_VIEWPORT) } : this.emulation;
    const vp = em.viewport;
    const page = this.pageBySession(sid); if (page) page.viewport = Object.assign({}, vp);
    await this.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor || 1, mobile: !!vp.mobile }, sid);
    if (vp.mobile) await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sid).catch(() => {});
    else await this.send("Emulation.setTouchEmulationEnabled", { enabled: false }, sid).catch(() => {});
    if (em.userAgent || em.locale) await this.send("Network.setUserAgentOverride", Object.assign({ userAgent: em.userAgent || (await this.send("Browser.getVersion", {}, null)).userAgent.replace("HeadlessChrome", "Chrome") }, em.locale ? { acceptLanguage: em.locale } : {}), sid).catch(() => {});
    else { try { const v = await this.send("Browser.getVersion", {}, null); await this.send("Network.setUserAgentOverride", { userAgent: String(v.userAgent || "").replace("HeadlessChrome", "Chrome") }, sid); } catch (e) {} }
    if (em.timezone) await this.send("Emulation.setTimezoneOverride", { timezoneId: em.timezone }, sid).catch(() => {});
    if (em.locale) await this.send("Emulation.setLocaleOverride", { locale: em.locale.split(",")[0] }, sid).catch(() => {});
    if (em.colorScheme) await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: em.colorScheme }] }, sid).catch(() => {});
    if (em.offline != null) await this.send("Network.emulateNetworkConditions", { offline: !!em.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sid).catch(() => {});
  }

  touch() {
    this.lastUsed = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (Date.now() - this.lastUsed >= IDLE_CLOSE_MS && !this.live.watchers && !this.handoff) this.close(); }, IDLE_CLOSE_MS + 1000);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async close() {
    clearTimeout(this.idleTimer);
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) await Promise.race([this.send("Browser.close", {}, null).catch(() => {}), sleep(1500)]);
    } catch (e) {}
    this.cleanupConnection();
  }

  // ---- Live view (screencast) & take-over ---------------------------------------
  async watch(delta) {
    this.live.watchers = Math.max(0, this.live.watchers + delta);
    if (this.live.watchers > 0 && !this.live.running && this.viewPage()) await this.startScreencast().catch(() => {});
    if (this.live.watchers === 0 && this.live.running) await this.stopScreencast().catch(() => {});
    if (this.live.watchers > 0) this.touch();
  }
  // Screencast selalu di tab tampilan (viewTab), bukan tab kerja agent.
  async startScreencast() {
    const page = this.viewPage(); if (!page || !this.browserAlive()) return;
    const vp = page.viewport || this.emulation.viewport;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: Math.round(vp.width * (vp.deviceScaleFactor || 1)), maxHeight: Math.round(vp.height * (vp.deviceScaleFactor || 1)), everyNthFrame: 1 }, page.sessionId);
    this.live.running = true;
    // Halaman statis tidak menghasilkan frame sampai ada perubahan: kirim screenshot sebagai frame pertama.
    const startedAt = Date.now();
    const t = setTimeout(() => { if (this.live.running && (!this.live.lastFrame || this.live.lastFrame.t < startedAt)) this.snapshotFrame().catch(() => {}); }, 400);
    if (t.unref) t.unref();
  }
  async stopScreencast(tabId) {
    const p = tabId ? this.pages.get(tabId) : this.viewPage();
    if (p) await this.send("Page.stopScreencast", {}, p.sessionId).catch(() => {});
    if (!tabId || tabId === this.viewTab) this.live.running = false;
  }
  // Frame dari screenshot biasa (fallback awal / setelah aksi tanpa repaint).
  async snapshotFrame() {
    const page = this.viewPage(); if (!page) return;
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 55 }, page.sessionId);
    const vp = page.viewport || this.emulation.viewport;
    this.pushFrame({ data: r.data, w: vp.width, h: vp.height, url: page.url, title: page.title, tab: page.id, owner: page.owner, t: Date.now() });
  }
  // Batasi laju ke penonton (~8 fps, frame terakhir selalu terkirim); ack tetap per frame.
  pushFrame(frame) {
    this.live.lastFrame = frame;
    const now = Date.now(); const gap = now - (this.live.sentAt || 0);
    if (gap >= LIVE_MIN_INTERVAL_MS) { this.live.sentAt = now; clearTimeout(this.live.trail); this.live.trail = null; this.emit("frame", frame); }
    else if (!this.live.trail) this.live.trail = setTimeout(() => { this.live.trail = null; this.live.sentAt = Date.now(); this.emit("frame", this.live.lastFrame); }, LIVE_MIN_INTERVAL_MS - gap);
  }
  // Input dari pengguna di panel Browser agent (koordinat dalam CSS px viewport).
  // Semua dikenakan ke tab TAMPILAN (viewTab): tab milik pengguna, atau tab agent bila pengguna
  // sengaja membantu (hand-off). Tab kerja agent tidak pernah berpindah karena aksi pengguna.
  async userInput(ev) {
    this.touch();
    if (ev.kind === "tab") {
      if (ev.action === "switch" && ev.id) { const p = this.pages.get(Number(ev.id)); if (p) await this.setView(p.id, p.id !== this.active); }
      else if (ev.action === "close" && ev.id) await this.closeTab(Number(ev.id), "user");
      else if (ev.action === "new") { await this.ensureBrowser(); await this.newTab(ev.url || "about:blank", "user"); }
      return;
    }
    if (!this.viewPage()) {
      // Belum ada tab yang tampil (browser mati / kosong): pengguna dapat tab miliknya sendiri.
      await this.ensureBrowser();
      if (this.viewPage() == null) await this.newTab("about:blank", "user");
    }
    const sid = this.viewPage().sessionId;
    if (ev.kind === "mouse") {
      const type = ev.type === "down" ? "mousePressed" : ev.type === "up" ? "mouseReleased" : ev.type === "wheel" ? "mouseWheel" : "mouseMoved";
      const params = { type, x: Number(ev.x) || 0, y: Number(ev.y) || 0, button: ev.button || "left", clickCount: Number(ev.clickCount) || 1, modifiers: Number(ev.modifiers) || 0 };
      if (type === "mouseWheel") { params.deltaX = Number(ev.deltaX) || 0; params.deltaY = Number(ev.deltaY) || 0; params.button = "none"; }
      if (type === "mouseMoved") params.button = ev.buttons ? "left" : "none";
      await this.send("Input.dispatchMouseEvent", params, sid);
    } else if (ev.kind === "key") {
      let text = ev.text || ""; if (!text && ev.key === "Enter") text = "\r"; if (!text && ev.key === "Tab") text = "\t";
      const p = { type: ev.type === "up" ? "keyUp" : (text ? "keyDown" : "rawKeyDown"), key: ev.key, code: ev.code, windowsVirtualKeyCode: Number(ev.keyCode) || 0, nativeVirtualKeyCode: Number(ev.keyCode) || 0, modifiers: Number(ev.modifiers) || 0 };
      if (text && ev.type !== "up") { p.text = text; p.unmodifiedText = text; }
      await this.send("Input.dispatchKeyEvent", p, sid);
    } else if (ev.kind === "text") {
      await this.send("Input.insertText", { text: String(ev.text || "") }, sid);
    } else if (ev.kind === "nav") {
      if (ev.action === "back" || ev.action === "forward") {
        const h = await this.send("Page.getNavigationHistory", {}, sid);
        const idx = h.currentIndex + (ev.action === "back" ? -1 : 1);
        if (h.entries[idx]) await this.send("Page.navigateToHistoryEntry", { entryId: h.entries[idx].id }, sid);
      } else if (ev.action === "reload") await this.send("Page.reload", {}, sid);
      else if (ev.url) { let url = String(ev.url).trim(); if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url; await this.send("Page.navigate", { url }, sid); }
    }
    // Aksi yang tidak memicu repaint (halaman statis) tetap terlihat: cek frame sesaat kemudian.
    if (this.live.running && (ev.kind !== "mouse" || ev.type === "up")) {
      const at = Date.now();
      const t = setTimeout(() => { if (this.live.running && (!this.live.lastFrame || this.live.lastFrame.t < at)) this.snapshotFrame().catch(() => {}); }, 300);
      if (t.unref) t.unref();
    }
  }
  // Agent minta bantuan pengguna (login/CAPTCHA); selesai saat pengguna menekan "kembalikan".
  requestUser(message, timeoutMs) {
    if (this.handoff) this.finishHandoff("superseded");
    // Tampilkan tab agent (bukan tab pengguna) supaya bantuan terjadi di halaman yang benar.
    if (this.active && this.viewTab !== this.active) this.setView(this.active, false).catch(() => {});
    return new Promise((resolve) => {
      const h = { message: String(message || "Agent membutuhkan bantuan Anda di browser."), since: Date.now(), resolve };
      this.handoff = h;
      this.emit("handoff", { message: h.message, since: h.since, tab: this.active });
      const t = setTimeout(() => { if (this.handoff === h) this.finishHandoff("timeout"); }, timeoutMs || 10 * 60 * 1000); if (t.unref) t.unref();
    });
  }
  finishHandoff(why) {
    if (!this.handoff) return false;
    const h = this.handoff; this.handoff = null; h.resolve(why || "done");
    this.emit("handoff", null);
    return true;
  }

  // ---- Utilitas halaman ------------------------------------------------------
  async evaluate(expression, awaitPromise, sid) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: !!awaitPromise }, sid);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "Evaluasi gagal");
    return r.result ? r.result.value : undefined;
  }
  async state() {
    try {
      const st = await this.evaluate("({ url: location.href, title: document.title })");
      const p = this.page();
      if (p && (p.url !== st.url || p.title !== st.title)) { p.url = st.url; p.title = st.title; this.emitTabs(); }
      return st;
    } catch (e) { return { url: "", title: "" }; }
  }
  async wall() { try { return await this.evaluate(WALL_JS + "()"); } catch (e) { return ""; } }
  async settle(ms) {
    const page = this.page(); const start = Date.now(); const limit = Math.max(200, Math.min(15000, ms || 1500));
    while (Date.now() - start < limit) {
      await sleep(150);
      if (page && page.requests.size === 0 && Date.now() - start >= 300) break;
    }
  }
  async networkIdle(idleMs, timeoutMs) {
    const page = this.page(); const start = Date.now(); let quietSince = null;
    while (Date.now() - start < (timeoutMs || 15000)) {
      await sleep(100);
      if (page && page.requests.size === 0) { if (!quietSince) quietSince = Date.now(); if (Date.now() - quietSince >= (idleMs || 500)) return true; }
      else quietSince = null;
    }
    return false;
  }
  // Selesai saat load event (atau untuk navigasi history/bfcache: frameNavigated), habis waktu → lanjut.
  waitLoad(timeoutMs, softMs) {
    return new Promise((resolve) => {
      let done = false; const offs = []; const sid = this.page() && this.page().sessionId;
      const finish = () => { if (done) return; done = true; offs.forEach((f) => f()); resolve(); };
      const timer = setTimeout(finish, timeoutMs || 15000);
      let soft = null;
      const mine = (s) => !sid || s === sid;
      offs.push(this.on("Page.loadEventFired", (p, s) => { if (!mine(s)) return; clearTimeout(timer); clearTimeout(soft); setTimeout(finish, 250); }));
      const softHit = () => { clearTimeout(soft); soft = setTimeout(finish, softMs || 1200); };
      offs.push(this.on("Page.frameNavigated", (p, s) => { if (mine(s) && p.frame && !p.frame.parentId) softHit(); }));
      offs.push(this.on("Page.navigatedWithinDocument", (p, s) => { if (mine(s)) softHit(); }));
      // Halaman yang tidak pernah memicu `load` (long-polling, data:) — cukup DOM siap + jaringan tenang.
      offs.push(this.on("Page.lifecycleEvent", (p, s) => {
        const page = this.pageBySession(s);
        if (!mine(s) || !p || !page || (page.frameId && p.frameId && p.frameId !== page.frameId)) return; // hanya frame utama
        if (p.name === "networkIdle") { clearTimeout(timer); clearTimeout(soft); setTimeout(finish, 300); }
        else if (p.name === "DOMContentLoaded") softHit();
      }));
    });
  }
  async navigate(url, timeoutMs) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = this.waitLoad(timeoutMs || 20000);
      const nav = await this.send("Page.navigate", { url });
      if (nav.errorText) {
        lastErr = new Error(nav.errorText + " (" + url + ")");
        if (/ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/.test(nav.errorText) && attempt === 0) { await sleep(1000); continue; }
        throw lastErr;
      }
      await loaded; await this.settle(2000);
      return;
    }
    throw lastErr || new Error("Navigasi gagal");
  }
  async screenshot(opts) {
    opts = opts || {};
    const params = { format: "jpeg", quality: opts.quality || 60 };
    if (opts.fullPage) {
      const m = await this.send("Page.getLayoutMetrics");
      const cs = m.cssContentSize || m.contentSize || this.emulation.viewport;
      params.clip = { x: 0, y: 0, width: Math.min(cs.width, 1600), height: Math.min(cs.height, 6000), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (opts.clip) {
      params.clip = Object.assign({ scale: 1 }, opts.clip);
    }
    let data = "";
    try {
      const r = await this.send("Page.captureScreenshot", params);
      data = r.data || "";
    } catch (e1) { data = ""; }
    if (!data) {
      // Halaman baru kadang belum siap dilukis. Coba sekali lagi tanpa clip.
      await sleep(400);
      const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 50 });
      data = r.data || "";
    }
    // Perkecil bila terlalu besar. Gagal mengecilkan tidak boleh membuang gambar yang sudah ada.
    if (data && data.length * 0.75 > SHOT_MAX_BYTES && !opts.clip && !opts.fullPage) {
      try {
        const vp = this.emulation.viewport || DEFAULT_VIEWPORT;
        const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 40, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 } });
        if (r.data) data = r.data;
      } catch (e2) {}
    }
    if (!data) throw new Error("Screenshot kosong");
    return data;
  }

  // Catat langkah (+ simpan screenshot) untuk kartu chat, tampilan live, dan model.
  async record(action, args, callId, withShot, shotOpts) {
    const st = await this.state();
    const step = { n: ++this.stepSeq, t: Date.now(), action, args: compactArgs(args), url: st.url, title: st.title, shot: null, tab: this.active, tabs: this.agentTabs().length };
    // ID unik lintas restart server: URL screenshot di-cache "immutable" oleh browser klien.
    step.shotId = step.n + "-" + step.t.toString(36);
    let data = "";
    if (withShot) {
      try {
        data = await this.screenshot(shotOpts || {});
        if (data) { fs.mkdirSync(this.shotDir, { recursive: true }); fs.writeFileSync(path.join(this.shotDir, step.shotId + ".jpg"), Buffer.from(data, "base64")); step.shot = "/api/ai/browser/shot/" + step.shotId; }
      } catch (e) { step.shotError = e.message; }
    }
    if (/^(navigate|click|type|press_key|back|wait|submit)$/.test(action)) { const w = await this.wall(); if (w) step.wall = w; }
    this.steps.push(step);
    if (this.steps.length > MAX_SHOTS) { const old = this.steps.splice(0, this.steps.length - MAX_SHOTS); old.forEach((s) => { try { fs.unlinkSync(path.join(this.shotDir, s.shotId + ".jpg")); } catch (e) {} }); }
    if (callId) this.stepByCall.set(String(callId), step);
    this.lastStep = step;
    if (this.onStep) { try { this.onStep(step); } catch (e) {} }
    // cardOnly: gambar untuk kartu chat saja, tidak dikirim ke model (langkah teks seperti extract).
    const forModel = shotOpts && shotOpts.cardOnly ? "" : data;
    // Penonton live yang sedang melihat tab agent: halaman statis tidak memicu frame screencast,
    // pakai screenshot langkah ini. Bila pengguna melihat tabnya sendiri, jangan ganggu.
    if (this.live.running && this.viewTab === this.active && !(shotOpts && shotOpts.clip)) {
      if (data && !(shotOpts && shotOpts.fullPage)) { const vp = this.emulation.viewport; this.pushFrame({ data, w: vp.width, h: vp.height, url: st.url, title: st.title, tab: this.active, owner: "agent", t: Date.now() }); }
      else this.snapshotFrame().catch(() => {});
    }
    return { step, data: forModel };
  }
  stepFor(callId) { return (callId && this.stepByCall.get(String(callId))) || null; }
  shotPath(id) { id = String(id || ""); if (!/^\d+(-[a-z0-9]+)?$/.test(id)) return null; return path.join(this.shotDir, id + ".jpg"); }
  // Path di workspace (relatif) → absolut, ditolak bila keluar workspace.
  wsPath(rel) {
    if (!this.workspace) throw new Error("Workspace tidak dikonfigurasi");
    const abs = path.resolve(this.workspace, String(rel || "").replace(/^[\\/]+/, ""));
    if (abs !== this.workspace && !abs.startsWith(this.workspace + path.sep)) throw new Error("Path di luar workspace: " + rel);
    return abs;
  }

  // ---- Aksi ---------------------------------------------------------------
  async locate(a) {
    const ref = a.ref || a.element || ""; const selector = a.selector || ""; const text = a.text_match || a.label || a.textMatch || "";
    if (!ref && !selector && !text && !(typeof a.x === "number" && typeof a.y === "number")) throw new Error("Sebutkan ref (dari browser_snapshot), selector CSS, atau text_match");
    if (typeof a.x === "number" && typeof a.y === "number") return { x: a.x, y: a.y, desc: "(" + a.x + "," + a.y + ")", editable: true };
    const r = await this.evaluate(LOCATE_JS + "(" + JSON.stringify(String(ref)) + "," + JSON.stringify(String(selector)) + "," + JSON.stringify(String(text)) + ")");
    if (!r) throw new Error("Elemen tidak ditemukan: " + (ref || selector || text) + ". Jalankan browser_snapshot untuk melihat ref yang tersedia.");
    return r;
  }
  async mouseClick(x, y, opts) {
    opts = opts || {};
    const button = opts.button || "left"; const clickCount = opts.double ? 2 : 1;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
  }
  async keyPress(key) {
    const map = { Enter: [13, "\r", "Enter"], Tab: [9, "\t", "Tab"], Escape: [27, "", "Escape"], Backspace: [8, "", "Backspace"], Delete: [46, "", "Delete"],
      ArrowDown: [40, "", "ArrowDown"], ArrowUp: [38, "", "ArrowUp"], ArrowLeft: [37, "", "ArrowLeft"], ArrowRight: [39, "", "ArrowRight"],
      Home: [36, "", "Home"], End: [35, "", "End"], PageDown: [34, "", "PageDown"], PageUp: [33, "", "PageUp"], Space: [32, " ", "Space"] };
    const k = map[key] || (key.length === 1 ? [key.toUpperCase().charCodeAt(0), key, "Key" + key.toUpperCase()] : null);
    if (!k) throw new Error("Tombol tidak dikenal: " + key);
    const base = { key: key === "Space" ? " " : key, code: k[2], windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0] };
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: k[1] ? "keyDown" : "rawKeyDown", text: k[1] || undefined, unmodifiedText: k[1] || undefined }, base));
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
  }
  async clearField() {
    await this.evaluate("(function(){var e=document.activeElement; if(!e) return; if(e.isContentEditable){document.execCommand('selectAll');} else if('value' in e){e.select&&e.select();}})()");
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }).catch(() => {});
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }).catch(() => {});
  }

  // ---- Unduh Chrome for Testing (fallback bila tidak ada browser terpasang) ------
  installChromium() {
    if (this.install && this.install.stage && !this.install.error && this.install.stage !== "done") return Promise.resolve(this.install);
    const platform = IS_WINDOWS ? (process.arch === "ia32" ? "win32" : "win64") : process.platform === "darwin" ? (process.arch === "arm64" ? "mac-arm64" : "mac-x64") : "linux64";
    const set = (stage, percent, extra) => { this.install = Object.assign({ stage, percent: percent == null ? null : Math.round(percent), platform }, extra || {}); this.emit("install", this.install); };
    const root = path.join(this.dataDir, "browser");
    return (async () => {
      set("metadata", null);
      const meta = await fetchJson("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json");
      const ch = meta.channels && meta.channels.Stable; const dl = ch && ch.downloads && ch.downloads.chrome && ch.downloads.chrome.find((d) => d.platform === platform);
      if (!dl) throw new Error("Tidak ada build Chrome for Testing untuk platform " + platform);
      fs.mkdirSync(root, { recursive: true });
      const zip = path.join(root, "chrome-" + platform + ".zip");
      set("download", 0, { version: ch.version });
      await downloadFile(dl.url, zip, (pct) => set("download", pct, { version: ch.version }));
      set("extract", null, { version: ch.version });
      // Windows: tar bawaan (bsdtar) bisa membaca zip; Linux/macOS: unzip.
      const r = IS_WINDOWS ? spawnSync("tar", ["-xf", zip, "-C", root], { stdio: "ignore", windowsHide: true, timeout: 10 * 60 * 1000 })
        : spawnSync("unzip", ["-oq", zip, "-d", root], { stdio: "ignore", timeout: 10 * 60 * 1000 });
      if (r.status !== 0) throw new Error("Ekstrak gagal (" + (IS_WINDOWS ? "tar" : "unzip") + " status " + r.status + ")");
      try { fs.unlinkSync(zip); } catch (e) {}
      const exe = downloadedBrowser(this.dataDir);
      if (!exe) throw new Error("Executable tidak ditemukan setelah ekstrak");
      if (!IS_WINDOWS) { try { fs.chmodSync(exe, 0o755); } catch (e) {} }
      this.exe = exe; this.version = "";
      set("done", 100, { version: ch.version, exe });
      return this.install;
    })().catch((e) => { set("error", null, { error: e.message }); throw e; });
  }

  // ---- Definisi tool untuk SDK (customTools) ----------------------------------
  tools() {
    const self = this;
    const img = (data) => ({ type: "image", data, mimeType: "image/jpeg" });
    const text = (t) => ({ type: "text", text: t });
    const result = (summary, rec, extraText) => {
      let s = summary;
      if (rec && rec.step && rec.step.wall) s += "\n\u26a0 Terdeteksi " + (rec.step.wall === "captcha" ? "CAPTCHA / verifikasi manusia" : "halaman login") + ". Gunakan browser_request_user agar pengguna menyelesaikannya lewat tab Browser agent (Ambil alih), lalu lanjutkan.";
      if (extraText) s += "\n" + extraText;
      const content = [text(s)];
      if (rec && rec.data) content.push(img(rec.data));
      return { content, structuredContent: rec && rec.step ? { step: rec.step.n, url: rec.step.url, title: rec.step.title, shot: rec.step.shot, tab: rec.step.tab } : undefined };
    };
    const run = (name, fn) => (args, ctx) => self.serial(async () => {
      args = args || {};
      const callId = ctx && ctx.toolCallId;
      if (++self.runSteps > MAX_STEPS_PER_RUN) return { content: [text("Error " + name + ": batas " + MAX_STEPS_PER_RUN + " langkah browser per run tercapai. Rangkum hasil sejauh ini atau minta pengguna melanjutkan.")], isError: true };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await self.ensure(); return await fn(args, callId); }
        catch (e) {
          const msg = (e && e.message) || String(e);
          // Tab agent mati/ditutup di tengah jalan: ganti tabnya saja (tab pengguna tetap hidup).
          // Browser/koneksi mati: luncurkan ulang sekali lalu ulangi aksi.
          if (attempt === 0 && (/terputus|belum tersambung|Session with given id not found|Target closed|Inspector\.detached|crashed/i.test(msg) || (self.page() && self.page().crashed))) {
            const p = self.page();
            if (!self.browserAlive()) self.cleanupConnection();
            else if (p && (p.crashed || /Session with given id not found|Target closed|Inspector\.detached/i.test(msg))) {
              await self.send("Target.closeTarget", { targetId: p.targetId }, null).catch(() => {});
              await self.dropPage(p.id).catch(() => {});
            }
            continue; // ensure() di putaran berikutnya membuat tab agent baru / meluncurkan ulang
          }
          await self.record(name.replace(/^browser_/, ""), args, callId, true, { cardOnly: true }).catch(() => {});
          return { content: [text("Error " + name + ": " + msg)], isError: true };
        }
      }
    });
    const shotOpt = { type: "boolean", description: "Include a viewport screenshot in the result (default true)" };
    const target = { ref: { type: "string", description: "Ref from browser_snapshot, e.g. e3" }, selector: { type: "string", description: "CSS selector" }, text_match: { type: "string", description: "Button/link/label text" } };
    // Agent hanya tahu tab miliknya; tab pengguna tidak pernah muncul di hasil tool.
    const agentCount = () => self.agentTabs().length;
    const stateLine = (st) => "URL: " + st.url + "\nJudul: " + (st.title || "(tanpa judul)") + (agentCount() > 1 ? "\nTab: #" + self.active + " dari " + agentCount() : "");
    const secretNames = () => (self.secrets ? self.secrets.list() : []);
    // Petunjuk selector untuk ekspor Playwright (disimpan di args langkah).
    const pwHint = (loc) => (loc ? { sel: loc.sel || "", text: loc.txt || "" } : undefined);
    return {
      browser_navigate: {
        description: Instructions.tool("browser_navigate"),
        inputSchema: { type: "object", properties: { url: { type: "string", description: "Full URL (http/https); https:// is added when the scheme is missing" }, new_tab: { type: "boolean", description: "Open in a new tab" }, screenshot: shotOpt }, required: ["url"] },
        annotations: { title: "Browser: navigate", openWorldHint: true },
        execute: run("browser_navigate", async (a, callId) => {
          let url = String(a.url || "").trim(); if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
          if (a.new_tab) await self.newTab("about:blank", "agent");
          await self.navigate(url);
          const rec = await self.record("navigate", a, callId, a.screenshot !== false);
          return result(stateLine(rec.step), rec);
        }),
      },
      browser_tabs: {
        description: Instructions.tool("browser_tabs"),
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "new", "switch", "close"] }, id: { type: "number" }, url: { type: "string" } }, required: ["action"] },
        annotations: { title: "Browser: tabs" },
        execute: run("browser_tabs", async (a, callId) => {
          if (a.action === "new") { await self.newTab("about:blank", "agent"); if (a.url) { let u = String(a.url); if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u; await self.navigate(u); } }
          else if (a.action === "switch") await self.activate(Number(a.id));
          else if (a.action === "close") { await self.closeTab(Number(a.id) || self.active, "agent"); await self.ensure(); }
          await self.state();
          const rec = await self.record("tabs", a, callId, a.action !== "list" && a.action !== "close");
          const mine = self.tabList().filter((t) => t.owner === "agent");
          const list = mine.map((t) => (t.active ? "* " : "  ") + "#" + t.id + " " + (t.title || "(tanpa judul)") + " — " + t.url).join("\n");
          const others = self.pages.size - mine.length;
          return result("Tab agent (" + mine.length + "):\n" + list + (others ? "\n(+" + others + " tab milik pengguna, tidak dikendalikan agent)" : ""), rec);
        }),
      },
      browser_snapshot: {
        description: Instructions.tool("browser_snapshot"),
        inputSchema: { type: "object", properties: { include_text: { type: "boolean" }, max_elements: { type: "number", description: "Max elements (default 120)" } } },
        annotations: { title: "Browser: snapshot", readOnlyHint: true },
        execute: run("browser_snapshot", async (a, callId) => {
          const snap = await self.evaluate(SNAPSHOT_JS + "(" + (!!a.include_text) + "," + (Number(a.max_elements) || 120) + ")");
          const rec = await self.record("snapshot", a, callId, true, { cardOnly: true });
          let out = stateLine(snap) + "\nElemen (" + snap.count + "):\n" + (snap.outline || "(tidak ada elemen interaktif yang terlihat)");
          if (snap.text) out += "\n\nTeks halaman:\n" + snap.text;
          return result(out, rec);
        }),
      },
      browser_extract: {
        description: Instructions.tool("browser_extract"),
        inputSchema: { type: "object", properties: { selector: { type: "string" }, format: { type: "string", enum: ["markdown", "text", "html", "table", "links"] }, max_chars: { type: "number", description: "Default 12000" } } },
        annotations: { title: "Browser: extract", readOnlyHint: true },
        execute: run("browser_extract", async (a, callId) => {
          const r = await self.evaluate(EXTRACT_JS + "(" + JSON.stringify(String(a.selector || "")) + "," + JSON.stringify(a.format || "markdown") + "," + (Number(a.max_chars) || 12000) + ")");
          if (r && r.error) throw new Error(r.error);
          const rec = await self.record("extract", a, callId, true, { cardOnly: true });
          return result((a.format || "markdown") + (r.truncated ? " (dipotong, " + r.chars + " karakter)" : "") + ":\n" + (r.content || "(kosong)"), rec);
        }),
      },
      browser_click: {
        description: Instructions.tool("browser_click"),
        inputSchema: { type: "object", properties: Object.assign({}, target, { x: { type: "number" }, y: { type: "number" }, double: { type: "boolean" }, button: { type: "string", enum: ["left", "right", "middle"] }, screenshot: shotOpt }) },
        annotations: { title: "Browser: click" },
        execute: run("browser_click", async (a, callId) => {
          const loc = await self.locate(a);
          await self.mouseClick(loc.x, loc.y, { double: !!a.double, button: a.button });
          await self.settle(1500);
          const rec = await self.record("click", Object.assign({}, a, { target: loc.desc, pw: pwHint(loc) }), callId, a.screenshot !== false);
          return result("Diklik: " + loc.desc + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_hover: {
        description: Instructions.tool("browser_hover"),
        inputSchema: { type: "object", properties: Object.assign({}, target, { x: { type: "number" }, y: { type: "number" }, screenshot: shotOpt }) },
        annotations: { title: "Browser: hover" },
        execute: run("browser_hover", async (a, callId) => {
          const loc = await self.locate(a);
          await self.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: loc.x, y: loc.y }); await sleep(400);
          const rec = await self.record("hover", Object.assign({}, a, { target: loc.desc, pw: pwHint(loc) }), callId, a.screenshot !== false);
          return result("Hover: " + loc.desc + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_type: {
        description: Instructions.tool("browser_type"),
        inputSchema: { type: "object", properties: Object.assign({}, target, { text: { type: "string" }, secret: { type: "string", description: "Name of a stored secret (see browser_secrets)" }, clear: { type: "boolean" }, submit: { type: "boolean" }, screenshot: shotOpt }) },
        annotations: { title: "Browser: type" },
        execute: run("browser_type", async (a, callId) => {
          let value = String(a.text || ""); let masked = false;
          if (a.secret) { const v = self.secrets && self.secrets.get(String(a.secret)); if (v == null) throw new Error("Rahasia \"" + a.secret + "\" tidak ada. Tersedia: " + (secretNames().join(", ") || "(kosong)") + ". Pengguna bisa menambahkannya di Setelan AI → Rahasia browser."); value = v; masked = true; }
          if (!value) throw new Error("text kosong");
          const loc = await self.locate(a);
          await self.mouseClick(loc.x, loc.y); await sleep(80);
          if (a.clear !== false) await self.clearField();
          await self.send("Input.insertText", { text: value });
          if (a.submit) { await self.keyPress("Enter"); await self.settle(2000); }
          const shown = masked ? "\u2022\u2022\u2022\u2022\u2022\u2022 (rahasia " + a.secret + ")" : value.slice(0, 200);
          const rec = await self.record("type", Object.assign({}, a, { text: shown, secret: a.secret, target: loc.desc, pw: pwHint(loc) }), callId, a.screenshot !== false && !(masked && loc.type !== "password"));
          return result("Diketik ke " + loc.desc + ": " + shown + (a.submit ? " lalu Enter" : "") + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_select: {
        description: Instructions.tool("browser_select"),
        inputSchema: { type: "object", properties: Object.assign({}, target, { label: { type: "string" }, value: { type: "string" }, index: { type: "number" }, screenshot: shotOpt }) },
        annotations: { title: "Browser: select" },
        execute: run("browser_select", async (a, callId) => {
          const loc = await self.locate(Object.assign({}, a, { label: undefined, text_match: a.text_match }));
          const r = await self.evaluate("(function(ref,label,value,index){var el=document.querySelector('[data-vrc-ref=\"'+ref+'\"]'); if(!el) return {error:'elemen hilang'}; if(el.tagName!=='SELECT') return {error:'bukan <select>: '+el.tagName}; var opts=Array.prototype.slice.call(el.options); var o=null; if(index!=null&&opts[index]) o=opts[index]; if(!o&&value!=null) o=opts.find(function(x){return x.value===value;}); if(!o&&label!=null){var l=String(label).trim().toLowerCase(); o=opts.find(function(x){return x.text.trim().toLowerCase()===l;})||opts.find(function(x){return x.text.trim().toLowerCase().indexOf(l)!==-1;});} if(!o) return {error:'opsi tidak ditemukan; tersedia: '+opts.map(function(x){return x.text.trim();}).slice(0,20).join(' | ')}; el.value=o.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,text:o.text.trim(),value:o.value};})(" + JSON.stringify(loc.ref) + "," + JSON.stringify(a.label == null ? null : String(a.label)) + "," + JSON.stringify(a.value == null ? null : String(a.value)) + "," + (a.index == null ? "null" : Number(a.index)) + ")");
          if (r.error) throw new Error(r.error);
          await self.settle(800);
          const rec = await self.record("select", Object.assign({}, a, { target: loc.desc, chosen: r.text, pw: pwHint(loc) }), callId, a.screenshot !== false);
          return result("Dipilih \"" + r.text + "\" (value=" + r.value + ") di " + loc.desc + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_upload: {
        description: Instructions.tool("browser_upload"),
        inputSchema: { type: "object", properties: Object.assign({}, target, { paths: { type: "array", items: { type: "string" } }, screenshot: shotOpt }), required: ["paths"] },
        annotations: { title: "Browser: upload" },
        execute: run("browser_upload", async (a, callId) => {
          const files = (a.paths || []).map((p) => self.wsPath(p));
          files.forEach((f) => { if (!fs.existsSync(f)) throw new Error("File tidak ada: " + f); });
          const loc = await self.locate(a);
          const doc = await self.send("DOM.getDocument", { depth: 0 });
          const q = await self.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '[data-vrc-ref="' + loc.ref + '"]' });
          if (!q.nodeId) throw new Error("Elemen input file tidak ditemukan");
          await self.send("DOM.setFileInputFiles", { files, nodeId: q.nodeId });
          await self.settle(1500);
          const rec = await self.record("upload", Object.assign({}, a, { target: loc.desc, pw: pwHint(loc) }), callId, a.screenshot !== false);
          return result("Diunggah " + files.length + " file ke " + loc.desc + ": " + files.map((f) => path.basename(f)).join(", ") + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_drag: {
        description: Instructions.tool("browser_drag"),
        inputSchema: { type: "object", properties: { from_ref: { type: "string" }, from_selector: { type: "string" }, from_x: { type: "number" }, from_y: { type: "number" }, to_ref: { type: "string" }, to_selector: { type: "string" }, to_x: { type: "number" }, to_y: { type: "number" }, screenshot: shotOpt } },
        annotations: { title: "Browser: drag" },
        execute: run("browser_drag", async (a, callId) => {
          const from = await self.locate({ ref: a.from_ref, selector: a.from_selector, x: a.from_x, y: a.from_y });
          const to = await self.locate({ ref: a.to_ref, selector: a.to_selector, x: a.to_x, y: a.to_y });
          await self.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
          await self.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
          const stepsN = 8; for (let i = 1; i <= stepsN; i++) { await self.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * i / stepsN, y: from.y + (to.y - from.y) * i / stepsN, button: "left" }); await sleep(30); }
          await self.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
          await self.settle(800);
          const rec = await self.record("drag", Object.assign({}, a, { target: from.desc + " → " + to.desc, pwFrom: pwHint(from), pwTo: pwHint(to) }), callId, a.screenshot !== false);
          return result("Diseret " + from.desc + " → " + to.desc + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_press_key: {
        description: Instructions.tool("browser_press_key"),
        inputSchema: { type: "object", properties: { key: { type: "string" }, screenshot: shotOpt }, required: ["key"] },
        annotations: { title: "Browser: press key" },
        execute: run("browser_press_key", async (a, callId) => {
          await self.keyPress(String(a.key || "Enter")); await self.settle(1000);
          const rec = await self.record("press_key", a, callId, a.screenshot !== false);
          return result("Tombol " + a.key + " ditekan\n" + stateLine(rec.step), rec);
        }),
      },
      browser_scroll: {
        description: Instructions.tool("browser_scroll"),
        inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "top", "bottom"] }, amount: { type: "number" }, ref: { type: "string" }, selector: { type: "string" }, screenshot: shotOpt } },
        annotations: { title: "Browser: scroll" },
        execute: run("browser_scroll", async (a, callId) => {
          let what = "";
          if (a.ref || a.selector) { const loc = await self.locate(a); what = "ke " + loc.desc; }
          else {
            const amt = Number(a.amount) || 600; const dir = a.direction || "down";
            const js = dir === "top" ? "window.scrollTo(0,0)" : dir === "bottom" ? "window.scrollTo(0,document.body.scrollHeight)" : "window.scrollBy(0," + (dir === "up" ? -amt : amt) + ")";
            await self.evaluate(js); what = dir + (dir === "up" || dir === "down" ? " " + amt + "px" : "");
          }
          await sleep(350);
          const rec = await self.record("scroll", a, callId, a.screenshot !== false);
          const pos = await self.evaluate("({y: Math.round(scrollY), max: Math.max(0, document.body.scrollHeight - innerHeight)})").catch(() => ({ y: 0, max: 0 }));
          return result("Digulir " + what + " (posisi " + pos.y + "/" + pos.max + ")\n" + stateLine(rec.step), rec);
        }),
      },
      browser_screenshot: {
        description: Instructions.tool("browser_screenshot"),
        inputSchema: { type: "object", properties: { full_page: { type: "boolean" }, ref: { type: "string" }, selector: { type: "string" }, annotate: { type: "boolean" } } },
        annotations: { title: "Browser: screenshot", readOnlyHint: true },
        execute: run("browser_screenshot", async (a, callId) => {
          let opts = { fullPage: !!a.full_page }; let extra = "";
          if (a.ref || a.selector) {
            const loc = await self.locate(a); const m = await self.send("Page.getLayoutMetrics"); const vv = m.cssVisualViewport || { pageX: 0, pageY: 0 };
            opts = { clip: { x: loc.left + vv.pageX, y: loc.top + vv.pageY, width: Math.max(1, loc.w), height: Math.max(1, loc.h) } }; extra = "Elemen: " + loc.desc;
          }
          if (a.annotate) { await self.evaluate(SNAPSHOT_JS + "(false,150)"); const n = await self.evaluate(ANNOTATE_JS + "(true)"); extra += (extra ? "\n" : "") + n + " elemen diberi label [eN] (ref sama dengan browser_snapshot)"; }
          const rec = await self.record("screenshot", a, callId, true, opts);
          if (a.annotate) await self.evaluate(ANNOTATE_JS + "(false)").catch(() => {});
          return result(stateLine(rec.step) + (extra ? "\n" + extra : ""), rec);
        }),
      },
      browser_console: {
        description: Instructions.tool("browser_console"),
        inputSchema: { type: "object", properties: { level: { type: "string", description: "Filter: error | warning | log | info" }, limit: { type: "number" }, clear: { type: "boolean" } } },
        annotations: { title: "Browser: console", readOnlyHint: true },
        execute: run("browser_console", async (a, callId) => {
          const page = self.page(); let list = page ? page.console.slice() : [];
          if (a.level) list = list.filter((x) => x.level === a.level || (a.level === "warning" && x.level === "warn"));
          list = list.slice(-(Number(a.limit) || 100));
          if (a.clear && page) page.console = [];
          const rec = await self.record("console", a, callId, false);
          const out = list.length ? list.map((x) => "[" + x.level + "] " + x.text).join("\n") : "(console kosong)";
          return result("Console (" + list.length + " pesan):\n" + out, rec);
        }),
      },
      browser_network: {
        description: Instructions.tool("browser_network"),
        inputSchema: { type: "object", properties: { url_contains: { type: "string" }, type: { type: "string" }, only_errors: { type: "boolean" }, limit: { type: "number" }, clear: { type: "boolean" } } },
        annotations: { title: "Browser: network", readOnlyHint: true },
        execute: run("browser_network", async (a, callId) => {
          const page = self.page(); let list = page ? page.network.slice() : [];
          if (a.url_contains) list = list.filter((x) => x.url.indexOf(a.url_contains) !== -1);
          if (a.type) list = list.filter((x) => String(x.type).toLowerCase() === String(a.type).toLowerCase());
          if (a.only_errors) list = list.filter((x) => x.failed || (x.status && x.status >= 400));
          list = list.slice(-(Number(a.limit) || 80));
          if (a.clear && page) page.network = [];
          const rec = await self.record("network", a, callId, false);
          const out = list.length ? list.map((x) => (x.status || (x.failed ? "FAIL" : "\u2026")) + " " + x.method + " " + (x.type || "") + " " + (x.size ? Math.round(x.size / 1024) + "KB " : "") + x.url + (x.failed ? " (" + x.failed + ")" : "")).join("\n") : "(belum ada request)";
          return result("Network (" + list.length + " request):\n" + out, rec);
        }),
      },
      browser_evaluate: {
        description: Instructions.tool("browser_evaluate"),
        inputSchema: { type: "object", properties: { expression: { type: "string" }, screenshot: shotOpt }, required: ["expression"] },
        annotations: { title: "Browser: evaluate" },
        execute: run("browser_evaluate", async (a, callId) => {
          const v = await self.evaluate(String(a.expression || ""), true);
          let s; try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch (e) { s = String(v); }
          if (s && s.length > 20000) s = s.slice(0, 20000) + "\n\u2026(dipotong)";
          const rec = await self.record("evaluate", a, callId, a.screenshot === true);
          return result("Hasil:\n" + (s === undefined ? "undefined" : s), rec);
        }),
      },
      browser_wait: {
        description: Instructions.tool("browser_wait"),
        inputSchema: { type: "object", properties: { ms: { type: "number" }, selector: { type: "string" }, text: { type: "string" }, url_contains: { type: "string" }, network_idle: { type: "boolean" }, timeout_ms: { type: "number" }, screenshot: shotOpt } },
        annotations: { title: "Browser: wait", readOnlyHint: true },
        execute: run("browser_wait", async (a, callId) => {
          const limit = Math.min(120000, Number(a.timeout_ms) || 10000); const start = Date.now();
          if (a.ms) await sleep(Math.min(120000, Number(a.ms)));
          let found = !a.selector && !a.text && !a.url_contains;
          while (!found && Date.now() - start < limit) {
            found = await self.evaluate("(function(){" + (a.selector ? "if(document.querySelector(" + JSON.stringify(a.selector) + ")) return true;" : "") + (a.text ? "if((document.body&&document.body.innerText||'').indexOf(" + JSON.stringify(a.text) + ")!==-1) return true;" : "") + (a.url_contains ? "if(location.href.indexOf(" + JSON.stringify(a.url_contains) + ")!==-1) return true;" : "") + "return false;})()").catch(() => false);
            if (!found) await sleep(250);
          }
          let idle = true; if (a.network_idle) idle = await self.networkIdle(500, Math.max(1000, limit - (Date.now() - start)));
          const rec = await self.record("wait", a, callId, a.screenshot !== false);
          return result((found && idle ? "Kondisi terpenuhi" : "Waktu habis, kondisi belum terpenuhi") + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_request_user: {
        description: Instructions.tool("browser_request_user"),
        inputSchema: { type: "object", properties: { message: { type: "string" }, timeout_ms: { type: "number" } }, required: ["message"] },
        annotations: { title: "Browser: request user" },
        // Tidak lewat run(): menunggu pengguna bisa lama dan tidak boleh memblokir antrean aksi.
        execute: async (args, ctx) => {
          args = args || {}; const callId = ctx && ctx.toolCallId;
          try { await self.serial(async () => { await self.ensure(); await self.record("request_user", args, callId, true); }); }
          catch (e) { return { content: [text("Error browser_request_user: " + e.message)], isError: true }; }
          const why = await self.requestUser(args.message, Math.min(60 * 60 * 1000, Number(args.timeout_ms) || 10 * 60 * 1000));
          const rec = await self.serial(() => self.record("user_done", { why }, null, true)).catch(() => ({ step: { url: "", title: "" }, data: "" }));
          return result(why === "timeout" ? "Waktu habis: pengguna belum menyelesaikan bantuan.\n" + stateLine(rec.step) : "Pengguna selesai (" + why + ").\n" + stateLine(rec.step), rec);
        },
      },
      browser_secrets: {
        description: Instructions.tool("browser_secrets"),
        inputSchema: { type: "object", properties: {} },
        annotations: { title: "Browser: secrets", readOnlyHint: true },
        execute: async () => ({ content: [text("Rahasia tersedia: " + (secretNames().join(", ") || "(belum ada — pengguna bisa menambahkan di Setelan AI → Rahasia browser)"))] }),
      },
      browser_emulate: {
        description: Instructions.tool("browser_emulate"),
        inputSchema: { type: "object", properties: { device: { type: "string" }, width: { type: "number" }, height: { type: "number" }, scale: { type: "number" }, mobile: { type: "boolean" }, user_agent: { type: "string" }, locale: { type: "string" }, timezone: { type: "string" }, color_scheme: { type: "string", enum: ["light", "dark"] }, offline: { type: "boolean" }, block_trackers: { type: "boolean" }, screenshot: shotOpt } },
        annotations: { title: "Browser: emulate" },
        execute: run("browser_emulate", async (a, callId) => {
          const em = self.emulation;
          if (a.device && DEVICES[a.device]) { const d = DEVICES[a.device]; em.device = a.device; em.viewport = { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile }; em.userAgent = d.userAgent || null; }
          if (a.width || a.height) { em.device = "custom"; em.viewport = { width: Number(a.width) || em.viewport.width, height: Number(a.height) || em.viewport.height, deviceScaleFactor: Number(a.scale) || em.viewport.deviceScaleFactor || 1, mobile: a.mobile != null ? !!a.mobile : !!em.viewport.mobile }; }
          if (a.user_agent) em.userAgent = String(a.user_agent);
          if (a.locale) em.locale = String(a.locale);
          if (a.timezone) em.timezone = String(a.timezone);
          if (a.color_scheme) em.colorScheme = a.color_scheme;
          if (a.offline != null) em.offline = !!a.offline;
          if (a.block_trackers != null) self.blockTrackers = !!a.block_trackers;
          for (const p of self.agentTabs()) { await self.applyEmulation(p.sessionId, "agent"); await self.send("Network.setBlockedURLs", { urls: self.blockTrackers ? TRACKER_BLOCKLIST : [] }, p.sessionId).catch(() => {}); }
          if (self.live.running && self.viewPage() && self.viewPage().owner === "agent") { await self.stopScreencast().catch(() => {}); await self.startScreencast().catch(() => {}); }
          const rec = await self.record("emulate", a, callId, a.screenshot !== false);
          return result("Emulasi: " + em.device + " " + em.viewport.width + "x" + em.viewport.height + (em.viewport.mobile ? " mobile" : "") + (em.locale ? " · " + em.locale : "") + (em.timezone ? " · " + em.timezone : "") + (em.colorScheme ? " · " + em.colorScheme : "") + (em.offline ? " · offline" : "") + "\n" + stateLine(rec.step), rec);
        }),
      },
      browser_download: {
        description: Instructions.tool("browser_download"),
        inputSchema: { type: "object", properties: Object.assign({}, target, { url: { type: "string" }, to: { type: "string", description: "Destination folder relative to the workspace (default downloads)" }, filename: { type: "string" }, timeout_ms: { type: "number" } }) },
        annotations: { title: "Browser: download" },
        execute: run("browser_download", async (a, callId) => {
          await self.setupDownloads();
          const before = new Set(self.downloads.keys());
          if (a.url) { let u = String(a.url); if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u; await self.send("Page.navigate", { url: u }).catch(() => {}); }
          else { const loc = await self.locate(a); await self.mouseClick(loc.x, loc.y); }
          const limit = Math.min(10 * 60 * 1000, Number(a.timeout_ms) || 60000); const start = Date.now(); let guid = null;
          while (!guid && Date.now() - start < limit) { await sleep(200); for (const g of self.downloads.keys()) if (!before.has(g)) guid = g; }
          if (!guid) throw new Error("Tidak ada unduhan yang dimulai dalam " + Math.round(limit / 1000) + " detik");
          const d = self.downloads.get(guid);
          if (d.state === "inProgress") await new Promise((res) => { d.resolve = res; setTimeout(res, Math.max(1000, limit - (Date.now() - start))); });
          if (d.state !== "completed") throw new Error("Unduhan " + (d.state || "gagal") + (d.suggested ? " (" + d.suggested + ")" : ""));
          const destDir = self.wsPath(a.to || "downloads"); fs.mkdirSync(destDir, { recursive: true });
          const name = String(a.filename || d.suggested || guid).replace(/[\\/:*?"<>|]/g, "_");
          let dest = path.join(destDir, name); let i = 1; while (fs.existsSync(dest)) { const ext = path.extname(name); dest = path.join(destDir, path.basename(name, ext) + " (" + (i++) + ")" + ext); }
          fs.renameSync(path.join(self.downloadDir, guid), dest);
          self.downloads.delete(guid);
          const rel = path.relative(self.workspace, dest).split(path.sep).join("/");
          const rec = await self.record("download", Object.assign({}, a, { file: rel }), callId, false);
          return result("Tersimpan: " + rel + " (" + fmtBytes(fs.statSync(dest).size) + ")", rec);
        }),
      },
      browser_pdf: {
        description: Instructions.tool("browser_pdf"),
        inputSchema: { type: "object", properties: { path: { type: "string" }, landscape: { type: "boolean" }, print_background: { type: "boolean" }, scale: { type: "number" } } },
        annotations: { title: "Browser: pdf" },
        execute: run("browser_pdf", async (a, callId) => {
          const st = await self.state();
          const rel = a.path || ("downloads/" + (String(st.title || "halaman").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "halaman") + ".pdf");
          const abs = self.wsPath(rel); fs.mkdirSync(path.dirname(abs), { recursive: true });
          const r = await self.send("Page.printToPDF", { landscape: !!a.landscape, printBackground: a.print_background !== false, scale: Number(a.scale) || 1, preferCSSPageSize: true });
          fs.writeFileSync(abs, Buffer.from(r.data, "base64"));
          const rec = await self.record("pdf", Object.assign({}, a, { file: rel }), callId, false);
          return result("PDF tersimpan: " + rel + " (" + fmtBytes(fs.statSync(abs).size) + ")", rec);
        }),
      },
      browser_back: {
        description: Instructions.tool("browser_back"),
        inputSchema: { type: "object", properties: { screenshot: shotOpt } },
        annotations: { title: "Browser: back" },
        execute: run("browser_back", async (a, callId) => {
          const h = await self.send("Page.getNavigationHistory");
          if (h.currentIndex > 0) { const loaded = self.waitLoad(6000, 600); await self.send("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id }); await loaded; await self.settle(1000); }
          const rec = await self.record("back", a, callId, a.screenshot !== false);
          return result(stateLine(rec.step), rec);
        }),
      },
      browser_export_script: {
        description: Instructions.tool("browser_export_script"),
        inputSchema: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, from_step: { type: "number" } } },
        annotations: { title: "Browser: export Playwright" },
        execute: async (a) => {
          a = a || {};
          try {
            let steps = self.steps.filter((s) => !a.from_step || s.n >= Number(a.from_step));
            if (!steps.length) return { content: [text("Belum ada langkah browser yang bisa diekspor.")], isError: true };
            const rel = String(a.path || ("tests/browser-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".spec.js"));
            const abs = self.wsPath(rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, toPlaywright(steps, { file: rel, title: a.title }), "utf8");
            await self.record("export_script", { path: rel, steps: steps.length }, null, false);
            return { content: [text("Skrip Playwright tersimpan: " + rel + " (" + steps.length + " langkah). Jalankan: npx playwright test " + rel)] };
          } catch (e) { return { content: [text("Error browser_export_script: " + e.message)], isError: true }; }
        },
      },
      browser_close: {
        description: Instructions.tool("browser_close"),
        inputSchema: { type: "object", properties: {} },
        annotations: { title: "Browser: close" },
        execute: () => self.serial(async () => { await self.close(); return { content: [text("Browser ditutup.")] }; }),
      },
    };
  }
}

// ---- Ekspor langkah → skrip Playwright Test (CommonJS) ------------------------------
// steps: [{action, url, title, args}] — dari BrowserAutomation.steps atau dari riwayat chat (meta.browser).
function toPlaywright(steps, opts) {
  opts = opts || {};
  const J = (v) => JSON.stringify(String(v == null ? "" : v));
  const loc = (a, hintKey) => {
    a = a || {}; const h = a[hintKey || "pw"] || {};
    if (h.sel) return "page.locator(" + J(h.sel) + ")";
    if (a.selector) return "page.locator(" + J(a.selector) + ")";
    if (a.text_match) return "page.getByText(" + J(a.text_match) + ")";
    if (h.text) return "page.getByText(" + J(h.text) + ").first()";
    if (a.target) { const m = /"([^"]{1,60})"\s*$/.exec(String(a.target)); if (m && m[1]) return "page.getByText(" + J(m[1]) + ").first()"; }
    return null;
  };
  const lines = [];
  const push = (s) => lines.push("  " + s);
  const comment = (s) => push("// " + s);
  let shots = 0, hasNav = false;
  (steps || []).forEach((st) => {
    const a = st.args || {}; const act = String(st.action || "");
    switch (act) {
      case "navigate": { let u = a.url || st.url || ""; if (u && !/^[a-z]+:\/\//i.test(u)) u = "https://" + u; if (u) { push("await page.goto(" + J(u) + ");"); hasNav = true; } break; }
      case "tabs":
        if (a.action === "new") { push("page = await context.newPage();"); if (a.url) push("await page.goto(" + J(/^[a-z]+:\/\//i.test(a.url) ? a.url : "https://" + a.url) + ");"); }
        else comment("tabs " + (a.action || "") + (a.id ? " #" + a.id : "") + " (ganti/tutup tab: sesuaikan manual bila perlu)");
        break;
      case "click": { const l = loc(a); if (typeof a.x === "number" && typeof a.y === "number" && !l) push("await page.mouse.click(" + a.x + ", " + a.y + ");"); else if (l) push("await " + l + ".click(" + (a.double ? "{ clickCount: 2 }" : a.button === "right" ? "{ button: 'right' }" : "") + ");"); else comment("click: target tidak dikenali"); break; }
      case "hover": { const l = loc(a); if (l) push("await " + l + ".hover();"); else comment("hover: target tidak dikenali"); break; }
      case "type": {
        const l = loc(a); if (!l) { comment("type: target tidak dikenali"); break; }
        const val = a.secret ? "process.env." + String(a.secret).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase() + " /* rahasia " + a.secret + " */" : J(String(a.text || "").replace(/\u2026$/, ""));
        push("await " + l + "." + (a.clear === false ? "pressSequentially" : "fill") + "(" + val + ");");
        if (a.submit) push("await page.keyboard.press('Enter');");
        break;
      }
      case "select": { const l = loc(a); if (!l) { comment("select: target tidak dikenali"); break; } push("await " + l + ".selectOption(" + (a.value != null ? J(a.value) : a.label != null ? "{ label: " + J(a.label) + " }" : a.index != null ? "{ index: " + Number(a.index) + " }" : J(a.chosen || "")) + ");"); break; }
      case "upload": { const l = loc(a); if (l) push("await " + l + ".setInputFiles(" + JSON.stringify(a.paths || []) + ");"); else comment("upload: target tidak dikenali"); break; }
      case "drag": { const f = loc({ selector: a.from_selector, pw: a.pwFrom }), t = loc({ selector: a.to_selector, pw: a.pwTo }); if (f && t) push("await " + f + ".dragTo(" + t + ");"); else comment("drag: target tidak dikenali"); break; }
      case "press_key": push("await page.keyboard.press(" + J(a.key || "Enter") + ");"); break;
      case "scroll": {
        if (a.ref || a.selector) { const l = loc(a); if (l) push("await " + l + ".scrollIntoViewIfNeeded();"); else comment("scroll: target tidak dikenali"); }
        else if (a.direction === "top") push("await page.evaluate(() => window.scrollTo(0, 0));");
        else if (a.direction === "bottom") push("await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));");
        else push("await page.mouse.wheel(0, " + (a.direction === "up" ? -1 : 1) * (Number(a.amount) || 600) + ");");
        break;
      }
      case "screenshot": push("await page.screenshot({ path: 'shot-" + (++shots) + ".png'" + (a.full_page ? ", fullPage: true" : "") + " });"); break;
      case "wait":
        if (a.selector) push("await page.locator(" + J(a.selector) + ").waitFor({ timeout: " + (Number(a.timeout_ms) || 10000) + " });");
        if (a.text) push("await page.getByText(" + J(a.text) + ").first().waitFor({ timeout: " + (Number(a.timeout_ms) || 10000) + " });");
        if (a.url_contains) push("await page.waitForURL(/" + String(a.url_contains).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "/);");
        if (a.network_idle) push("await page.waitForLoadState('networkidle');");
        if (a.ms) push("await page.waitForTimeout(" + Number(a.ms) + ");");
        break;
      case "back": push("await page.goBack();"); break;
      case "evaluate": push("await page.evaluate(() => { " + String(a.expression || "").replace(/\*\//g, "* /") + " });"); break;
      case "pdf": push("await page.pdf({ path: " + J(a.path || a.file || "halaman.pdf") + (a.landscape ? ", landscape: true" : "") + " });"); break;
      case "emulate": comment("emulasi: " + (a.device ? "device " + a.device : "") + (a.locale ? " locale " + a.locale : "") + (a.timezone ? " tz " + a.timezone : "") + " — atur lewat test.use({ ...devices['iPhone 13'], locale, timezoneId })"); break;
      case "extract": case "snapshot": case "console": case "network": case "secrets": case "user_done": break; // baca-saja: tidak perlu di skrip
      case "request_user": comment("agent minta bantuan pengguna di sini: " + String(a.message || "").slice(0, 120)); push("await page.pause(); // selesaikan login/CAPTCHA secara manual"); break;
      case "download": { const l = loc(a); push("const downloadPromise = page.waitForEvent('download');"); if (a.url) push("await page.goto(" + J(a.url) + ").catch(() => {});"); else if (l) push("await " + l + ".click();"); push("const download = await downloadPromise;"); push("await download.saveAs(" + J(a.file || (a.to || "downloads") + "/" + (a.filename || "unduhan")) + ");"); break; }
      default: comment(act + " " + JSON.stringify(a).slice(0, 120));
    }
  });
  if (!hasNav && steps && steps.length && steps[0].url) lines.unshift("  await page.goto(" + J(steps[0].url) + ");");
  return [
    "// Direkam dari VRCloud IDE \u2014 Browser agent, " + new Date().toISOString(),
    "// Jalankan: npx playwright test " + (opts.file || "<file>") + "   (butuh: npm i -D @playwright/test && npx playwright install)",
    "// Rahasia dibaca dari environment variable (lihat komentar process.env.*).",
    "const { test, expect } = require('@playwright/test');",
    "",
    "test(" + J(opts.title || "rekaman browser agent") + ", async ({ page, context }) => {",
    ...lines,
    "});",
    "",
  ].join("\n");
}

function compactArgs(a) {
  const out = {};
  Object.keys(a || {}).forEach((k) => { const v = a[k]; if (v === undefined || v === null || v === "") return; out[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "\u2026" : v; });
  return out;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtBytes(n) { n = Number(n) || 0; return n < 1024 ? n + " B" : n < 1024 * 1024 ? (Math.round(n / 102.4) / 10) + " KB" : (Math.round(n / (1024 * 102.4)) / 10) + " MB"; }
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "VRCloud-IDE" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return fetchJson(res.headers.location).then(resolve, reject);
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => { b += c; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const go = (u, redirects) => {
      https.get(u, { headers: { "User-Agent": "VRCloud-IDE" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) return go(res.headers.location, redirects + 1);
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + " saat mengunduh"));
        const total = Number(res.headers["content-length"]) || 0; let got = 0; let last = 0;
        const out = fs.createWriteStream(dest);
        res.on("data", (c) => { got += c.length; if (total && onProgress) { const pct = got / total * 100; if (pct - last >= 1) { last = pct; onProgress(pct); } } });
        res.pipe(out); out.on("finish", () => out.close(resolve)); out.on("error", reject);
      }).on("error", reject);
    };
    go(url, 0);
  });
}

BrowserAutomation.findBrowser = findBrowser;
BrowserAutomation.toPlaywright = toPlaywright;
module.exports = BrowserAutomation;
