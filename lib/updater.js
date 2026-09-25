"use strict";

/**
 * Self-update VRCloud IDE dari dalam IDE (tanpa SSH).
 *
 * - status(): commit lokal vs remote (git ls-remote, cache 5 menit), apakah update tersedia,
 *   apakah proses update sedang berjalan, dan tail log update.
 * - start(): meluncurkan proses updater TERPISAH (detached) supaya tetap hidup saat server
 *   ini di-restart. Urutan: git fetch+reset ke branch → npm ci --production → restart:
 *     Linux : `vrcloud update` bila CLI terpasang (systemd), selain itu git/npm lalu
 *             systemctl restart / kill proses ini (supervisor menghidupkan kembali).
 *     Windows: git/npm lalu restart Scheduled Task 'VRCloudIDE' bila ada, selain itu
 *             matikan proses ini dan jalankan `node server.js` lagi di folder yang sama.
 *
 * Log: data/update.log. Kunci: data/update.lock (pid + waktu; dianggap basi setelah 20 menit).
 */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const IS_WIN = process.platform === "win32";

class Updater {
  constructor(opts) {
    opts = opts || {};
    this.appDir = path.resolve(opts.appDir || process.cwd());
    this.dataDir = opts.dataDir || path.join(this.appDir, "data");
    this.repo = opts.repo || process.env.VRCLOUD_REPOSITORY || "https://github.com/bayar-gg/vrcloud-ide.git";
    this.branch = opts.branch || process.env.VRCLOUD_BRANCH || "main";
    this.logFile = path.join(this.dataDir, "update.log");
    this.lockFile = path.join(this.dataDir, "update.lock");
    this.remoteCache = { at: 0, commit: "", error: "" };
    this.version = "";
    try { this.version = require(path.join(this.appDir, "package.json")).version || ""; } catch (e) {}
  }

