#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const AiChat = require("../lib/ai-chat");
const ContextEngine = require("../lib/context-engine");
const MemoryStore = require("../lib/memory-store");
const VerificationEngine = require("../lib/verification-engine");
const WorkspaceEvents = require("../lib/workspace-events");
const WorkspaceIndex = require("../lib/workspace-index");
const createMemoryTools = require("../lib/memory-tools");
const createStructuralTools = require("../lib/structural-tools");
const BrowserAutomation = require("../lib/browser-automation");
const DesktopRemote = require("../lib/desktop-remote");
const assertions = require("../eval/assertions");

function argsOf(argv) {
  const args = { cases: [] };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--config") args.config = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--case") args.cases.push.apply(args.cases, String(argv[++index] || "").split(","));
    else if (value === "--keep-workspaces") args.keepWorkspaces = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error("Unknown argument: " + value);
  }
  args.cases = args.cases.map((value) => value.trim()).filter(Boolean);
  return args;
}

function help() {
  return [
    "Opt-in live Smart Agent evaluation",
    "",
    "Usage:",
    "  SMART_AGENT_EVAL=1 npm run eval:agent -- --case js-function-replacement",
    "  npm run eval:agent -- --config eval/live-config.json --output eval/results/latest.json",
    "",
    "The runner does nothing unless SMART_AGENT_EVAL=1 or the config contains",
    "{\"enabled\":true}. Provider credentials use CURSOR_API_KEY, ANTHROPIC_API_KEY,",
    "or an existing encrypted Grok session selected by SMART_AGENT_EVAL_GROK_AUTH_FILE.",
  ].join("\n");
}

