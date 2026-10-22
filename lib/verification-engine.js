"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".cs", ".go", ".h", ".hpp", ".java", ".js",
  ".jsx", ".kt", ".kts", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".ts",
  ".tsx", ".vue", ".svelte",
]);
const CONFIG_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
  "yarn.lock", "bun.lock", "bun.lockb", "pyproject.toml", "pytest.ini", "tox.ini",
  "setup.cfg", "requirements.txt", "go.mod", "go.sum", "cargo.toml", "cargo.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "gemfile",
]);
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".cache", "coverage",
  ".turbo", "__pycache__", ".venv", "venv", "target", "vendor", ".idea",
]);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function quoteArg(value) {
  const text = String(value);
  if (process.platform === "win32") return '"' + text.replace(/"/g, '""') + '"';
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function unique(values) {
  return Array.from(new Set((values || []).map(toPosix).filter(Boolean)));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { return null; }
}

function fileSignature(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isRelevantFile(rel) {
  const base = path.basename(rel).toLowerCase();
  return CODE_EXTENSIONS.has(path.extname(base)) || CONFIG_FILES.has(base) ||
    /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(rel) || /\.(test|spec)\.[^.]+$/i.test(rel);
}

function looksLikeTest(rel) {
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(rel) || /\.(test|spec)\.[^.]+$/i.test(rel);
}

function packageManager(workspace) {
  if (fs.existsSync(path.join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(workspace, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(workspace, "bun.lock")) || fs.existsSync(path.join(workspace, "bun.lockb"))) return "bun";
  return "npm";
}

function scriptCommand(manager, name) {
  if (manager === "yarn" || manager === "bun") return manager + " run " + name;
  return manager + " run " + name;
}

function importedStem(importValue) {
  return toPosix(importValue).replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/i, "").replace(/^\.\//, "");
}

function relevantNodeTests(index, touched) {
  const manifest = index && typeof index.manifest === "function" ? index.manifest() : { files: {} };
  const files = manifest.files || {};
  const sourceStems = touched.filter((rel) => !looksLikeTest(rel))
    .map((rel) => toPosix(rel).replace(/\.[^.\/]+$/, ""));
  const direct = touched.filter((rel) => looksLikeTest(rel) && /\.(c?m?js|jsx)$/i.test(rel));
  Object.keys(files).forEach((rel) => {
    if (!looksLikeTest(rel) || !/\.(c?m?js|jsx)$/i.test(rel)) return;
    const entry = files[rel] || {};
    const testDir = path.posix.dirname(rel);
    const matches = (entry.imports || []).some((value) => {
      const stem = importedStem(value);
      if (!stem.startsWith(".")) return false;
      const resolved = path.posix.normalize(path.posix.join(testDir, stem));
      return sourceStems.some((source) => source === resolved || source.endsWith("/" + path.posix.basename(resolved)));
    });
    if (matches) direct.push(rel);
  });
  return unique(direct).slice(0, 8);
}

function isStandaloneNodeTest(workspace, rel) {
  let source = "";
  try { source = fs.readFileSync(path.join(workspace, rel.split("/").join(path.sep)), "utf8"); }
  catch (error) { return false; }
  return /(?:require\s*\(\s*["']node:test["']\s*\)|from\s+["']node:test["']|import\s*\(\s*["']node:test["']\s*\))/m.test(source);
}

function filteredTestCommand(manager, script, tests) {
  const command = String(script || "");
  let option = "";
  if (/\bjest\b/i.test(command)) option = "--runTestsByPath ";
  else if (/\bvitest\b/i.test(command)) option = "--run ";
  else if (!/\bmocha\b/i.test(command) && !/\bnode(?:\.exe)?\s+--test\b/i.test(command)) return "";
  const separator = manager === "yarn" ? " " : " -- ";
  return scriptCommand(manager, "test") + separator + option + tests.map(quoteArg).join(" ");
}

function selectCommands(input) {
  input = input || {};
  const workspace = path.resolve(input.workspace || process.cwd());
  const override = String(input.override || "").trim();
  if (override) return { source: "override", commands: [override] };
  const touched = unique(input.touchedFiles).filter((rel) => rel !== "*");
  const relevant = touched.filter(isRelevantFile);
  if (!relevant.length) return { source: "workspace", commands: [], reason: "No relevant code or project files changed." };

  const commands = [];
  const pkg = readJson(path.join(workspace, "package.json"));
  if (pkg) {
    const tests = relevantNodeTests(input.index, relevant);
    const scripts = pkg.scripts || {};
    const manager = packageManager(workspace);
    if (tests.length) {
      const standalone = tests.filter((rel) => isStandaloneNodeTest(workspace, rel));
      if (standalone.length === tests.length) {
        commands.push("node --test " + standalone.map(quoteArg).join(" "));
      } else if (scripts.test) {
        commands.push(filteredTestCommand(manager, scripts.test, tests) || scriptCommand(manager, "test"));
      }
    } else {
      const onlyUi = relevant.every((rel) => /\.(css|html?)$/i.test(rel));
      if (onlyUi && scripts.lint) commands.push(scriptCommand(manager, "lint"));
      else if (scripts.test) commands.push(scriptCommand(manager, "test"));
      else if (scripts.check) commands.push(scriptCommand(manager, "check"));
      else if (scripts.typecheck) commands.push(scriptCommand(manager, "typecheck"));
      else if (scripts.lint) commands.push(scriptCommand(manager, "lint"));
      else if (scripts.build) commands.push(scriptCommand(manager, "build"));
    }
  }

  const python = relevant.filter((rel) => /\.py$/i.test(rel));
  if (python.length && (fs.existsSync(path.join(workspace, "pyproject.toml")) || fs.existsSync(path.join(workspace, "pytest.ini")))) {
    const tests = python.filter(looksLikeTest);
    commands.push("python -m pytest -q" + (tests.length ? " " + tests.map(quoteArg).join(" ") : ""));
  }
  const go = relevant.filter((rel) => /\.go$/i.test(rel));
  if (go.length && fs.existsSync(path.join(workspace, "go.mod"))) {
    const dirs = unique(go.map((rel) => path.posix.dirname(rel))).map((dir) => dir === "." ? "./..." : "./" + dir + "/...");
    commands.push("go test " + dirs.join(" "));
  }
  if (relevant.some((rel) => /\.rs$/i.test(rel)) && fs.existsSync(path.join(workspace, "Cargo.toml"))) commands.push("cargo test");
  if (relevant.some((rel) => /\.(java|kt|kts)$/i.test(rel))) {
    if (fs.existsSync(path.join(workspace, "pom.xml"))) commands.push("mvn -q test");
    else if (fs.existsSync(path.join(workspace, "gradlew")) || fs.existsSync(path.join(workspace, "gradlew.bat"))) {
      commands.push(process.platform === "win32" ? "gradlew.bat test" : "./gradlew test");
    } else if (fs.existsSync(path.join(workspace, "build.gradle")) || fs.existsSync(path.join(workspace, "build.gradle.kts"))) commands.push("gradle test");
  }
  if (relevant.some((rel) => /\.php$/i.test(rel)) && fs.existsSync(path.join(workspace, "composer.json"))) {
    if (fs.existsSync(path.join(workspace, "vendor", "bin", process.platform === "win32" ? "phpunit.bat" : "phpunit"))) {
      commands.push(process.platform === "win32" ? "vendor\\bin\\phpunit.bat" : "vendor/bin/phpunit");
    }
  }
  if (relevant.some((rel) => /\.rb$/i.test(rel)) && fs.existsSync(path.join(workspace, "Gemfile"))) commands.push("bundle exec rspec");

  return {
    source: "manifest",
    commands: Array.from(new Set(commands)).slice(0, 3),
    reason: commands.length ? "" : "No applicable verification command was found in project manifests.",
  };
}

function shellInvocation(command, configuredShell) {
  let shell = String(configuredShell || "").trim();
  if (!shell) shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
  const base = path.basename(shell).toLowerCase();
  if (/powershell|pwsh/.test(base)) return { file: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  if (base === "cmd" || base === "cmd.exe") return { file: shell, args: ["/d", "/s", "/c", command], verbatim: true };
  return { file: shell, args: ["-lc", command] };
}

function terminate(child) {
  let killTimer = null;
  const cleanup = () => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
  };
  if (!child || child.exitCode != null) return cleanup;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 3000 });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { child.kill("SIGTERM"); }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { try { child.kill("SIGKILL"); } catch (ignored) {} }
      }, 1000);
      if (killTimer.unref) killTimer.unref();
      child.once("close", cleanup);
    }
  } catch (error) {
    try { child.kill(); } catch (ignored) {}
  }
  return cleanup;
}

