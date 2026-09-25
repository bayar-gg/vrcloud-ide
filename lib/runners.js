"use strict";

/**
 * Deteksi runner "Jalankan" per ekstensi file berdasarkan interpreter/compiler
 * yang benar-benar terpasang di server (which/where).
 *
 * Hasil: { platform, outDir, runners: { ext: { bin, label, template } }, missing: { ext: { label, need } } }
 * template memakai placeholder: {bin} {file} {out} {stem} {dir}.
 * Klien menyisipkan path yang sudah di-quote sesuai shell server.
 *
 * Rantai perintah: bash memakai `&&`; PowerShell 5.1 tidak mendukung `&&`,
 * jadi dipakai `; if ($?) { ... }`.
 */

const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const OUT_DIR = path.join(os.tmpdir(), "vrcloud-run");

// Definisi: ext -> kandidat biner (urutan prioritas) + pola perintah.
// run: perintah langsung. build: kompilasi ke {out} lalu jalankan {out}.
const DEFS = [
  { ext: ["py", "pyw"], label: "Python", bins: IS_WIN ? ["python", "python3", "py"] : ["python3", "python"], run: "{bin} {file}" },
  { ext: ["js", "mjs", "cjs"], label: "Node.js", bins: ["node"], run: "{bin} {file}" },
  { ext: ["ts", "mts", "cts"], label: "TypeScript", bins: ["tsx", "bun", "deno", "ts-node", "node"],
    runBy: { tsx: "{bin} {file}", bun: "{bin} run {file}", deno: "{bin} run -A {file}", "ts-node": "{bin} {file}", node: "npx --yes tsx {file}" } },
  { ext: ["jsx", "tsx"], label: "TSX/JSX", bins: ["tsx", "bun", "deno"], runBy: { tsx: "{bin} {file}", bun: "{bin} run {file}", deno: "{bin} run -A {file}" } },
  { ext: ["sh", "bash"], label: "Bash", bins: ["bash", "sh"], run: "{bin} {file}" }, // Windows: Git Bash/WSL bila ada di PATH
  { ext: ["zsh"], label: "Zsh", bins: ["zsh"], run: "{bin} {file}", unix: true },
  { ext: ["fish"], label: "Fish", bins: ["fish"], run: "{bin} {file}", unix: true },
  { ext: ["ps1"], label: "PowerShell", bins: IS_WIN ? ["powershell", "pwsh"] : ["pwsh"], run: IS_WIN ? "& {file}" : "{bin} -File {file}" },
  { ext: ["bat", "cmd"], label: "Batch", bins: ["cmd"], run: "cmd /c {file}", win: true },
  { ext: ["rb"], label: "Ruby", bins: ["ruby"], run: "{bin} {file}" },
  { ext: ["php"], label: "PHP", bins: ["php"], run: "{bin} {file}" },
  { ext: ["pl", "pm"], label: "Perl", bins: ["perl"], run: "{bin} {file}" },
  { ext: ["lua"], label: "Lua", bins: ["lua", "luajit", "lua5.4", "lua5.3"], run: "{bin} {file}" },
  { ext: ["go"], label: "Go", bins: ["go"], run: "{bin} run {file}" },
  { ext: ["rs"], label: "Rust", bins: ["rust-script", "rustc", "cargo"],
    runBy: { "rust-script": "{bin} {file}", cargo: "{bin} run", rustc: "BUILD:{bin} {file} -o {out}" } },
  { ext: ["java"], label: "Java", bins: ["java"], run: "{bin} {file}" },
  { ext: ["kts"], label: "Kotlin Script", bins: ["kotlinc"], run: "{bin} -script {file}" },
  { ext: ["kt"], label: "Kotlin", bins: ["kotlinc"], run: "BUILD:{bin} {file} -include-runtime -d {out}.jar", exec: "java -jar {out}.jar" },
  { ext: ["scala", "sc"], label: "Scala", bins: ["scala-cli", "scala"], runBy: { "scala-cli": "{bin} run {file}", scala: "{bin} {file}" } },
  { ext: ["groovy"], label: "Groovy", bins: ["groovy"], run: "{bin} {file}" },
  { ext: ["clj", "cljc"], label: "Clojure", bins: ["clojure", "clj", "bb"], runBy: { clojure: "{bin} -M {file}", clj: "{bin} -M {file}", bb: "{bin} {file}" } },
  { ext: ["c"], label: "C", bins: ["gcc", "clang", "cc", "tcc"], run: "BUILD:{bin} {file} -o {out}" },
  { ext: ["cpp", "cc", "cxx", "c++"], label: "C++", bins: ["g++", "clang++", "c++"], run: "BUILD:{bin} {file} -o {out}" },
  { ext: ["cs"], label: "C#", bins: ["dotnet-script", "dotnet"], runBy: { "dotnet-script": "{bin} {file}", dotnet: "{bin} run {file}" } },
  { ext: ["fsx", "fs"], label: "F#", bins: ["dotnet"], run: "{bin} fsi {file}" },
  { ext: ["swift"], label: "Swift", bins: ["swift"], run: "{bin} {file}" },
  { ext: ["dart"], label: "Dart", bins: ["dart"], run: "{bin} run {file}" },
  { ext: ["r"], label: "R", bins: ["Rscript"], run: "{bin} {file}" },
  { ext: ["jl"], label: "Julia", bins: ["julia"], run: "{bin} {file}" },
  { ext: ["hs"], label: "Haskell", bins: ["runghc", "runhaskell", "stack"], runBy: { runghc: "{bin} {file}", runhaskell: "{bin} {file}", stack: "{bin} runghc {file}" } },
  { ext: ["ex", "exs"], label: "Elixir", bins: ["elixir"], run: "{bin} {file}" },
  { ext: ["erl"], label: "Erlang", bins: ["escript"], run: "{bin} {file}" },
  { ext: ["nim"], label: "Nim", bins: ["nim"], run: "{bin} c -r --hints:off {file}" },
  { ext: ["zig"], label: "Zig", bins: ["zig"], run: "{bin} run {file}" },
  { ext: ["v"], label: "V", bins: ["v"], run: "{bin} run {file}" },
  { ext: ["cr"], label: "Crystal", bins: ["crystal"], run: "{bin} run {file}" },
  { ext: ["d"], label: "D", bins: ["rdmd", "dmd"], runBy: { rdmd: "{bin} {file}", dmd: "BUILD:{bin} {file} -of={out}" } },
  { ext: ["ml"], label: "OCaml", bins: ["ocaml"], run: "{bin} {file}" },
  { ext: ["raku", "p6"], label: "Raku", bins: ["raku", "perl6"], run: "{bin} {file}" },
  { ext: ["tcl"], label: "Tcl", bins: ["tclsh"], run: "{bin} {file}" },
  { ext: ["awk"], label: "AWK", bins: ["awk", "gawk"], run: "{bin} -f {file}" },
  { ext: ["coffee"], label: "CoffeeScript", bins: ["coffee"], run: "{bin} {file}" },
  { ext: ["lisp", "lsp"], label: "Common Lisp", bins: ["sbcl", "clisp"], runBy: { sbcl: "{bin} --script {file}", clisp: "{bin} {file}" } },
  { ext: ["scm", "ss"], label: "Scheme", bins: ["guile", "racket", "chicken-csi"], runBy: { guile: "{bin} {file}", racket: "{bin} {file}", "chicken-csi": "{bin} -s {file}" } },
  { ext: ["rkt"], label: "Racket", bins: ["racket"], run: "{bin} {file}" },
  { ext: ["m"], label: "Octave", bins: ["octave"], run: "{bin} --no-gui {file}" },
  { ext: ["f90", "f95", "f03", "f"], label: "Fortran", bins: ["gfortran"], run: "BUILD:{bin} {file} -o {out}" },
  { ext: ["pas", "pp"], label: "Pascal", bins: ["fpc"], run: "BUILD:{bin} {file} -o{out}" },
  { ext: ["asm", "s"], label: "Assembly (NASM)", bins: ["nasm"], run: IS_WIN ? "BUILD:{bin} -f win64 {file} -o {out}.obj" : "BUILD:{bin} -f elf64 {file} -o {out}.o && ld {out}.o -o {out}" },
  { ext: ["sql"], label: "SQLite", bins: ["sqlite3"], run: "{bin} -init {file} :memory: .quit" },
  { ext: ["http", "rest"], label: "HTTP (hurl)", bins: ["hurl"], run: "{bin} {file}" },
  { ext: ["nu"], label: "Nushell", bins: ["nu"], run: "{bin} {file}" },
  { ext: ["ipynb"], label: "Jupyter", bins: ["jupyter"], run: "{bin} nbconvert --to notebook --execute --inplace {file}" },
  { ext: ["make", "mk"], label: "Make", bins: ["make"], run: "{bin} -f {file}" },
  { ext: ["gradle"], label: "Gradle", bins: ["gradle"], run: "{bin} -b {file}" },
  { ext: ["tf"], label: "Terraform", bins: ["terraform", "tofu"], run: "{bin} -chdir={dir} plan" },
  { ext: ["yml", "yaml"], label: "Ansible/Compose", bins: ["ansible-playbook", "docker"], runBy: { "ansible-playbook": "{bin} {file}", docker: "{bin} compose -f {file} up" } },
  { ext: ["wat", "wasm"], label: "WebAssembly", bins: ["wasmtime", "wasmer", "node"], runBy: { wasmtime: "{bin} {file}", wasmer: "{bin} run {file}", node: "{bin} --experimental-wasm-modules {file}" } },
];