  git(args, timeout) {
    try {
      return execFileSync("git", ["-c", "safe.directory=*"].concat(args), { cwd: this.appDir, encoding: "utf8", timeout: timeout || 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) { return null; }
  }

  isGit() { return fs.existsSync(path.join(this.appDir, ".git")); }

  local() {
    if (!this.isGit()) return { commit: "", short: "", date: "", branch: "" };
    const commit = this.git(["rev-parse", "HEAD"]) || "";
    const date = this.git(["log", "-1", "--format=%cI"]) || "";
    const subject = this.git(["log", "-1", "--format=%s"]) || "";
    const branch = this.git(["rev-parse", "--abbrev-ref", "HEAD"]) || "";
    return { commit, short: commit.slice(0, 7), date, subject, branch };
  }

  async remote(force) {
    const now = Date.now();
    if (!force && this.remoteCache.commit && now - this.remoteCache.at < 5 * 60 * 1000) return this.remoteCache;
    const out = await new Promise((resolve) => {
      const p = spawn("git", ["-c", "safe.directory=*", "ls-remote", this.repo, "refs/heads/" + this.branch], { cwd: this.appDir, windowsHide: true, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" }) });
      let so = "", se = "";
      const t = setTimeout(() => { try { p.kill(); } catch (e) {} }, 20000);
      p.stdout.on("data", (d) => so += d); p.stderr.on("data", (d) => se += d);
      p.on("error", (e) => { clearTimeout(t); resolve({ error: e.message }); });
      p.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? { out: so } : { error: (se || "git ls-remote gagal (exit " + code + ")").trim() }); });
    });
    if (out.error) { this.remoteCache = { at: now, commit: this.remoteCache.commit || "", error: String(out.error).slice(0, 300) }; return this.remoteCache; }
    const m = String(out.out || "").match(/^([0-9a-f]{40})\s/m);
    this.remoteCache = { at: now, commit: m ? m[1] : "", error: m ? "" : "Branch tidak ditemukan di remote" };
    return this.remoteCache;
  }

  // Cara restart yang tersedia di host ini.
  method() {
    if (IS_WIN) {
      const r = spawnSync("schtasks", ["/Query", "/TN", "VRCloudIDE"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      return r.status === 0 ? "task" : "respawn";
    }
    if (fs.existsSync("/usr/local/bin/vrcloud")) return "vrcloud";
    const r = spawnSync("systemctl", ["is-enabled", "vrcloud-ide"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0) return "systemd";
    return "exit";
  }

  running() {
    try {
      if (!fs.existsSync(this.lockFile)) return null;
      const j = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      if (!j || !j.at || Date.now() - j.at > 20 * 60 * 1000) { try { fs.unlinkSync(this.lockFile); } catch (e) {} return null; }
      return j;
    } catch (e) { return null; }
  }

  logTail(n) {
    try {
      const s = fs.readFileSync(this.logFile, "utf8").replace(/^\uFEFF/, "");
      const lines = s.split(/\r?\n/).filter(Boolean);
      return lines.slice(-(n || 30));
    } catch (e) { return []; }
  }

  // Log untuk panel live di IDE: hanya bagian sejak sesi update terakhir ("=====").
  logView() {
    const all = this.logTail(600);
    let start = 0;
    for (let i = all.length - 1; i >= 0; i--) { if (all[i].indexOf("=====") === 0) { start = i; break; } }
    const lines = all.slice(start);
    const last = lines.length ? lines[lines.length - 1] : "";
    const done = /update selesai/i.test(last);
    const failed = lines.some((l) => /^\[[^\]]*\] GAGAL|GAGAL meluncurkan/i.test(l));
    return { lines, running: !!this.running(), done, failed };
  }

  async status(opts) {
    opts = opts || {};
    const local = this.local();
    const remote = await this.remote(!!opts.force);
    const running = this.running();
    const method = this.method();
    const canRoot = IS_WIN ? true : (typeof process.getuid === "function" ? process.getuid() === 0 : true);
    let reason = "";
    if (!this.isGit()) reason = "";
    else if (method === "vrcloud" && !canRoot) reason = "Service tidak berjalan sebagai root; update butuh hak root (pasang ulang dengan VRCLOUD_ROOT_ACCESS=true atau jalankan `sudo vrcloud update`).";
    return {
      platform: process.platform,
      appDir: this.appDir,
      repo: this.repo,
      branch: this.branch,
      version: this.version,
      isGit: this.isGit(),
      local,
      remote: { commit: remote.commit || "", short: (remote.commit || "").slice(0, 7), error: remote.error || "", checkedAt: this.remoteCache.at || 0 },
      updateAvailable: !!(remote.commit && (!local.commit || local.commit !== remote.commit)),
      method,
      canUpdate: !reason,
      reason,
      running: running ? { pid: running.pid, at: running.at, startedBy: running.by || "" } : null,
      log: this.logTail(40),
      pid: process.pid,
    };
  }

  // Skrip updater yang dijalankan terpisah dari proses server.
  script(method) {
    const app = this.appDir, repo = this.repo, br = this.branch, pid = process.pid;
    const lock = this.lockFile;
    if (IS_WIN) {
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      // Urutan: ambil kode dulu (server TETAP berjalan) → npm ci hanya bila package-lock berubah
      // (server harus berhenti dulu karena conpty.node terkunci) → restart server di akhir.
      // Perintah native lewat cmd /c agar stderr tidak jadi error record PowerShell.
      const stopLines = method === "task"
        ? ["Stop-ScheduledTask -TaskName 'VRCloudIDE' -ErrorAction SilentlyContinue"]
        : ["Stop-Process -Id " + pid + " -Force -ErrorAction SilentlyContinue"];
      const startLines = method === "task"
        ? ["Start-ScheduledTask -TaskName 'VRCloudIDE'"]
        : ["$node = (Get-Command node).Source", "Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory " + q(app) + " -WindowStyle Hidden"];
      const lines = [
        "$ErrorActionPreference = 'Continue'",
        "Set-Location -LiteralPath " + q(app),
        "function Stop-Vrc { Write-Output 'menghentikan server ...'; " + stopLines.join("; ") + "; Start-Sleep -Seconds 2 }",
        "function Start-Vrc { Write-Output 'menjalankan server ...'; " + startLines.join("; ") + " }",
        "function Lock-Hash { if (Test-Path 'package-lock.json') { (Get-FileHash 'package-lock.json' -Algorithm SHA1).Hash } else { '' } }",
        "function Finish([int]$code, [string]$msg) { Write-Output ('[' + (Get-Date -Format s) + '] ' + $msg); Remove-Item -LiteralPath " + q(lock) + " -ErrorAction SilentlyContinue; exit $code }",
        "Write-Output ('[' + (Get-Date -Format s) + '] update dimulai (' + " + q(method) + " + ') - server tetap berjalan selama pengambilan kode')",
        "$lockBefore = Lock-Hash",
        "if (-not (Test-Path '.git')) {",
        "  Write-Output 'folder belum punya Git (hasil ZIP): menyiapkan checkout ...'",
        "  cmd /c \"git -c safe.directory=* init -b " + br + " 2>&1\" | Write-Output",
        "  if ($LASTEXITCODE -ne 0) { Finish 1 'GAGAL: git init' }",
        "  cmd /c \"git -c safe.directory=* remote add origin " + repo + " 2>&1\" | Write-Output",
        "  if ($LASTEXITCODE -ne 0) { Finish 1 'GAGAL: git remote add' }",
        "  $fresh = $true",
        "} else { $fresh = $false }",
        "Write-Output ('mengambil kode terbaru dari " + repo + " (" + br + ") ...')",
        "cmd /c \"git -c safe.directory=* fetch --depth 1 origin " + br + " 2>&1\" | Write-Output",
        "if ($LASTEXITCODE -ne 0) { Finish 1 'GAGAL: git fetch - server tidak diubah' }",
        "if ($fresh) { cmd /c \"git -c safe.directory=* checkout -f -B " + br + " FETCH_HEAD 2>&1\" | Write-Output }",
        "else { cmd /c \"git -c safe.directory=* reset --hard FETCH_HEAD 2>&1\" | Write-Output }",
        "if ($LASTEXITCODE -ne 0) { Finish 1 'GAGAL: git checkout' }",
        "Write-Output ('kode sekarang di ' + (cmd /c 'git -c safe.directory=* rev-parse --short HEAD 2>&1'))",
        "$lockAfter = Lock-Hash",
        "if ($lockAfter -ne $lockBefore) {",
        "  Write-Output 'dependensi berubah (package-lock.json): server dihentikan untuk npm ci ...'",
        "  Stop-Vrc",
        "  cmd /c \"npm ci --omit=dev --no-audit --no-fund 2>&1\" | Write-Output",
        "  if ($LASTEXITCODE -ne 0) { Write-Output 'PERINGATAN: npm ci gagal; server dijalankan dengan dependensi lama' }",
        "  Start-Vrc",
        "} else {",
        "  Write-Output 'dependensi tidak berubah: npm ci dilewati'",
        "  Write-Output 'restart server untuk memuat kode baru ...'",
        "  Stop-Vrc",
        "  Start-Vrc",
        "}",
        "Finish 0 'update selesai'",
      ];
      return lines.join("\r\n");
    }
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const lines = [
      "#!/usr/bin/env bash",
      "set -u",
      "trap 'rm -f " + q(lock) + "' EXIT",
      "echo \"[$(date -Is)] update dimulai (" + method + ") - server tetap berjalan selama pengambilan kode\"",
      "sleep 1",
    ];
    if (method === "vrcloud") {
      // vrcloud update: fetch+reset → npm ci → restart hanya bila service aktif (server tidak dihentikan lebih dulu).
      lines.push("/usr/local/bin/vrcloud update; rc=$?", "echo \"[$(date -Is)] update selesai (exit $rc)\"", "exit $rc");
      return lines.join("\n");
    }
    lines.push(
      "cd " + q(app) + " || { echo 'GAGAL: folder aplikasi'; exit 1; }",
      "lock_hash() { [ -f package-lock.json ] && sha1sum package-lock.json | cut -d' ' -f1 || echo ''; }",
      "before=$(lock_hash)",
      "echo 'mengambil kode terbaru dari " + repo + " (" + br + ") ...'",
      "git -c safe.directory=* fetch --depth 1 " + q(repo) + " " + q(br) + " || { echo \"[$(date -Is)] GAGAL: git fetch - server tidak diubah\"; exit 1; }",
      "git -c safe.directory=* reset --hard FETCH_HEAD || { echo \"[$(date -Is)] GAGAL: git reset\"; exit 1; }",
      "echo \"kode sekarang di $(git -c safe.directory=* rev-parse --short HEAD)\"",
      "for f in scripts/vrcloud scripts/*.sh start.sh; do [ -f \"$f\" ] && { sed -i 's/\\r$//' \"$f\"; chmod 755 \"$f\"; }; done",
      "after=$(lock_hash)",
      "if [ \"$before\" != \"$after\" ]; then echo 'dependensi berubah: npm ci --omit=dev ...'; npm ci --omit=dev --no-audit --no-fund || echo 'PERINGATAN: npm ci gagal; melanjutkan restart'; else echo 'dependensi tidak berubah: npm ci dilewati'; fi",
      "echo 'restart server untuk memuat kode baru ...'",
    );
    if (method === "systemd") lines.push("systemctl restart vrcloud-ide");
    else lines.push("kill " + pid + " 2>/dev/null || true", "sleep 2", "( cd " + q(app) + " && nohup node server.js >> data/vrcloud-ide.log 2>&1 & )");
    lines.push("echo \"[$(date -Is)] update selesai\"");
    return lines.join("\n");
  }

  async start(by) {
    if (this.running()) throw new Error("Update sedang berjalan.");
    const st = await this.status();
    if (!st.canUpdate) throw new Error(st.reason || "Update tidak tersedia.");
    fs.mkdirSync(this.dataDir, { recursive: true });
    const method = st.method;
    const scriptPath = path.join(this.dataDir, IS_WIN ? "update-run.ps1" : "update-run.sh");
    fs.writeFileSync(scriptPath, this.script(method), { encoding: "utf8", mode: 0o755 });
    fs.appendFileSync(this.logFile, "\n===== " + new Date().toISOString() + " update diminta oleh " + (by || "web") + " (" + method + ") =====\n");
    // Proses detached tidak mewarisi handle log dengan andal (terutama Windows): skrip
    // sendiri yang mengalihkan seluruh outputnya ke update.log; stdio kita 'ignore'.
    const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", CI: "1" });
    let pid = 0;
    if (IS_WIN) {
      // PowerShell yang di-spawn `detached` di Windows keluar tanpa menjalankan perintah; jadi
      // pakai launcher biasa (tersembunyi) yang memanggil Start-Process → proses independen
      // yang tetap hidup saat server ini dimatikan. Log ditulis UTF-8 oleh proses itu sendiri.
      const ps = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const inner = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& " + ps(scriptPath) + " *>&1 | Out-File -FilePath " + ps(this.logFile) + " -Append -Encoding utf8\"";
      const launcher = "$p = Start-Process -FilePath powershell.exe -ArgumentList " + ps(inner) + " -WindowStyle Hidden -WorkingDirectory " + ps(this.appDir) + " -PassThru; Write-Output $p.Id";
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher],
        { cwd: this.appDir, encoding: "utf8", windowsHide: true, env, timeout: 20000 });
      if (r.status !== 0) throw new Error("Gagal meluncurkan updater: " + String(r.stderr || r.stdout || "").trim().slice(0, 300));
      pid = parseInt(String(r.stdout || "").trim(), 10) || 0;
    } else {
      const sh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
      const child = spawn("bash", ["-c", "exec bash " + sh(scriptPath) + " >> " + sh(this.logFile) + " 2>&1"],
        { cwd: this.appDir, detached: true, stdio: "ignore", env });
      child.on("error", (e) => { try { fs.appendFileSync(this.logFile, "GAGAL meluncurkan updater: " + e.message + "\n"); } catch (e2) {} });
      child.unref();
      pid = child.pid || 0;
    }
    fs.writeFileSync(this.lockFile, JSON.stringify({ pid, at: Date.now(), by: by || "web", method }));
    // Kunci dibersihkan oleh server baru saat start (lihat clearStaleLock) atau kadaluarsa 20 menit.
    return { started: true, pid, method, from: st.local.short, to: st.remote.short };
  }

  // Dipanggil saat server start: update sebelumnya selesai (server ini adalah hasilnya).
  clearStaleLock() {
    try {
      if (!fs.existsSync(this.lockFile)) return;
      const j = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      // Bila proses updater sudah tidak ada, hapus kunci.
      let alive = false;
      try { process.kill(j.pid, 0); alive = true; } catch (e) { alive = false; }
      if (!alive || Date.now() - (j.at || 0) > 20 * 60 * 1000) fs.unlinkSync(this.lockFile);
    } catch (e) { try { fs.unlinkSync(this.lockFile); } catch (e2) {} }
  }
}

module.exports = Updater;
