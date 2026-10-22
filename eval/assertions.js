"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Parser, Language } = require("web-tree-sitter");
const createStructuralTools = require("../lib/structural-tools");

const GRAMMAR_PACKAGE = "@repomix/tree-sitter-wasms/out/tree-sitter-";
const LANGUAGES = Object.freeze({
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
});
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "target"]);
let parserInit = null;
const languageCache = new Map();

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveInside(root, relativePath) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(relativePath || ""));
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Fixture path escapes workspace: " + relativePath);
  }
  return target;
}

function writeFiles(workspace, files) {
  Object.keys(files || {}).sort().forEach((relativePath) => {
    const target = resolveInside(workspace, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(files[relativePath]), "utf8");
  });
}

function copyFixture(caseDefinition, workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  writeFiles(workspace, caseDefinition.workspace || {});
  return workspace;
}

function materializeExpected(caseDefinition, workspace) {
  writeFiles(workspace, caseDefinition.expected || {});
}

function walkFiles(root) {
  const files = [];
  const queue = [path.resolve(root)];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      continue;
    }
    entries.forEach((entry) => {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(slash(path.relative(root, absolute)));
      }
    });
  }
  return files.sort();
}

function snapshotWorkspace(workspace) {
  const snapshot = {};
  walkFiles(workspace).forEach((relativePath) => {
    const buffer = fs.readFileSync(resolveInside(workspace, relativePath));
    snapshot[relativePath] = {
      hash: sha256(buffer),
      bytes: buffer.length,
      content: buffer.toString("utf8"),
    };
  });
  return snapshot;
}

function changedFiles(before, after) {
  return Array.from(new Set(Object.keys(before || {}).concat(Object.keys(after || {}))))
    .filter((relativePath) => !before[relativePath] || !after[relativePath] ||
      before[relativePath].hash !== after[relativePath].hash)
    .sort();
}

async function language(languageName) {
  if (!parserInit) {
    parserInit = Parser.init({
      locateFile() {
        return require.resolve("web-tree-sitter/web-tree-sitter.wasm");
      },
    });
  }
  await parserInit;
  if (!languageCache.has(languageName)) {
    languageCache.set(languageName,
      Language.load(require.resolve(GRAMMAR_PACKAGE + languageName + ".wasm")));
  }
  return languageCache.get(languageName);
}

async function syntaxSnapshot(workspace) {
  const result = {};
  for (const relativePath of walkFiles(workspace)) {
    const languageName = LANGUAGES[path.extname(relativePath).toLowerCase()];
    if (!languageName) continue;
    const loadedLanguage = await language(languageName);
    const parser = new Parser();
    let tree = null;
    try {
      parser.setLanguage(loadedLanguage);
      tree = parser.parse(fs.readFileSync(resolveInside(workspace, relativePath), "utf8"));
      result[relativePath] = createStructuralTools._private.syntaxErrorCount(tree);
    } finally {
      if (tree) tree.delete();
      parser.delete();
    }
  }
  return result;
}

function syntaxRegressions(before, after) {
  const files = [];
  let count = 0;
  Object.keys(after || {}).sort().forEach((relativePath) => {
    const added = Math.max(0, Number(after[relativePath] || 0) - Number(before[relativePath] || 0));
    if (added) files.push({ path: relativePath, before: before[relativePath] || 0, after: after[relativePath], added });
    count += added;
  });
  return { count, files };
}

function loadCases(casesDirectory) {
  return fs.readdirSync(casesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(casesDirectory, entry.name);
      const definition = JSON.parse(fs.readFileSync(file, "utf8"));
      definition.fixtureFile = file;
      if (!definition.id || !definition.prompt || !definition.workspace || !definition.expected) {
        throw new Error("Invalid eval fixture: " + entry.name);
      }
      return definition;
    });
}

async function evaluateCase(caseDefinition, options) {
  options = options || {};
  const workspace = path.resolve(options.workspace);
  const before = options.beforeSnapshot || {};
  const after = snapshotWorkspace(workspace);
  const changed = changedFiles(before, after);
  const checks = [];
  const failures = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail || "" });
    if (!ok) failures.push(name + (detail ? ": " + detail : ""));
  };

  Object.keys(caseDefinition.expected || {}).sort().forEach((relativePath) => {
    const entry = after[relativePath];
    const expected = String(caseDefinition.expected[relativePath]);
    record("file:" + relativePath, !!entry && entry.content === expected,
      !entry ? "missing" : "content mismatch");
  });

  const rules = caseDefinition.assertions || {};
  const allowed = (rules.allowedChangedFiles || Object.keys(caseDefinition.expected || {})).slice().sort();
  const required = (rules.requiredChangedFiles || []).slice().sort();
  const unexpected = changed.filter((relativePath) => !allowed.includes(relativePath));
  const missingChanges = required.filter((relativePath) => !changed.includes(relativePath));
  record("diff-scope", unexpected.length === 0,
    unexpected.length ? "unexpected changes: " + unexpected.join(", ") : "");
  record("required-changes", missingChanges.length === 0,
    missingChanges.length ? "missing changes: " + missingChanges.join(", ") : "");

  (rules.protectedFiles || []).forEach((relativePath) => {
    const previous = before[relativePath];
    const current = after[relativePath];
    record("protected:" + relativePath, !!previous && !!current && previous.hash === current.hash,
      !previous ? "missing baseline" : !current ? "file removed" : "file changed");
  });

  const tools = createStructuralTools({ workspace });
  for (const expectedAst of rules.ast || []) {
    try {
      const result = await tools.ast_search.execute({
        path: expectedAst.path,
        kind: expectedAst.kind || "declaration",
        name: expectedAst.name || "",
        case_sensitive: expectedAst.caseSensitive !== false,
      });
      const matches = result.structuredContent.matches || [];
      const count = expectedAst.count == null ? 1 : expectedAst.count;
      let ok = matches.length === count;
      if (expectedAst.nodeType) ok = ok && matches.every((match) => match.node_type === expectedAst.nodeType);
      if (expectedAst.contains) ok = ok && matches.some((match) => match.text.includes(expectedAst.contains));
      if (expectedAst.notContains) ok = ok && matches.every((match) => !match.text.includes(expectedAst.notContains));
      record("ast:" + expectedAst.path + ":" + (expectedAst.name || expectedAst.kind), ok,
        "expected " + count + ", found " + matches.length);
    } catch (error) {
      record("ast:" + expectedAst.path, false, error.message || String(error));
    }
  }

  if (rules.verification && rules.verification.required) {
    const verification = options.verification || null;
    record("verification", !!verification && verification.passed === true,
      verification ? String(verification.status || "unknown") : "missing");
  }

  const beforeSyntax = options.beforeSyntax || {};
  const afterSyntax = await syntaxSnapshot(workspace);
  const regressions = syntaxRegressions(beforeSyntax, afterSyntax);
  record("syntax-regressions", regressions.count === 0,
    regressions.files.map((item) => item.path + " +" + item.added).join(", "));

  return {
    success: failures.length === 0,
    checks,
    failures,
    changedFiles: changed,
    syntaxRegressions: regressions.count,
    syntaxRegressionFiles: regressions.files,
    afterSnapshot: after,
    afterSyntax,
  };
}

async function assertCase(caseDefinition, options) {
  const result = await evaluateCase(caseDefinition, options);
  assert.strictEqual(result.success, true, result.failures.join("\n"));
  return result;
}

module.exports = {
  assertCase,
  changedFiles,
  copyFixture,
  evaluateCase,
  loadCases,
  materializeExpected,
  snapshotWorkspace,
  syntaxRegressions,
  syntaxSnapshot,
};
