"use strict";

const AnthropicAgent = require("./anthropic-agent");
const GrokAgent = require("./grok-agent");

let defaultSdk = null;
let defaultSdkError = "";
try {
  defaultSdk = require("@cursor/sdk");
} catch (e) {
  defaultSdkError = (e && e.message) || String(e);
}

const READ_ONLY_BUILTINS = [
  "edit", "write", "create", "delete", "shell", "applyAgentDiff", "multiEdit",
  "strReplace", "searchReplace", "applyPatch", "notebookEdit", "editNotebook",
  "generateImage", "task", "askQuestion",
];
const READ_ONLY_ALLOWLIST = [
  "read", "grep", "glob", "ls", "readLints", "webFetch", "webSearch", "semSearch",
];

function paramsFor(modelParams) {
  return Object.keys(modelParams || {})
    .map((id) => ({ id, value: String(modelParams[id]) }))
    .filter((item) => item.value !== "");
}

function isReadOnlyCustomTool(name, tool) {
  if (/^ast_search$/i.test(name) || /^memory_search$/i.test(name) || /^diagnostics$/i.test(name)) return true;
  if (/^(browser_|desktop_)/i.test(name)) return false;
  if (/^memory_(upsert|forget|revalidate)$/i.test(name) || /^ast_edit$/i.test(name)) return false;
  return !!(tool && tool.annotations && tool.annotations.readOnlyHint === true);
}

function filterCustomTools(source, restrictions) {
  const out = {};
  Object.keys(source || {}).forEach((name) => {
    const tool = source[name];
    if (restrictions && restrictions.readOnly && !isReadOnlyCustomTool(name, tool)) return;
    if (restrictions && restrictions.noBrowser && /^browser_/i.test(name)) return;
    if (restrictions && restrictions.noDesktop && /^desktop_/i.test(name)) return;
    if (restrictions && restrictions.noMemoryMutation && /^memory_(upsert|forget|revalidate)$/i.test(name)) return;
    if (restrictions && restrictions.noAstEdit && /^ast_edit$/i.test(name)) return;
    if (restrictions && restrictions.noImage && /^generate_image$/i.test(name)) return;
    out[name] = tool;
  });
  return out;
}

function disallowedCandidates(mode, restrictions) {
  // readOnlyBuiltins (mode Chat): tool bawaan dibatasi seperti Ask, tanpa membatasi tool kustom.
  const readOnly = mode === "ask" || (restrictions && (restrictions.readOnly || restrictions.readOnlyBuiltins));
  if (readOnly) {
    const list = READ_ONLY_BUILTINS.slice();
    // Chat boleh membuat gambar (tidak menyentuh workspace) kecuali pengguna mematikannya.
    if (mode !== "ask" && restrictions && restrictions.readOnlyBuiltins && !restrictions.readOnly && !restrictions.noImage) list.splice(list.indexOf("generateImage"), 1);
    return [list];
  }
  // noNativeTask: "task" harus ada di SETIAP anak tangga. Tangga penuh di bawah turun
  // sampai [] saat SDK menolak daftar tool, yang diam-diam mengizinkan subagent bersarang
  // di dalam implementer orkestrasi; di sini kegagalan kedua rung berarti gagal, bukan lolos.
  let ladder = (restrictions && restrictions.noNativeTask)
    ? [["askQuestion", "task"], ["task"]]
    : [["askQuestion", "task"], ["task"], ["askQuestion"], []];
  // noImage (pengguna mematikan pembuatan gambar): generateImage bawaan Cursor dilarang di
  // setiap anak tangga dengan alasan yang sama.
  if (restrictions && restrictions.noImage) ladder = ladder.map((rung) => rung.concat(["generateImage"]));
  return ladder;
}

class ProviderFactory {
  constructor(options) {
    options = options || {};
    this.sdk = Object.prototype.hasOwnProperty.call(options, "sdk") ? options.sdk : defaultSdk;
    this.sdkError = options.sdkError || defaultSdkError;
    this.AnthropicAgent = options.AnthropicAgent || AnthropicAgent;
    this.GrokAgent = options.GrokAgent || GrokAgent;
  }

  cursorStatus() {
    return { available: !!this.sdk, error: this.sdkError || "" };
  }

