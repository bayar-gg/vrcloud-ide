"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX_VERSION = 1;
const MAX_FILE_SIZE = 1024 * 1024;
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".cache", "coverage",
  ".turbo", "__pycache__", ".venv", "venv", "target", "vendor", ".idea",
]);

const LANGUAGES = {
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".css": "css", ".go": "go", ".html": "html", ".htm": "html",
  ".java": "java", ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript",
  ".jsx": "javascript", ".json": "json", ".kt": "kotlin", ".kts": "kotlin",
  ".lua": "lua", ".md": "markdown", ".mdx": "markdown", ".php": "php",
  ".py": "python", ".rb": "ruby", ".rs": "rust", ".scss": "scss", ".sh": "shell",
  ".sql": "sql", ".svelte": "svelte", ".toml": "toml", ".ts": "typescript",
  ".tsx": "typescript", ".vue": "vue", ".xml": "xml", ".yaml": "yaml", ".yml": "yaml",
};

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function workspaceHash(workspace) {
  let normalized = path.resolve(workspace);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

function languageFor(file) {
  const base = path.basename(file).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANGUAGES[path.extname(base)] || "plaintext";
}

function uniqueLimited(values, max) {
  const out = [];
  const seen = new Set();
  values.forEach((value) => {
    const clean = String(value || "").trim();
    if (!clean || seen.has(clean) || out.length >= max) return;
    seen.add(clean);
    out.push(clean);
  });
  return out;
}

function extractSymbols(text) {
  const symbols = [];
  const patterns = [
    /\b(?:class|interface|enum|struct|trait|type|function|def|fn|func)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/gm,
    /^\s*(?:public|private|protected|static|async|\s)+\s*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:\{|=>)/gm,
  ];
  patterns.forEach((re) => {
    let match;
    while ((match = re.exec(text)) && symbols.length < 120) symbols.push(match[1]);
  });
  return uniqueLimited(symbols, 120);
}

function extractImports(text) {
  const imports = [];
  const patterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+["']([^"']+)["']/g,
    /^\s*import\s+["']([^"']+)["']/gm,
    /^\s*(?:from|import)\s+([A-Za-z0-9_./-]+)/gm,
    /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
    /^\s*use\s+([A-Za-z0-9_:]+)/gm,
  ];
  patterns.forEach((re) => {
    let match;
    while ((match = re.exec(text)) && imports.length < 100) imports.push(match[1]);
  });
  return uniqueLimited(imports, 100);
}

