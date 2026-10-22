"use strict";

/**
 * Checkpoint workspace memakai "shadow git": repositori git terpisah
 * (GIT_DIR di data/, GIT_WORK_TREE = workspace) sehingga tidak menyentuh
 * .git milik proyek pengguna. Sebelum setiap pesan ke agent, seluruh
 * workspace di-snapshot (git add -A + commit). Pengguna bisa mengembalikan
 * satu file atau seluruh workspace ke snapshot mana pun.
 *
 * Nonaktif otomatis bila `git` tidak tersedia.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// Folder berat/hasil build yang dilewati checkpoint, indeks file "@", dan pencarian
// Node (server.js memakai daftar yang sama lewat Checkpoints.HEAVY_DIRS).
const HEAVY_DIRS = ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__", "target"];
const EXCLUDES = HEAVY_DIRS.map((d) => d + "/").concat([
  "*.pyc", "*.log", ".DS_Store", "Thumbs.db",
  "*.zip", "*.tar", "*.tar.gz", "*.tgz", "*.7z", "*.rar", "*.iso", "*.img", "*.mp4", "*.mov", "*.mkv", "*.exe", "*.dll", "*.msi",
]);

class Checkpoints {
  constructor(options) {
    this.workspace = options.workspace;
    this.gitDir = options.gitDir;
    this.available = false;
    this.error = "";
    this.queue = Promise.resolve(); // serialisasi operasi git
    this.ready = this.init().catch((e) => { this.error = (e && e.message) || String(e); this.available = false; });
  }

  git(args, opts) {
    opts = opts || {};
    const base = [
      "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false",
      "-c", "core.longpaths=true", "-c", "commit.gpgsign=false", "-c", "gc.auto=0",
      "-c", "user.name=VRCloud IDE", "-c", "user.email=agent@vrcloud.local",
    ];
    return new Promise((resolve, reject) => {
      execFile("git", base.concat(args), {
        cwd: this.workspace,
        env: Object.assign({}, process.env, { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workspace, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }),
        timeout: opts.timeout || 180000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
        resolve(String(stdout || ""));
      });
    });
  }

  // Jalankan operasi berurutan (git tidak suka dijalankan paralel di repo yang sama).
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async init() {
    await new Promise((resolve, reject) => {
      execFile("git", ["--version"], { timeout: 10000, windowsHide: true }, (err) => (err ? reject(new Error("git tidak ditemukan")) : resolve()));
    });
    if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git(["init", "--quiet"]);
    }
    try {
      fs.mkdirSync(path.join(this.gitDir, "info"), { recursive: true });
      fs.writeFileSync(path.join(this.gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n", "utf8");
    } catch (e) { /* abaikan */ }
    this.available = true;
  }

  status() {
    return { available: this.available, error: this.error || undefined };
  }

  async head() {
    try { return (await this.git(["rev-parse", "--verify", "-q", "HEAD"])).trim() || null; }
    catch (e) { return null; }
  }

  // Snapshot seluruh workspace. Mengembalikan hash commit (dipakai ulang bila tidak ada perubahan).
  snapshot(label) {
    return this.serial(() => this.snapshotUnlocked(label));
  }
  // Versi tanpa serial(): untuk dipanggil dari dalam operasi yang sudah memegang antrean.
  async snapshotUnlocked(label) {
    await this.ready;
    if (!this.available) return null;
    await this.git(["add", "-A", "--ignore-errors", "."]).catch((e) => {
      // add gagal sebagian (file terkunci dsb.): lanjutkan dengan yang berhasil
      if (!/ignore-errors|unable to index|Permission denied|LOCK/i.test(String(e.stderr || e.message))) throw e;
    });
    const head = await this.head();
    if (head) {
      let changed = true;
      try { await this.git(["diff", "--cached", "--quiet"]); changed = false; }
      catch (e) { if (e.code !== 1) throw e; }
      if (!changed) return head;
    }
    await this.git(["commit", "-q", "--allow-empty", "--no-verify", "-m", String(label || "checkpoint")]);
    return (await this.head());
  }

  parseNameStatus(out) {
    const parts = out.split("\0");
    const list = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      const code = st.charAt(0);
      if (code === "R" || code === "C") {
        list.push({ status: code, from: parts[i + 1], path: parts[i + 2] });
        i += 2;
      } else {
        list.push({ status: code, path: parts[i + 1] });
        i += 1;
      }
    }
    return list.filter((x) => x.path);
  }

  // Statistik perubahan antara dua snapshot: [{ path, status, added, removed }].
  async diffStat(from, to) {
    await this.ready;
    if (!this.available || !from || !to || from === to) return [];
    const ns = this.parseNameStatus(await this.git(["diff", "--name-status", "-z", from, to]));
    const num = await this.git(["diff", "--numstat", "-z", from, to]);
    const counts = {};
    // format -z: "added\tremoved\tpath\0" (rename: "a\tr\t\0old\0new\0")
    const parts = num.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
      if (!m) continue;
      let p = m[3];
      if (!p) { i += 2; p = parts[i]; }
      counts[p] = { added: m[1] === "-" ? 0 : parseInt(m[1], 10), removed: m[2] === "-" ? 0 : parseInt(m[2], 10), binary: m[1] === "-" };
    }
    return ns.map((x) => Object.assign({ path: x.path, status: x.status, from: x.from }, counts[x.path] || { added: 0, removed: 0 }));
  }

  // Diff unified satu file antara dua snapshot (dipotong bila sangat besar).
  async diffFile(from, to, rel, maxChars) {
    await this.ready;
    if (!this.available) throw new Error("Checkpoint tidak tersedia");
    rel = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || rel.indexOf("..") !== -1) throw new Error("Path tidak valid");
    const out = await this.git(["diff", "--no-color", "--no-ext-diff", "-U3", from, to, "--", rel]);
    const cap = maxChars || 200000;
    return out.length > cap ? out.slice(0, cap) + "\n\u2026(dipotong)\n" : out;
  }

  unlinkSafe(rel) {
    try {
      const abs = path.join(this.workspace, rel);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      // hapus folder kosong yang tertinggal
      let dir = path.dirname(abs);
      while (dir.length > this.workspace.length && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir); dir = path.dirname(dir);
      }
    } catch (e) { /* abaikan */ }
  }

  async checkoutPaths(hash, paths) {
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      await this.git(["checkout", "--quiet", hash, "--"].concat(chunk));
    }
  }

  // Kembalikan seluruh workspace ke snapshot `hash`.
  restoreAll(hash) {
    return this.serial(async () => {
      await this.ready;
      if (!this.available) throw new Error("Checkpoint tidak tersedia (git tidak ditemukan)");
      // Simpan keadaan sekarang dulu agar "kembalikan" sendiri bisa dibatalkan.
      const cur = await this.snapshotUnlocked("sebelum kembalikan");
      const out = await this.git(["diff", "--name-status", "-z", hash, cur]);
      const list = this.parseNameStatus(out);
      const toDelete = [], toCheckout = [];
      list.forEach((x) => {
        if (x.status === "A") toDelete.push(x.path);              // ada sekarang, tidak ada di snapshot
        else if (x.status === "R" || x.status === "C") { toDelete.push(x.path); if (x.from) toCheckout.push(x.from); }
        else toCheckout.push(x.path);                              // M, D, T: ambil versi snapshot
      });
      toDelete.forEach((p) => this.unlinkSafe(p));
      if (toCheckout.length) await this.checkoutPaths(hash, toCheckout);
      await this.git(["add", "-A", "--ignore-errors", "."]).catch(() => {});
      await this.git(["commit", "-q", "--allow-empty", "--no-verify", "-m", "dikembalikan ke " + hash.slice(0, 8)]).catch(() => {});
      return { restored: toCheckout, deleted: toDelete, changed: toCheckout.concat(toDelete) };
    });
  }

  // Kembalikan satu file ke versi di snapshot `hash` (dihapus bila tidak ada di snapshot).
  restoreFile(hash, rel) {
    return this.serial(async () => {
      await this.ready;
      if (!this.available) throw new Error("Checkpoint tidak tersedia (git tidak ditemukan)");
      rel = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel || rel.indexOf("..") !== -1) throw new Error("Path tidak valid");
      let exists = true;
      try { await this.git(["cat-file", "-e", hash + ":" + rel]); } catch (e) { exists = false; }
      if (exists) await this.git(["checkout", "--quiet", hash, "--", rel]);
      else this.unlinkSafe(rel);
      return { restored: exists ? [rel] : [], deleted: exists ? [] : [rel], changed: [rel] };
    });
  }
}

Checkpoints.HEAVY_DIRS = HEAVY_DIRS;
module.exports = Checkpoints;
