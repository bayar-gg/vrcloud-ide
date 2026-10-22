"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_BUDGET = 12000;
const DEFAULT_MAX_FILES = 12;
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "but", "can", "could", "does",
  "for", "from", "have", "how", "into", "its", "make", "need", "not", "please",
  "that", "the", "their", "then", "this", "use", "what", "when", "where", "which",
  "with", "would", "you", "your",
]);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function queryTerms(value) {
  const terms = String(value || "").toLowerCase().match(/[a-z_$][a-z0-9_$-]{1,63}/g) || [];
  return Array.from(new Set(terms.filter((term) => !STOP_WORDS.has(term)))).sort();
}

function normalizeList(values) {
  const out = [];
  (Array.isArray(values) ? values : (values ? [values] : [])).forEach((value) => {
    const rel = toPosix(value);
    if (rel && rel.split("/").indexOf("..") === -1 && out.indexOf(rel) === -1) out.push(rel);
  });
  return out;
}

class ContextEngine {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.index = options.index;
    if (!this.index) throw new Error("ContextEngine requires a WorkspaceIndex");
    this.lspManager = options.lspManager || null;
    this.memoryStore = options.memoryStore || null;
    this.characterBudget = Math.max(256, Number(options.characterBudget) || DEFAULT_BUDGET);
    this.maxFiles = Math.max(1, Number(options.maxFiles) || DEFAULT_MAX_FILES);
    this.cache = new Map();
    this._unsubscribe = null;
    if (options.events && typeof options.events.onChange === "function") {
      this._unsubscribe = options.events.onChange(() => this.invalidate());
    }
  }

  invalidate() {
    this.cache.clear();
  }

  explicitPaths(query, knownPaths) {
    const out = [];
    const text = String(query || "");
    const lower = text.toLowerCase().replace(/\\/g, "/");
    knownPaths.forEach((rel) => {
      const candidate = rel.toLowerCase();
      const base = path.posix.basename(candidate);
      if (lower.indexOf(candidate) !== -1 || (base.length > 3 && lower.indexOf(base) !== -1)) out.push(rel);
    });
    const pathLike = text.match(/(?:^|[\s`"'(@])@?([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)/g) || [];
    pathLike.forEach((token) => {
      const cleaned = toPosix(token.trim().replace(/^[`"'(@]+|[`"',)]+$/g, "").replace(/^@/, ""));
      const found = knownPaths.find((rel) => rel.toLowerCase() === cleaned.toLowerCase());
      if (found && out.indexOf(found) === -1) out.push(found);
    });
    return out;
  }

  score(entry, rel, terms, priorities) {
    let score = 0;
    const reason = [];
    const relLower = rel.toLowerCase();
    const base = path.posix.basename(relLower);
    const activeAt = priorities.active.indexOf(rel);
    const openAt = priorities.open.indexOf(rel);
    const explicitAt = priorities.explicit.indexOf(rel);
    if (activeAt !== -1) { score += 30000 - activeAt; reason.push("active"); }
    if (openAt !== -1) { score += 20000 - openAt; reason.push("open"); }
    if (explicitAt !== -1) { score += 10000 - explicitAt; reason.push("explicit"); }

    const symbolSet = new Set((entry.symbols || []).map((value) => String(value).toLowerCase()));
    const imports = (entry.imports || []).map((value) => String(value).toLowerCase());
    terms.forEach((term) => {
      let hit = 0;
      if (base === term || base.replace(/\.[^.]+$/, "") === term) hit += 180;
      else if (base.indexOf(term) !== -1) hit += 120;
      else if (relLower.indexOf(term) !== -1) hit += 70;
      if (symbolSet.has(term)) hit += 100;
      else if ((entry.symbols || []).some((symbol) => String(symbol).toLowerCase().indexOf(term) !== -1)) hit += 55;
      if (imports.some((value) => value.indexOf(term) !== -1)) hit += 35;
      const frequency = entry.terms && Number(entry.terms[term]);
      if (frequency) hit += Math.min(40, 8 + frequency * 2);
      if (hit) { score += hit; reason.push(term); }
    });
    if (terms.some((term) => /^(test|tests|testing|spec)$/.test(term)) && entry.isTest) score += 45;
    return { score, reason: Array.from(new Set(reason)) };
  }

  relevantLines(text, terms, preferred, limit) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    if (!lines.length) return "";
    const hits = [];
    if (terms.length) {
      lines.forEach((line, index) => {
        const lower = line.toLowerCase();
        let weight = 0;
        terms.forEach((term) => { if (lower.indexOf(term) !== -1) weight++; });
        if (weight) hits.push({ index, weight });
      });
      hits.sort((a, b) => (b.weight - a.weight) || (a.index - b.index));
    }
    const selected = new Set();
    const addWindow = (center, radius) => {
      for (let i = Math.max(0, center - radius); i <= Math.min(lines.length - 1, center + radius); i++) selected.add(i);
    };
    hits.slice(0, 6).forEach((hit) => addWindow(hit.index, 3));
    if (!selected.size || preferred) {
      const leading = preferred ? 28 : 16;
      for (let i = 0; i < Math.min(lines.length, leading); i++) selected.add(i);
    }
    const indexes = Array.from(selected).sort((a, b) => a - b);
    const output = [];
    let previous = -2;
    for (const index of indexes) {
      if (previous >= 0 && index > previous + 1) output.push("...");
      output.push(String(index + 1) + ": " + lines[index]);
      previous = index;
      if (output.join("\n").length >= limit) break;
    }
    return output.join("\n").slice(0, limit);
  }

  async retrieve(query, options) {
    options = options || {};
    await this.index.whenIdle();
    if (this.memoryStore && this.memoryStore.ready) await this.memoryStore.ready;
    const manifest = this.index.manifest();
    const knownPaths = Object.keys(manifest.files).sort();
    const active = normalizeList(options.active);
    const open = normalizeList(options.open).filter((rel) => active.indexOf(rel) === -1);
    const explicit = normalizeList(options.explicit).concat(this.explicitPaths(query, knownPaths))
      .filter((rel, index, all) => active.indexOf(rel) === -1 && open.indexOf(rel) === -1 && all.indexOf(rel) === index);
    const canonical = (values) => values.map((value) =>
      knownPaths.find((rel) => rel.toLowerCase() === value.toLowerCase())).filter(Boolean);
    const priorities = {
      active: canonical(active),
      open: canonical(open),
      explicit: canonical(explicit),
    };
    const terms = queryTerms(query);
    const budget = Math.max(0, Number(options.characterBudget == null ? this.characterBudget : options.characterBudget) || 0);
    const maxFiles = Math.max(1, Number(options.maxFiles) || this.maxFiles);
    const ranked = knownPaths.map((rel) => {
      const entry = manifest.files[rel];
      const rank = this.score(entry, rel, terms, priorities);
      return { rel, entry, score: rank.score, reason: rank.reason };
    }).filter((item) => item.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0)))
      .slice(0, maxFiles);

    const semanticPaths = Array.from(new Set(
      priorities.active.concat(priorities.open, priorities.explicit, ranked.slice(0, 6).map((item) => item.rel))
    ));
    let semantic = { diagnostics: [], symbols: [], revision: 0 };
    if (this.lspManager) {
      try { semantic = this.lspManager.contextSnapshot(query, semanticPaths); } catch (e) {}
      try { this.lspManager.prime(query, semanticPaths); } catch (e) {}
    }
    let memories = [];
    if (this.memoryStore && typeof this.memoryStore.cachedSearch === "function") {
      try { memories = this.memoryStore.cachedSearch(query, { limit: 8 }); } catch (e) {}
    }
    const key = JSON.stringify({
      revision: manifest.revision,
      lspRevision: semantic.revision || 0,
      memoryRevision: this.memoryStore ? this.memoryStore.revision : 0,
      query: String(query || ""), priorities, budget, maxFiles,
      readOnly: !!options.readOnly,
    });
    const cached = this.cache.get(key);
    if (cached) return cached;

    const readOnly = !!options.readOnly;
    const header = readOnly
      ? "[Read-only workspace context — use this evidence to answer; do not modify files]\n"
      : "[Relevant workspace context — retrieved from the incremental index]\n";
    let text = header.slice(0, budget);
    if (memories.length && text.length < budget) {
      const lines = memories.map((memory) => {
        const evidence = (memory.evidence || []).map((item) => item.path).filter(Boolean).join(", ");
        return "- [" + memory.kind + ":" + memory.id + "] " + memory.statement + (evidence ? " (evidence: " + evidence + ")" : "");
      });
      const memoryBudget = Math.min(2000, Math.floor(budget * 0.2), Math.max(0, budget - text.length));
      text += ("\n[Active structured project memory]\n" + lines.join("\n") + "\n").slice(0, memoryBudget);
    }
    if ((semantic.symbols.length || semantic.diagnostics.length) && text.length < budget) {
      const lines = [];
      semantic.symbols.slice(0, 20).forEach((symbol) => {
        lines.push("- symbol " + symbol.name + " — " + symbol.path);
      });
      semantic.diagnostics.slice(0, 20).forEach((diagnostic) => {
        const start = diagnostic.range && diagnostic.range.start;
        const where = diagnostic.path + (start ? ":" + (Number(start.line) + 1) + ":" + (Number(start.character) + 1) : "");
        lines.push("- diagnostic " + where + " — " + diagnostic.message);
      });
      const semanticBudget = Math.min(2500, Math.floor(budget * 0.25), Math.max(0, budget - text.length));
      text += ("\n[Cached language-server context]\n" + lines.join("\n") + "\n").slice(0, semanticBudget);
    }
    const files = [];
    for (const item of ranked) {
      if (text.length >= budget) break;
      const abs = path.join(this.workspace, item.rel.split("/").join(path.sep));
      let content;
      try { content = await fs.promises.readFile(abs, "utf8"); } catch (e) { continue; }
      const sectionHeader = "\n--- " + item.rel + " (" + item.entry.language + "; " + item.reason.join(", ") + ") ---\n";
      const remaining = budget - text.length - sectionHeader.length;
      if (remaining <= 24) break;
      const preferred = priorities.active.indexOf(item.rel) !== -1 || priorities.open.indexOf(item.rel) !== -1;
      const excerpt = this.relevantLines(content, terms, preferred, remaining);
      if (!excerpt) continue;
      text += sectionHeader + excerpt;
      files.push({ path: item.rel, language: item.entry.language, score: item.score, reason: item.reason });
    }
    if (text.length > budget) text = text.slice(0, budget);
    const result = {
      text, files, characterCount: text.length, budget, indexRevision: manifest.revision,
      diagnostics: semantic.diagnostics, symbols: semantic.symbols,
      memories: memories.map((memory) => memory.id),
    };
    this.cache.set(key, result);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  async buildContext(options) {
    options = options || {};
    const result = await this.retrieve(options.query || "", options);
    return result.text;
  }

  async context(options) {
    return this.buildContext(options);
  }

  close() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    this.cache.clear();
  }
}

ContextEngine.queryTerms = queryTerms;

module.exports = ContextEngine;