  async create(options) {
    options = options || {};
    const provider = String(options.provider || "cursor").toLowerCase();
    const persistent = options.persistent !== false;
    const meta = options.meta || null;
    const restrictions = options.restrictions || {};
    const customTools = filterCustomTools(options.customTools || {}, restrictions);
    const modelParams = options.params || {};
    const model = { id: options.model || "auto" };
    const params = paramsFor(modelParams);
    if (params.length) model.params = params;
    const prelude = options.prelude || "";

    if (provider === "anthropic") {
      let history = persistent && meta && Array.isArray(meta.claudeHistory) ? meta.claudeHistory : [];
      if (prelude) {
        history = [
          { role: "user", content: [{ type: "text", text: prelude }] },
          { role: "assistant", content: [{ type: "text", text: "I have the conversation so far and will continue the same task." }] },
        ];
      }
      const agent = await this.AnthropicAgent.create({
        apiKey: options.anthropicKey,
        model: options.model,
        params: modelParams,
        workspace: options.workspace,
        shell: options.shell,
        customTools,
        promptCache: options.promptCache,
        disallowedTools: disallowedCandidates(options.mode, restrictions)[0],
        history,
        agentId: persistent && !options.forceNew && !prelude && meta ? meta.claudeAgentId : undefined,
        beforeShell: options.beforeShell,
        onTodos: options.onTodos,
        contextLimit: options.contextLimit,
      });
      if (persistent && meta) {
        meta.claudeAgentId = agent.agentId;
        if (typeof options.save === "function") options.save();
      }
      return { agent, prelude: "" };
    }

    if (provider === "grok") {
      let history = persistent && meta && Array.isArray(meta.grokHistory) ? meta.grokHistory : [];
      if (prelude) {
        history = [
          { role: "user", content: prelude },
          { role: "assistant", content: "I have the conversation so far and will continue the same task." },
        ];
      }
      const agent = await this.GrokAgent.create({
        getToken: options.getGrokToken,
        model: options.model,
        params: modelParams,
        workspace: options.workspace,
        shell: options.shell,
        customTools,
        promptCache: options.promptCache,
        disallowedTools: disallowedCandidates(options.mode, restrictions)[0],
        history,
        agentId: persistent && !options.forceNew && !prelude && meta ? meta.grokAgentId : undefined,
        beforeShell: options.beforeShell,
        onTodos: options.onTodos,
      });
      if (persistent && meta) {
        meta.grokAgentId = agent.agentId;
        if (typeof options.save === "function") options.save();
      }
      return { agent, prelude: "" };
    }

    if (!this.sdk) throw new Error("Modul @cursor/sdk belum terpasang di server");
    // Ask / worker baca-saja: allowlist ketat, gagal = error (jangan pernah menurunkan pengaman).
    // Chat (readOnlyBuiltins): cukup larang tool bawaan yang mengubah workspace lewat tangga
    // disallowedTools biasa, supaya tool kustom (browser, memori, gambar) tetap tersedia.
    const readOnly = options.mode === "ask" || restrictions.readOnly === true;
    const base = {
      apiKey: options.apiKey,
      model,
      // SDK Cursor hanya mengenal agent/plan; Ask dan Chat memakai "agent" dengan daftar tool yang dibatasi.
      mode: options.mode === "ask" || options.mode === "chat" ? "agent" : (options.mode || "agent"),
      local: { cwd: options.workspace, settingSources: ["project"] },
    };
    if (Object.keys(customTools).length) base.local.customTools = customTools;
    const candidates = disallowedCandidates(options.mode, restrictions);
    const make = async (fn) => {
      if (readOnly) {
        const opts = Object.assign({}, base, {
          tools: READ_ONLY_ALLOWLIST.slice(),
          disallowedTools: candidates[0].slice(),
        });
        try {
          return await fn(opts);
        } catch (e) {
          const error = new Error("Cannot safely create read-only worker: " + ((e && e.message) || String(e)));
          error.cause = e;
          throw error;
        }
      }
      let lastErr = null;
      for (const list of candidates) {
        try {
          const opts = list.length ? Object.assign({}, base, { disallowedTools: list }) : base;
          return await fn(opts);
        } catch (e) {
          lastErr = e;
          if (!/tool|disallowed|ConfigurationError/i.test(String((e && e.message) || e))) throw e;
        }
      }
      throw lastErr || new Error("Gagal membuat agent");
    };

    let agent = null;
    let nextPrelude = prelude;
    if (persistent && !options.forceNew && !prelude && meta && meta.agentId && typeof this.sdk.Agent.resume === "function") {
      try {
        agent = await make((opts) => this.sdk.Agent.resume(meta.agentId, opts));
      } catch (e) {
        nextPrelude = options.sessionTranscript || "";
      }
    }
    if (!agent) {
      agent = await make((opts) => this.sdk.Agent.create(opts));
      if (persistent && meta) {
        meta.agentId = agent.agentId || meta.agentId;
        if (typeof options.save === "function") options.save();
      }
    }
    return { agent, prelude: nextPrelude };
  }

  async listModels(options) {
    options = options || {};
    const provider = String(options.provider || "cursor").toLowerCase();
    if (provider === "grok") {
      return this.GrokAgent.listModels(options.getGrokToken, { refresh: !!options.refresh });
    }
    if (provider === "anthropic") {
      return this.AnthropicAgent.listModels(options.apiKey, { refresh: !!options.refresh });
    }
    if (!this.sdk) throw new Error("Modul @cursor/sdk belum terpasang di server");
    if (!this.sdk.Cursor || !this.sdk.Cursor.models || typeof this.sdk.Cursor.models.list !== "function") {
      throw new Error("SDK ini tidak mendukung daftar model");
    }
    return this.sdk.Cursor.models.list({ apiKey: options.apiKey });
  }

  async deleteCursorAgent(agentId, options) {
    if (!agentId || !this.sdk || !this.sdk.Agent || typeof this.sdk.Agent.delete !== "function") return;
    return this.sdk.Agent.delete(agentId, { cwd: options.workspace, apiKey: options.apiKey });
  }
}

ProviderFactory.READ_ONLY_BUILTINS = READ_ONLY_BUILTINS;
ProviderFactory.READ_ONLY_ALLOWLIST = READ_ONLY_ALLOWLIST;
ProviderFactory.filterCustomTools = filterCustomTools;
ProviderFactory.isReadOnlyCustomTool = isReadOnlyCustomTool;
ProviderFactory.disallowedCandidates = disallowedCandidates;

module.exports = ProviderFactory;
