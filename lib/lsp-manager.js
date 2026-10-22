"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL, fileURLToPath } = require("url");

const DEFAULT_PROFILES = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"],
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
  },
  go: {
    command: "gopls",
    args: ["serve"],
    extensions: [".go"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
  },
};

const LANGUAGE_IDS = {
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescriptreact", ".py": "python", ".go": "go", ".rs": "rust",
};

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function cloneProfiles(overrides) {
  const out = {};
  Object.keys(DEFAULT_PROFILES).forEach((key) => {
    out[key] = Object.assign({}, DEFAULT_PROFILES[key], (overrides && overrides[key]) || {});
    out[key].args = Array.isArray(out[key].args) ? out[key].args.slice() : [];
    out[key].extensions = Array.isArray(out[key].extensions) ? out[key].extensions.slice() : [];
  });
  if (overrides) {
    Object.keys(overrides).forEach((key) => {
      if (out[key]) return;
      out[key] = Object.assign({ args: [], extensions: [] }, overrides[key]);
    });
  }
  return out;
}

function locationPath(location, workspace) {
  const uri = location && (location.uri || (location.targetUri));
  if (!uri) return "";
  try {
    const abs = fileURLToPath(uri);
    const rel = path.relative(workspace, abs);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "";
    return toPosix(rel);
  } catch (e) {
    return "";
  }
}

class JsonRpcConnection {
  constructor(readable, writable, options) {
    options = options || {};
    this.readable = readable;
    this.writable = writable;
    this.timeoutMs = Math.max(100, Number(options.timeoutMs) || 10000);
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onNotification = typeof options.onNotification === "function" ? options.onNotification : function () {};
    this.onRequest = typeof options.onRequest === "function" ? options.onRequest : function () { return null; };
    this.onError = typeof options.onError === "function" ? options.onError : function () {};
    readable.on("data", (chunk) => this._data(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.on("error", (error) => this._fail(error));
    readable.on("end", () => this._fail(new Error("LSP stream ended")));
    writable.on("error", (error) => this._fail(error));
  }

  _data(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        this.onError(new Error("Invalid LSP header"));
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      let message;
      try { message = JSON.parse(body.toString("utf8")); }
      catch (error) { this.onError(error); continue; }
      this._message(message);
    }
  }

  _message(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, "id") &&
        (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "LSP request failed");
        error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message && message.method) {
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        Promise.resolve().then(() => this.onRequest(message.method, message.params))
          .then((value) => this.respond(message.id, value == null ? null : value))
          .catch((error) => this._write({
            jsonrpc: "2.0", id: message.id,
            error: { code: -32603, message: String(error && error.message || error) },
          }).catch(() => {}));
      } else {
        try { this.onNotification(message.method, message.params); } catch (error) { this.onError(error); }
      }
    }
  }

  _write(message) {
    if (this.closed) return Promise.reject(new Error("LSP connection is closed"));
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body]);
    return new Promise((resolve, reject) => {
      this.writable.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("LSP request timed out: " + method));
      }, Math.max(100, Number(timeoutMs) || this.timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: "2.0", id, method, params: params == null ? null : params }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method, params) {
    return this._write({ jsonrpc: "2.0", method, params: params == null ? null : params });
  }

  respond(id, result) {
    return this._write({ jsonrpc: "2.0", id, result });
  }

  _fail(error) {
    if (this.closed) return;
    this.onError(error);
    this.close(error);
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    const failure = error || new Error("LSP connection closed");
    this.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(failure);
    });
    this.pending.clear();
  }
}

