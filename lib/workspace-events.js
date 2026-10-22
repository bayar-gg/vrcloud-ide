"use strict";

const path = require("path");
const { EventEmitter } = require("events");

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

class WorkspaceEvents {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.dedupeMs = Math.max(0, Number(options.dedupeMs) || 150);
    this.seq = 0;
    this.emitter = new EventEmitter();
    this.recent = new Map();
    this.pending = new Map();
  }

  normalize(change) {
    let value = typeof change === "string" ? change : (change && change.path);
    if (!value) return "";
    value = String(value);
    if (path.isAbsolute(value)) {
      const relative = path.relative(this.workspace, path.resolve(value));
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return "";
      value = relative;
    }
    value = toPosix(value).replace(/^\.\//, "").replace(/^\/+/, "");
    const parts = value.split("/");
    if (!value || parts.indexOf("..") !== -1) return "";
    return value;
  }

  publish(source, changes, options) {
    options = options || {};
    const now = Date.now();
    const normalized = [];
    (Array.isArray(changes) ? changes : (changes == null ? [] : [changes])).forEach((change) => {
      const rel = this.normalize(change);
      if (rel && normalized.indexOf(rel) === -1) normalized.push(rel);
    });
    normalized.sort();
    const wildcard = options.wildcard === true || (!normalized.length && options.wildcard !== false);
    const key = wildcard ? "*" : normalized.join("\n");
    const previous = this.recent.get(key);
    if (previous != null && now - previous < this.dedupeMs) {
      this._scheduleTrailing(key, {
        source: String(source || "unknown"),
        changes: normalized,
        wildcard,
      });
      return null;
    }

    this._cancelPending(key);
    this.recent.set(key, now);
    if (this.recent.size > 256) {
      const cutoff = now - Math.max(this.dedupeMs * 4, 1000);
      this.recent.forEach((at, recentKey) => { if (at < cutoff) this.recent.delete(recentKey); });
    }

    return this._emit({
      source: String(source || "unknown"),
      changes: normalized,
      wildcard,
    }, now);
  }

  _emit(value, at) {
    const event = {
      seq: ++this.seq,
      at: at == null ? Date.now() : at,
      source: value.source,
      changes: value.changes,
      wildcard: value.wildcard,
    };
    this.emitter.emit("change", event);
    return event;
  }

  _cancelPending(key) {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  _scheduleTrailing(key, value) {
    this._cancelPending(key);
    const pending = Object.assign({}, value);
    pending.timer = setTimeout(() => {
      if (this.pending.get(key) !== pending) return;
      this.pending.delete(key);
      const now = Date.now();
      this.recent.set(key, now);
      this._emit(pending, now);
    }, this.dedupeMs);
    if (pending.timer.unref) pending.timer.unref();
    this.pending.set(key, pending);
  }

  flush() {
    const entries = Array.from(this.pending.entries());
    entries.forEach(([key, pending]) => {
      clearTimeout(pending.timer);
      if (this.pending.get(key) !== pending) return;
      this.pending.delete(key);
      const now = Date.now();
      this.recent.set(key, now);
      this._emit(pending, now);
    });
  }

  close() {
    this.pending.forEach((pending) => clearTimeout(pending.timer));
    this.pending.clear();
    this.emitter.removeAllListeners();
  }

  onChange(listener) {
    this.emitter.on("change", listener);
    return () => this.emitter.removeListener("change", listener);
  }
}

module.exports = WorkspaceEvents;
