"use strict";

const fs = require("fs");
const path = require("path");

function initialState() {
  return {
    schema: 1,
    revision: 0,
    layout: null,
    activeLeafId: null,
    tabSeq: 0,
    nodeSeq: 0,
    docs: {},
    terminals: {},
    cursors: {},
    updatedAt: new Date().toISOString(),
  };
}

class SessionStore {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Object.assign(initialState(), parsed, {
        docs: parsed.docs || {},
        terminals: parsed.terminals || {},
        cursors: parsed.cursors || {},
      });
    } catch (e) {
      return initialState();
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  change(mutator) {
    mutator(this.state);
    this.state.revision = (this.state.revision || 0) + 1;
    this.state.updatedAt = new Date().toISOString();
    this.schedule();
    return this.state.revision;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    // Dipanggil dari timer: gagal tulis (EPERM saat file dikunci antivirus/indexer di
    // Windows, disk penuh, folder read-only) tidak boleh menjatuhkan server. Coba lagi
    // dengan jeda; state di memori tetap utuh.
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
      this.failures = 0;
    } catch (e) {
      this.failures = (this.failures || 0) + 1;
      if (this.failures <= 3 || this.failures % 20 === 0) console.warn("[store] gagal menyimpan " + path.basename(this.file) + ": " + e.message);
      this.timer = setTimeout(() => this.flush(), Math.min(30000, 1000 * this.failures));
    }
  }
}

module.exports = SessionStore;
