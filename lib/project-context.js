"use strict";

/**
 * Snapshot ringkas workspace untuk prompt agent: stack yang terdeteksi, skrip
 * build/test, status git, struktur folder tingkat atas, dan file yang baru
 * berubah. Dihitung cepat, di-cache beberapa detik, dan dibatasi ukurannya.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SKIP = { node_modules: 1, ".git": 1, dist: 1, build: 1, ".next": 1, ".cache": 1, __pycache__: 1, ".venv": 1, venv: 1, target: 1, vendor: 1, ".idea": 1, ".vscode": 1, coverage: 1, ".turbo": 1 };
const CACHE_MS = 8000;
const cache = new Map(); // workspace -> { at, text }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function toPosix(p) { return String(p || "").replace(/\\/g, "/"); }

function git(ws, args) {
  try {
    const r = spawnSync("git", ["-c", "safe.directory=*"].concat(args), { cwd: ws, encoding: "utf8", timeout: 3000, windowsHide: true });
    if (r.status !== 0) return "";
    return String(r.stdout || "").trim();
  } catch (e) { return ""; }
}

function detectStack(ws) {
  const out = { stack: [], scripts: [], verify: [], run: [] };
  const pkg = readJson(path.join(ws, "package.json"));
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    let label = "Node.js";
    if (deps.next) label += " + Next.js";
    else if (deps.react) label += " + React";
    else if (deps.vue) label += " + Vue";
    else if (deps.svelte) label += " + Svelte";
    else if (deps.express) label += " + Express";
    else if (deps.fastify) label += " + Fastify";
    if (deps.typescript || exists(path.join(ws, "tsconfig.json"))) label += " (TypeScript)";
    out.stack.push(label + (pkg.name ? " — " + pkg.name : ""));
    const pm = exists(path.join(ws, "pnpm-lock.yaml")) ? "pnpm" : exists(path.join(ws, "yarn.lock")) ? "yarn" : exists(path.join(ws, "bun.lockb")) || exists(path.join(ws, "bun.lock")) ? "bun" : "npm";
    const sc = pkg.scripts || {};
    Object.keys(sc).slice(0, 14).forEach((k) => out.scripts.push(pm + " run " + k + "  →  " + String(sc[k]).slice(0, 90)));
    ["test", "lint", "typecheck", "check", "build"].forEach((k) => { if (sc[k]) out.verify.push(pm + " run " + k); });
    if (sc.dev) out.run.push(pm + " run dev"); else if (sc.start) out.run.push(pm + " run start");
  }
  if (exists(path.join(ws, "pyproject.toml")) || exists(path.join(ws, "requirements.txt")) || exists(path.join(ws, "setup.py"))) {
    let label = "Python";
    const py = (() => { try { return fs.readFileSync(path.join(ws, "pyproject.toml"), "utf8"); } catch (e) { return ""; } })();
    if (/django/i.test(py) || exists(path.join(ws, "manage.py"))) label += " + Django";
    else if (/fastapi/i.test(py)) label += " + FastAPI";
    else if (/flask/i.test(py)) label += " + Flask";
    out.stack.push(label);
    if (/pytest/i.test(py) || exists(path.join(ws, "pytest.ini")) || exists(path.join(ws, "tests"))) out.verify.push("python -m pytest -q");
    if (/\[tool\.ruff\]/.test(py)) out.verify.push("ruff check .");
  }
  if (exists(path.join(ws, "go.mod"))) { out.stack.push("Go"); out.verify.push("go build ./...", "go test ./..."); }
  if (exists(path.join(ws, "Cargo.toml"))) { out.stack.push("Rust"); out.verify.push("cargo check", "cargo test"); }
  if (exists(path.join(ws, "composer.json"))) { out.stack.push("PHP (Composer)"); if (exists(path.join(ws, "phpunit.xml")) || exists(path.join(ws, "phpunit.xml.dist"))) out.verify.push("vendor/bin/phpunit"); }
  if (exists(path.join(ws, "pom.xml"))) { out.stack.push("Java (Maven)"); out.verify.push("mvn -q test"); }
  if (exists(path.join(ws, "build.gradle")) || exists(path.join(ws, "build.gradle.kts"))) { out.stack.push("Java/Kotlin (Gradle)"); out.verify.push("gradle test"); }
  if (exists(path.join(ws, "Gemfile"))) { out.stack.push("Ruby"); if (exists(path.join(ws, "spec"))) out.verify.push("bundle exec rspec"); }
  if (exists(path.join(ws, "pubspec.yaml"))) { out.stack.push("Dart/Flutter"); out.verify.push("flutter analyze", "flutter test"); }
  if (exists(path.join(ws, "Dockerfile"))) out.stack.push("has Dockerfile");
  if (exists(path.join(ws, "docker-compose.yml")) || exists(path.join(ws, "compose.yaml")) || exists(path.join(ws, "docker-compose.yaml"))) out.stack.push("has docker compose");
  if (exists(path.join(ws, "Makefile"))) out.stack.push("has Makefile");
  return out;
}

function topLevel(ws) {
  let ents = [];
  try { ents = fs.readdirSync(ws, { withFileTypes: true }); } catch (e) { return []; }
  const rows = ents
    .filter((e) => !SKIP[e.name] && e.name !== ".DS_Store")
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((e) => {
      if (!e.isDirectory()) return e.name;
      let n = 0;
      try { n = fs.readdirSync(path.join(ws, e.name)).length; } catch (x) { n = 0; }
      return e.name + "/ (" + n + ")";
    });
  if (ents.length > 40) rows.push("… " + (ents.length - 40) + " more entries");
  return rows;
}

function recentFiles(ws, limit) {
  const hits = [];
  const stack = [{ dir: ws, depth: 0 }];
  let budget = 2500;
  while (stack.length && budget > 0) {
    const cur = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (budget <= 0) break;
      if (SKIP[e.name] || e.name.startsWith(".")) continue;
      const abs = path.join(cur.dir, e.name);
      if (e.isDirectory()) { if (cur.depth < 4) stack.push({ dir: abs, depth: cur.depth + 1 }); continue; }
      if (!e.isFile()) continue;
      budget--;
      let st; try { st = fs.statSync(abs); } catch (x) { continue; }
      if (st.size > 2 * 1024 * 1024) continue;
      hits.push({ rel: toPosix(path.relative(ws, abs)), m: st.mtimeMs });
    }
  }
  hits.sort((a, b) => b.m - a.m);
  const now = Date.now();
  return hits.slice(0, limit).map((h) => {
    const age = Math.max(0, now - h.m);
    const t = age < 3600e3 ? Math.round(age / 60e3) + " min" : age < 86400e3 ? Math.round(age / 3600e3) + " h" : Math.round(age / 86400e3) + " d";
    return h.rel + " (" + t + " ago)";
  });
}

function gitSummary(ws) {
  if (!exists(path.join(ws, ".git"))) return null;
  const branch = git(ws, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const status = git(ws, ["status", "--porcelain", "--untracked-files=normal"]);
  const lines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const files = lines.slice(0, 12).map((l) => l.trim().replace(/\s+/, " "));
  const last = git(ws, ["log", "-1", "--format=%h %s"]);
  return { branch, changed: lines.length, files, last };
}

function snapshot(ws, opts) {
  ws = path.resolve(ws || process.cwd());
  const c = cache.get(ws);
  if (c && Date.now() - c.at < CACHE_MS && !(opts && opts.refresh)) return c;
  const st = detectStack(ws);
  const out = { stack: st.stack, scripts: st.scripts, verify: st.verify, run: st.run, tree: topLevel(ws), recent: recentFiles(ws, 8), git: gitSummary(ws), at: Date.now() };
  out.text = render(out);
  cache.set(ws, out);
  return out;
}

function render(s) {
  const L = ["[Project snapshot — computed automatically; verify with tools when needed]"];
  if (s.stack.length) L.push("Stack: " + s.stack.join("; "));
  if (s.git) {
    L.push("Git: branch " + s.git.branch + (s.git.last ? ", last commit " + s.git.last.slice(0, 90) : "") +
      (s.git.changed ? ", " + s.git.changed + " changed/uncommitted files" : ", clean working tree"));
    if (s.git.files.length) L.push("  Changed: " + s.git.files.join(" · ") + (s.git.changed > s.git.files.length ? " · …" : ""));
  }
  if (s.scripts.length) L.push("Scripts: " + s.scripts.join(" | "));
  if (s.tree.length) L.push("Root: " + s.tree.join("  "));
  if (s.recent.length) L.push("Recently modified: " + s.recent.join(", "));
  const text = L.join("\n");
  return text.length > 3500 ? text.slice(0, 3500) + "\n…" : text;
}

module.exports = { snapshot };
