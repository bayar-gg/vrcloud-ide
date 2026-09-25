"use strict";

/**
 * Provider Grok (xAI) untuk panel AI — login akun, bukan API key.
 *
 * Meniru antarmuka Cursor SDK Agent yang dipakai lib/ai-chat.js (sama seperti
 * lib/anthropic-agent.js): Agent.create -> send -> stream/wait/cancel, event
 * tool_call / usage / assistant / thinking. Tool workspace dipakai bersama
 * Anthropic (Workspace + executeWorkspaceTool).
 *
 * Transport: OpenAI-compatible Chat Completions di api.x.ai/v1 dengan Bearer
 * token sesi OAuth (lib/grok-auth.js). Bila api.x.ai menolak token sesi (403),
 * dicoba proxy resmi CLI https://cli-chat-proxy.grok.com/v1.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AnthropicAgent = require("./anthropic-agent");
const Instructions = require("./agent-instructions");
const GrokAuth = require("./grok-auth");

const DEFAULT_API_BASE = GrokAuth.DEFAULT_API_BASE;
const CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
const MAX_TOOL_ROUNDS = 80;
const MAX_OUTPUT_CHARS = 30000;
const HISTORY_KEEP = 60;
const HISTORY_CHARS_SOFT = 480000;
const HISTORY_CHARS_TARGET = 360000;
const DEFAULT_MODEL = "grok-4.6";

const modelCache = new Map();

function cap(s, n) { return AnthropicAgent.cap(s, n); }
function hashKey(k) { return crypto.createHash("sha1").update(String(k || "")).digest("hex"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function modelParams() {
  return [
    { id: "thinking", displayName: "Thinking", values: [{ value: "off", displayName: "Off" }, { value: "on", displayName: "On" }] },
    { id: "effort", displayName: "Effort", values: [
      { value: "default", displayName: "Default" },
      { value: "low", displayName: "Low" },
      { value: "medium", displayName: "Medium" },
      { value: "high", displayName: "High" },
      { value: "xhigh", displayName: "xHigh" },
    ] },
  ];
}

function fallbackModels() {
  return [
    { id: "grok-4.6", displayName: "Grok 4.6" },
    { id: "grok-4", displayName: "Grok 4" },
    { id: "grok-3", displayName: "Grok 3" },
    { id: "grok-3-mini", displayName: "Grok 3 Mini" },
  ].map((m) => ({ id: m.id, displayName: m.displayName, parameters: modelParams(), variants: [] }));
}

function prettyName(id) {
  const s = String(id || "");
  return s.replace(/^grok-/i, "Grok ").replace(/-/g, " ");
}

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const raw = line.slice(5).replace(/^ /, "");
        if (raw === "[DONE]") return;
        try { yield JSON.parse(raw); } catch (e) { /* potongan rusak */ }
      }
    }
  }
}

function toOpenAITools(defs) {
  return (defs || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
    },
  }));
}

class Run {
  constructor(agent, payload) {
    this.agent = agent;
    this.queue = [];
    this.waiters = [];
    this.done = false;
    this.status = "finished";
    this.error = null;
    this.cancelled = false;
    this.ac = new AbortController();
    this.promise = agent._exec(this, payload)
      .catch((e) => { if (!this.cancelled) { this.status = "error"; this.error = e; } })
      .finally(() => { this.done = true; this._wake(); });
  }
  push(ev) { this.queue.push(ev); this._wake(); }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
  supports(name) { return name === "cancel"; }
  async cancel() { this.cancelled = true; this.status = "cancelled"; try { this.ac.abort(); } catch (e) {} }
  async *stream() {
    let i = 0;
    for (;;) {
      if (i < this.queue.length) { yield this.queue[i++]; continue; }
      if (this.done) return;
      await new Promise((r) => this.waiters.push(r));
    }
  }
  async wait() {
    await this.promise;
    if (this.error && !this.cancelled) throw this.error;
    return { status: this.status };
  }
}

class GrokAgent {
  static async create(opts) {
    opts = opts || {};
    if (typeof opts.getToken !== "function") throw new Error("Grok session token provider missing");
    const agent = new GrokAgent(opts);
    await agent._resolveModel();
    return agent;
  }

