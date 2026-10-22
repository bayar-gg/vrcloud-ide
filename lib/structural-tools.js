"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Parser, Language } = require("web-tree-sitter");

const GRAMMAR_PACKAGE = "@repomix/tree-sitter-wasms/out/tree-sitter-";
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 250,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxMatches: 200,
  timeoutMs: 5000,
});
const HARD_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxMatches: 1000,
  timeoutMs: 30000,
});
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".next", ".cache", ".venv", "build", "coverage",
  "dist", "node_modules", "target", "vendor", "__pycache__",
]);

const LANGUAGE_BY_EXTENSION = Object.freeze({
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

const DECLARATIONS = Object.freeze({
  javascript: new Set([
    "function_declaration", "generator_function_declaration", "class_declaration",
    "method_definition", "variable_declarator",
  ]),
  typescript: new Set([
    "function_declaration", "generator_function_declaration", "class_declaration",
    "method_definition", "variable_declarator", "interface_declaration",
    "type_alias_declaration", "enum_declaration", "abstract_class_declaration",
    "internal_module",
  ]),
  tsx: new Set([
    "function_declaration", "generator_function_declaration", "class_declaration",
    "method_definition", "variable_declarator", "interface_declaration",
    "type_alias_declaration", "enum_declaration", "abstract_class_declaration",
    "internal_module",
  ]),
  python: new Set(["function_definition", "class_definition"]),
  go: new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]),
  rust: new Set([
    "function_item", "struct_item", "enum_item", "trait_item", "type_item",
    "mod_item", "const_item", "static_item", "union_item", "macro_definition",
  ]),
});

const IMPORTS = Object.freeze({
  javascript: new Set(["import_statement"]),
  typescript: new Set(["import_statement"]),
  tsx: new Set(["import_statement"]),
  python: new Set(["import_statement", "import_from_statement"]),
  go: new Set(["import_spec"]),
  rust: new Set(["use_declaration"]),
});

let parserInit = null;
const languagePromises = new Map();

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function boundedInt(value, fallback, hardMax) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, hardMax);
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpath(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function assertRealpathInside(realRoot, candidate, label) {
  const resolved = realpath(candidate);
  if (!isInside(realRoot, resolved)) {
    throw new Error((label || "Path") + " escapes the workspace through a symlink or junction");
  }
  return resolved;
}

function resolveWorkspacePath(workspace, relativePath) {
  const root = path.resolve(workspace);
  const target = path.resolve(root, String(relativePath || "."));
  if (!isInside(root, target)) throw new Error("Path escapes the workspace");
  return target;
}

function relativeWorkspacePath(workspace, absolutePath) {
  return slash(path.relative(path.resolve(workspace), absolutePath));
}

function languageForPath(filePath) {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "";
}

async function initializeParser() {
  if (!parserInit) {
    parserInit = Parser.init({
      locateFile() {
        return require.resolve("web-tree-sitter/web-tree-sitter.wasm");
      },
    });
  }
  await parserInit;
}

async function loadLanguage(language) {
  if (!DECLARATIONS[language]) throw new Error("Unsupported structural language: " + language);
  if (!languagePromises.has(language)) {
    languagePromises.set(language, (async () => {
      await initializeParser();
      const grammar = require.resolve(GRAMMAR_PACKAGE + language + ".wasm");
      return Language.load(grammar);
    })());
  }
  return languagePromises.get(language);
}

async function createParser(language) {
  const loadedLanguage = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(loadedLanguage);
  return parser;
}

function byteOffsetMap(source) {
  const offsets = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let index = 0; index < source.length;) {
    offsets[index] = bytes;
    const codePoint = source.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    bytes += Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    if (width === 2) offsets[index + 1] = bytes;
    index += width;
    offsets[index] = bytes;
  }
  return offsets;
}

function nodeByteRange(node, byteOffsets) {
  return {
    start: byteOffsets[node.startIndex],
    end: byteOffsets[node.endIndex],
  };
}

function sourceSlice(buffer, node, byteOffsets) {
  const range = nodeByteRange(node, byteOffsets);
  return buffer.subarray(range.start, range.end).toString("utf8");
}

function fieldText(buffer, node, field, byteOffsets) {
  const child = node.childForFieldName(field);
  return child ? sourceSlice(buffer, child, byteOffsets) : "";
}