function runCommand(command, options) {
  options = options || {};
  const started = Date.now();
  const maxOutput = Math.max(1024, Number(options.maxOutput) || 64 * 1024);
  const invocation = shellInvocation(command, options.shell);
  const spawnProcess = typeof options.spawn === "function" ? options.spawn : spawn;
  const terminateProcess = typeof options.terminate === "function" ? options.terminate : terminate;
  return new Promise((resolve) => {
    let stdout = "", stderr = "", stdoutTruncated = false, stderrTruncated = false;
    let settled = false, timedOut = false, cancelled = false;
    let child, timer = null, closeTimer = null, terminateCleanup = null;
    const append = (current, chunk, stream) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const room = maxOutput - current.length;
      if (room <= 0) {
        if (stream === "stdout") stdoutTruncated = true; else stderrTruncated = true;
        return current;
      }
      if (text.length > room) {
        if (stream === "stdout") stdoutTruncated = true; else stderrTruncated = true;
        return current + text.slice(0, room);
      }
      return current + text;
    };
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      if (terminateCleanup) terminateCleanup();
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      if (stdoutTruncated) stdout += "\n…(stdout truncated)";
      if (stderrTruncated) stderr += "\n…(stderr truncated)";
      if (error && !stderr) stderr = error.message || String(error);
      const exitCode = typeof code === "number" ? code : (cancelled || timedOut ? null : 1);
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        status: cancelled ? "cancelled" : timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
        passed: !cancelled && !timedOut && exitCode === 0,
        timedOut,
        cancelled,
      });
    };
    const onAbort = () => {
      if (settled || cancelled || timedOut) return;
      cancelled = true;
      if (!child) return finish(null);
      terminateCleanup = terminateProcess(child) || null;
      closeTimer = setTimeout(() => finish(null), 5000);
    };
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal && options.signal.aborted) return onAbort();
    try {
      child = spawnProcess(invocation.file, invocation.args, {
        cwd: options.workspace,
        env: Object.assign({}, process.env, options.env || {}),
        windowsHide: true,
        windowsVerbatimArguments: process.platform === "win32" && !!invocation.verbatim,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return finish(1, error);
    }
    if (settled || cancelled) {
      terminateCleanup = terminateProcess(child) || null;
      return;
    }
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.on("error", (error) => {
      if (!cancelled && !timedOut) finish(1, error);
      else if (!stderr) stderr = error.message || String(error);
    });
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => {
      if (settled || timedOut) return;
      timedOut = true;
      terminateCleanup = terminateProcess(child) || null;
      closeTimer = setTimeout(() => finish(null), 5000);
    }, Math.max(100, Number(options.timeoutMs) || 120000));
    if (timer.unref) timer.unref();
  });
}