// Nama file tanpa ekstensi yang punya runner khusus.
const BY_NAME = [
  { name: /^makefile$/i, label: "Make", bins: ["make"], run: "{bin} -f {file}" },
  { name: /^dockerfile$/i, label: "Docker", bins: ["docker"], run: "{bin} build -f {file} {dir}" },
  { name: /^(justfile)$/i, label: "Just", bins: ["just"], run: "{bin} -f {file}" },
  { name: /^(rakefile)$/i, label: "Rake", bins: ["rake"], run: "{bin} -f {file}" },
];

// Ekstensi yang "dijalankan" dengan membuka pratinjau di browser (ditangani klien).
const PREVIEW_EXT = ["html", "htm", "svg", "pdf", "md", "markdown", "png", "jpg", "jpeg", "gif", "webp"];

let whichCache = new Map();
function which(bin) {
  if (whichCache.has(bin)) return whichCache.get(bin);
  let found = "";
  try {
    const r = spawnSync(IS_WIN ? "where" : "which", [bin], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    if (r.status === 0) {
      const lines = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Windows: lewati alias App Execution (python.exe stub Microsoft Store yang hanya membuka Store).
      found = lines.find((l) => !/WindowsApps/i.test(l)) || (IS_WIN ? "" : lines[0] || "");
    }
  } catch (e) { found = ""; }
  whichCache.set(bin, found);
  return found;
}

function templateFor(def, bin) {
  let t = def.runBy ? def.runBy[bin] : def.run;
  if (!t) return null;
  if (t.indexOf("BUILD:") === 0) {
    // Kompilasi lalu jalankan biner hasil. `{out}` diisi klien (tanpa ekstensi).
    const build = t.slice(6);
    const exec = def.exec || (IS_WIN ? "& {out}" : "{out}");
    t = IS_WIN ? build + "; if ($?) { " + exec + " }" : build + " && " + exec;
  } else if (!IS_WIN && t.indexOf(" && ") !== -1) {
    // sudah bash-style
  } else if (IS_WIN && t.indexOf(" && ") !== -1) {
    t = t.split(" && ").join("; if ($?) { ") + " }".repeat(t.split(" && ").length - 1);
  }
  return t;
}

function classify(def) {
  if (def.unix && IS_WIN) return null;
  if (def.win && !IS_WIN) return null;
  let bin = null, binPath = "";
  for (const b of def.bins) { const p = which(b); if (p) { bin = b; binPath = p; break; } }
  if (!bin) return { missing: { label: def.label, need: def.bins.slice() } };
  const template = templateFor(def, bin);
  if (!template) return { missing: { label: def.label, need: def.bins.slice() } };
  return { run: { bin, path: binPath, label: def.label, template } };
}

function forgetBins(bins) {
  (bins || []).forEach((b) => whichCache.delete(b));
}

function storeExt(def, hit) {
  def.ext.forEach((e) => {
    const k = e.toLowerCase();
    delete detected.runners[k];
    delete detected.missing[k];
    if (!hit) return;
    if (hit.run) detected.runners[k] = hit.run;
    else detected.missing[k] = hit.missing;
  });
}

function nameEntry(def, hit) {
  const base = { pattern: def.name.source, flags: def.name.flags, label: def.label, need: def.bins.slice() };
  if (!hit || !hit.run) return Object.assign(base, { bin: null, path: "", template: null });
  return Object.assign(base, { bin: hit.run.bin, path: hit.run.path, template: hit.run.template });
}

let detected = null;
function detect(refresh) {
  if (detected && !refresh) return detected;
  if (refresh) whichCache = new Map();
  detected = {
    platform: process.platform,
    shell: IS_WIN ? "powershell" : "bash",
    outDir: OUT_DIR,
    exeSuffix: IS_WIN ? ".exe" : "",
    previewExt: PREVIEW_EXT,
    runners: {},
    missing: {},
    byName: [],
    detectedAt: Date.now(),
  };
  DEFS.forEach((def) => storeExt(def, classify(def)));
  detected.byName = BY_NAME.map((def) => nameEntry(def, classify(def)));
  detected.detectedAt = Date.now();
  return detected;
}

// Cek ulang satu ekstensi / nama file (bukan seluruh PATH) supaya tombol Jalankan
// mengikuti file aktif tanpa menunggu deteksi penuh.
function probe(key, refresh) {
  if (!detected) return detect(false);
  const raw = String(key || "").replace(/^\./, "").slice(0, 80);
  const k = raw.toLowerCase();
  const def = DEFS.find((d) => d.ext.some((e) => e.toLowerCase() === k));
  if (def) {
    forgetBins(def.bins);
    storeExt(def, classify(def));
    detected.detectedAt = Date.now();
    return detected;
  }
  const idx = BY_NAME.findIndex((d) => d.name.test(raw));
  if (idx >= 0) {
    forgetBins(BY_NAME[idx].bins);
    detected.byName[idx] = nameEntry(BY_NAME[idx], classify(BY_NAME[idx]));
    detected.detectedAt = Date.now();
  }
  return detected;
}

module.exports = { detect, probe, PREVIEW_EXT };