function terminalName(value) {
  const clean = String(value || "").trim().replace(/^["'`]|["'`]$/g, "");
  const parts = clean.split(/(?:\.|::|->|\s+)/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
}

function importName(language, buffer, node, byteOffsets) {
  const source = fieldText(buffer, node, "source", byteOffsets) ||
    fieldText(buffer, node, "path", byteOffsets) ||
    fieldText(buffer, node, "module", byteOffsets) ||
    fieldText(buffer, node, "module_name", byteOffsets) ||
    fieldText(buffer, node, "name", byteOffsets);
  if (source) return source.replace(/^["'`]|["'`]$/g, "");
  const text = sourceSlice(buffer, node, byteOffsets).trim();
  if (language === "python") {
    const match = /^(?:from\s+([^\s]+)|import\s+([^\s,]+))/.exec(text);
    if (match) return match[1] || match[2];
  }
  if (language === "rust") {
    const match = /^use\s+([^;]+)/.exec(text);
    if (match) return match[1].trim();
  }
  const quoted = /["']([^"']+)["']/.exec(text);
  return quoted ? quoted[1] : text;
}

function classifyNode(language, kind, buffer, node, byteOffsets) {
  if (kind === "declaration") {
    if (!DECLARATIONS[language].has(node.type)) return null;
    let name = fieldText(buffer, node, "name", byteOffsets);
    if (!name && node.type === "method_declaration") {
      const receiver = fieldText(buffer, node, "receiver", byteOffsets);
      name = (receiver ? receiver + "." : "") + fieldText(buffer, node, "name", byteOffsets);
    }
    if (!name) return null;
    return { name: name.trim(), node };
  }
  if (kind === "call") {
    if (node.type !== "call_expression" && !(language === "python" && node.type === "call") &&
        !(language === "javascript" && node.type === "new_expression") &&
        !(language === "typescript" && node.type === "new_expression") && !(language === "tsx" && node.type === "new_expression") &&
        !(language === "rust" && node.type === "macro_invocation")) return null;
    const called = fieldText(buffer, node, "function", byteOffsets) ||
      fieldText(buffer, node, "macro", byteOffsets) ||
      (node.namedChildCount ? sourceSlice(buffer, node.namedChild(0), byteOffsets) : "");
    if (!called) return null;
    return { name: called.trim(), node };
  }
  if (kind === "import") {
    if (!IMPORTS[language].has(node.type)) return null;
    return { name: importName(language, buffer, node, byteOffsets), node };
  }
  return null;
}

function nameMatches(actual, expected, caseSensitive) {
  if (!expected) return true;
  let left = String(actual || "");
  let right = String(expected || "");
  if (!caseSensitive) {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  return left === right || terminalName(left) === right;
}

function stableMatchId(relativePath, kind, nodeType, name, bytes) {
  const contentHash = sha256(bytes);
  return "ast-" + sha256([
    "v1", slash(relativePath), kind, nodeType, String(name || ""), contentHash,
  ].join("\0")).slice(0, 24);
}

function position(position) {
  return { line: position.row, column: position.column };
}

function findMatches(relativePath, language, kind, name, caseSensitive, buffer, tree, byteOffsets, maxMatches) {
  const matches = [];
  const stack = [tree.rootNode];
  while (stack.length && matches.length < maxMatches) {
    const node = stack.pop();
    const classified = classifyNode(language, kind, buffer, node, byteOffsets);
    if (classified && nameMatches(classified.name, name, caseSensitive)) {
      const byteRange = nodeByteRange(node, byteOffsets);
      const bytes = buffer.subarray(byteRange.start, byteRange.end);
      const fullText = bytes.toString("utf8");
      matches.push({
        id: stableMatchId(relativePath, kind, node.type, classified.name, bytes),
        path: slash(relativePath),
        language,
        kind,
        name: classified.name,
        node_type: node.type,
        start_byte: byteRange.start,
        end_byte: byteRange.end,
        range: { start: position(node.startPosition), end: position(node.endPosition) },
        text: fullText.length > 2000 ? fullText.slice(0, 2000) + "\n…(truncated)" : fullText,
      });
    }
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return matches;
}

function syntaxErrorCount(tree) {
  let errors = 0;
  const stack = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (node.isError || node.isMissing) errors++;
    const children = node.children;
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return errors;
}

function collectFiles(workspace, realRoot, requestedPath, limits, deadline) {
  const target = resolveWorkspacePath(workspace, requestedPath || ".");
  if (!fs.existsSync(target)) throw new Error("Path does not exist: " + (requestedPath || "."));
  assertRealpathInside(realRoot, target, "Search path");
  const files = [];
  const queue = [target];
  const maxEntries = Math.max(1000, limits.maxFiles * 50);
  let visited = 0;
  let truncated = false;
  while (queue.length && files.length < limits.maxFiles && visited < maxEntries && Date.now() <= deadline) {
    const current = queue.shift();
    visited++;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { continue; }
    if (stat.isSymbolicLink()) continue;
    try { assertRealpathInside(realRoot, current, "Search path"); } catch (error) { continue; }
    if (stat.isFile()) {
      if (languageForPath(current)) files.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) { continue; }
    for (const entry of entries) {
      if (queue.length + visited >= maxEntries) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      queue.push(path.join(current, entry.name));
    }
  }
  if (queue.length || visited >= maxEntries || Date.now() > deadline) truncated = true;
  return { files, truncated };
}

async function parseFile(filePath, buffer) {
  const language = languageForPath(filePath);
  if (!language) throw new Error("Unsupported file extension: " + path.extname(filePath));
  const parser = await createParser(language);
  const source = buffer.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(buffer)) {
    parser.delete();
    throw new Error("Structural tools require valid UTF-8 source files");
  }
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    throw new Error("Tree-sitter did not produce a syntax tree");
  }
  return { language, parser, tree, byteOffsets: byteOffsetMap(source) };
}

function normalizeNewlines(text, buffer) {
  const value = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const probe = buffer.toString("utf8");
  const firstNewline = /\r\n|\n|\r/.exec(probe);
  const eol = firstNewline && firstNewline[0] === "\r\n" ? "\r\n" : "\n";
  return value.replace(/\r\n|\r|\n/g, eol);
}

function lineCount(text) {
  if (!text) return 0;
  return String(text).split(/\r\n|\r|\n/).length;
}

function makeDiff(relativePath, operation, oldText, insertedText) {
  const lines = ["--- " + relativePath, "+++ " + relativePath, "@@ ast_edit " + operation + " @@"];
  const cap = (value) => {
    const text = String(value);
    return text.length > 6000 ? text.slice(0, 6000) + "\n…(diff truncated)" : text;
  };
  if (operation === "replace") {
    cap(oldText).split(/\r\n|\r|\n/).forEach((line) => lines.push("-" + line));
  }
  cap(insertedText).split(/\r\n|\r|\n/).forEach((line) => lines.push("+" + line));
  return lines.join("\n");
}

function atomicWrite(realRoot, filePath, buffer, mode) {
  const directory = path.dirname(filePath);
  assertRealpathInside(realRoot, directory, "Structural edit directory");
  assertRealpathInside(realRoot, filePath, "Structural edit target");
  const temporary = path.join(directory, "." + path.basename(filePath) + ".ast-" +
    process.pid + "-" + crypto.randomBytes(6).toString("hex") + ".tmp");
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", mode);
    assertRealpathInside(realRoot, temporary, "Structural edit temporary file");
    fs.writeFileSync(handle, buffer);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    assertRealpathInside(realRoot, directory, "Structural edit directory");
    assertRealpathInside(realRoot, filePath, "Structural edit target");
    assertRealpathInside(realRoot, temporary, "Structural edit temporary file");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (handle != null) {
      try { fs.closeSync(handle); } catch (closeError) {}
    }
    try { fs.unlinkSync(temporary); } catch (unlinkError) {}
    throw error;
  }
}

function toolResult(value, text) {
  return {
    content: [{ type: "text", text: text || JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

class StructuralTools {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.realWorkspace = realpath(this.workspace);
  }

  async search(args) {
    args = args || {};
    const kind = String(args.kind || "").toLowerCase();
    if (!["declaration", "call", "import"].includes(kind)) {
      throw new Error("kind must be declaration, call, or import");
    }
    const limits = {
      maxFiles: boundedInt(args.max_files, DEFAULT_LIMITS.maxFiles, HARD_LIMITS.maxFiles),
      maxFileBytes: boundedInt(args.max_file_bytes, DEFAULT_LIMITS.maxFileBytes, HARD_LIMITS.maxFileBytes),
      maxTotalBytes: boundedInt(args.max_total_bytes, DEFAULT_LIMITS.maxTotalBytes, HARD_LIMITS.maxTotalBytes),
      maxMatches: boundedInt(args.limit, DEFAULT_LIMITS.maxMatches, HARD_LIMITS.maxMatches),
      timeoutMs: boundedInt(args.timeout_ms, DEFAULT_LIMITS.timeoutMs, HARD_LIMITS.timeoutMs),
    };
    const started = Date.now();
    const collected = collectFiles(this.workspace, this.realWorkspace, args.path || ".", limits, started + limits.timeoutMs);
    const matches = [];
    const skipped = [];
    let scannedBytes = 0;
    let scannedFiles = 0;
    let truncated = collected.truncated;

    for (const filePath of collected.files) {
      if (Date.now() - started > limits.timeoutMs || matches.length >= limits.maxMatches) {
        truncated = true;
        break;
      }
      assertRealpathInside(this.realWorkspace, filePath, "Structural search target");
      const stat = fs.statSync(filePath);
      const relativePath = relativeWorkspacePath(this.workspace, filePath);
      if (stat.size > limits.maxFileBytes) {
        skipped.push({ path: relativePath, reason: "file_too_large", bytes: stat.size });
        continue;
      }
      if (scannedBytes + stat.size > limits.maxTotalBytes) {
        truncated = true;
        break;
      }
      assertRealpathInside(this.realWorkspace, filePath, "Structural search target");
      const buffer = fs.readFileSync(filePath);
      const fileHash = sha256(buffer);
      const parsed = await parseFile(filePath, buffer);
      try {
        const remaining = limits.maxMatches - matches.length;
        const found = findMatches(relativePath, parsed.language, kind, args.name,
          args.case_sensitive !== false, buffer, parsed.tree, parsed.byteOffsets, remaining);
        found.forEach((match) => {
          match.file_hash = fileHash;
          matches.push(match);
        });
      } finally {
        parsed.tree.delete();
        parsed.parser.delete();
      }
      scannedFiles++;
      scannedBytes += buffer.length;
    }

    const value = {
      matches,
      count: matches.length,
      scanned_files: scannedFiles,
      scanned_bytes: scannedBytes,
      truncated,
      skipped,
    };
    return toolResult(value, matches.length ? JSON.stringify(value, null, 2) : "No structural matches.");
  }

  async edit(args) {
    args = args || {};
    const relativePath = slash(args.path);
    const matchId = String(args.match_id || "");
    const expectedHash = String(args.file_hash || "").toLowerCase();
    const operation = String(args.operation || "").toLowerCase();
    if (!relativePath || !matchId || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error("path, match_id, and a SHA-256 file_hash are required");
    }
    if (!["replace", "insert-before", "insert-after"].includes(operation)) {
      throw new Error("operation must be replace, insert-before, or insert-after");
    }
    if (typeof args.text !== "string") throw new Error("text must be a string");

    const filePath = resolveWorkspacePath(this.workspace, relativePath);
    assertRealpathInside(this.realWorkspace, filePath, "Structural edit target");
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Structural edit target must be a regular file");
    if (stat.size > HARD_LIMITS.maxFileBytes) throw new Error("Structural edit target is too large");
    assertRealpathInside(this.realWorkspace, filePath, "Structural edit target");
    const before = fs.readFileSync(filePath);
    const beforeHash = sha256(before);
    if (beforeHash !== expectedHash) {
      throw new Error("Stale structural match: file hash changed; run ast_search again");
    }

    const parsed = await parseFile(filePath, before);
    let candidates = [];
    let oldErrorCount;
    try {
      oldErrorCount = syntaxErrorCount(parsed.tree);
      for (const kind of ["declaration", "call", "import"]) {
        candidates = candidates.concat(findMatches(relativePath, parsed.language, kind, "", true,
          before, parsed.tree, parsed.byteOffsets, HARD_LIMITS.maxMatches));
      }
    } finally {
      parsed.tree.delete();
      parsed.parser.delete();
    }
    candidates = candidates.filter((match) => match.id === matchId);
    if (args.start_byte != null) {
      const expectedStart = Number(args.start_byte);
      candidates = candidates.filter((match) => match.start_byte === expectedStart);
    }
    if (!candidates.length) throw new Error("Structural match not found; run ast_search again");
    if (candidates.length !== 1) {
      throw new Error("Ambiguous structural match: " + candidates.length +
        " nodes share this match ID; pass the returned start_byte");
    }

    const target = candidates[0];
    const normalizedText = normalizeNewlines(args.text, before);
    const inserted = Buffer.from(normalizedText, "utf8");
    let start = target.start_byte;
    let end = target.end_byte;
    if (operation === "insert-before") end = start;
    else if (operation === "insert-after") start = end;
    const after = Buffer.concat([before.subarray(0, start), inserted, before.subarray(end)]);

    const checked = await parseFile(filePath, after);
    let newErrorCount;
    try { newErrorCount = syntaxErrorCount(checked.tree); }
    finally {
      checked.tree.delete();
      checked.parser.delete();
    }
    if (newErrorCount > oldErrorCount) {
      throw new Error("Structural edit rejected: syntax errors would increase from " +
        oldErrorCount + " to " + newErrorCount);
    }

    assertRealpathInside(this.realWorkspace, filePath, "Structural edit target");
    const current = fs.readFileSync(filePath);
    if (sha256(current) !== beforeHash) {
      throw new Error("Stale structural match: file changed during edit; run ast_search again");
    }
    atomicWrite(this.realWorkspace, filePath, after, stat.mode);

    const oldText = before.subarray(target.start_byte, target.end_byte).toString("utf8");
    const diff = makeDiff(relativePath, operation, oldText, normalizedText);
    const value = {
      path: relativePath,
      match_id: matchId,
      operation,
      before_hash: beforeHash,
      after_hash: sha256(after),
      start_byte: start,
      old_end_byte: end,
      new_end_byte: start + inserted.length,
      linesAdded: lineCount(normalizedText),
      linesRemoved: operation === "replace" ? lineCount(oldText) : 0,
      diff,
      diffString: diff,
    };
    return toolResult(value, diff);
  }

  tools() {
    return {
      ast_search: {
        description: "Search Tree-sitter syntax trees for declarations, calls, or imports in JavaScript/JSX, TypeScript/TSX, Python, Go, and Rust. Returns deterministic match IDs, byte ranges, and SHA-256 file hashes for ast_edit.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["declaration", "call", "import"] },
            name: { type: "string", description: "Optional exact name or terminal identifier" },
            path: { type: "string", description: "Workspace-relative file or directory; default workspace root" },
            case_sensitive: { type: "boolean", description: "Default true" },
            limit: { type: "integer", minimum: 1, maximum: HARD_LIMITS.maxMatches },
            max_files: { type: "integer", minimum: 1, maximum: HARD_LIMITS.maxFiles },
            max_file_bytes: { type: "integer", minimum: 1, maximum: HARD_LIMITS.maxFileBytes },
            max_total_bytes: { type: "integer", minimum: 1, maximum: HARD_LIMITS.maxTotalBytes },
            timeout_ms: { type: "integer", minimum: 1, maximum: HARD_LIMITS.timeoutMs },
          },
          required: ["kind"],
        },
        annotations: { title: "Search syntax trees", readOnlyHint: true },
        execute: (args) => this.search(args),
      },
      ast_edit: {
        description: "Safely edit one ast_search match. Requires its path, stable match ID, and exact file hash; rejects stale, ambiguous, non-unique, or syntax-regressing changes. Operations: replace, insert-before, insert-after.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path returned by ast_search" },
            match_id: { type: "string", description: "Stable match ID returned by ast_search" },
            file_hash: { type: "string", description: "SHA-256 file hash returned by ast_search" },
            start_byte: { type: "integer", minimum: 0, description: "Returned byte start; required only to disambiguate identical nodes" },
            operation: { type: "string", enum: ["replace", "insert-before", "insert-after"] },
            text: { type: "string", description: "UTF-8 text to insert or use as replacement" },
          },
          required: ["path", "match_id", "file_hash", "operation", "text"],
        },
        annotations: { title: "Edit syntax tree match", readOnlyHint: false, idempotentHint: false },
        execute: (args) => this.edit(args),
      },
    };
  }
}

function createStructuralTools(options) {
  const structural = new StructuralTools(options);
  return structural.tools();
}

createStructuralTools.StructuralTools = StructuralTools;
createStructuralTools._private = {
  languageForPath,
  normalizeNewlines,
  sha256,
  stableMatchId,
  syntaxErrorCount,
  assertRealpathInside,
};

module.exports = createStructuralTools;