class LspManager {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.index = options.index || null;
    this.profiles = cloneProfiles(options.profiles);
    this.commandResolver = options.commandResolver || ((profile) => this.resolveCommand(profile.command));
    this.spawn = options.spawn || spawn;
    this.requestTimeoutMs = Math.max(200, Number(options.requestTimeoutMs) || 10000);
    this.maxRestarts = Math.max(0, Number(options.maxRestarts == null ? 3 : options.maxRestarts));
    this.backoffBaseMs = Math.max(10, Number(options.backoffBaseMs) || 250);
    this.states = new Map();
    this.documents = new Map();
    this.diagnosticsCache = new Map();
    this.definitionCache = new Map();
    this.referenceCache = new Map();
    this.symbolCache = new Map();
    this.cacheRevision = 0;
    this.closed = false;
    this._unsubscribe = null;
    if (options.events && typeof options.events.onChange === "function") {
      this._unsubscribe = options.events.onChange((event) => this.applyWorkspaceEvent(event));
    }
  }

  normalize(rel) {
    let value = String(rel || "");
    if (path.isAbsolute(value)) {
      const relative = path.relative(this.workspace, path.resolve(value));
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return "";
      value = relative;
    }
    value = toPosix(value);
    return !value || value.split("/").indexOf("..") !== -1 ? "" : value;
  }

  absolute(rel) {
    rel = this.normalize(rel);
    return rel ? path.join(this.workspace, rel.split("/").join(path.sep)) : "";
  }

  uri(rel) {
    const abs = this.absolute(rel);
    return abs ? pathToFileURL(abs).href : "";
  }

  profileKey(value) {
    if (this.profiles[value]) return value;
    const ext = path.extname(String(value || "")).toLowerCase();
    return Object.keys(this.profiles).find((key) => this.profiles[key].extensions.indexOf(ext) !== -1) || "";
  }

  languageId(rel) {
    return LANGUAGE_IDS[path.extname(String(rel || "")).toLowerCase()] || "plaintext";
  }

  state(key) {
    let state = this.states.get(key);
    if (!state) {
      state = {
        key, profile: this.profiles[key], process: null, connection: null, starting: null,
        status: "idle", command: "", error: "", restarts: 0, timer: null, stopRequested: false,
        opened: new Set(), lastDetection: 0,
      };
      this.states.set(key, state);
    }
    return state;
  }

  async resolveCommand(command) {
    command = String(command || "");
    if (!command) return "";
    const hasSeparator = command.indexOf("/") !== -1 || command.indexOf("\\") !== -1;
    const candidates = [];
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((value) => value.toLowerCase())
      : [""];
    const addWithExtensions = (base) => {
      if (path.extname(base)) candidates.push(base);
      else extensions.forEach((extension) => candidates.push(base + extension.toLowerCase()));
    };
    if (hasSeparator || path.isAbsolute(command)) addWithExtensions(path.resolve(this.workspace, command));
    else {
      addWithExtensions(path.join(this.workspace, "node_modules", ".bin", command));
      String(process.env.PATH || "").split(path.delimiter).filter(Boolean).forEach((dir) => addWithExtensions(path.join(dir, command)));
    }
    for (const candidate of candidates) {
      try {
        await fs.promises.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch (e) {}
    }
    return "";
  }

  _bump() {
    this.cacheRevision++;
  }

  async start(languageOrPath) {
    const key = this.profileKey(languageOrPath);
    if (!key || this.closed) return null;
    const state = this.state(key);
    state.stopRequested = false;
    if (state.connection && !state.connection.closed) return state;
    if (state.starting) return state.starting;
    if (state.status === "unavailable" && Date.now() - state.lastDetection < 30000) return null;
    state.starting = this._startState(state).finally(() => { state.starting = null; });
    return state.starting;
  }

  async _startState(state) {
    state.status = "detecting";
    state.lastDetection = Date.now();
    let command = "";
    try { command = await this.commandResolver(state.profile, state.key); }
    catch (error) { state.error = String(error.message || error); }
    if (!command || this.closed || state.stopRequested) {
      state.status = command ? "stopped" : "unavailable";
      return null;
    }
    state.command = command;
    state.status = "starting";
    let child;
    try {
      child = this.spawn(command, state.profile.args || [], {
        cwd: this.workspace,
        env: Object.assign({}, process.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      });
    } catch (error) {
      state.error = String(error.message || error);
      state.status = "unavailable";
      return null;
    }
    state.process = child;
    let stderr = "";
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    const connection = new JsonRpcConnection(child.stdout, child.stdin, {
      timeoutMs: this.requestTimeoutMs,
      onNotification: (method, params) => this._notification(state.key, method, params),
      onRequest: (method, params) => {
        if (method === "workspace/configuration") return (params && Array.isArray(params.items)) ? params.items.map(() => null) : [];
        if (method === "workspace/workspaceFolders") {
          const uri = pathToFileURL(this.workspace).href;
          return [{ uri, name: path.basename(this.workspace) }];
        }
        return null;
      },
      onError: (error) => { state.error = String(error.message || error); },
    });
    state.connection = connection;
    let settled = false;
    let exitedOnce = false;
    const exited = (code, signal) => {
      if (exitedOnce) return;
      exitedOnce = true;
      if (settled && state.connection !== connection) return;
      connection.close(new Error("LSP exited" + (code == null ? "" : " (" + code + ")")));
      if (state.connection === connection) state.connection = null;
      if (state.process === child) state.process = null;
      state.opened.clear();
      state.error = stderr.trim() || ("exit " + code + (signal ? " " + signal : ""));
      if (!state.stopRequested && !this.closed && state.restarts < this.maxRestarts) {
        state.status = "backoff";
        const delay = Math.min(5000, this.backoffBaseMs * Math.pow(2, state.restarts++));
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          this.start(state.key).catch(() => {});
        }, delay);
        if (state.timer.unref) state.timer.unref();
      } else state.status = state.stopRequested ? "stopped" : "failed";
    };
    child.once("error", (error) => {
      state.error = String(error.message || error);
      exited(null, "error");
    });
    child.once("exit", exited);
    try {
      const rootUri = pathToFileURL(this.workspace).href;
      await connection.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "vrcloud-ide", version: "1" },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspace) }],
        capabilities: {
          workspace: { symbol: { dynamicRegistration: false } },
          textDocument: {
            synchronization: { didSave: true, willSave: false },
            definition: {}, references: {}, publishDiagnostics: { relatedInformation: true },
          },
        },
      });
      await connection.notify("initialized", {});
      settled = true;
      state.status = "running";
      state.error = "";
      state.restarts = 0;
      const docs = Array.from(this.documents.values()).filter((doc) => doc.key === state.key);
      for (const doc of docs) {
        await connection.notify("textDocument/didOpen", {
          textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
        });
        state.opened.add(doc.rel);
      }
      return state;
    } catch (error) {
      state.error = String(error.message || error);
      connection.close(error);
      try { child.kill(); } catch (e) {}
      state.status = "failed";
      return null;
    }
  }

  _notification(key, method, params) {
    if (method !== "textDocument/publishDiagnostics" || !params || !params.uri) return;
    let rel = "";
    try { rel = this.normalize(fileURLToPath(params.uri)); } catch (e) {}
    if (!rel) return;
    this.diagnosticsCache.set(rel, {
      key, uri: params.uri, version: params.version,
      diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
      updatedAt: Date.now(),
    });
    this._bump();
  }

  async stop(languageOrPath) {
    const keys = languageOrPath ? [this.profileKey(languageOrPath)].filter(Boolean) : Array.from(this.states.keys());
    for (const key of keys) {
      const state = this.state(key);
      state.stopRequested = true;
      clearTimeout(state.timer);
      state.timer = null;
      const connection = state.connection;
      const child = state.process;
      state.connection = null;
      state.process = null;
      state.opened.clear();
      if (connection && !connection.closed) {
        try { await connection.request("shutdown", null, 750); } catch (e) {}
        try { await connection.notify("exit", null); } catch (e) {}
        connection.close();
      }
      if (child) {
        await new Promise((resolve) => {
          if (child.exitCode != null || child.signalCode != null) return resolve();
          let done = false;
          const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
          child.once("exit", finish);
          child.once("error", finish);
          const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
            finish();
          }, 500);
        });
      }
      state.status = "stopped";
    }
  }

  async restart(languageOrPath) {
    const key = this.profileKey(languageOrPath);
    if (!key) return null;
    await this.stop(key);
    const state = this.state(key);
    state.restarts = 0;
    state.lastDetection = 0;
    state.stopRequested = false;
    return this.start(key);
  }

  async didOpen(rel, text, version) {
    rel = this.normalize(rel);
    const key = this.profileKey(rel);
    if (!rel || !key) return false;
    const previous = this.documents.get(rel);
    const requested = Number(version);
    const nextVersion = previous
      ? Math.max(previous.version + 1, Number.isFinite(requested) ? requested : 0)
      : Math.max(1, Number.isFinite(requested) ? requested : 0);
    const existingState = this.states.get(key);
    const wasOpen = !!(existingState && existingState.connection &&
      !existingState.connection.closed && existingState.opened.has(rel));
    const doc = {
      rel, key, uri: this.uri(rel), languageId: this.languageId(rel),
      text: String(text == null ? "" : text), version: nextVersion,
    };
    this.documents.set(rel, doc);
    const state = await this.start(key);
    if (!state || !state.connection) return false;
    if (wasOpen) {
      await state.connection.notify("textDocument/didChange", {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ text: doc.text }],
      });
    } else if (!state.opened.has(rel)) {
      await state.connection.notify("textDocument/didOpen", {
        textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
      });
    }
    state.opened.add(rel);
    return true;
  }

  async didChange(rel, text, version) {
    rel = this.normalize(rel);
    if (!rel || !this.profileKey(rel)) return false;
    const previous = this.documents.get(rel);
    if (!previous) return this.didOpen(rel, text, version);
    previous.text = String(text == null ? "" : text);
    previous.version = Math.max(previous.version + 1, Number(version) || 0);
    this.definitionCache.clear();
    this.referenceCache.clear();
    this.diagnosticsCache.delete(rel);
    this._bump();
    const state = await this.start(previous.key);
    if (!state || !state.connection) return false;
    await state.connection.notify("textDocument/didChange", {
      textDocument: { uri: previous.uri, version: previous.version },
      contentChanges: [{ text: previous.text }],
    });
    return true;
  }

  async didClose(rel) {
    rel = this.normalize(rel);
    const doc = this.documents.get(rel);
    if (!doc) return false;
    this.documents.delete(rel);
    this.diagnosticsCache.delete(rel);
    this._bump();
    const state = this.states.get(doc.key);
    if (state && state.connection && !state.connection.closed) {
      try { await state.connection.notify("textDocument/didClose", { textDocument: { uri: doc.uri } }); } catch (e) {}
    }
    if (state) state.opened.delete(rel);
    return true;
  }

  _positionParams(rel, position) {
    return {
      textDocument: { uri: this.uri(rel) },
      position: {
        line: Math.max(0, Number(position && position.line) || 0),
        character: Math.max(0, Number(position && position.character) || 0),
      },
    };
  }

  async definitions(rel, position, symbol) {
    rel = this.normalize(rel);
    const key = this.profileKey(rel);
    const cacheKey = rel + ":" + JSON.stringify(position || {}) + ":" + String(symbol || "");
    if (this.definitionCache.has(cacheKey)) return this.definitionCache.get(cacheKey);
    const state = key ? await this.start(key) : null;
    if (state && state.connection) {
      try {
        const result = await state.connection.request("textDocument/definition", this._positionParams(rel, position));
        const list = result == null ? [] : (Array.isArray(result) ? result : [result]);
        this.definitionCache.set(cacheKey, list);
        this._bump();
        return list;
      } catch (e) {}
    }
    const fallback = await this._lexicalDefinitions(symbol || this._symbolAt(rel, position));
    this.definitionCache.set(cacheKey, fallback);
    return fallback;
  }

  async references(rel, position, options) {
    options = options || {};
    rel = this.normalize(rel);
    const key = this.profileKey(rel);
    const symbol = options.symbol || this._symbolAt(rel, position);
    const cacheKey = rel + ":" + JSON.stringify(position || {}) + ":" + String(symbol || "");
    if (this.referenceCache.has(cacheKey)) return this.referenceCache.get(cacheKey);
    const state = key ? await this.start(key) : null;
    if (state && state.connection) {
      try {
        const params = this._positionParams(rel, position);
        params.context = { includeDeclaration: options.includeDeclaration !== false };
        const result = await state.connection.request("textDocument/references", params);
        const list = Array.isArray(result) ? result : [];
        this.referenceCache.set(cacheKey, list);
        this._bump();
        return list;
      } catch (e) {}
    }
    const fallback = await this._lexicalReferences(symbol);
    this.referenceCache.set(cacheKey, fallback);
    return fallback;
  }

  async workspaceSymbols(query, languageOrPath) {
    query = String(query || "").trim();
    const requested = languageOrPath ? [this.profileKey(languageOrPath)].filter(Boolean)
      : Array.from(this.states.keys()).filter((key) => {
        const state = this.states.get(key);
        return state && (state.status === "running" || state.status === "starting");
      });
    const combined = [];
    for (const key of requested) {
      const cacheKey = key + "\n" + query.toLowerCase();
      if (this.symbolCache.has(cacheKey)) {
        combined.push.apply(combined, this.symbolCache.get(cacheKey));
        continue;
      }
      const state = await this.start(key);
      if (!state || !state.connection) continue;
      try {
        const result = await state.connection.request("workspace/symbol", { query });
        const list = Array.isArray(result) ? result : [];
        this.symbolCache.set(cacheKey, list);
        combined.push.apply(combined, list);
        this._bump();
      } catch (e) {}
    }
    if (combined.length) return combined;
    return this._lexicalSymbols(query);
  }

  diagnostics(rel) {
    rel = this.normalize(rel);
    const entry = this.diagnosticsCache.get(rel);
    return entry ? entry.diagnostics.slice() : [];
  }

  prime(query, paths) {
    if (this.closed) return;
    const keys = new Set();
    (paths || []).forEach((rel) => {
      const key = this.profileKey(rel);
      if (key) keys.add(key);
    });
    keys.forEach((key) => {
      this.start(key).then((state) => {
        if (state) this.workspaceSymbols(query, key).catch(() => {});
      }).catch(() => {});
    });
  }

  contextSnapshot(query, paths) {
    const lower = String(query || "").toLowerCase();
    const diagnostics = [];
    (paths || []).forEach((rel) => {
      const cached = this.diagnosticsCache.get(this.normalize(rel));
      if (!cached) return;
      cached.diagnostics.slice(0, 20).forEach((diagnostic) => diagnostics.push({
        path: this.normalize(rel), severity: diagnostic.severity, message: diagnostic.message,
        range: diagnostic.range, source: diagnostic.source || cached.key,
      }));
    });
    const symbols = [];
    this.symbolCache.forEach((list, cacheKey) => {
      const cachedQuery = cacheKey.split("\n").slice(1).join("\n");
      if (lower && cachedQuery && cachedQuery !== lower && lower.indexOf(cachedQuery) === -1) return;
      list.forEach((symbol) => {
        const rel = locationPath(symbol.location || symbol, this.workspace);
        if (!rel) return;
        symbols.push({ name: symbol.name || "", kind: symbol.kind, path: rel, range: symbol.location && symbol.location.range });
      });
    });
    return { diagnostics, symbols: symbols.slice(0, 50), revision: this.cacheRevision };
  }

  _manifest() {
    try { return this.index && this.index.manifest ? this.index.manifest() : { files: {} }; }
    catch (e) { return { files: {} }; }
  }

  _lexicalSymbols(query) {
    const lower = String(query || "").toLowerCase();
    const out = [];
    const files = this._manifest().files || {};
    Object.keys(files).sort().forEach((rel) => {
      (files[rel].symbols || []).forEach((name) => {
        if (lower && String(name).toLowerCase().indexOf(lower) === -1) return;
        out.push({
          name, kind: 13, location: { uri: this.uri(rel), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
          source: "lexical",
        });
      });
    });
    return out.slice(0, 200);
  }

  async _lexicalDefinitions(symbol) {
    if (!symbol) return [];
    const exact = this._lexicalSymbols(symbol).filter((entry) => entry.name === symbol);
    return exact.map((entry) => Object.assign({ source: "lexical" }, entry.location)).slice(0, 50);
  }

  _symbolAt(rel, position) {
    const doc = this.documents.get(this.normalize(rel));
    let text = doc && doc.text;
    if (text == null) {
      try { text = fs.readFileSync(this.absolute(rel), "utf8"); } catch (e) { return ""; }
    }
    const line = String(text).split(/\r?\n/)[Math.max(0, Number(position && position.line) || 0)] || "";
    const at = Math.max(0, Number(position && position.character) || 0);
    const left = line.slice(0, at).match(/[A-Za-z_$][\w$]*$/);
    const right = line.slice(at).match(/^[\w$]*/);
    return (left ? left[0] : "") + (right ? right[0] : "");
  }

  async _lexicalReferences(symbol) {
    if (!symbol) return [];
    const escaped = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b" + escaped + "\\b", "g");
    const out = [];
    const files = this._manifest().files || {};
    for (const rel of Object.keys(files).sort()) {
      if (out.length >= 200) break;
      let text;
      try { text = await fs.promises.readFile(this.absolute(rel), "utf8"); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      for (let line = 0; line < lines.length && out.length < 200; line++) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(lines[line])) && out.length < 200) {
          out.push({
            uri: this.uri(rel),
            range: { start: { line, character: match.index }, end: { line, character: match.index + symbol.length } },
            source: "lexical",
          });
        }
      }
    }
    return out;
  }

  applyWorkspaceEvent(event) {
    const changes = event && Array.isArray(event.changes) ? event.changes.map((rel) => this.normalize(rel)).filter(Boolean) : [];
    this.definitionCache.clear();
    this.referenceCache.clear();
    this.symbolCache.clear();
    if (!event || event.wildcard) this.diagnosticsCache.clear();
    else changes.forEach((rel) => this.diagnosticsCache.delete(rel));
    this._bump();
    const affected = event && event.wildcard ? Array.from(this.documents.keys())
      : Array.from(this.documents.keys()).filter((rel) => changes.some((changed) => rel === changed || rel.startsWith(changed + "/")));
    affected.forEach((rel) => {
      fs.promises.readFile(this.absolute(rel), "utf8").then((text) => {
        const doc = this.documents.get(rel);
        if (doc && doc.text !== text) this.didChange(rel, text, doc.version + 1).catch(() => {});
      }, (error) => {
        if (error && error.code === "ENOENT") this.didClose(rel).catch(() => {});
      });
    });
  }

  status() {
    const servers = {};
    Object.keys(this.profiles).forEach((key) => {
      const state = this.states.get(key);
      servers[key] = state ? {
        status: state.status, command: state.command || "", error: state.error || "",
        restarts: state.restarts,
      } : { status: "idle", command: "", error: "", restarts: 0 };
    });
    let diagnostics = 0;
    const diagnosticFiles = [];
    this.diagnosticsCache.forEach((entry, rel) => {
      const count = entry && Array.isArray(entry.diagnostics) ? entry.diagnostics.length : 0;
      diagnostics += count;
      if (count) diagnosticFiles.push({ path: rel, count });
    });
    return {
      servers,
      openDocuments: this.documents.size,
      cacheRevision: this.cacheRevision,
      diagnostics,
      diagnosticFiles: diagnosticFiles.slice(0, 20),
    };
  }

  async close() {
    this.closed = true;
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    await this.stop();
    this.documents.clear();
    this.diagnosticsCache.clear();
    this.definitionCache.clear();
    this.referenceCache.clear();
    this.symbolCache.clear();
  }
}

LspManager.JsonRpcConnection = JsonRpcConnection;
LspManager.DEFAULT_PROFILES = DEFAULT_PROFILES;
LspManager.locationPath = locationPath;

module.exports = LspManager;
