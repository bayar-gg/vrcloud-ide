"use strict";

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

class RealtimeHub {
  constructor(options) {
    this.server = options.server;
    this.store = options.store;
    this.workspace = options.workspace;
    this.safe = options.safe;
    this.terminals = options.terminals;
    this.browser = options.browser || null; // BrowserAutomation: live view + ambil alih
    this.clients = new Map();
    this.clientSeq = 0;
    // Kursor milik browser dari proses server sebelumnya: pemiliknya sudah tidak ada
    // dan presence-leave-nya tidak akan pernah datang, jadi kosongkan saat start.
    if (this.store.state.cursors && Object.keys(this.store.state.cursors).length) this.store.change((s) => { s.cursors = {}; });
    this.wss = new WebSocket.Server({ noServer: true, maxPayload: 12 * 1024 * 1024 });
    this.wss.on("connection", (ws) => this.connect(ws));
    this.heartbeat = setInterval(() => this.ping(), 20000);
    this.startDiskWatch();
  }

  normRel(rel) {
    let s = String(rel || "").replace(/\\/g, "/");
    const root = String(this.workspace || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && s.toLowerCase().indexOf(root.toLowerCase() + "/") === 0) s = s.slice(root.length + 1);
    return s.replace(/^\.\//, "").replace(/^\/+/, "");
  }

  ignoreRel(rel) {
    if (!rel) return false;
    const parts = rel.split("/");
    return parts.indexOf("node_modules") !== -1 || parts.indexOf(".git") !== -1;
  }

  docKey(rel) {
    const n = this.normRel(rel);
    const docs = this.store.state.docs || {};
    if (docs[n]) return n;
    const lower = n.toLowerCase();
    const keys = Object.keys(docs);
    for (let i = 0; i < keys.length; i++) {
      if (this.normRel(keys[i]).toLowerCase() === lower) return keys[i];
    }
    return n;
  }

  layoutFiles(layout, out) {
    out = out || [];
    if (!layout) return out;
    if (layout.type === "leaf") {
      (layout.tabs || []).forEach((t) => {
        if (t && t.kind === "file" && t.path) out.push(this.normRel(t.path));
      });
    } else {
      (layout.children || []).forEach((child) => this.layoutFiles(child, out));
    }
    return out;
  }

  pathOpen(rel) {
    const n = this.normRel(rel).toLowerCase();
    if (!n) return false;
    return this.layoutFiles(this.store.state.layout).some((p) => p.toLowerCase() === n);
  }

  looksBinary(buf) {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }

  readDiskFile(rel) {
    const abs = this.safe(rel);
    if (!fs.existsSync(abs)) return null;
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > 5 * 1024 * 1024) return { tooBig: true, mtime: st.mtimeMs };
    const buf = fs.readFileSync(abs);
    if (this.looksBinary(buf)) return { binary: true, mtime: st.mtimeMs };
    return { content: buf.toString("utf8"), mtime: st.mtimeMs };
  }

