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
    this.clients = new Map();
    this.clientSeq = 0;
    this.wss = new WebSocket.Server({ noServer: true, maxPayload: 12 * 1024 * 1024 });
    this.wss.on("connection", (ws) => this.connect(ws));
    this.heartbeat = setInterval(() => this.ping(), 20000);
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
    const file = this.safe(relPath);
    let doc = this.store.state.docs[relPath];
    if (!doc) {
      const st = fs.statSync(file);
      if (st.size > 5 * 1024 * 1024) throw new Error("File terlalu besar (>5MB)");
      const content = fs.readFileSync(file, "utf8");
      doc = { path: relPath, content, dirty: false, mode: "", revision: 0, updatedAt: Date.now() };
      this.store.change((s) => { s.docs[relPath] = doc; });
    }
    return doc;
  }

  message(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    const meta = this.clients.get(ws);
    if (!meta || !msg || typeof msg.type !== "string") return;
    try {
      if (msg.type === "layout") {
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
        const rel = String(msg.path || "");
        const content = String(msg.content == null ? "" : msg.content);
        if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("Buffer terlalu besar (>5MB)");
        const doc = this.ensureDoc(rel);
        if (Number(msg.revision) !== Number(doc.revision)) {
          this.send(ws, { type: "doc-conflict", doc });
          return;
        }
        const next = Object.assign({}, doc, {
          content,
          dirty: true,
          mode: msg.mode || doc.mode || "",
          revision: doc.revision + 1,
          updatedAt: Date.now(),
          author: meta.clientId,
        });
        this.store.change((s) => { s.docs[rel] = next; });
        this.send(ws, { type: "doc-ack", path: rel, revision: next.revision, dirty: true });
        this.broadcast({ type: "doc", doc: next, source: meta.clientId }, ws);
      } else if (msg.type === "doc-save") {
        const rel = String(msg.path || "");
        const doc = this.ensureDoc(rel);
        const content = msg.content == null ? doc.content : String(msg.content);
        fs.mkdirSync(path.dirname(this.safe(rel)), { recursive: true });
        fs.writeFileSync(this.safe(rel), content, "utf8");
        const next = Object.assign({}, doc, {
          content,
          dirty: false,
          revision: doc.revision + 1,
          updatedAt: Date.now(),
          author: meta.clientId,
        });
        this.store.change((s) => { s.docs[rel] = next; });
        this.send(ws, { type: "doc-ack", requestId: msg.requestId, path: rel, revision: next.revision, dirty: false });
        this.broadcast({ type: "doc", doc: next, source: meta.clientId }, ws);
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
      } else if (msg.type === "ping") {
        this.send(ws, { type: "pong", time: Date.now() });
      }
    } catch (e) {
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
