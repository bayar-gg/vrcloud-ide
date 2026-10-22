"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WorkspaceIndex = require("./workspace-index");

const VERSION = 1;
const STATUSES = new Set(["active", "stale", "invalid", "superseded"]);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function jsonClone(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return fallback; }
}

function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}

function terms(value) {
  return Array.from(new Set((String(value || "").toLowerCase().match(/[a-z0-9_$.-]{2,64}/g) || [])));
}

class MemoryStore {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.workspaceHash = WorkspaceIndex.workspaceHash(this.workspace);
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data", "context"));
    this.dir = path.join(this.dataDir, this.workspaceHash);
    this.file = path.join(this.dir, "memory.json");
    this.records = [];
    this.revision = 0;
    this.updatedAt = 0;
    this.maxRecords = Math.max(10, Number(options.maxRecords) || 2000);
    // Tampilan Markdown di workspace. Sebelumnya ada dua memori yang tidak saling kenal:
    // prompt menyuruh agent menulis .vrcloud-agent/memory.md, sementara tool memory_*
    // menulis memory.json di data/. Sekarang memory.json adalah sumber kebenaran untuk
    // fakta terstruktur, dan bagian bertanda di memory.md dirender darinya; catatan bebas
    // pengguna/agent di luar penanda tidak disentuh.
    this.markdownFile = options.markdownFile === false ? "" : path.resolve(options.markdownFile ||
      path.join(this.workspace, ".vrcloud-agent", "memory.md"));
    this._lastMarkdown = null;
    this._queue = Promise.resolve();
    this._unsubscribe = null;
    this.ready = this.load().catch((error) => {
      this.error = error;
      this.records = [];
      return this;
    });
    if (options.events && typeof options.events.onChange === "function") {
      this._unsubscribe = options.events.onChange((event) => {
        this.invalidate(event).catch(() => {});
      });
    }
  }

  normalizePath(value) {
    let rel = String(value || "");
    if (path.isAbsolute(rel)) {
      rel = path.relative(this.workspace, path.resolve(rel));
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "";
    }
    rel = toPosix(rel);
    return !rel || rel.split("/").indexOf("..") !== -1 ? "" : rel;
  }

  absolute(rel) {
    rel = this.normalizePath(rel);
    return rel ? path.join(this.workspace, rel.split("/").join(path.sep)) : "";
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
      if (parsed && parsed.version === VERSION && parsed.workspaceHash === this.workspaceHash && Array.isArray(parsed.records)) {
        this.records = parsed.records.map((record) => this._normalizeLoaded(record)).filter(Boolean).slice(-this.maxRecords);
        this.revision = Math.max(0, Number(parsed.revision) || 0);
        this.updatedAt = Math.max(0, Number(parsed.updatedAt) || 0);
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") this.records = [];
    }
    this._expire(Date.now());
    return this;
  }

  _normalizeLoaded(record) {
    if (!record || !record.id || !record.statement) return null;
    const status = STATUSES.has(record.status) ? record.status : "active";
    return {
      id: String(record.id),
      kind: String(record.kind || "fact"),
      statement: String(record.statement),
      scope: jsonClone(record.scope == null ? "workspace" : record.scope, "workspace"),
      evidence: this._evidence(record.evidence),
      provenance: jsonClone(record.provenance == null ? { source: "unknown" } : record.provenance, { source: "unknown" }),
      confidence: this._confidence(record.confidence),
      ttl: record.ttl == null ? null : Math.max(0, Number(record.ttl) || 0),
      expiresAt: record.expiresAt == null ? null : Math.max(0, Number(record.expiresAt) || 0),
      status,
      createdAt: Math.max(0, Number(record.createdAt) || Date.now()),
      updatedAt: Math.max(0, Number(record.updatedAt) || Date.now()),
      validatedAt: record.validatedAt == null ? null : Math.max(0, Number(record.validatedAt) || 0),
      invalidatedAt: record.invalidatedAt == null ? null : Math.max(0, Number(record.invalidatedAt) || 0),
      invalidationReason: record.invalidationReason ? String(record.invalidationReason) : "",
      supersedes: record.supersedes ? String(record.supersedes) : "",
      supersededBy: record.supersededBy ? String(record.supersededBy) : "",
    };
  }

  _confidence(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.7;
    return Math.max(0, Math.min(1, number));
  }

  _evidence(value) {
    const out = [];
    (Array.isArray(value) ? value : (value ? [value] : [])).forEach((entry) => {
      if (typeof entry === "string") entry = { path: entry };
      if (!entry || typeof entry !== "object") return;
      const rel = this.normalizePath(entry.path);
      if (!rel) return;
      const range = entry.range && typeof entry.range === "object" ? jsonClone(entry.range, null) : null;
      out.push({
        path: rel,
        range,
        hash: entry.hash ? String(entry.hash).toLowerCase() : "",
      });
    });
    return out;
  }

  _scopePaths(scope) {
    const values = [];
    if (typeof scope === "string" && /[\\/]/.test(scope)) values.push(scope);
    else if (scope && typeof scope === "object") {
      if (typeof scope.path === "string") values.push(scope.path);
      if (Array.isArray(scope.paths)) values.push.apply(values, scope.paths);
    }
    return values.map((value) => this.normalizePath(value)).filter(Boolean);
  }

  _newId() {
    return "mem-" + Date.now().toString(36) + "-" + crypto.randomBytes(5).toString("hex");
  }

  async _hash(rel) {
    const abs = this.absolute(rel);
    if (!abs) return "";
    try {
      const buffer = await fs.promises.readFile(abs);
      return crypto.createHash("sha256").update(buffer).digest("hex");
    } catch (error) {
      return "";
    }
  }

  async _hydrateEvidence(evidence, replaceHashes) {
    const out = [];
    for (const item of this._evidence(evidence)) {
      const current = await this._hash(item.path);
      out.push(Object.assign({}, item, { hash: replaceHashes || !item.hash ? current : item.hash }));
    }
    return out;
  }

  _enqueue(work) {
    const run = async () => {
      await this.ready;
      return work();
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  _expire(now) {
    let changed = false;
    this.records.forEach((record) => {
      if (record.status === "active" && record.expiresAt && record.expiresAt <= now) {
        record.status = "stale";
        record.invalidatedAt = now;
        record.invalidationReason = "ttl-expired";
        changed = true;
      }
    });
    return changed;
  }

  async _persist() {
    this.revision++;
    this.updatedAt = Date.now();
    const document = {
      version: VERSION,
      workspaceHash: this.workspaceHash,
      workspace: this.workspace,
      revision: this.revision,
      updatedAt: this.updatedAt,
      records: this.records,
    };
    await fs.promises.mkdir(this.dir, { recursive: true });
    const temporary = this.file + ".tmp-" + process.pid + "-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    await fs.promises.writeFile(temporary, JSON.stringify(document, null, 2) + "\n", "utf8");
    try {
      await fs.promises.rename(temporary, this.file);
    } catch (error) {
      await fs.promises.copyFile(temporary, this.file);
      await fs.promises.unlink(temporary).catch(() => {});
    }
    await this._renderMarkdown().catch(() => {});
  }

  static get MARK_START() { return "<!-- vrcloud:structured-memory start -->"; }
  static get MARK_END() { return "<!-- vrcloud:structured-memory end -->"; }

  // Teks Markdown untuk rekaman aktif (dipakai juga oleh prompt agent).
  renderMarkdown() {
    const active = this.records.filter((r) => r && r.status === "active")
      .sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const L = [
      MemoryStore.MARK_START,
      "<!-- Generated from structured memory (" + active.length + " active fact" + (active.length === 1 ? "" : "s") + "). " +
        "Change it with the memory_upsert / memory_forget tools, not by hand: edits inside these markers are overwritten. -->",
      "## Structured memory",
    ];
    if (!active.length) L.push("_No facts recorded yet._");
    let kind = null;
    active.slice(0, 400).forEach((r) => {
      if (r.kind !== kind) { kind = r.kind; L.push("", "### " + kind); }
      const ev = (r.evidence || []).map((e) => e.path).filter(Boolean).slice(0, 4);
      const scope = r.scope && r.scope !== "workspace" ? (typeof r.scope === "string" ? r.scope : JSON.stringify(r.scope)) : "";
      const tail = [scope ? "scope " + scope : "", ev.length ? "evidence " + ev.join(", ") : "", "confidence " + Number(r.confidence || 0).toFixed(2)].filter(Boolean).join(" \u00b7 ");
      L.push("- " + String(r.statement).replace(/\s+/g, " ").trim() + (tail ? "  \u2014 " + tail : "") + "  <!-- id " + r.id + " -->");
    });
    L.push(MemoryStore.MARK_END);
    return L.join("\n");
  }

  // Tulis blok bertanda ke memory.md, mempertahankan teks di luar penanda. Tidak membuat
  // file hanya untuk menulis "belum ada fakta", dan tidak menulis ulang isi yang sama —
  // itu mencegah loop dengan watcher workspace yang memanggil invalidate().
  async _renderMarkdown() {
    if (!this.markdownFile) return false;
    const block = this.renderMarkdown();
    if (block === this._lastMarkdown) return false;
    let current = "";
    try { current = await fs.promises.readFile(this.markdownFile, "utf8"); } catch (e) { current = ""; }
    const hasActive = this.records.some((r) => r && r.status === "active");
    const a = current.indexOf(MemoryStore.MARK_START), b = current.indexOf(MemoryStore.MARK_END);
    let next;
    if (a !== -1 && b !== -1 && b > a) {
      next = current.slice(0, a) + block + current.slice(b + MemoryStore.MARK_END.length);
    } else {
      if (!hasActive && !current) { this._lastMarkdown = block; return false; }
      const head = current.trim() ? current.replace(/\s+$/, "") + "\n\n" : "# Project memory\n\nFree-form notes for the agent go above this block; the block itself is generated.\n\n";
      next = head + block + "\n";
    }
    if (next === current) { this._lastMarkdown = block; return false; }
    await fs.promises.mkdir(path.dirname(this.markdownFile), { recursive: true });
    const tmp = this.markdownFile + ".tmp-" + process.pid;
    await fs.promises.writeFile(tmp, next, "utf8");
    try { await fs.promises.rename(tmp, this.markdownFile); }
    catch (e) { await fs.promises.copyFile(tmp, this.markdownFile); await fs.promises.unlink(tmp).catch(() => {}); }
    this._lastMarkdown = block;
    return true;
  }

  _public(record) {
    return jsonClone(record, null);
  }

  async search(query, options) {
    options = options || {};
    await this.ready;
    const expired = this._expire(Date.now());
    if (expired) this._enqueue(() => this._persist()).catch(() => {});
    const queryTerms = terms(query);
    const statuses = options.status
      ? new Set(Array.isArray(options.status) ? options.status.map(String) : [String(options.status)])
      : new Set(options.includeStale ? ["active", "stale"] : ["active"]);
    const kind = options.kind ? String(options.kind).toLowerCase() : "";
    const scope = options.scope == null ? "" : stable(options.scope);
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 20));
    return this.records.map((record) => {
      if (!statuses.has(record.status)) return null;
      if (kind && record.kind.toLowerCase() !== kind) return null;
      if (scope && stable(record.scope) !== scope) return null;
      const haystack = [
        record.id, record.statement, record.kind, stable(record.scope), stable(record.provenance),
        record.evidence.map((entry) => entry.path).join(" "),
      ].join(" ").toLowerCase();
      let score = queryTerms.length ? 0 : 1;
      queryTerms.forEach((term) => {
        if (record.statement.toLowerCase().indexOf(term) !== -1) score += 10;
        else if (haystack.indexOf(term) !== -1) score += 3;
      });
      if (queryTerms.length && score === 0) return null;
      score += record.confidence * 2;
      if (record.status === "active") score += 2;
      return { record, score };
    }).filter(Boolean)
      .sort((a, b) => (b.score - a.score) || (b.record.updatedAt - a.record.updatedAt) || a.record.id.localeCompare(b.record.id))
      .slice(0, limit)
      .map((entry) => this._public(entry.record));
  }

  cachedSearch(query, options) {
    options = options || {};
    const queryTerms = terms(query);
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 8));
    return this.records.filter((record) => record.status === "active" && (!record.expiresAt || record.expiresAt > Date.now()))
      .map((record) => {
        const haystack = (record.id + " " + record.statement + " " + record.kind + " " + stable(record.scope)).toLowerCase();
        let score = queryTerms.length ? queryTerms.reduce((sum, term) => sum + (haystack.indexOf(term) !== -1 ? 1 : 0), 0) : 1;
        if (!score) return null;
        score += record.confidence;
        return { record, score };
      }).filter(Boolean)
      .sort((a, b) => (b.score - a.score) || (b.record.updatedAt - a.record.updatedAt))
      .slice(0, limit)
      .map((entry) => this._public(entry.record));
  }

  upsert(input) {
    input = input || {};
    return this._enqueue(async () => {
      const statement = String(input.statement || "").replace(/\s+/g, " ").trim();
      if (!statement) throw new Error("Memory statement is required");
      if (statement.length > 8000) throw new Error("Memory statement is too long");
      const kind = String(input.kind || "fact").trim().slice(0, 80) || "fact";
      const scope = jsonClone(input.scope == null ? "workspace" : input.scope, "workspace");
      const requestedId = input.id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(input.id)) ? String(input.id) : "";
      let record = requestedId ? this.records.find((item) => item.id === requestedId) : null;
      if (!record) {
        record = this.records.find((item) =>
          item.status === "active" && item.kind === kind && item.statement === statement && stable(item.scope) === stable(scope));
      }
      const now = Date.now();
      const ttl = input.ttl == null && input.ttlMs == null && input.ttlSeconds == null
        ? (record ? record.ttl : null)
        : Math.max(0, Number(input.ttlMs != null ? input.ttlMs : (input.ttlSeconds != null ? Number(input.ttlSeconds) * 1000 : input.ttl)) || 0);
      const evidence = await this._hydrateEvidence(input.evidence == null && record ? record.evidence : input.evidence, false);
      const evidenceMissing = evidence.some((item) => !item.hash);
      const nextStatus = evidenceMissing ? "invalid" : (STATUSES.has(input.status) ? input.status : "active");
      if (!record) {
        record = {
          id: requestedId || this._newId(),
          kind, statement, scope, evidence,
          provenance: jsonClone(input.provenance == null ? { source: "agent" } : input.provenance, { source: "agent" }),
          confidence: this._confidence(input.confidence),
          ttl, expiresAt: ttl ? now + ttl : null,
          status: nextStatus,
          createdAt: now, updatedAt: now, validatedAt: now,
          invalidatedAt: evidenceMissing ? now : null, invalidationReason: evidenceMissing ? "evidence-missing" : "",
          supersedes: input.supersedes ? String(input.supersedes) : "", supersededBy: "",
        };
        this.records.push(record);
      } else {
        Object.assign(record, {
          kind, statement, scope, evidence,
          provenance: input.provenance == null ? record.provenance : jsonClone(input.provenance, record.provenance),
          confidence: input.confidence == null ? record.confidence : this._confidence(input.confidence),
          ttl, expiresAt: ttl ? now + ttl : null,
          status: nextStatus,
          updatedAt: now, validatedAt: now,
          invalidatedAt: evidenceMissing ? now : null,
          invalidationReason: evidenceMissing ? "evidence-missing" : "",
        });
        if (input.supersedes != null) record.supersedes = String(input.supersedes || "");
      }
      if (record.supersedes) {
        const previous = this.records.find((item) => item.id === record.supersedes && item.id !== record.id);
        if (previous) {
          previous.status = "superseded";
          previous.supersededBy = record.id;
          previous.updatedAt = now;
          previous.invalidatedAt = now;
          previous.invalidationReason = "superseded";
        }
      }
      if (this.records.length > this.maxRecords) {
        const removable = this.records.filter((item) => item.status !== "active")
          .sort((a, b) => a.updatedAt - b.updatedAt);
        while (this.records.length > this.maxRecords && removable.length) {
          const remove = removable.shift();
          this.records.splice(this.records.indexOf(remove), 1);
        }
      }
      await this._persist();
      return this._public(record);
    });
  }

  forget(id) {
    return this._enqueue(async () => {
      const record = this.records.find((item) => item.id === String(id || ""));
      if (!record) return null;
      const now = Date.now();
      record.status = "invalid";
      record.updatedAt = now;
      record.invalidatedAt = now;
      record.invalidationReason = "forgotten";
      await this._persist();
      return this._public(record);
    });
  }

  revalidate(id, options) {
    options = options || {};
    return this._enqueue(async () => {
      const record = this.records.find((item) => item.id === String(id || ""));
      if (!record) return null;
      const now = Date.now();
      const evidence = options.evidence == null ? record.evidence : options.evidence;
      record.evidence = await this._hydrateEvidence(evidence, true);
      const missing = record.evidence.some((item) => !item.hash);
      record.status = missing ? "invalid" : "active";
      record.invalidatedAt = missing ? now : null;
      record.invalidationReason = missing ? "evidence-missing" : "";
      record.validatedAt = now;
      record.updatedAt = now;
      if (options.statement != null) {
        const statement = String(options.statement).replace(/\s+/g, " ").trim();
        if (!statement) throw new Error("Memory statement is required");
        record.statement = statement;
      }
      if (options.confidence != null) record.confidence = this._confidence(options.confidence);
      if (record.ttl) record.expiresAt = now + record.ttl;
      await this._persist();
      return this._public(record);
    });
  }

  invalidate(event) {
    return this._enqueue(async () => {
      const changes = event && Array.isArray(event.changes)
        ? event.changes.map((value) => this.normalizePath(value)).filter(Boolean) : [];
      const wildcard = !event || event.wildcard;
      const now = Date.now();
      let changed = this._expire(now);
      for (const record of this.records) {
        if (record.status !== "active") continue;
        const affected = record.evidence.filter((entry) => wildcard || changes.some((rel) =>
          entry.path === rel || entry.path.startsWith(rel + "/") || rel.startsWith(entry.path + "/")));
        const scopePaths = this._scopePaths(record.scope);
        const scopeAffected = scopePaths.some((scopePath) => wildcard || changes.some((rel) =>
          scopePath === rel || scopePath.startsWith(rel + "/") || rel.startsWith(scopePath + "/")));
        if (!affected.length && !scopeAffected) continue;
        if (!record.evidence.length && scopeAffected) {
          record.status = "stale";
          record.invalidatedAt = now;
          record.updatedAt = now;
          record.invalidationReason = "scope-changed";
          changed = true;
          continue;
        }
        let missing = false;
        let mismatched = scopeAffected && !affected.length;
        for (const evidence of affected) {
          const hash = await this._hash(evidence.path);
          if (!hash) missing = true;
          else if (!evidence.hash || evidence.hash !== hash) mismatched = true;
        }
        if (!missing && !mismatched) continue;
        record.status = missing ? "invalid" : "stale";
        record.invalidatedAt = now;
        record.updatedAt = now;
        record.invalidationReason = missing ? "evidence-missing"
          : (scopeAffected && !affected.length ? "scope-changed" : "evidence-changed");
        changed = true;
      }
      if (changed) await this._persist();
      return changed;
    });
  }

  async whenIdle() {
    await this.ready;
    await this._queue;
    return this;
  }

  status() {
    const counts = { active: 0, stale: 0, invalid: 0, superseded: 0 };
    this.records.forEach((record) => { if (counts[record.status] != null) counts[record.status]++; });
    return {
      version: VERSION, workspaceHash: this.workspaceHash, revision: this.revision,
      updatedAt: this.updatedAt, file: this.file, counts,
    };
  }

  async close() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    await this.whenIdle();
  }
}

module.exports = MemoryStore;