function extractTestHints(rel, text) {
  const hints = [];
  const lower = rel.toLowerCase();
  if (/(^|\/)(__tests__|tests?|spec)(\/|$)/.test(lower) || /\.(test|spec)\.[^.]+$/.test(lower)) hints.push("test-file");
  [
    ["jest", /\b(?:describe|test|it)\s*\(/],
    ["node:test", /\brequire\s*\(\s*["']node:test["']\s*\)|\bfrom\s+["']node:test["']/],
    ["pytest", /\bdef\s+test_[A-Za-z0-9_]+\s*\(/],
    ["unittest", /\b(?:unittest\.TestCase|assertEqual|assertRaises)\b/],
    ["go-test", /\bfunc\s+Test[A-Z][A-Za-z0-9_]*\s*\(/],
    ["rust-test", /#\s*\[\s*test\s*\]/],
  ].forEach(([name, re]) => { if (re.test(text)) hints.push(name); });
  return hints;
}

function termFrequencies(text) {
  const counts = new Map();
  const matches = String(text || "").toLowerCase().match(/[a-z_$][a-z0-9_$-]{1,63}/g) || [];
  matches.forEach((term) => counts.set(term, Math.min(255, (counts.get(term) || 0) + 1)));
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)))
    .slice(0, 800)
    .reduce((out, pair) => { out[pair[0]] = pair[1]; return out; }, {});
}

function looksBinary(buffer) {
  const size = Math.min(buffer.length, 8192);
  for (let i = 0; i < size; i++) if (buffer[i] === 0) return true;
  return false;
}

class WorkspaceIndex {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.hash = workspaceHash(this.workspace);
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), "data", "context"));
    this.dir = path.join(this.dataDir, this.hash);
    this.file = path.join(this.dir, "index.json");
    this.maxFileSize = Math.max(4096, Number(options.maxFileSize) || MAX_FILE_SIZE);
    this.files = {};
    this.revision = 0;
    this.updatedAt = 0;
    this._queue = Promise.resolve();
    this._unsubscribe = null;
    this.ready = this.initialize().catch((error) => {
      this.error = error;
      return this;
    });
    if (options.events && typeof options.events.onChange === "function") {
      this._unsubscribe = options.events.onChange((event) => this.applyEvent(event));
    }
  }

  normalize(rel) {
    let value = String(rel || "");
    if (path.isAbsolute(value)) {
      value = path.relative(this.workspace, path.resolve(value));
      if (value === ".." || value.startsWith(".." + path.sep) || path.isAbsolute(value)) return "";
    }
    value = toPosix(value).replace(/^\.\//, "").replace(/^\/+/, "");
    return !value || value.split("/").indexOf("..") !== -1 ? "" : value;
  }

  async initialize() {
    await this.load();
    await this.rescan();
    return this;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
      if (parsed && parsed.version === INDEX_VERSION && parsed.workspaceHash === this.hash && parsed.files && typeof parsed.files === "object") {
        this.files = parsed.files;
        this.revision = Number(parsed.revision) || 0;
        this.updatedAt = Number(parsed.updatedAt) || 0;
      }
    } catch (e) {
      if (e && e.code !== "ENOENT") this.files = {};
    }
  }

  shouldSkipDirectory(abs, name) {
    if (SKIP_DIRS.has(name)) return true;
    const contextRelative = path.relative(abs, this.dataDir);
    return contextRelative === "" || (!contextRelative.startsWith("..") && !path.isAbsolute(contextRelative));
  }

  async walk(start) {
    const out = [];
    const stack = [start];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (e) { continue; }
      entries.sort((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!this.shouldSkipDirectory(abs, entry.name)) stack.push(abs);
        } else if (entry.isFile()) {
          const rel = this.normalize(path.relative(this.workspace, abs));
          if (rel) out.push(rel);
        }
      }
    }
    out.sort();
    return out;
  }

  async buildEntry(rel, stat) {
    const abs = path.join(this.workspace, rel.split("/").join(path.sep));
    if (stat.size > this.maxFileSize) {
      return {
        path: rel, language: languageFor(rel), hash: "", mtime: stat.mtimeMs,
        mtimeMs: stat.mtimeMs, size: stat.size, symbols: [], imports: [],
        testHints: [], isTest: false, terms: {}, skipped: "large",
      };
    }
    let buffer;
    try { buffer = await fs.promises.readFile(abs); } catch (e) { return null; }
    if (looksBinary(buffer)) return null;
    const text = buffer.toString("utf8");
    const testHints = extractTestHints(rel, text);
    return {
      path: rel,
      language: languageFor(rel),
      hash: crypto.createHash("sha256").update(buffer).digest("hex"),
      mtime: stat.mtimeMs,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      symbols: extractSymbols(text),
      imports: extractImports(text),
      testHints,
      isTest: testHints.length > 0,
      terms: termFrequencies(text),
    };
  }

  sameStat(entry, stat) {
    return !!entry && Number(entry.size) === Number(stat.size) &&
      Math.abs(Number(entry.mtimeMs == null ? entry.mtime : entry.mtimeMs) - Number(stat.mtimeMs)) < 0.5;
  }

  async rescan() {
    const paths = await this.walk(this.workspace);
    const next = {};
    let changed = false;
    for (const rel of paths) {
      const abs = path.join(this.workspace, rel.split("/").join(path.sep));
      let stat;
      try { stat = await fs.promises.stat(abs); } catch (e) { continue; }
      const previous = this.files[rel];
      if (this.sameStat(previous, stat)) next[rel] = previous;
      else {
        const entry = await this.buildEntry(rel, stat);
        if (entry) next[rel] = entry;
        changed = true;
      }
    }
    if (Object.keys(this.files).some((rel) => !Object.prototype.hasOwnProperty.call(next, rel))) changed = true;
    this.files = next;
    if (changed || !this.updatedAt) await this.persist();
    return changed;
  }

  async updatePath(rel) {
    rel = this.normalize(rel);
    if (!rel) return false;
    const abs = path.join(this.workspace, rel.split("/").join(path.sep));
    let stat;
    try { stat = await fs.promises.stat(abs); }
    catch (e) {
      let changed = false;
      Object.keys(this.files).forEach((file) => {
        if (file === rel || file.startsWith(rel + "/")) { delete this.files[file]; changed = true; }
      });
      return changed;
    }
    if (stat.isDirectory()) {
      const found = await this.walk(abs);
      let changed = false;
      const live = new Set(found);
      Object.keys(this.files).forEach((file) => {
        if ((file === rel || file.startsWith(rel + "/")) && !live.has(file)) { delete this.files[file]; changed = true; }
      });
      for (const file of found) if (await this.updatePath(file)) changed = true;
      return changed;
    }
    if (!stat.isFile()) return false;
    const previous = this.files[rel];
    if (this.sameStat(previous, stat)) return false;
    const entry = await this.buildEntry(rel, stat);
    if (entry) this.files[rel] = entry;
    else delete this.files[rel];
    return !previous || !entry || previous.hash !== entry.hash || !this.sameStat(previous, stat);
  }

  applyEvent(event) {
    const work = async () => {
      await this.ready;
      let changed = false;
      if (!event || event.wildcard) changed = await this.rescan();
      else {
        for (const rel of event.changes || []) if (await this.updatePath(rel)) changed = true;
        if (changed) await this.persist();
      }
      return changed;
    };
    this._queue = this._queue.then(work, work);
    return this._queue;
  }

  async persist() {
    this.revision++;
    this.updatedAt = Date.now();
    const document = {
      version: INDEX_VERSION,
      workspaceHash: this.hash,
      workspace: this.workspace,
      revision: this.revision,
      updatedAt: this.updatedAt,
      files: this.files,
    };
    await fs.promises.mkdir(this.dir, { recursive: true });
    const temporary = this.file + ".tmp-" + process.pid + "-" + Date.now();
    await fs.promises.writeFile(temporary, JSON.stringify(document), "utf8");
    try {
      await fs.promises.rename(temporary, this.file);
    } catch (e) {
      await fs.promises.copyFile(temporary, this.file);
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  manifest() {
    return {
      version: INDEX_VERSION,
      workspaceHash: this.hash,
      revision: this.revision,
      updatedAt: this.updatedAt,
      files: this.files,
    };
  }

  async whenIdle() {
    await this.ready;
    await this._queue;
    return this;
  }

  async close() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    await this.whenIdle();
  }
}

WorkspaceIndex.workspaceHash = workspaceHash;
WorkspaceIndex.languageFor = languageFor;

module.exports = WorkspaceIndex;
