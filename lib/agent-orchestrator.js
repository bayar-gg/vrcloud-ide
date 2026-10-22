"use strict";

const crypto = require("crypto");

const READ_ONLY_RESTRICTIONS = Object.freeze({
  readOnly: true,
  noShell: true,
  noBrowser: true,
  noDesktop: true,
  noMemoryMutation: true,
  noAstEdit: true,
});

class Mutex {
  constructor() {
    this.locked = false;
    this.waiters = [];
  }
  acquire(signal) {
    if (signal && signal.aborted) return Promise.reject(this._abortError());
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this._lease());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null, cancelled: false };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(this._abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }
  _abortError() {
    const error = new Error("Mutex acquisition cancelled");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    return error;
  }
  _lease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }
  release() {
    let next = null;
    while (this.waiters.length && !next) {
      const candidate = this.waiters.shift();
      if (!candidate.cancelled) next = candidate;
    }
    if (!next) {
      this.locked = false;
      return;
    }
    next.cancelled = true;
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    next.resolve(this._lease());
  }
}

function makeId(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

function cap(value, max) {
  const text = String(value == null ? "" : value);
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

function addUsage(total, next) {
  const out = Object.assign({}, total || {});
  Object.keys(next || {}).forEach((key) => {
    if (typeof next[key] === "number") out[key] = (typeof out[key] === "number" ? out[key] : 0) + next[key];
  });
  return out;
}

function normalizeConfig(config) {
  if (config === false || config === "off") return { mode: "off", explorerCount: 2, maxRepairAttempts: 1 };
  if (config === true || config === "on") return { mode: "on", explorerCount: 2, maxRepairAttempts: 1 };
  const source = config && typeof config === "object" ? config : {};
  const mode = ["off", "on", "auto"].indexOf(String(source.mode || "").toLowerCase()) !== -1
    ? String(source.mode).toLowerCase() : "auto";
  const repairRaw = parseInt(source.maxRepairAttempts, 10);
  return {
    mode,
    explorerCount: Math.max(1, Math.min(4, parseInt(source.explorerCount, 10) || 2)),
    maxRepairAttempts: Math.max(0, Math.min(3, Number.isFinite(repairRaw) ? repairRaw : 1)),
    minChars: Math.max(60, Math.min(1000, parseInt(source.minChars, 10) || 180)),
    // Zona abu-abu (mode auto) ditanyakan ke model, bukan diputuskan dari panjang teks.
    classifier: source.classifier !== false,
  };
}

/**
 * Keputusan orkestrasi beserta alasannya. decision: true | false | "ambiguous".
 * Kasus yang jelas (pendek, bukan tugas, sangat panjang / multi-baris) diputuskan di sini;
 * zona abu-abu dikembalikan sebagai "ambiguous" supaya pemanggil bisa bertanya ke model
 * (AiChat.classifyOrchestration) alih-alih mengandalkan panjang karakter. Alasannya
 * ditampilkan di UI, jadi pengguna tahu kenapa sebuah pesan lewat pipeline atau tidak.
 */
function explainOrchestration(input) {
  input = input || {};
  const config = normalizeConfig(input.config);
  const no = (reason) => ({ decision: false, reason, config });
  const yes = (reason) => ({ decision: true, reason, config });
  if (String(input.mode || "agent").toLowerCase() !== "agent") return no("not in Agent mode");
  if (config.mode === "off") return no("Smart Agent is off");
  if (input.hasImages) return no("requests with images use the direct agent");
  if (typeof input.force === "boolean") return input.force ? yes("forced on for this message") : no("forced off for this message");
  const text = String(input.text || "").trim();
  if (!text) return no("empty message");
  const task = /\b(add|build|change|create|debug|delete|fix|implement|integrate|migrate|refactor|remove|replace|test|update|wire|tambah|tambahkan|buat|bangun|ubah|ganti|perbaiki|hapus|implementasikan|integrasikan|migrasi|refaktor|uji|tes)\b/i.test(text);
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
  if (config.mode === "on") {
    if (text.length >= 40 || lines >= 2) return yes("Smart Agent is set to on");
    return no("message too short for Smart Agent");
  }
  if (!task) return no("no change request detected (question or discussion)");
  if (text.length < 40 && lines < 2) return no("short, single-step request");
  const multiRequirement = /\b(and|then|also|plus|while|with tests?|backward compat|preserv|phase|parallel|architecture|across|dan|lalu|kemudian|juga|serta|sekaligus|sambil|dengan|beserta|termasuk|lintas|seluruh|beberapa|tetap|pertahankan|kompatib(?:el|ilitas)|tahap|paralel|arsitektur)\b/i.test(text);
  const codeScope = /(?:^|[\s`])(?:[\w.-]+[\\/])+[\w.-]+|\b(files?|modules?|providers?|server|frontend|backend|tests?|berkas|file|modul|penyedia|peladen|antarmuka|uji|tes)\b/i.test(text);
  if (lines >= 4) return yes("multi-line request with several parts");
  if (text.length >= config.minChars) return yes("long request (" + text.length + " chars)");
  if (text.length >= 100 && multiRequirement && codeScope) return yes("several requirements across named code areas");
  return { decision: "ambiguous", reason: "medium-length change request", config };
}

function shouldOrchestrate(input) {
  const out = explainOrchestration(input);
  // Tanpa pengklasifikasi (pemanggil lama), zona abu-abu berarti jalur langsung.
  return out.decision === true;
}

function cleanInline(value, max) {
  const text = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function phaseActivity(worker) {
  const phase = String(worker && worker.phase || worker && worker.role || "").toLowerCase();
  if (phase === "planner" || phase === "planning") return "Planning the work";
  if (phase === "exploration") return "Inspecting the codebase";
  if (phase === "implementation") return "Implementing changes";
  if (phase === "repair") return "Repairing verification failures";
  if (phase === "verification" || phase === "verifier") return "Running verification";
  if (phase === "finalization") return "Composing the final response";
  return "Working";
}

function safeToolActivity(value) {
  value = value && typeof value === "object" ? value : {};
  const rawName = String(value.tool || value.name || "tool");
  const name = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const summary = cleanInline(value.summary, 120);
  const safePath = summary && !/[;&|><`$]/.test(summary) &&
    (/^(?:[a-z]:[\\/]|\.{0,2}[\\/]|[\w.@ -]+[\\/]|[\w.@ -]+\.[a-z0-9]{1,10}$)/i.test(summary))
    ? summary : "";
  if (/read|readfile/.test(name)) return "Reading" + (safePath ? " " + safePath : " files");
  if (/grep|glob|search|find/.test(name)) return "Searching the workspace";
  if (/edit|write|create|patch|notebook/.test(name)) return "Editing" + (safePath ? " " + safePath : " files");
  if (/delete|remove/.test(name)) return "Removing" + (safePath ? " " + safePath : " files");
  if (/lint/.test(name)) return "Checking diagnostics";
  if (/test|verify/.test(name)) return "Running verification";
  if (/shell|terminal|exec|command/.test(name)) return "Running a command";
  if (/todo|plan/.test(name)) return "Updating the work plan";
  if (/web|browser/.test(name)) return "Inspecting web resources";
  return "Using " + cleanInline(rawName, 50);
}

function outputPreview(text) {
  const cleaned = String(text || "")
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleanInline(cleaned, 360) : "";
}

function verificationPreview(result) {
  result = result || {};
  const state = result.passed ? "Verification passed" : "Verification failed";
  const detail = result.message || (Array.isArray(result.issues) ? result.issues.join("; ") : result.status);
  return cleanInline(state + (detail ? ": " + detail : ""), 360);
}

function cleanReport(text) {
  return String(text || "")
    .replace(/^\s*\[Orchestration phase:[^\]]+\]\s*$/gim, "")
    .replace(/^\s*(planner|explorer|implementer|repairer|finalizer|worker)\s+(?:report|output)\s*:?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function responseQuality(text) {
  const value = cleanReport(text);
  if (!value) return 0;
  let score = Math.min(5, Math.floor(value.length / 180));
  if (/(?:^|\s)(?:[\w.-]+[\\/])+[\w.-]+/m.test(value)) score += 3;
  if (/\b(test|verify|verification|lint|syntax|npm|passed|failed)\b/i.test(value)) score += 2;
  if (/\b(implemented|changed|updated|fixed|added|removed|migrated|refactored)\b/i.test(value)) score += 2;
  if (/^(?:[-*]|\d+\.)\s/m.test(value)) score += 1;
  if (/^(?:done|completed|implementation completed|canonical final answer)[.!]?$/i.test(value)) score -= 6;
  return score;
}

function verificationSection(verification) {
  verification = verification || {};
  const lines = [];
  lines.push("- Status: " + String(verification.status || (verification.passed ? "passed" : "failed")));
  if (verification.command) lines.push("- Command: `" + cleanInline(verification.command, 300) + "`");
  if (Array.isArray(verification.commands)) {
    verification.commands.forEach((entry) => {
      if (!entry) return;
      const command = entry.command || entry.cmd;
      lines.push("- " + (command ? "`" + cleanInline(command, 240) + "`: " : "") + String(entry.status || "completed"));
    });
  }
  const issues = Array.isArray(verification.issues) ? verification.issues : [];
  if (issues.length) lines.push("- Failures/limitations: " + issues.map((item) => cleanInline(item, 300)).join("; "));
  else if (verification.message && !verification.passed) lines.push("- Failures/limitations: " + cleanInline(verification.message, 500));
  return lines.join("\n");
}

function composeFinalResponse(finalizer, implementation, verification, touchedFiles) {
  const finalText = cleanReport(finalizer);
  const implementationText = cleanReport(implementation);
  const finalScore = responseQuality(finalText);
  const implementationScore = responseQuality(implementationText);
  let output = finalScore >= 4 || finalScore >= implementationScore ? finalText : implementationText;
  if (!output) output = verification && verification.passed
    ? "Implementation completed and verification passed."
    : "Implementation completed, but verification did not pass.";

  if (output === finalText && implementationScore >= 4 && finalScore < implementationScore &&
      output.toLowerCase().indexOf(implementationText.toLowerCase()) === -1) {
    const normalizedOutput = output.toLowerCase().replace(/[`*_#]/g, "").replace(/\s+/g, " ");
    const uniqueLines = implementationText.split(/\r?\n/).filter((line) => {
      const normalized = line.toLowerCase().replace(/^[\s\-*#\d.]+/, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
      return normalized && normalized.length > 10 && normalizedOutput.indexOf(normalized) === -1;
    });
    if (uniqueLines.length) output += "\n\nImplementation details\n" + uniqueLines.join("\n");
  }

  const files = Array.from(new Set((touchedFiles || []).filter(Boolean).map(String)));
  const changedHeading = /(?:^|\n)#{0,3}\s*(?:changed files|files changed|file yang diubah)\s*:?\s*(?:\n|$)/i;
  const changedMatch = changedHeading.exec(output);
  if (!changedMatch) {
    output += "\n\nChanged files\n" + (files.length ? files.map((file) => "- `" + file + "`").join("\n") : "- None reported.");
  } else {
    const missing = files.filter((file) => output.indexOf(file) === -1);
    if (missing.length) {
      const insertAt = changedMatch.index + changedMatch[0].length;
      output = output.slice(0, insertAt) + missing.map((file) => "- `" + file + "`").join("\n") + "\n" + output.slice(insertAt);
    }
  }

  const verificationHeading = /(?:^|\n)#{0,3}\s*(?:verification|verifikasi|tests?)\s*:?\s*(?:\n|$)/i;
  const verificationMatch = verificationHeading.exec(output);
  if (!verificationMatch) {
    output += "\n\nVerification\n" + verificationSection(verification);
  } else {
    const status = String(verification && (verification.status || (verification.passed ? "passed" : "failed")) || "");
    const command = String(verification && verification.command || "");
    const authoritative = [];
    if (status && output.toLowerCase().indexOf(status.toLowerCase()) === -1) authoritative.push("- Status: " + status);
    if (command && output.indexOf(command) === -1) authoritative.push("- Command: `" + cleanInline(command, 300) + "`");
    if (authoritative.length) {
      const insertAt = verificationMatch.index + verificationMatch[0].length;
      output = output.slice(0, insertAt) + authoritative.join("\n") + "\n" + output.slice(insertAt);
    }
    if (verification && !verification.passed && !/failures?|limitations?|kegagalan|keterbatasan/i.test(output)) {
      output += "\n\nFailures/limitations\n" + verificationSection(verification);
    }
  }
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

function parseJson(text) {
  const src = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(src);
  const candidate = fenced ? fenced[1] : src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch (e) { return null; }
}

function normalizeTodos(items, runId) {
  if (!Array.isArray(items)) return [];
  const ids = {};
  return items.map((item, index) => {
    item = item || {};
    let id = String(item.id || ("todo-" + (index + 1))).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
    if (!id) id = "todo-" + (index + 1);
    if (ids[id]) id += "-" + (index + 1);
    ids[id] = true;
    const statusRaw = String(item.status || "pending");
    const status = /complete|done/i.test(statusRaw) ? "completed"
      : /in.?progress/i.test(statusRaw) ? "inProgress"
        : /cancel/i.test(statusRaw) ? "cancelled" : "pending";
    const dependencies = Array.isArray(item.dependencies) ? item.dependencies
      : (Array.isArray(item.dependsOn) ? item.dependsOn : []);
    return {
      id,
      content: String(item.content || item.text || item.title || "Work item " + (index + 1)),
      status,
      owner: String(item.owner || "implementer"),
      dependencies: dependencies.map(String).slice(0, 20),
      runId,
    };
  });
}

function setPhaseStatus(plan, phase, status) {
  const patterns = {
    exploration: /explor/i,
    implementation: /implement|change|write/i,
    verification: /verif|repair|test/i,
    finalization: /final/i,
  };
  const re = patterns[phase];
  if (!re || !plan || !Array.isArray(plan.todos)) return;
  plan.todos.forEach((todo) => {
    if (re.test(String(todo.owner || "")) || re.test(String(todo.id || ""))) todo.status = status;
  });
}

function ensurePhaseTodos(plan, runId) {
  const defaults = defaultPlan("", { explorerCount: 2 }, runId).todos;
  const patterns = [/explor/i, /implement|change|write/i, /verif|repair|test/i, /final/i];
  patterns.forEach((re, index) => {
    const found = plan.todos.some((todo) => re.test(String(todo.owner || "")) || re.test(String(todo.id || "")));
    if (!found) plan.todos.push(defaults[index]);
  });
}

function defaultPlan(request, config, runId) {
  const explorers = [];
  for (let i = 0; i < config.explorerCount; i++) {
    explorers.push({
      id: "explorer-" + (i + 1),
      objective: i === 0
        ? "Map the relevant implementation, callers, and compatibility constraints."
        : "Inspect tests, verification paths, and edge cases relevant to the requested change.",
    });
  }
  return {
    summary: cap(request, 500),
    explorers,
    todos: normalizeTodos([
      { id: "explore", content: "Inspect relevant code and constraints", owner: "explorers" },
      { id: "implement", content: "Implement the requested workspace changes", owner: "implementer", dependencies: ["explore"] },
      { id: "verify", content: "Verify and repair the implementation", owner: "verifier", dependencies: ["implement"] },
      { id: "finalize", content: "Produce the canonical final result", owner: "finalizer", dependencies: ["verify"] },
    ], runId),
  };
}

function plannerPrompt(request, fullPrompt, config) {
  return [
    "[Orchestration phase: planner]",
    "Plan the substantive coding task. Do not modify files, run shell commands, use browser/desktop tools, mutate memory, or call ast_edit.",
    "Do not invoke a native task/subagent tool. Return one JSON object only:",
    '{"summary":"...","explorers":[{"id":"explorer-1","objective":"..."}],"todos":[{"id":"...","content":"...","owner":"...","dependencies":["..."],"status":"pending"}]}',
    "Use " + config.explorerCount + " independent explorer objectives. Keep them read-only and non-overlapping.",
    "",
    fullPrompt || request,
  ].join("\n");
}

function readOnlyPrompt(role, request, objective, fullPrompt) {
  return [
    "[Orchestration phase: " + role + "]",
    "You are a read-only worker. You may only inspect files and search.",
    "Forbidden: every file mutation tool, shell, browser, desktop/computer-use, memory mutation, ast_edit, and native task/subagent tools.",
    "Return concrete findings with file paths, symbols, constraints, and recommendations. Do not implement.",
    "Objective: " + objective,
    "Original request: " + request,
    "",
    fullPrompt || "",
  ].join("\n");
}

function implementationPrompt(request, fullPrompt, plan, findings) {
  return [
    "[Orchestration phase: implementer]",
    "You are the only implementation writer. Do not invoke a native task/subagent tool.",
    "Apply the requested changes completely. Respect existing uncommitted work. Use the supplied read-only findings, but verify any uncertain detail yourself.",
    "Update the todo list with the supplied IDs, owners, and dependencies. Run only checks directly needed during implementation; server verification follows separately.",
    "",
    "Plan:\n" + cap(JSON.stringify(plan, null, 2), 12000),
    "",
    "Explorer findings:\n" + findings.map((item) => "## " + item.workerId + "\n" + cap(item.text, 12000)).join("\n\n"),
    "",
    fullPrompt || request,
  ].join("\n");
}

function repairPrompt(request, verification, attempt, implementation) {
  return [
    "[Orchestration phase: repair, attempt " + attempt + "]",
    "You hold the exclusive workspace writer lock. Do not invoke a native task/subagent tool.",
    "Repair only the verified failures below. Preserve unrelated and pre-existing changes. Re-run the narrow check needed to validate the repair.",
    "",
    "Original request:\n" + request,
    "",
    "Verifier result:\n" + cap(JSON.stringify(verification, null, 2), 12000),
    "",
    "Implementation report:\n" + cap(implementation, 12000),
  ].join("\n");
}

function finalizationPrompt(request, plan, findings, implementation, verification, touchedFiles) {
  return [
    "[Orchestration phase: finalization]",
    "Produce the single canonical answer to the user. This is read-only finalization.",
    "Forbidden: file mutation, shell, browser, desktop/computer-use, memory mutation, ast_edit, and native task/subagent tools.",
    "Lead with the outcome. Preserve concrete implementation details from the implementation report; do not replace them with a vague completion statement.",
    "Name exact changed file paths and explain the substantive change in each. Report verification commands/evidence and their real pass/fail state.",
    "Include failures, unresolved issues, and limitations plainly. Never claim checks passed when the verifier did not report that.",
    "Do not mention planners, explorers, implementers, finalizers, orchestration phases, or other internal-worker jargon.",
    "Avoid repeating the same facts. Keep the response concise, but never shorten away details needed to understand or verify the work.",
    "",
    "Original request:\n" + request,
    "",
    "Plan:\n" + cap(JSON.stringify(plan, null, 2), 8000),
    "",
    "Explorer findings:\n" + findings.map((item) => cap(item.text, 4000)).join("\n---\n"),
    "",
    "Implementation report:\n" + cap(implementation, 12000),
    "",
    "Verifier result:\n" + cap(JSON.stringify(verification, null, 2), 8000),
    "",
    "Touched files:\n" + (touchedFiles.length ? touchedFiles.join("\n") : "(none reported)"),
  ].join("\n");
}

class AgentOrchestrator {
  constructor(options) {
    options = options || {};
    if (typeof options.createAgent !== "function") throw new Error("AgentOrchestrator requires createAgent");
    this.createAgent = options.createAgent;
    this.disposeAgent = typeof options.disposeAgent === "function" ? options.disposeAgent : async () => {};
    this.eventAdapter = typeof options.eventAdapter === "function" ? options.eventAdapter : this.defaultEventAdapter;
    this.setVerifier(options.verifier);
    this.config = normalizeConfig(options.config);
    this.progressThrottleMs = Math.max(0, parseInt(options.progressThrottleMs, 10) || 300);
    this.activeRuns = new Map();
    // Lock penulis workspace. AiChat memberikan satu Mutex bersama supaya run biasa
    // (non-orkestrasi) di sesi lain tidak menulis bersamaan dengan implementer di sini.
    this.writerMutex = options.writerMutex instanceof Mutex ? options.writerMutex : new Mutex();
  }

  setVerifier(verifier) {
    if (typeof verifier === "function") this.verifier = { verify: verifier };
    else if (verifier && typeof verifier.verify === "function") this.verifier = verifier;
    else this.verifier = {
      verify: async () => ({ passed: true, status: "skipped", issues: [], message: "Verification hook not configured." }),
    };
  }

  shouldRun(input) {
    const config = input && Object.prototype.hasOwnProperty.call(input, "config") ? input.config : this.config;
    return shouldOrchestrate(Object.assign({}, input || {}, { config }));
  }
  explain(input) {
    const config = input && Object.prototype.hasOwnProperty.call(input, "config") ? input.config : this.config;
    return explainOrchestration(Object.assign({}, input || {}, { config }));
  }

  defaultEventAdapter(event, emit) {
    if (!event) return;
    if (event.type === "assistant" || event.type === "text" || event.type === "message") emit("text", event.text || (event.message && event.message.text) || "");
    else if (event.type === "thinking" || event.type === "reasoning") emit("think", event.text || "");
    else if (event.type === "usage") emit("usage", event.usage || {});
    else if (event.type === "tool_call") emit("tool", event);
  }

  metadata(ctx, worker) {
    return {
      runId: ctx.runId,
      workerId: worker.workerId,
      role: worker.role,
      phase: worker.phase,
      attempt: worker.attempt,
      sequence: ++ctx.sequence,
    };
  }

  workerLifecycle(ctx, worker, eventKind, extra) {
    const elapsedMs = Math.max(0, Date.now() - worker.startedAt);
    const lifecycle = Object.assign({
      eventKind,
      status: eventKind === "end" ? worker.status : "running",
      activity: worker.activity || phaseActivity(worker),
      toolCount: worker.toolCount || 0,
      outputChars: worker.outputChars || 0,
      elapsedMs,
      startedAt: worker.startedAt,
    }, extra || {}, this.metadata(ctx, worker));
    if (eventKind === "end") lifecycle.durationMs = elapsedMs;
    ctx.emit("worker", lifecycle);
    return lifecycle;
  }

  emitWorkerProgress(ctx, worker, activity, force) {
    const now = Date.now();
    if (activity) worker.activity = cleanInline(activity, 160);
    if (!force && worker.lastProgressAt && now - worker.lastProgressAt < this.progressThrottleMs) return;
    worker.lastProgressAt = now;
    this.workerLifecycle(ctx, worker, "progress");
  }

  emitVisibleWorkerEvent(ctx, worker, eventKind, value, visible) {
    if (!visible) return;
    const metadata = this.metadata(ctx, worker);
    let next = value;
    if (eventKind === "tool" && value && typeof value === "object") {
      next = Object.assign({}, value, { meta: Object.assign({}, value.meta || {}, { run: metadata }) });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      next = Object.assign({}, value, { run: metadata });
    }
    ctx.emit(eventKind, next);
  }

  async executeWorker(ctx, spec, payload) {
    const worker = {
      workerId: spec.workerId || makeId(spec.role),
      role: spec.role,
      phase: spec.phase || spec.role,
      attempt: spec.attempt || 0,
      readOnly: !!spec.readOnly,
      mutating: !!spec.mutating,
      status: "creating",
      run: null,
      agent: null,
      text: "",
      think: "",
      touched: [],
      startedAt: Date.now(),
      toolCount: 0,
      toolCalls: new Set(),
      outputChars: 0,
      activity: phaseActivity(spec),
      lastProgressAt: 0,
      runtime: { sessionId: ctx.sessionId, live: { touched: [], usage: null }, todos: null },
    };
    ctx.workers.set(worker.workerId, worker);
    worker.status = "running";
    this.workerLifecycle(ctx, worker, "start");
    this.emitWorkerProgress(ctx, worker, worker.activity, true);
    let release = null;
    let keepAgent = false;
    try {
      if (worker.mutating && !ctx.writerLease) {
        worker.status = "waiting-writer";
        this.emitWorkerProgress(ctx, worker, "Waiting for the workspace writer lock", true);
        release = await this.writerMutex.acquire(ctx.abortController.signal);
        if (ctx.cancelled) throw new Error("orchestration cancelled");
      }
      worker.status = "creating";
      worker.agent = await this.createAgent(Object.assign({}, spec, {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        workerId: worker.workerId,
        providerConfig: ctx.providerConfig,
      }));
      if (ctx.cancelled) throw new Error("orchestration cancelled");
      worker.status = "running";
      const run = await worker.agent.send(payload);
      worker.run = run;
      for await (const event of run.stream()) {
        if (ctx.cancelled) break;
        this.eventAdapter(event, (kind, value) => {
          if (kind === "text") {
            const chunk = String(value == null ? "" : value);
            worker.text += chunk;
            worker.outputChars += chunk.length;
            worker.activity = phaseActivity(worker);
          }
          if (kind === "think") worker.think += String(value == null ? "" : value);
          if (kind === "usage" && value) worker.runtime.live.usage = value;
          if (kind === "tool" && value) {
            const callId = String(value.callId || value.call_id || "");
            if (!callId || !worker.toolCalls.has(callId)) {
              if (callId) worker.toolCalls.add(callId);
              worker.toolCount++;
            }
            worker.activity = safeToolActivity(value);
          } else if (kind === "plan") {
            worker.activity = "Updating the work plan";
          } else if (kind === "think") {
            worker.activity = phaseActivity(worker);
          }
          this.emitWorkerProgress(ctx, worker, worker.activity, kind === "tool" || kind === "plan");
          this.emitVisibleWorkerEvent(ctx, worker, kind, value, !!spec.visibleKinds && spec.visibleKinds.indexOf(kind) !== -1);
        }, worker);
      }
      const result = await run.wait();
      worker.run = null;
      worker.status = (result && result.status) || "finished";
      if (/^(error|failed)$/i.test(worker.status)) {
        const detail = result && (result.error || result.message);
        throw new Error("Provider worker ended with status " + worker.status + (detail ? ": " + detail : ""));
      }
      if (worker.runtime && worker.runtime.live && Array.isArray(worker.runtime.live.touched)) {
        worker.touched = worker.runtime.live.touched.slice();
      }
      worker.touched.forEach((file) => ctx.touched.add(file));
      if (worker.runtime && worker.runtime.live && worker.runtime.live.usage) {
        ctx.usage = addUsage(ctx.usage, worker.runtime.live.usage);
        ctx.emit("usage", ctx.usage);
      }
      keepAgent = !!spec.keepAgent && worker.status !== "cancelled" && !ctx.cancelled;
      this.workerLifecycle(ctx, worker, "end", {
        touchedFiles: worker.touched.slice(),
        summary: outputPreview(worker.text),
      });
      return { worker, agent: keepAgent ? worker.agent : null };
    } catch (e) {
      worker.status = ctx.cancelled ? "cancelled" : "error";
      worker.error = (e && e.message) || String(e);
      if (worker.runtime && worker.runtime.live && Array.isArray(worker.runtime.live.touched)) {
        worker.touched = worker.runtime.live.touched.slice();
      }
      this.workerLifecycle(ctx, worker, "end", {
        error: cleanInline(worker.error, 500),
        touchedFiles: worker.touched.slice(),
        summary: outputPreview(worker.text) || cleanInline(worker.error, 360),
      });
      if (!ctx.cancelled) throw e;
      return { worker, agent: null };
    } finally {
      worker.run = null;
      if (worker.runtime && worker.runtime.live && Array.isArray(worker.runtime.live.touched)) {
        worker.touched = worker.runtime.live.touched.slice();
      }
      worker.touched.forEach((file) => ctx.touched.add(file));
      if (release) release();
      if (worker.agent && !keepAgent) {
        try { await this.disposeAgent(worker.agent, worker); } catch (e) {}
        worker.agent = null;
      }
    }
  }

  async verify(ctx, attempt, implementation) {
    if (ctx.cancelled) return { passed: false, status: "cancelled", issues: [] };
    const worker = {
      workerId: "verifier-" + attempt,
      role: "verifier",
      phase: "verification",
      attempt,
      status: "running",
      startedAt: Date.now(),
      toolCount: 0,
      outputChars: 0,
      activity: "Running verification",
      touched: [],
    };
    ctx.workers.set(worker.workerId, worker);
    this.workerLifecycle(ctx, worker, "start");
    this.emitWorkerProgress(ctx, worker, worker.activity, true);
    let result;
    try {
      result = await this.verifier.verify({
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        attempt,
        request: ctx.request,
        touchedFiles: Array.from(ctx.touched),
        implementation,
        verifyCmd: ctx.verifyCmd,
        signal: ctx.abortController.signal,
      });
    } catch (e) {
      result = { passed: false, status: "error", issues: [(e && e.message) || String(e)] };
    }
    if (!result || typeof result !== "object") result = { passed: !!result, status: result ? "passed" : "failed", issues: [] };
    if (typeof result.passed !== "boolean") result.passed = result.status !== "failed" && result.status !== "error";
    if (Array.isArray(result.touchedFiles)) result.touchedFiles.forEach((file) => {
      if (file) ctx.touched.add(String(file));
    });
    result.attempt = attempt;
    ctx.verification = result;
    ctx.emit("verification", Object.assign({ runId: ctx.runId, phase: "verifier", sequence: ++ctx.sequence }, result));
    worker.status = result.status || (result.passed ? "passed" : "failed");
    worker.touched = Array.isArray(result.touchedFiles) ? result.touchedFiles.map(String) : [];
    worker.outputChars = verificationPreview(result).length;
    this.workerLifecycle(ctx, worker, "end", {
      touchedFiles: worker.touched.slice(),
      summary: verificationPreview(result),
    });
    return result;
  }

  async run(input) {
    input = input || {};
    const config = normalizeConfig(input.config || this.config);
    const ctx = {
      runId: input.runId || makeId("run"),
      sessionId: String(input.sessionId || ""),
      request: String(input.request || ""),
      fullPrompt: String(input.fullPrompt || ""),
      emit: typeof input.emit === "function" ? input.emit : () => {},
      workers: new Map(),
      touched: new Set(),
      sequence: 0,
      cancelled: false,
      verification: null,
      providerConfig: input.providerConfig || null,
      verifyCmd: String(input.verifyCmd || ""),
      usage: null,
      abortController: new AbortController(),
      writerLease: false,
      completion: null,
      resolveCompletion: null,
    };
    ctx.completion = new Promise((resolve) => { ctx.resolveCompletion = resolve; });
    this.activeRuns.set(ctx.runId, ctx);
    let finalAgent = null;
    let canonicalText = "";
    let plan = defaultPlan(ctx.request, config, ctx.runId);
    const findings = [];
    let implementation = "";
    let releaseWriter = null;
    try {
      const planner = await this.executeWorker(ctx, {
        role: "planner", phase: "planner", readOnly: true,
        restrictions: READ_ONLY_RESTRICTIONS,
      }, plannerPrompt(ctx.request, ctx.fullPrompt, config));
      if (ctx.cancelled) throw new Error("orchestration cancelled");
      const parsed = parseJson(planner.worker.text);
      if (parsed) {
        plan = {
          summary: String(parsed.summary || plan.summary),
          explorers: Array.isArray(parsed.explorers) && parsed.explorers.length
            ? parsed.explorers.slice(0, config.explorerCount).map((item, index) => ({
              id: String((item && item.id) || ("explorer-" + (index + 1))),
              objective: String((item && (item.objective || item.content)) || "Inspect the relevant code path."),
            })) : plan.explorers,
          todos: normalizeTodos(parsed.todos, ctx.runId),
        };
        if (!plan.todos.length) plan.todos = defaultPlan(ctx.request, config, ctx.runId).todos;
      }
      ensurePhaseTodos(plan, ctx.runId);
      ctx.emit("plan", plan.todos);

      setPhaseStatus(plan, "exploration", "inProgress");
      ctx.emit("plan", plan.todos);
      const explorerResults = await Promise.allSettled(plan.explorers.map((item, index) => this.executeWorker(ctx, {
        workerId: item.id || ("explorer-" + (index + 1)),
        role: "explorer", phase: "exploration", readOnly: true,
        restrictions: READ_ONLY_RESTRICTIONS,
      }, readOnlyPrompt("explorer", ctx.request, item.objective, ctx.fullPrompt))));
      explorerResults.forEach((entry) => {
        if (entry.status === "fulfilled") {
          findings.push({ workerId: entry.value.worker.workerId, text: entry.value.worker.text, status: entry.value.worker.status });
        } else {
          findings.push({ workerId: "explorer-error", text: (entry.reason && entry.reason.message) || String(entry.reason), status: "error" });
        }
      });
      setPhaseStatus(plan, "exploration", "completed");
      ctx.emit("plan", plan.todos);
      if (ctx.cancelled) throw new Error("orchestration cancelled");

      setPhaseStatus(plan, "implementation", "inProgress");
      ctx.emit("plan", plan.todos);
      releaseWriter = await this.writerMutex.acquire(ctx.abortController.signal);
      ctx.writerLease = true;
      if (ctx.cancelled) throw new Error("orchestration cancelled");
      if (this.verifier && typeof this.verifier.prepare === "function") {
        await this.verifier.prepare({
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          request: ctx.request,
          signal: ctx.abortController.signal,
        });
      }
      const implemented = await this.executeWorker(ctx, {
        role: "implementer", phase: "implementation", mutating: true,
        restrictions: { noNativeTask: true },
        visibleKinds: ["tool", "plan"],
      }, implementationPrompt(ctx.request, ctx.fullPrompt, plan, findings));
      implementation = implemented.worker.text;
      setPhaseStatus(plan, "implementation", "completed");
      setPhaseStatus(plan, "verification", "inProgress");
      ctx.emit("plan", plan.todos);
      if (ctx.cancelled) throw new Error("orchestration cancelled");

      let verification = await this.verify(ctx, 0, implementation);
      for (let attempt = 1; !verification.passed && attempt <= config.maxRepairAttempts && !ctx.cancelled; attempt++) {
        const repaired = await this.executeWorker(ctx, {
          role: "repairer", phase: "repair", attempt, mutating: true,
          restrictions: { noNativeTask: true },
          visibleKinds: ["tool", "plan"],
        }, repairPrompt(ctx.request, verification, attempt, implementation));
        implementation += (implementation ? "\n\n" : "") + repaired.worker.text;
        verification = await this.verify(ctx, attempt, implementation);
      }
      setPhaseStatus(plan, "verification", verification.passed ? "completed" : "cancelled");
      ctx.writerLease = false;
      releaseWriter();
      releaseWriter = null;
      setPhaseStatus(plan, "finalization", "inProgress");
      ctx.emit("plan", plan.todos);
      if (ctx.cancelled) throw new Error("orchestration cancelled");

      const finalized = await this.executeWorker(ctx, {
        role: "finalizer", phase: "finalization", readOnly: true,
        restrictions: READ_ONLY_RESTRICTIONS,
        visibleKinds: [],
      }, finalizationPrompt(ctx.request, plan, findings, implementation, verification, Array.from(ctx.touched)));
      finalAgent = finalized.agent;
      canonicalText = composeFinalResponse(finalized.worker.text, implementation, verification, Array.from(ctx.touched));
      setPhaseStatus(plan, "finalization", "completed");
      ctx.emit("plan", plan.todos);
      ctx.emit("text", canonicalText);
      const status = verification.passed ? "finished" : "verification-failed";
      const result = {
        runId: ctx.runId,
        status,
        text: canonicalText,
        verification,
        usage: ctx.usage,
        touchedFiles: Array.from(ctx.touched),
        todos: plan.todos,
        workers: Array.from(ctx.workers.values()).map((worker) => ({
          workerId: worker.workerId,
          role: worker.role,
          phase: worker.phase,
          attempt: worker.attempt,
          status: worker.status,
        })),
      };
      ctx.emit("result", Object.assign({ sequence: ++ctx.sequence }, result));
      return Object.assign({ finalAgent }, result);
    } catch (e) {
      if (ctx.cancelled) {
        return {
          runId: ctx.runId,
          status: "cancelled",
          text: "",
          verification: ctx.verification,
          touchedFiles: Array.from(ctx.touched),
          todos: plan.todos,
          workers: Array.from(ctx.workers.values()).map((worker) => ({
            workerId: worker.workerId, role: worker.role, phase: worker.phase, attempt: worker.attempt, status: worker.status,
          })),
          finalAgent: null,
        };
      }
      throw e;
    } finally {
      ctx.writerLease = false;
      if (releaseWriter) releaseWriter();
      if (this.verifier && typeof this.verifier.complete === "function") {
        try { await this.verifier.complete({ runId: ctx.runId, sessionId: ctx.sessionId }); } catch (e) {}
      }
      this.activeRuns.delete(ctx.runId);
      ctx.resolveCompletion();
    }
  }

  async cancel(runId) {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) return false;
    ctx.cancelled = true;
    try { ctx.abortController.abort(); } catch (e) {}
    const pending = [];
    ctx.workers.forEach((worker) => {
      if (!worker.run || typeof worker.run.cancel !== "function") return;
      try {
        if (typeof worker.run.supports !== "function" || worker.run.supports("cancel")) pending.push(Promise.resolve(worker.run.cancel()).catch(() => {}));
      } catch (e) {}
    });
    await Promise.all(pending);
    await ctx.completion;
    return true;
  }

  async cancelSession(sessionId) {
    const ids = [];
    this.activeRuns.forEach((ctx, id) => { if (ctx.sessionId === String(sessionId || "")) ids.push(id); });
    const results = await Promise.all(ids.map((id) => this.cancel(id)));
    return results.some(Boolean);
  }

  getRun(runId) {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) return null;
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      cancelled: ctx.cancelled,
      workers: Array.from(ctx.workers.values()).map((worker) => ({
        workerId: worker.workerId,
        role: worker.role,
        phase: worker.phase,
        attempt: worker.attempt,
        status: worker.status,
      })),
    };
  }
}

AgentOrchestrator.READ_ONLY_RESTRICTIONS = READ_ONLY_RESTRICTIONS;
AgentOrchestrator.Mutex = Mutex;
AgentOrchestrator.normalizeConfig = normalizeConfig;
AgentOrchestrator.normalizeTodos = normalizeTodos;
AgentOrchestrator.shouldOrchestrate = shouldOrchestrate;
AgentOrchestrator.explainOrchestration = explainOrchestration;
AgentOrchestrator.composeFinalResponse = composeFinalResponse;

module.exports = AgentOrchestrator;