  // Tulis buffer editor ke disk supaya file, agent, dan terminal melihat isi yang sama.
  persistDoc(rel, content) {
    const abs = this.safe(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return fs.statSync(abs).mtimeMs;
  }

  startDiskWatch() {
    const pending = new Map();
    let timer = null;
    const flush = () => {
      timer = null;
      const paths = [];
      let rename = false;
      pending.forEach((isRename, p) => { paths.push(p); if (isRename) rename = true; });
      pending.clear();
      if (!paths.length) return;
      try { this.filesChangedOnDisk(paths, "disk", { tree: rename }); } catch (e) {}
    };
    const push = (filename, eventType) => {
      const rename = eventType === "rename";
      const add = (p) => pending.set(p, pending.get(p) || rename);
      if (!filename) this.layoutFiles(this.store.state.layout).forEach(add);
      else {
        const n = this.normRel(filename);
        if (!n || this.ignoreRel(n)) return;
        add(n);
      }
      clearTimeout(timer);
      timer = setTimeout(flush, 50);
    };
    try {
      this.watcher = fs.watch(this.workspace, { recursive: true }, (eventType, filename) => push(filename, eventType));
      if (this.watcher && this.watcher.on) this.watcher.on("error", () => {});
    } catch (e) {
      console.warn("[realtime] fs.watch gagal: " + e.message);
    }
    // Cadangan kalau event watch terlewat: tab yang terbuka dicek berkala.
    this.pollTimer = setInterval(() => {
      try {
        const open = new Set(this.layoutFiles(this.store.state.layout, []));
        if (this.liveDocs) this.liveDocs.forEach((p) => open.add(p));
        const paths = Array.from(open);
        if (paths.length) this.filesChangedOnDisk(paths, "disk", { tree: false });
      } catch (e) {}
    }, 400);
  }

  send(ws, value) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(value)); } catch (e) {}
    }
  }

  broadcast(value, except) {
    this.clients.forEach((meta, ws) => {
      if (ws !== except) this.send(ws, value);
    });
  }

  terminalIds(layout, out) {
    out = out || new Set();
    if (!layout) return out;
    if (layout.type === "leaf") {
      (layout.tabs || []).forEach((tab) => {
        if (tab.kind === "term" && tab.termId) out.add(String(tab.termId));
      });
    } else {
      (layout.children || []).forEach((child) => this.terminalIds(child, out));
    }
    return out;
  }

  cleanupOrphanTerminals(layout) {
    const used = this.terminalIds(layout);
    Object.keys(this.store.state.terminals || {}).forEach((id) => {
      const meta = this.store.state.terminals[id];
      if (!used.has(id) && Date.now() - Number(meta.createdAt || 0) > 2000) {
        this.terminals.close(id);
        this.broadcast({ type: "terminal-meta", action: "closed", id, source: "server" });
      }
    });
  }

  connect(ws) {
    const clientId = "browser-" + (++this.clientSeq);
    const meta = { clientId, alive: true };
    this.clients.set(ws, meta);
    ws.on("pong", () => { meta.alive = true; });
    ws.on("message", (raw) => this.message(ws, raw));
    ws.on("close", () => {
      this.clients.delete(ws);
      if (meta.watching) this.watchBrowser(meta, false);
      this.store.change((s) => { delete s.cursors[clientId]; });
      this.broadcast({ type: "presence-leave", clientId });
    });
    this.send(ws, {
      type: "snapshot",
      clientId,
      canInitialize: !this.store.state.layout && this.clients.size === 1,
      state: this.store.snapshot(),
      presence: Array.from(this.clients.values()).map((x) => x.clientId),
    });
    this.broadcast({ type: "presence-join", clientId }, ws);
  }

  ensureDoc(relPath) {
    const key = this.docKey(relPath);
    this.liveDocs = this.liveDocs || new Set();
    this.liveDocs.add(key);
    const file = this.safe(key);
    let doc = this.store.state.docs[key];
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error("Bukan file");
    if (st.size > 5 * 1024 * 1024) throw new Error("File terlalu besar (>5MB)");
    if (!doc) {
      const buf = fs.readFileSync(file);
      if (this.looksBinary(buf)) throw new Error("File biner tidak bisa dibuka di editor");
      doc = { path: key, content: buf.toString("utf8"), dirty: false, mode: "", revision: 0, updatedAt: Date.now(), diskMtime: st.mtimeMs };
      this.store.change((s) => { s.docs[key] = doc; });
      return doc;
    }
    // Buffer bersama yang bersih harus mengikuti file di disk, bukan salinan lama di session.
    if (!doc.dirty && st.mtimeMs > (Number(doc.diskMtime) || 0) + 1) {
      const buf = fs.readFileSync(file);
      if (!this.looksBinary(buf)) {
        const content = buf.toString("utf8");
        if (content !== doc.content) {
          doc = Object.assign({}, doc, {
            content, dirty: false, revision: (doc.revision || 0) + 1, updatedAt: Date.now(), diskMtime: st.mtimeMs, author: "disk",
          });
          this.store.change((s) => { s.docs[key] = doc; });
          this.broadcast({ type: "doc", doc, source: "disk" });
          return doc;
        }
        doc.diskMtime = st.mtimeMs;
      }
    }
    return doc;
  }

  // File berubah di disk (agent, shell, editor lain, proses luar):
  // tab yang terbuka ikut berubah. Daftar path kosong = semua file yang sedang terbuka.
  filesChangedOnDisk(relPaths, source, opts) {
    const src = source || "disk";
    const wantTree = !opts || opts.tree !== false;
    let paths;
    let forceTree = false;
    if (!relPaths || !relPaths.length) {
      paths = this.layoutFiles(this.store.state.layout, []);
      forceTree = wantTree;
    } else {
      paths = [];
      relPaths.forEach((rel) => {
        const n = this.normRel(rel);
        if (n && !this.ignoreRel(n)) paths.push(n);
      });
    }
    const changed = [];
    const treeDirs = {};
    const seen = new Set();
    const noteTree = (rel) => {
      if (!wantTree) return;
      const i = rel.lastIndexOf("/");
      treeDirs[i >= 0 ? rel.slice(0, i) : ""] = 1;
    };
    paths.forEach((rel) => {
      const key = this.docKey(rel);
      if (seen.has(key)) return;
      seen.add(key);
      const doc = this.store.state.docs[key];
      const open = this.pathOpen(key);
      let disk = null;
      try { disk = this.readDiskFile(key); } catch (e) { return; }
      if (!doc && !open) {
        noteTree(key);
        return;
      }
      if (!disk || disk.tooBig || disk.binary) {
        if (doc && !disk) {
          this.store.change((s) => { delete s.docs[key]; });
          this.broadcast({ type: "fs-removed", path: key, source: src });
          changed.push(key);
          noteTree(key);
        }
        return;
      }
      if (!doc) {
        const next = {
          path: key, content: disk.content, dirty: false, mode: "", revision: 1,
          updatedAt: Date.now(), author: src, diskMtime: disk.mtime,
        };
        this.store.change((s) => { s.docs[key] = next; });
        this.broadcast({ type: "doc", doc: next, source: src });
        changed.push(key);
        noteTree(key);
        return;
      }
      if (disk.content === doc.content && !doc.dirty) {
        doc.diskMtime = disk.mtime;
        return;
      }
      // Buffer kotor yang lebih baru dari file jangan ditimpa salinan disk yang lebih lama.
      if (doc.dirty && disk.content !== doc.content && disk.mtime <= (Number(doc.diskMtime) || 0) + 2) return;
      const next = Object.assign({}, doc, {
        content: disk.content, dirty: false, revision: (doc.revision || 0) + 1,
        updatedAt: Date.now(), author: src, diskMtime: disk.mtime,
      });
      this.store.change((s) => { s.docs[key] = next; });
      this.broadcast({ type: "doc", doc: next, source: src });
      changed.push(key);
      if (src !== "disk") noteTree(key);
    });
    if (wantTree) {
      const keys = Object.keys(treeDirs);
      if (forceTree || keys.length > 3) this.broadcast({ type: "fs-change", path: "", source: src });
      else keys.forEach((d) => this.broadcast({ type: "fs-change", path: d, source: src }));
    }
    return changed;
  }

  // ---- Agent AI: event sesi & cermin shell agent (view-only) ----
  // Event ringan dari AiChat (run mulai/selesai, daftar sesi berubah) → semua browser.
  aiEvent(payload) { this.broadcast(Object.assign({ type: "ai" }, payload || {})); }
  // Output perintah shell agent per sesi, disimpan di memori (maks 256 KB) agar browser
  // yang membuka tab "Agent shell" belakangan bisa memutar ulang.
  agentShell(p) {
    if (!p || !p.sessionId) return;
    this.agentShells = this.agentShells || {};
    const key = String(p.sessionId);
    const buf = this.agentShells[key] || (this.agentShells[key] = { text: "", running: {}, updatedAt: 0 });
    let chunk = "";
    // Kunci per perintah: call_id bisa kosong/berbeda antara event running & completed.
    const rk = String(p.callId || p.command || "");
    if (p.status === "running") {
      if (!buf.running[rk]) {
        buf.running[rk] = true;
        chunk = "\x1b[1;36m$ " + p.command.replace(/\r?\n/g, "\r\n  ") + "\x1b[0m" + (p.background ? "  \x1b[33m(latar belakang)\x1b[0m" : "") + "\r\n";
      }
    } else {
      if (!buf.running[rk]) chunk += "\x1b[1;36m$ " + p.command.replace(/\r?\n/g, "\r\n  ") + "\x1b[0m\r\n";
      delete buf.running[rk];
      const out = [p.stdout || "", p.stderr || ""].filter(Boolean).join("\n").replace(/\r?\n/g, "\r\n");
      if (out) chunk += out + (out.endsWith("\r\n") ? "" : "\r\n");
      if (p.exitCode != null) chunk += (p.exitCode === 0 ? "\x1b[32m" : "\x1b[31m") + "[exit " + p.exitCode + "]\x1b[0m\r\n";
      else if (p.background) chunk += "\x1b[33m[berjalan di latar belakang]\x1b[0m\r\n";
      chunk += "\r\n";
    }
    if (!chunk) return;
    buf.text = (buf.text + chunk).slice(-256 * 1024);
    buf.updatedAt = Date.now();
    this.broadcast({ type: "agent-shell", sessionId: key, data: chunk, status: p.status, command: p.command, callId: p.callId, background: !!p.background, exitCode: p.exitCode });
  }

  // ---- Browser agent: live view (screencast) & ambil alih ------------------------
  watchBrowser(meta, on) {
    if (!this.browser || !!meta.watching === !!on) return;
    meta.watching = !!on;
    this.browser.watch(on ? 1 : -1).catch(() => {});
  }
  // Event dari BrowserAutomation: frame hanya ke penonton, sisanya ke semua browser.
  browserEvent(type, payload) {
    if (type === "frame") {
      const msg = JSON.stringify(Object.assign({ type: "browser-frame" }, payload));
      this.clients.forEach((meta, ws) => { if (meta.watching && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) { try { ws.send(msg); } catch (e) {} } });
      return;
    }
    this.broadcast(Object.assign({ type: "browser-" + type }, type === "handoff" ? { handoff: payload } : payload || {}));
  }

  message(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    const meta = this.clients.get(ws);
    if (!meta || !msg || typeof msg.type !== "string") return;
    try {
      if (msg.type === "browser-live") {
        // Klien membuka/menutup tab Browser agent: mulai/berhenti screencast.
        this.watchBrowser(meta, !!msg.on);
        if (msg.on && this.browser) {
          const b = this.browser;
          this.send(ws, Object.assign({ type: "browser-tabs" }, b.tabsPayload()));
          if (b.handoff) this.send(ws, { type: "browser-handoff", handoff: { message: b.handoff.message, since: b.handoff.since } });
          if (b.live.lastFrame && Date.now() - b.live.lastFrame.t < 60000) this.send(ws, Object.assign({ type: "browser-frame" }, b.live.lastFrame));
        }
      } else if (msg.type === "browser-input") {
        // Pengguna mengambil alih: mouse/keyboard/navigasi/tab diteruskan ke CDP.
        if (!this.browser) return;
        this.browser.userInput(msg.event || {}).catch((e) => this.send(ws, { type: "error", message: e.message }));
      } else if (msg.type === "browser-handoff-done") {
        if (this.browser) this.browser.finishHandoff("done");
      } else if (msg.type === "ai-draft") {
        // Draft composer AI: diteruskan apa adanya ke browser lain (tidak disimpan).
        const text = String(msg.text == null ? "" : msg.text).slice(0, 20000);
        this.broadcast({ type: "ai-draft", sessionId: String(msg.sessionId || ""), text, source: meta.clientId }, ws);
      } else if (msg.type === "agent-shell-buffer") {
        const buf = this.agentShells && this.agentShells[String(msg.sessionId || "")];
        this.send(ws, { type: "agent-shell-buffer", requestId: msg.requestId, sessionId: String(msg.sessionId || ""), data: buf ? buf.text : "" });
      } else if (msg.type === "layout") {
        if (!msg.layout || typeof msg.layout !== "object") return;
        const revision = this.store.change((s) => {
          s.layout = msg.layout;
          s.activeLeafId = msg.activeLeafId == null ? null : msg.activeLeafId;
          s.tabSeq = Number(msg.tabSeq) || s.tabSeq || 0;
          s.nodeSeq = Number(msg.nodeSeq) || s.nodeSeq || 0;
        });
        this.broadcast({
          type: "layout",
          revision,
          layout: msg.layout,
          activeLeafId: msg.activeLeafId,
          tabSeq: msg.tabSeq,
          nodeSeq: msg.nodeSeq,
          source: meta.clientId,
        }, ws);
        this.send(ws, { type: "layout-ack", revision });
        this.cleanupOrphanTerminals(msg.layout);
      } else if (msg.type === "doc-open") {
        const doc = this.ensureDoc(String(msg.path || ""));
        this.send(ws, { type: "doc", requestId: msg.requestId, doc });
      } else if (msg.type === "doc-change") {
        const raw = String(msg.path || "");
        const rel = this.docKey(raw);
        const content = String(msg.content == null ? "" : msg.content);
        if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("Buffer terlalu besar (>5MB)");
        let doc = this.store.state.docs[rel];
        if (!doc) {
          try { doc = this.ensureDoc(rel); } catch (e) {
            doc = { path: rel, content: "", dirty: false, mode: "", revision: 0, updatedAt: 0, diskMtime: 0 };
          }
        }
        if (Number(msg.revision) !== Number(doc.revision)) {
          this.send(ws, { type: "doc-conflict", doc });
          return;
        }
        let diskMtime = Number(doc.diskMtime) || 0;
        let dirty = false;
        try { diskMtime = this.persistDoc(rel, content); } catch (e) { dirty = true; }
        const next = Object.assign({}, doc, {
          path: rel,
          content,
          dirty,
          mode: msg.mode || doc.mode || "",
          revision: (doc.revision || 0) + 1,
          updatedAt: Date.now(),
          author: meta.clientId,
          diskMtime,
        });
        this.store.change((s) => { s.docs[rel] = next; });
        this.send(ws, { type: "doc-ack", path: raw, revision: next.revision, dirty });
        this.broadcast({ type: "doc", doc: Object.assign({}, next, { path: raw }), source: meta.clientId }, ws);
      } else if (msg.type === "doc-save") {
        const raw = String(msg.path || "");
        const rel = this.docKey(raw);
        const doc = this.ensureDoc(rel);
        const content = msg.content == null ? doc.content : String(msg.content);
        const diskMtime = this.persistDoc(rel, content);
        const next = Object.assign({}, doc, {
          path: rel,
          content,
          dirty: false,
          revision: doc.revision + 1,
          updatedAt: Date.now(),
          author: meta.clientId,
          diskMtime,
        });
        this.store.change((s) => { s.docs[rel] = next; });
        this.send(ws, { type: "doc-ack", requestId: msg.requestId, path: raw, revision: next.revision, dirty: false });
        this.broadcast({ type: "doc", doc: Object.assign({}, next, { path: raw }), source: meta.clientId }, ws);
      } else if (msg.type === "cursor") {
        const cursor = {
          clientId: meta.clientId,
          path: String(msg.path || ""),
          row: Number(msg.row) || 0,
          column: Number(msg.column) || 0,
          selection: msg.selection || null,
          updatedAt: Date.now(),
        };
        this.store.change((s) => { s.cursors[meta.clientId] = cursor; });
        this.broadcast({ type: "cursor", cursor }, ws);
      } else if (msg.type === "terminal-create") {
        const terminal = this.terminals.create(msg.cwd || "");
        this.send(ws, { type: "terminal-created", requestId: msg.requestId, terminal });
        this.broadcast({ type: "terminal-meta", action: "created", terminal, source: meta.clientId }, ws);
      } else if (msg.type === "terminal-close") {
        const id = String(msg.id || "");
        this.terminals.close(id);
        this.broadcast({ type: "terminal-meta", action: "closed", id, source: meta.clientId }, ws);
      } else if (msg.type === "fs-change") {
        this.broadcast({ type: "fs-change", path: msg.path || "", source: meta.clientId }, ws);
      } else if (msg.type === "uiview") {
        // Tampilan sidebar (Workspace/Git/Search) + panel AI: teruskan apa adanya ke browser lain.
        this.broadcast({ type: "uiview", side: String(msg.side || ""), ai: !!msg.ai, desk: !!msg.desk, source: meta.clientId }, ws);
      }
    } catch (e) {
      try { console.warn("[vrcloud] sync " + msg.type + ": " + ((e && e.message) || e)); } catch (e2) {}
      this.send(ws, { type: "error", requestId: msg.requestId, message: e.message });
    }
  }

  ping() {
    this.clients.forEach((meta, ws) => {
      if (!meta.alive) {
        try { ws.terminate(); } catch (e) {}
        return;
      }
      meta.alive = false;
      try { ws.ping(); } catch (e) {}
    });
  }
}

module.exports = RealtimeHub;
