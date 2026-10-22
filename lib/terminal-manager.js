"use strict";

const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const WebSocket = require("ws");
const pty = require("node-pty");

const IS_WINDOWS = process.platform === "win32";

class TerminalManager {
  constructor(options) {
    this.workspace = options.workspace;
    this.rcfile = options.rcfile;
    this.shell = options.shell || (IS_WINDOWS ? "powershell.exe" : "/bin/bash");
    this.store = options.store;
    this.safe = options.safe;
    this.sessions = new Map();
    this.sequence = 0;
    // Mode "direct": shell dijalankan langsung lewat node-pty (Windows/ConPTY, atau
    // Linux tanpa tmux). Tanpa tmux terminal tidak persisten melewati restart,
    // tetapi tetap bisa dipakai — bukan crash saat tmux tidak terpasang.
    this.hasTmux = !IS_WINDOWS && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
    this.direct = IS_WINDOWS || !this.hasTmux;
    Object.keys(this.store.state.terminals || {}).forEach((id) => {
      try { this.ensure(id); } catch (e) {}
    });
  }

  tmuxName(id) {
    return "c9_" + String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  exists(name) {
    if (this.direct) return false;
    return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
  }

  create(cwd) {
    let resolved = this.workspace;
    try { if (cwd) resolved = this.safe(cwd); } catch (e) {}
    const id = "term-" + Date.now().toString(36) + "-" + (++this.sequence).toString(36);
    const count = Object.keys(this.store.state.terminals || {}).length + 1;
    const title = (IS_WINDOWS ? "shell " : "bash ") + count;
    const meta = { id, title, cwd: resolved, createdAt: Date.now() };
    this.store.change((s) => { s.terminals[id] = meta; });
    this.ensure(id);
    return meta;
  }

  // Pasang handler output/exit yang sama untuk semua platform.
  // Memakai onData/onExit (API node-pty v1) agar konsisten lintas platform.
  wireProcess(session) {
    const proc = session.proc;
    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-512 * 1024);
      session.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(data); } catch (e) {}
        }
      });
    });
    proc.onExit(() => {
      session.proc = null;
      session.clients.forEach((ws) => { try { ws.close(); } catch (e) {} });
      this.sessions.delete(session.id);
    });
  }

  ensure(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const meta = this.store.state.terminals[id];
    if (!meta) return null;
    return this.direct ? this.ensureDirect(id, meta) : this.ensureTmux(id, meta);
  }

  // Shell langsung lewat node-pty (Windows/ConPTY atau Unix tanpa tmux). Tidak
  // persisten melewati restart proses server.
  ensureDirect(id, meta) {
    const shell = this.shell;
    const base = path.basename(shell).toLowerCase();
    let args = [];
    if (/^powershell/.test(base) || base === "pwsh.exe" || base === "pwsh") args = ["-NoLogo"];
    else if (!IS_WINDOWS) args = base === "bash" && this.rcfile ? ["--rcfile", this.rcfile, "-i"] : ["-i"];
    const proc = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: meta.cwd || this.workspace,
      env: Object.assign({}, process.env),
    });
    const session = { id, meta, name: this.tmuxName(id), proc, clients: new Set(), buffer: "" };
    this.wireProcess(session);
    this.sessions.set(id, session);
    return session;
  }

  // Unix: shell persisten via named tmux session.
  ensureTmux(id, meta) {
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
        // Pane idle di prompt (└─$ / └─#): bersihkan layar agar snapshot rapi.
        if (/└─[$#]\s*$/.test(last)) execFileSync("tmux", ["send-keys", "-t", name, "clear", "C-m"]);
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
    this.wireProcess(session);
    this.sessions.set(id, session);
    return session;
  }

  redraw(session) {
    if (this.direct) return;
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
    if (this.direct) {
      // Tanpa tmux: kirim ulang buffer agar browser baru melihat riwayat output.
      if (ws.readyState === WebSocket.OPEN && session.buffer) {
        try { ws.send(session.buffer); } catch (e) {}
      }
    } else {
      // Jangan kirim raw buffer lalu redraw: itu menggandakan neofetch/prompt.
      // Reset hanya layar browser baru, lalu minta tmux menggambar satu snapshot.
      if (ws.readyState === WebSocket.OPEN) ws.send("\x1bc");
      setTimeout(() => this.redraw(session), 25);
    }
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
    if (!this.direct) {
      try { execFileSync("tmux", ["kill-session", "-t", this.tmuxName(id)]); } catch (e) {}
    }
    this.store.change((s) => { delete s.terminals[id]; });
  }

  status() {
    const result = {};
    this.sessions.forEach((session, id) => {
      result[id] = {
        clients: session.clients.size,
        tmux: this.direct ? !!session.proc : this.exists(session.name),
        cwd: session.meta.cwd,
      };
    });
    return result;
  }
}

module.exports = TerminalManager;