  static async listModels(getToken, opts) {
    if (typeof getToken !== "function") throw new Error("Belum masuk ke akun Grok");
    const token = await getToken();
    const h = hashKey(token);
    const c = modelCache.get(h);
    if (!(opts && opts.refresh) && c && Date.now() - c.at < 10 * 60 * 1000) return c.list;
    const bases = GrokAgent.apiBases();
    let lastErr = null;
    for (let i = 0; i < bases.length; i++) {
      try {
        const res = await GrokAgent.apiFetch(token, bases[i], "/models", { method: "GET" });
        if (!res.ok) { lastErr = await GrokAgent.readError(res); continue; }
        const j = await res.json();
        const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
        const list = arr.map((m) => {
          const id = String((m && (m.id || m.name)) || "");
          return { id, displayName: (m && m.display_name) || prettyName(id) || id, parameters: modelParams(), variants: [] };
        }).filter((m) => m.id && /grok/i.test(m.id));
        const out = list.length ? list : fallbackModels();
        modelCache.set(h, { at: Date.now(), list: out });
        return out;
      } catch (e) { lastErr = e; }
    }
    if (opts && opts.refresh && lastErr) throw lastErr;
    return fallbackModels();
  }

  static apiBases() {
    const primary = String(process.env.GROK_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
    const out = [primary];
    if (primary !== CLI_PROXY_BASE) out.push(CLI_PROXY_BASE);
    return out;
  }

  static headersFor(base, token) {
    const h = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "VRCloud-IDE/grok-agent",
    };
    if (/cli-chat-proxy\.grok\.com/i.test(base)) {
      // Official consumer proxy for grok-login session tokens (Grok CLI).
      h["x-xai-token-auth"] = "xai-grok-cli";
    }
    return h;
  }

  static async apiFetch(token, base, route, init, signal) {
    const headers = Object.assign(GrokAgent.headersFor(base, token), (init && init.headers) || {});
    return fetch(base + route, Object.assign({}, init || {}, { headers, signal }));
  }