function readConfig(file) {
  if (!file) return {};
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function enabled(config) {
  return process.env.SMART_AGENT_EVAL === "1" || config.enabled === true;
}

function providerConfig(config) {
  const provider = String(process.env.SMART_AGENT_EVAL_PROVIDER || config.provider || "cursor").toLowerCase();
  if (!["cursor", "anthropic", "grok"].includes(provider)) {
    throw new Error("Unsupported eval provider: " + provider);
  }
  return {
    provider,
    model: process.env.SMART_AGENT_EVAL_MODEL || config.model || "auto",
    apiKey: process.env.CURSOR_API_KEY || config.cursorApiKey || "",
    anthropicKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey || "",
    grokAuthFile: process.env.SMART_AGENT_EVAL_GROK_AUTH_FILE || config.grokAuthFile || "",
    authSecret: process.env.AUTH_SECRET || config.authSecret || "",
  };
}

function uniqueToolCalls(events) {
  const calls = new Map();
  events.filter((event) => event.kind === "tool").forEach((event, index) => {
    const value = event.value || {};
    const key = value.callId || ((value.tool || value.name || "tool") + "-" + index);
    calls.set(key, value);
  });
  return Array.from(calls.values());
}

function usageFrom(events, result) {
  if (result && result.usage) return result.usage;
  const usages = events.filter((event) => event.kind === "usage" && event.value);
  return usages.length ? usages[usages.length - 1].value : null;
}

function textEditFallback(toolCalls) {
  const direct = /^(edit|write|create|applypatch|applyagentdiff|multiedit|strreplace|searchreplace)$/i;
  return toolCalls.some((call) => direct.test(String(call.tool || call.name || "").replace(/[_-]/g, "")));
}

// Fixture boleh meminta tool yang butuh perangkat di server: "requires": ["browser"] dan/atau
// ["desktop"]. Bila perangkatnya tidak ada, case dilaporkan "skipped" (bukan gagal), supaya
// laporan di server tanpa browser/desktop tetap jujur tentang yang benar-benar diuji.
function unmetRequirements(definition, browser, desktop) {
  const needs = Array.isArray(definition.requires) ? definition.requires : [];
  const missing = [];
  if (needs.includes("browser") && !(browser && browser.exe)) missing.push("browser (no Chromium-based browser found)");
  if (needs.includes("desktop")) {
    let st = null;
    try { st = desktop ? desktop.status() : null; } catch (e) { st = null; }
    if (!st || !st.ok) missing.push("desktop (" + ((st && st.reason) || "no display") + ")");
  }
  return missing;
}

async function runCase(definition, config, provider) {
  const needs = Array.isArray(definition.requires) ? definition.requires : [];
  const deviceDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-agent-eval-dev-"));
  const browser = needs.includes("browser") ? new BrowserAutomation({ dataDir: deviceDir }) : null;
  const desktop = needs.includes("desktop") ? new DesktopRemote({ dataDir: deviceDir }) : null;
  const missing = unmetRequirements(definition, browser, desktop);
  if (missing.length) {
    fs.rmSync(deviceDir, { recursive: true, force: true });
    return {
      id: definition.id, success: false, skipped: true, provider: provider.provider, model: provider.model,
      status: "skipped", toolCalls: 0, textEditFallback: false, tokens: null, durationMs: 0, changedFiles: [],
      syntaxRegressions: null, verification: null, failures: [], skipReason: "missing " + missing.join(", "),
    };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-agent-eval-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data", "context");
  const started = Date.now();
  let chat = null;
  let index = null;
  let memory = null;
  let context = null;
  let beforeSnapshot = null;
  let beforeSyntax = null;
  const events = [];
  let status = "error";
  let error = "";
  let assertionResult = null;
  let orchestrationResult = null;
  try {
    assertions.copyFixture(definition, workspace);
    beforeSnapshot = assertions.snapshotWorkspace(workspace);
    beforeSyntax = await assertions.syntaxSnapshot(workspace);
    const workspaceEvents = new WorkspaceEvents({ workspace, dedupeMs: 1 });
    index = new WorkspaceIndex({ workspace, dataDir, events: workspaceEvents });
    await index.whenIdle();
    memory = new MemoryStore({ workspace, dataDir, events: workspaceEvents });
    await memory.whenIdle();
    context = new ContextEngine({
      workspace,
      index,
      events: workspaceEvents,
      memoryStore: memory,
      characterBudget: Number(config.characterBudget) || 12000,
    });
    const verifier = new VerificationEngine({
      workspace,
      index,
      shell: config.verifyShell || "",
      timeoutMs: Number(config.verifyTimeoutMs) || 120000,
      maxOutput: Number(config.verifyMaxOutput) || 64 * 1024,
      onChanged: (paths) => workspaceEvents.publish("eval-verifier", paths, { wildcard: !paths.length }),
    });
    const aiConfigFile = path.join(root, "ai-config.json");
    fs.writeFileSync(aiConfigFile, JSON.stringify({
      provider: provider.provider,
      model: provider.model,
      mode: "agent",
      orchestration: {
        mode: "on",
        explorerCount: Math.max(1, Math.min(4, Number(config.explorerCount) || 2)),
        maxRepairAttempts: Math.max(0, Math.min(3, Number(config.maxRepairAttempts) || 1)),
      },
      verifyCmd: definition.verifyCommand || "",
      browserTools: browser ? "on" : "off",
      desktopTools: desktop ? "on" : "off",
      memory: false,
    }, null, 2));
    chat = new AiChat({
      workspace,
      configFile: aiConfigFile,
      storeFile: path.join(root, "ai-sessions.json"),
      grokAuthFile: provider.grokAuthFile,
      authSecret: provider.authSecret,
      apiKey: provider.apiKey,
      anthropicKey: provider.anthropicKey,
      contextEngine: context,
      workspaceEvents,
      customTools: () => Object.assign({},
        browser ? browser.tools() : {},
        desktop ? desktop.tools() : {},
        createMemoryTools(memory),
        createStructuralTools({ workspace })),
      browser: browser || undefined,
      desktopStatus: desktop ? () => desktop.status() : undefined,
      desktopShot: desktop ? (callId) => desktop.shotFor(callId) : undefined,
      verifier,
      orchestration: "on",
      onFsChange: (paths) => workspaceEvents.publish("eval-agent", paths, { wildcard: !paths.length }),
    });
    const readiness = chat.readiness();
    if (!readiness.ok) throw new Error(readiness.reason);

    const sessionId = "eval-" + definition.id;
    const timeoutMs = Math.max(1000, Number(config.caseTimeoutMs) || 10 * 60 * 1000);
    const timer = setTimeout(() => {
      chat.stop(sessionId).catch(() => {});
    }, timeoutMs);
    if (timer.unref) timer.unref();
    try {
      status = await chat.send(sessionId, definition.prompt, (kind, value) => {
        events.push({ kind, value });
        if (kind === "result") orchestrationResult = value;
      }, { orchestrate: true, title: "Eval: " + definition.id });
    } finally {
      clearTimeout(timer);
    }
    const stored = chat.getSession(sessionId);
    const aiMessage = stored && stored.messages.slice().reverse().find((message) => message.role === "ai");
    if (!orchestrationResult && aiMessage && aiMessage.orchestration) {
      orchestrationResult = aiMessage.orchestration;
    }
    const verification = orchestrationResult && orchestrationResult.verification;
    assertionResult = await assertions.evaluateCase(definition, {
      workspace,
      beforeSnapshot,
      beforeSyntax,
      verification,
    });
  } catch (caught) {
    error = caught && caught.stack ? caught.stack : String(caught);
    if (beforeSnapshot && beforeSyntax && fs.existsSync(workspace)) {
      try {
        assertionResult = await assertions.evaluateCase(definition, {
          workspace,
          beforeSnapshot,
          beforeSyntax,
          verification: orchestrationResult && orchestrationResult.verification,
        });
      } catch (assertionError) {
        error += "\nAssertion error: " + (assertionError.stack || assertionError);
      }
    }
  } finally {
    if (chat) {
      try { await chat.disposeAll(); } catch (disposeError) {}
    }
    if (context) context.close();
    if (memory) memory.close();
    if (index) index.close();
    if (browser) { try { await browser.close(); } catch (e) {} }
    try { fs.rmSync(deviceDir, { recursive: true, force: true }); } catch (e) {}
  }

  const tools = uniqueToolCalls(events);
  const durationMs = Date.now() - started;
  const result = {
    id: definition.id,
    success: status === "finished" && !!assertionResult && assertionResult.success,
    provider: provider.provider,
    model: provider.model,
    status,
    toolCalls: tools.length,
    textEditFallback: textEditFallback(tools),
    tokens: usageFrom(events, orchestrationResult),
    durationMs,
    changedFiles: assertionResult ? assertionResult.changedFiles : [],
    syntaxRegressions: assertionResult ? assertionResult.syntaxRegressions : null,
    verification: orchestrationResult && orchestrationResult.verification
      ? {
        passed: orchestrationResult.verification.passed,
        status: orchestrationResult.verification.status,
        attempts: Number(orchestrationResult.verification.attempt || 0) + 1,
      } : null,
    failures: assertionResult ? assertionResult.failures : ["evaluation did not reach assertions"],
  };
  if (error) result.error = error;
  if (config.keepWorkspaces || !result.success) result.workspace = workspace;
  else fs.rmSync(root, { recursive: true, force: true });
  return result;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) {
    console.log(help());
    return;
  }
  const config = readConfig(args.config);
  if (!enabled(config)) {
    console.log("Live agent evaluation is disabled. Set SMART_AGENT_EVAL=1 or use a config with enabled=true.");
    return;
  }
  if (args.keepWorkspaces) config.keepWorkspaces = true;
  const provider = providerConfig(config);
  const casesDirectory = path.join(__dirname, "..", "eval", "cases");
  let cases = assertions.loadCases(casesDirectory);
  const selected = args.cases.length ? args.cases : (Array.isArray(config.cases) ? config.cases : []);
  if (selected.length) cases = cases.filter((definition) => selected.includes(definition.id));
  if (!cases.length) throw new Error("No eval cases selected");

  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    provider: provider.provider,
    model: provider.model,
    cases: [],
  };
  for (const definition of cases) {
    process.stdout.write("eval " + definition.id + " ... ");
    const result = await runCase(definition, config, provider);
    report.cases.push(result);
    console.log(result.skipped ? "skipped (" + result.skipReason + ")" : (result.success ? "passed" : "failed"));
  }
  report.finishedAt = new Date().toISOString();
  const ran = report.cases.filter((item) => !item.skipped);
  report.success = ran.length > 0 && ran.every((item) => item.success);
  report.metrics = {
    total: report.cases.length,
    ran: ran.length,
    skipped: report.cases.length - ran.length,
    passed: ran.filter((item) => item.success).length,
    successRate: ran.length ? ran.filter((item) => item.success).length / ran.length : 0,
    toolCalls: report.cases.reduce((sum, item) => sum + item.toolCalls, 0),
    textEditFallbacks: report.cases.filter((item) => item.textEditFallback).length,
    durationMs: report.cases.reduce((sum, item) => sum + item.durationMs, 0),
    syntaxRegressions: report.cases.reduce((sum, item) => sum + Number(item.syntaxRegressions || 0), 0),
  };
  const output = path.resolve(args.output || config.output ||
    path.join(__dirname, "..", "eval", "results", "latest.json"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("metrics: " + output);
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