class VerificationEngine {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.index = options.index || null;
    this.shell = options.shell || "";
    this.timeoutMs = Math.max(100, Number(options.timeoutMs) || 120000);
    this.maxOutput = Math.max(1024, Number(options.maxOutput) || 64 * 1024);
    this.onChanged = typeof options.onChanged === "function" ? options.onChanged : null;
    this.baselines = new Map();
    this.results = new Map();
    this.latest = null;
  }

  async _paths() {
    if (this.index && typeof this.index.walk === "function") return this.index.walk(this.workspace);
    const out = [], stack = [this.workspace];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (error) { continue; }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
        } else if (entry.isFile()) out.push(toPosix(path.relative(this.workspace, abs)));
      }
    }
    return out.sort();
  }

  async _snapshot() {
    if (this.index && typeof this.index.whenIdle === "function") await this.index.whenIdle();
    const files = {};
    const paths = await this._paths();
    for (const rel of paths) {
      const abs = path.join(this.workspace, rel.split("/").join(path.sep));
      try {
        const stat = await fs.promises.stat(abs);
        if (!stat.isFile()) continue;
        if (stat.size > 2 * 1024 * 1024) files[rel] = "stat:" + stat.size + ":" + Math.floor(stat.mtimeMs);
        else files[rel] = fileSignature(await fs.promises.readFile(abs));
      } catch (error) {}
    }
    return files;
  }

  async prepare(context) {
    const runId = String(context && context.runId || "");
    if (!runId || this.baselines.has(runId)) return;
    this.baselines.set(runId, await this._snapshot());
  }

  async reconcile(runId) {
    const baseline = this.baselines.get(String(runId || "")) || {};
    const current = await this._snapshot();
    const changed = [];
    Object.keys(Object.assign({}, baseline, current)).sort().forEach((rel) => {
      if (baseline[rel] !== current[rel]) changed.push(rel);
    });
    if (this.index && typeof this.index.rescan === "function") {
      try { await this.index.rescan(); } catch (error) {}
    }
    if (changed.length && this.onChanged) {
      try { this.onChanged(changed); } catch (error) {}
    }
    return changed;
  }

  async verify(context) {
    context = context || {};
    if (!this.baselines.has(String(context.runId || ""))) await this.prepare(context);
    const reconciled = await this.reconcile(context.runId);
    let touchedFiles = unique([].concat(context.touchedFiles || [], reconciled)).filter((rel) => rel !== "*");
    const selection = selectCommands({
      workspace: this.workspace,
      index: this.index,
      touchedFiles,
      override: context.verifyCmd,
    });
    if (!selection.commands.length) {
      const skipped = {
        runId: context.runId,
        attempt: context.attempt || 0,
        passed: true,
        status: "skipped",
        command: "",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        commands: [],
        issues: [],
        message: selection.reason || "No verification command selected.",
        selection: selection.source,
        touchedFiles,
      };
      this._remember(skipped);
      return skipped;
    }

    const started = Date.now();
    const results = [];
    for (const command of selection.commands) {
      const result = await runCommand(command, {
        workspace: this.workspace,
        shell: this.shell,
        timeoutMs: this.timeoutMs,
        maxOutput: this.maxOutput,
        signal: context.signal,
      });
      results.push(result);
      if (!result.passed) break;
    }
    touchedFiles = unique(touchedFiles.concat(await this.reconcile(context.runId)));
    const failed = results.find((result) => !result.passed);
    const status = failed ? failed.status : "passed";
    const aggregate = {
      runId: context.runId,
      attempt: context.attempt || 0,
      passed: !failed,
      status,
      command: results.map((result) => result.command).join(" && "),
      exitCode: failed ? failed.exitCode : (results.length ? results[results.length - 1].exitCode : null),
      stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
      stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
      durationMs: Date.now() - started,
      commands: results,
      issues: failed ? [failed.stderr || failed.stdout || (failed.command + " " + failed.status)] : [],
      selection: selection.source,
      touchedFiles,
    };
    this._remember(aggregate);
    return aggregate;
  }

  _remember(result) {
    this.latest = result;
    const runId = String(result.runId || "");
    if (runId) {
      const list = this.results.get(runId) || [];
      list.push(result);
      this.results.set(runId, list.slice(-8));
    }
    while (this.results.size > 50) this.results.delete(this.results.keys().next().value);
  }

  complete(context) {
    this.baselines.delete(String(context && context.runId || ""));
  }

  status(runId) {
    const id = String(runId || "");
    return {
      active: this.baselines.size,
      latest: id ? ((this.results.get(id) || []).slice(-1)[0] || null) : this.latest,
      results: id ? (this.results.get(id) || []) : undefined,
      timeoutMs: this.timeoutMs,
      maxOutput: this.maxOutput,
    };
  }
}

VerificationEngine.selectCommands = selectCommands;
VerificationEngine.runCommand = runCommand;
VerificationEngine.shellInvocation = shellInvocation;

module.exports = VerificationEngine;