  static async readError(res) {
    let text = "";
    try { text = await res.text(); } catch (e) {}
    let msg = text;
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type)) || j.message || text; } catch (e) {}
    return new Error("Grok API " + res.status + ": " + cap(msg || res.statusText, 600));
  }

  constructor(opts) {
    this.getToken = opts.getToken;
    this.modelId = String((opts.model && opts.model.id) || opts.model || "auto");
    this.params = (opts.params && typeof opts.params === "object") ? opts.params : {};
    this.workspace = new AnthropicAgent.Workspace(opts.workspace || (opts.local && opts.local.cwd) || process.cwd(), opts.shell);
    this.customTools = (opts.customTools && typeof opts.customTools === "object") ? opts.customTools : {};
    this.disallowed = {};
    (opts.disallowedTools || []).forEach((n) => { this.disallowed[String(n).toLowerCase()] = 1; });
    this.messages = GrokAgent.sanitizeHistory(Array.isArray(opts.history) ? opts.history : []);
    this.promptCache = opts.promptCache !== false;
    this.agentId = opts.agentId || ("grok-" + crypto.randomBytes(6).toString("hex"));
    this.todos = null;
    this.closed = false;
    this.apiBase = null;
    this.effortUnsupported = false;
  }

  async _resolveModel() {
    if (this.modelId && this.modelId !== "auto" && this.modelId !== "default") return;
    let list = [];
    try { list = await GrokAgent.listModels(this.getToken); }
    catch (e) {
      if (/401|403|authentication|re-?login|kedaluwarsa|belum masuk/i.test(String(e && e.message))) throw e;
      list = [];
    }
    const pick = list.find((m) => /4\.6/.test(m.id)) || list.find((m) => /grok-4/i.test(m.id)) || list[0];
    this.modelId = pick ? pick.id : DEFAULT_MODEL;
  }

  static sanitizeHistory(msgs) {
    let out = (msgs || []).filter((m) => m && m.role && (m.content || m.tool_calls || m.tool_call_id));
    while (out.length) {
      const m = out[0];
      if (m.role === "user") break;
      out.shift();
    }
    if (out.length) {
      const last = out[out.length - 1];
      if (last.role === "assistant" && last.tool_calls && last.tool_calls.length) out.pop();
    }
    return out.map((m) => {
      if (m.role !== "assistant") return m;
      const copy = { role: "assistant" };
      if (m.content) copy.content = m.content;
      if (m.tool_calls) copy.tool_calls = m.tool_calls;
      return copy;
    });
  }

  getHistory() {
    const msgs = this.messages.slice(-HISTORY_KEEP).map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: cap(m.content, 6000) };
      if (m.role === "user" && Array.isArray(m.content)) {
        return { role: "user", content: m.content.map((b) => {
          if (b && b.type === "image_url") return { type: "text", text: "[attached image]" };
          if (b && b.type === "text") return { type: "text", text: cap(b.text, 20000) };
          return b;
        }) };
      }
      if (m.role === "assistant") {
        const copy = { role: "assistant", content: typeof m.content === "string" ? cap(m.content, 20000) : (m.content || "") };
        if (m.tool_calls) copy.tool_calls = m.tool_calls;
        return copy;
      }
      return m;
    });
    return GrokAgent.sanitizeHistory(msgs);
  }

  async close() { this.closed = true; }

  send(payload) {
    if (this.closed) throw new Error("Agent sudah ditutup");
    return new Run(this, payload);
  }

  systemPrompt() {
    const ws = this.workspace.root;
    const lines = Instructions.anthropicSystem({ workspace: ws, platform: process.platform });
    const extra = [];
    const add = (file, label) => {
      try {
        if (!fs.existsSync(file)) return;
        const t = fs.readFileSync(file, "utf8").trim();
        if (t) extra.push("[" + label + "]\n" + cap(t, 6000));
      } catch (e) {}
    };
    add(path.join(ws, "AGENTS.md"), "AGENTS.md");
    try {
      const rulesDir = path.join(ws, ".vrcloud-agent", "rules");
      if (fs.existsSync(rulesDir)) {
        fs.readdirSync(rulesDir).filter((f) => /\.(md|mdc)$/i.test(f)).slice(0, 10).forEach((f) => add(path.join(rulesDir, f), ".vrcloud-agent/rules/" + f));
      }
    } catch (e) {}
    return cap(lines.join("\n") + (extra.length ? "\n\n" + extra.join("\n\n") : ""), 30000);
  }

  toolDefs() {
    const defs = AnthropicAgent.builtinTools().filter((t) => !this.disallowed[t.name.toLowerCase()]);
    Object.keys(this.customTools).forEach((name) => {
      const t = this.customTools[name];
      if (!t || typeof t.execute !== "function") return;
      if (this.disallowed[name.toLowerCase()]) return;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return;
      defs.push({ name, description: cap(t.description || name, 2000), input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} } });
    });
    return defs;
  }

  thinkingOn() { return /^(on|true|1|yes|enabled)$/i.test(String(this.params.thinking || "")); }

  effortValue() {
    const e = String(this.params.effort || "").trim().toLowerCase();
    if (["low", "medium", "high", "xhigh"].indexOf(e) !== -1) return e;
    if (this.thinkingOn()) return "high";
    return "";
  }

  userContent(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const blocks = [];
      (payload.images || []).forEach((im) => {
        if (im && im.data && im.mimeType) {
          blocks.push({ type: "image_url", image_url: { url: "data:" + String(im.mimeType).toLowerCase() + ";base64," + String(im.data) } });
        }
      });
      blocks.push({ type: "text", text: String(payload.text == null ? "" : payload.text) || "(see the attached image)" });
      return blocks;
    }
    return String(payload == null ? "" : payload) || "(empty)";
  }

  async runTool(name, input, callId, signal) {
    return AnthropicAgent.executeWorkspaceTool(this, name, input, callId, signal);
  }

  _toolEvent(tc, status, result) {
    const name = tc.name;
    const isCustom = !!this.customTools[name];
    const ev = {
      type: "tool_call",
      call_id: tc.id,
      name: isCustom ? "mcp" : name,
      args: isCustom ? { toolName: name, args: tc.input || {} } : (tc.input || {}),
      status,
    };
    if (result) ev.result = result;
    return ev;
  }

  compactHistory() {
    const size = (m) => { try { return JSON.stringify(m).length; } catch (e) { return 0; } };
    let total = this.messages.reduce((n, m) => n + size(m), 0);
    if (total < HISTORY_CHARS_SOFT) return;
    const keepTail = 6;
    for (let i = 0; i < this.messages.length - keepTail && total > HISTORY_CHARS_TARGET; i++) {
      const m = this.messages[i];
      if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= 600) continue;
      m.content = m.content.slice(0, 400) + "\n\u2026(older tool output compacted; re-read if needed)\u2026\n" + m.content.slice(-150);
      total = this.messages.reduce((n, mm) => n + size(mm), 0);
    }
  }

  requestMessages() {
    const system = this.systemPrompt();
    return [{ role: "system", content: system }].concat(this.messages);
  }

  async _callModel(run, tools) {
    let effort = this.effortValue();
    if (this.effortUnsupported) effort = "";
    const bases = this.apiBase ? [this.apiBase].concat(GrokAgent.apiBases().filter((b) => b !== this.apiBase)) : GrokAgent.apiBases();
    let attempt = 0;
    let token = await this.getToken();
    for (;;) {
      if (run.cancelled) return { text: "", thinking: "", toolCalls: [], stopReason: "cancelled" };
      const body = {
        model: this.modelId,
        messages: this.requestMessages(),
        stream: true,
      };
      if (tools && tools.length) body.tools = tools;
      if (effort) body.reasoning_effort = effort;
      let res = null;
      let usedBase = bases[0];
      let lastErr = null;
      for (let i = 0; i < bases.length; i++) {
        usedBase = bases[i];
        try {
          res = await GrokAgent.apiFetch(token, usedBase, "/chat/completions", { method: "POST", body: JSON.stringify(body) }, run.ac.signal);
        } catch (e) {
          if (run.cancelled) return { text: "", thinking: "", toolCalls: [], stopReason: "cancelled" };
          lastErr = e;
          res = null;
          continue;
        }
        if (res.ok) { this.apiBase = usedBase; break; }
        if (res.status === 401 && attempt === 0) {
          try { token = await this.getToken(); } catch (e) { throw e; }
          attempt++;
          i--;
          continue;
        }
        if ((res.status === 403 || res.status === 404) && i < bases.length - 1) { lastErr = await GrokAgent.readError(res); continue; }
        break;
      }
      if (!res) {
        if (attempt++ < 3) { await sleep(800 * attempt); continue; }
        throw new Error("Gagal menghubungi Grok API: " + ((lastErr && lastErr.message) || lastErr || "network"));
      }
      if (!res.ok) {
        const err = await GrokAgent.readError(res);
        const msg = err.message || "";
        if (res.status === 400 && effort && /reasoning_effort|effort|unknown/i.test(msg)) {
          effort = ""; this.effortUnsupported = true; continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt++ < 4) { await sleep(1500 * attempt); continue; }
        throw err;
      }
      let text = "", thinking = "";
      const calls = []; // index -> { id, name, arguments }
      let stopReason = "end_turn";
      let inTokens = 0, outTokens = 0, cacheRead = 0;
      let streamErr = null;
      for await (const d of sseEvents(res)) {
        if (run.cancelled) return { text, thinking, toolCalls: [], stopReason: "cancelled" };
        const ch = d && d.choices && d.choices[0];
        const delta = (ch && ch.delta) || {};
        if (d.usage) {
          inTokens = d.usage.prompt_tokens || inTokens;
          outTokens = d.usage.completion_tokens || outTokens;
          const det = d.usage.prompt_tokens_details || {};
          cacheRead = det.cached_tokens || d.usage.cached_tokens || cacheRead;
        }
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          run.push({ type: "assistant", text: delta.content });
        }
        const thinkBit = delta.reasoning_content || delta.reasoning || (delta.reasoning && delta.reasoning.content);
        if (typeof thinkBit === "string" && thinkBit) {
          thinking += thinkBit;
          run.push({ type: "thinking", text: thinkBit });
        }
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach((tc) => {
            const idx = typeof tc.index === "number" ? tc.index : calls.length;
            if (!calls[idx]) calls[idx] = { id: tc.id || "", name: "", arguments: "" };
            if (tc.id) calls[idx].id = tc.id;
            if (tc.function && tc.function.name) calls[idx].name = tc.function.name;
            if (tc.function && typeof tc.function.arguments === "string") calls[idx].arguments += tc.function.arguments;
          });
        }
        if (ch && ch.finish_reason === "tool_calls") stopReason = "tool_use";
        else if (ch && ch.finish_reason === "length") stopReason = "max_tokens";
        else if (ch && ch.finish_reason && ch.finish_reason !== "stop") stopReason = ch.finish_reason;
        if (d.error) streamErr = new Error("Grok stream error: " + (d.error.message || JSON.stringify(d.error)));
      }
      if (streamErr) {
        if (attempt++ < 3 && !calls.some(Boolean)) { await sleep(1500 * attempt); continue; }
        throw streamErr;
      }
      const toolCalls = calls.filter(Boolean).map((c, i) => {
        let input = {};
        try { input = c.arguments ? JSON.parse(c.arguments) : {}; } catch (e) { input = { _raw: c.arguments }; }
        return { id: c.id || ("call_" + i), name: c.name || "unknown", input };
      });
      if (toolCalls.length) stopReason = "tool_use";
      run.push({ type: "usage", usage: { inputTokens: inTokens, outputTokens: outTokens, totalTokens: inTokens + outTokens, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } });
      return { text, thinking, toolCalls, stopReason };
    }
  }

  async _exec(run, payload) {
    this.messages = GrokAgent.sanitizeHistory(this.messages);
    this.messages.push({ role: "user", content: this.userContent(payload) });
    const tools = toOpenAITools(this.toolDefs());
    const failStreak = {};
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (run.cancelled) { run.status = "cancelled"; return; }
      this.compactHistory();
      const { text, toolCalls, stopReason } = await this._callModel(run, tools);
      if (run.cancelled) { run.status = "cancelled"; return; }
      const assistant = { role: "assistant", content: text || (toolCalls.length ? "" : "") };
      if (toolCalls.length) {
        assistant.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      }
      this.messages.push(assistant);

      if (stopReason !== "tool_use" || !toolCalls.length) {
        if (stopReason === "max_tokens") run.push({ type: "assistant", text: "\n\n_(reply cut off: token limit reached)_" });
        run.status = "finished";
        return;
      }
      for (const tc of toolCalls) {
        if (run.cancelled) break;
        run.push(this._toolEvent(tc, "running", null));
        let r, isError = false;
        try { r = await this.runTool(tc.name, tc.input, tc.id, run.ac.signal); isError = !!r.isError; }
        catch (e) { r = { content: [{ type: "text", text: "Error: " + ((e && e.message) || String(e)) }] }; isError = true; }
        const failed = isError || (String(tc.name).toLowerCase() === "shell" && r.value && typeof r.value.exitCode === "number" && r.value.exitCode !== 0);
        let sig = "";
        try { sig = String(tc.name) + ":" + JSON.stringify(tc.input || {}); } catch (e) { sig = String(tc.name); }
        if (failed) {
          failStreak[sig] = (failStreak[sig] || 0) + 1;
          if (failStreak[sig] >= 2) {
            r.content = (r.content || []).concat([{ type: "text", text: "\n[System note] Tool " + tc.name + " has failed " + failStreak[sig] +
              " times with identical arguments. Do not repeat it; re-read the relevant context, change approach, or report the blocker to the user." }]);
          }
        } else delete failStreak[sig];
        const textOut = (r.content || []).map((c) => {
          if (c && c.type === "text") return cap(c.text, MAX_OUTPUT_CHARS);
          if (c && c.type === "image") return "[image]";
          return "";
        }).filter(Boolean).join("\n") || "(no output)";
        this.messages.push({ role: "tool", tool_call_id: tc.id, content: textOut });
        const value = r.value != null ? r.value : { content: r.content, isError };
        run.push(this._toolEvent(tc, isError ? "error" : "completed", { status: isError ? "error" : "success", value }));
      }
      if (run.cancelled) { run.status = "cancelled"; return; }
    }
    run.push({ type: "assistant", text: "\n\n_(stopped: limit of " + MAX_TOOL_ROUNDS + " tool rounds per message reached; send \u201ccontinue\u201d to keep going)_" });
    run.status = "finished";
  }
}

GrokAgent.toOpenAITools = toOpenAITools;
GrokAgent.fallbackModels = fallbackModels;
GrokAgent.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports = GrokAgent;
