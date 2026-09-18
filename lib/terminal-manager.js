"use strict";

const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const WebSocket = require("ws");
const pty = require("node-pty-prebuilt-multiarch");

class TerminalManager {
  constructor(options) {
    this.workspace = options.workspace;
    this.rcfile = options.rcfile;
    this.shell = options.shell || "/bin/bash";
    this.store = options.store;
    this.safe = options.safe;
    this.sessions = new Map();
    this.sequence = 0;
    Object.keys(this.store.state.terminals || {}).forEach((id) => this.ensure(id));
  }

  tmuxName(id) {
    return "c9_" + String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  exists(name) {
    return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
  }

  create(cwd) {
    let resolved = this.workspace;
    try { if (cwd) resolved = this.safe(cwd); } catch (e) {}
    const id = "term-" + Date.now().toString(36) + "-" + (++this.sequence).toString(36);
    const count = Object.keys(this.store.state.terminals || {}).length + 1;
    const meta = { id, title: "bash " + count, cwd: resolved, createdAt: Date.now() };
    this.store.change((s) => { s.terminals[id] = meta; });
    this.ensure(id);
    return meta;
  }

  ensure(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const meta = this.store.state.terminals[id];
    if (!meta) return null;
    const name = this.tmuxName(id);
    const existed = this.exists(name);
    if (!existed) {
      const shellArgs = path.basename(this.shell) === "bash"
        ? [this.shell, "--rcfile", this.rcfile, "-i"]
        : [this.shell, "-i"];
      const made = spawnSync("tmux", [
        "new-session", "-d", "-s", name, "-c", meta.cwd || this.workspace
      ].concat(shellArgs));
      if (made.status !== 0) throw new Error("Gagal membuat tmux " + id + ": " + String(made.stderr || ""));
    }
    try { execFileSync("tmux", ["set-option", "-t", name, "status", "off"]); } catch (e) {}
    // Perbarui prompt terminal lama hanya ketika pane benar-benar sedang idle.
    if (existed) {
      try {
        const screen = execFileSync("tmux", ["capture-pane", "-p", "-t", name], { encoding: "utf8" });
        const last = screen.split("\n").filter(Boolean).pop() || "";
        if (/cloud9project@.*#\s*$/.test(last)) {
          execFileSync("tmux", ["send-keys", "-t", name, "source " + this.rcfile, "C-m"]);
        } else if (/└─#\s*$/.test(last)) {
          execFileSync("tmux", ["send-keys", "-t", name, "clear", "C-m"]);
        }
      } catch (e) {}
    }
    const proc = pty.spawn("tmux", ["-2", "attach-session", "-t", name], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: meta.cwd || this.workspace,
      env: Object.assign({}, process.env, { TERM: "xterm-256color" }),
    });
    const session = { id, meta, name, proc, clients: new Set(), buffer: "" };
    proc.on("data", (data) => {
      session.buffer = (session.buffer + data).slice(-512 * 1024);
      session.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(data); } catch (e) {}
        }
      });
    });
    proc.on("exit", () => {
      session.proc = null;
      session.clients.forEach((ws) => { try { ws.close(); } catch (e) {} });
      this.sessions.delete(id);
    });
    this.sessions.set(id, session);
    return session;
  }

  history(session) {
    if (session.buffer) return session.buffer;
    try {
      return execFileSync("tmux", ["capture-pane", "-p", "-S", "-2000", "-t", session.name], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (e) {
      return "";
    }
  }

  redraw(session) {
    try {
      const clients = execFileSync("tmux", [
        "list-clients", "-t", session.name, "-F", "#{client_name}"
      ], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      clients.forEach((client) => {
        try { execFileSync("tmux", ["refresh-client", "-S", "-t", client]); } catch (e) {}
      });
    } catch (e) {}
  }

  attach(ws, id) {
    const session = this.ensure(id);
    if (!session) {
      ws.close(1008, "Terminal tidak ditemukan");
      return;
    }
    session.clients.add(ws);
    // Jangan kirim raw buffer lalu redraw: itu menggandakan neofetch/prompt.
    // Reset hanya layar browser baru, lalu minta tmux menggambar satu snapshot.
    if (ws.readyState === WebSocket.OPEN) ws.send("\x1bc");
    setTimeout(() => this.redraw(session), 25);
    ws.on("message", (raw) => {
      const value = raw.toString();
      if (!session.proc) return;
      if (value[0] === "\x00") {
        try {
          const ctl = JSON.parse(value.slice(1));
          if (ctl.resize) session.proc.resize(
            Math.max(20, Math.min(500, Number(ctl.resize.cols) || 80)),
            Math.max(5, Math.min(200, Number(ctl.resize.rows) || 24))
          );
        } catch (e) {}
      } else {
        session.proc.write(value);
      }
    });
    ws.on("close", () => session.clients.delete(ws));
  }

  close(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.clients.forEach((ws) => { try { ws.close(1000, "Terminal ditutup"); } catch (e) {} });
      try { if (session.proc) session.proc.kill(); } catch (e) {}
      this.sessions.delete(id);
    }
    try { execFileSync("tmux", ["kill-session", "-t", this.tmuxName(id)]); } catch (e) {}
    this.store.change((s) => { delete s.terminals[id]; });
  }

  status() {
    const result = {};
    this.sessions.forEach((session, id) => {
      result[id] = {
        clients: session.clients.size,
        tmux: this.exists(session.name),
        cwd: session.meta.cwd,
      };
    });
    return result;
  }
}

module.exports = TerminalManager;
