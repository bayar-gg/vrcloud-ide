"use strict";

/**
 * Operasi Git di workspace pengguna (bukan shadow-git checkpoint).
 * Dipakai status bar dan panel Source Control.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

class GitScm {
  constructor(options) {
    this.workspace = options.workspace;
    this.gitBin = options.git !== false;
  }

  relSafe(rel) {
    const raw = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!raw || raw === "." || raw.indexOf("\0") !== -1) throw new Error("Path tidak valid");
    const abs = path.resolve(this.workspace, raw);
    const root = this.workspace.endsWith(path.sep) ? this.workspace : this.workspace + path.sep;
    if (abs !== this.workspace && !abs.startsWith(root)) throw new Error("Path di luar workspace");
    if (path.relative(this.workspace, abs).split(path.sep).includes("..")) throw new Error("Path tidak valid");
    return path.relative(this.workspace, abs).replace(/\\/g, "/") || raw;
  }

  run(args, opts) {
    opts = opts || {};
    const base = [
      "-c", "safe.directory=*", "-c", "core.quotepath=false", "-c", "core.longpaths=true",
      "-c", "gc.auto=0", "-c", "advice.detachedHead=false",
    ];
    return new Promise((resolve, reject) => {
      execFile("git", base.concat(args), {
        cwd: this.workspace,
        env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }),
        timeout: opts.timeout || 30000,
        maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.message = String(stderr || stdout || err.message || "git gagal").trim().split(/\r?\n/)[0] || err.message;
          return reject(err);
        }
        resolve(String(stdout || ""));
      });
    });
  }

  isRepo() {
    return fs.existsSync(path.join(this.workspace, ".git"));
  }

  async head() {
    try { return (await this.run(["rev-parse", "--verify", "-q", "HEAD"])).trim() || ""; }
    catch (e) { return ""; }
  }

  async summary() {
    if (!this.gitBin) return { repo: false, error: "git tidak ditemukan" };
    if (!this.isRepo()) return { repo: false };
    let branch = "";
    try { branch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 8000 })).trim(); }
    catch (e) { return { repo: true, branch: "", changes: 0, error: "belum ada commit" }; }
    if (branch === "HEAD") {
      try { branch = (await this.run(["rev-parse", "--short", "HEAD"], { timeout: 8000 })).trim() + " (detached)"; }
      catch (e) {}
    }
    const porcelain = await this.run(["status", "--porcelain", "--untracked-files=normal"], { timeout: 15000 }).catch(() => "");
    const lines = porcelain.split(/\r?\n/).filter(Boolean);
    let staged = 0, unstaged = 0, untracked = 0;
    lines.forEach((l) => {
      if (l.startsWith("??")) untracked++;
      else { if (l[0] !== " " && l[0] !== "?") staged++; if (l[1] !== " ") unstaged++; }
    });
    let ahead = 0, behind = 0;
    try {
      const lr = (await this.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { timeout: 8000 })).trim().split(/\s+/);
      ahead = parseInt(lr[0], 10) || 0; behind = parseInt(lr[1], 10) || 0;
    } catch (e) { /* tanpa upstream */ }
    return { repo: true, branch, changes: lines.length, staged, unstaged, untracked, ahead, behind };
  }

  parsePorcelainZ(buf) {
    const parts = String(buf || "").split("\0");
    const files = [];
    const isEntry = (s) => s && s.length >= 3 && /^[ MADRCU?!]{2} /.test(s);
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (!isEntry(rec)) continue;
      const x = rec[0], y = rec[1];
      const p = rec.slice(3);
      let from = "";
      if (i + 1 < parts.length && parts[i + 1] && !isEntry(parts[i + 1])) from = parts[++i];
      const untracked = x === "?" && y === "?";
      const staged = !untracked && x !== " " && x !== "?";
      const unstaged = !untracked && y !== " " && y !== "?";
      files.push({
        path: p.replace(/\\/g, "/"),
        from: from.replace(/\\/g, "/") || undefined,
        index: x, work: y,
        staged, unstaged, untracked,
        status: untracked ? "?" : (y !== " " && y !== "?" ? y : x),
      });
    }
    return files.filter((f) => f.path);
  }

  async status() {
    const sum = await this.summary();
    if (!sum.repo) return Object.assign({ files: [], branches: [], log: [] }, sum);
    const z = await this.run(["status", "-z", "--untracked-files=normal"], { timeout: 20000 }).catch(() => "");
    const files = this.parsePorcelainZ(z);
    let branches = [], log = [];
    try { branches = await this.branches(); } catch (e) { branches = []; }
    try { log = await this.log(12); } catch (e) { log = []; }
    return Object.assign({}, sum, { files, branches, log });
  }

  async diff(rel, staged) {
    if (!this.isRepo()) throw new Error("Bukan repositori Git");
    rel = this.relSafe(rel);
    const args = ["diff", "--no-color", "--no-ext-diff", "-U3"];
    if (staged) args.push("--cached");
    args.push("--", rel);
    let out = "";
    try { out = await this.run(args, { timeout: 20000 }); }
    catch (e) { throw e; }
    if (!out.trim()) {
      const st = (await this.run(["status", "-z", "--", rel], { timeout: 8000 }));
      const f = this.parsePorcelainZ(st)[0];
      if (f && f.untracked) {
        const abs = path.join(this.workspace, rel);
        let body = "";
        try {
          if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size < 400000) {
            body = fs.readFileSync(abs, "utf8");
            if (body.indexOf("\0") !== -1) body = "(file biner)\n";
          } else body = "(folder atau file terlalu besar)\n";
        } catch (e) { body = ""; }
        const lines = body.split(/\r?\n/);
        out = "--- /dev/null\n+++ b/" + rel + "\n@@ -0,0 +1," + lines.length + " @@\n" + lines.map((l) => "+" + l).join("\n");
      }
    }
    const cap = 200000;
    return out.length > cap ? out.slice(0, cap) + "\n…(dipotong)\n" : out;
  }

  pathsOf(list) {
    if (!Array.isArray(list) || !list.length) throw new Error("Daftar path kosong");
    if (list.length > 500) throw new Error("Maksimal 500 file per operasi");
    return list.map((p) => this.relSafe(p));
  }

  async stage(paths, all) {
    if (!this.isRepo()) throw new Error("Bukan repositori Git");
    if (all) await this.run(["add", "-A", "--", "."]);
    else await this.run(["add", "--"].concat(this.pathsOf(paths)));
    return this.summary();
  }

  async unstage(paths, all) {
    if (!this.isRepo()) throw new Error("Bukan repositori Git");
    const args = all ? ["."] : this.pathsOf(paths);
    try { await this.run(["restore", "--staged", "--"].concat(args)); }
    catch (e) { await this.run(["reset", "-q", "HEAD", "--"].concat(args)); }
    return this.summary();
  }

  async discard(paths) {
    if (!this.isRepo()) throw new Error("Bukan repositori Git");
    const list = this.pathsOf(paths);
    const changed = [];
    for (const rel of list) {
      const st = this.parsePorcelainZ(await this.run(["status", "-z", "--untracked-files=all", "--", rel], { timeout: 8000 }))[0];
      if (st && st.untracked) {
        const abs = path.join(this.workspace, rel);
        try {
          if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        } catch (e) { /* lanjut */ }
        changed.push(rel);
        continue;
      }
      await this.run(["restore", "--worktree", "--source=HEAD", "--", rel]).catch(async () => {
        await this.run(["checkout", "--", rel]);
      });
      changed.push(rel);
    }
    return Object.assign({ changed }, await this.summary());
  }

  async commit(message) {
    if (!this.isRepo()) throw new Error("Bukan repositori Git");
    const msg = String(message == null ? "" : message).replace(/\r\n/g, "\n").trim();
    if (!msg) throw new Error("Pesan commit kosong");
    if (msg.length > 4000) throw new Error("Pesan commit terlalu panjang");
    const staged = await this.run(["diff", "--cached", "--name-only"], { timeout: 15000 });
    if (!staged.trim()) throw new Error("Tidak ada file yang di-stage");
    let name = "", email = "";
    try { name = (await this.run(["config", "--get", "user.name"], { timeout: 5000 })).trim(); } catch (e) {}
    try { email = (await this.run(["config", "--get", "user.email"], { timeout: 5000 })).trim(); } catch (e) {}
    const ident = [];
    if (!name) ident.push("-c", "user.name=VRCloud IDE");
    if (!email) ident.push("-c", "user.email=ide@vrcloud.local");
    const out = await this.run(ident.concat(["commit", "-m", msg, "--no-verify"]));
    const hash = (await this.head()).slice(0, 12);
    return Object.assign({ ok: true, hash, output: out.trim().split(/\r?\n/)[0] || "" }, await this.summary());
  }

  async branches() {
    if (!this.isRepo()) return [];
    const out = await this.run(["branch", "--list", "--format=%(refname:short)%09%(HEAD)%09%(objectname:short)%09%(upstream:short)"], { timeout: 8000 });
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const p = line.split("\t");
      return { name: p[0], current: p[1] === "*", hash: p[2] || "", upstream: p[3] || "" };
    });
  }

  async checkout(branch, create) {
    if (!this.isRepo()) throw new Error("Bukan repositori Git");
    const name = String(branch || "").trim();
    if (!/^[A-Za-z0-9._/-]{1,80}$/.test(name) || name[0] === "-" || name.indexOf("..") !== -1) {
      throw new Error("Nama branch tidak valid");
    }
    const before = await this.head();
    if (create) await this.run(["checkout", "-b", name]);
    else await this.run(["checkout", name]);
    const after = await this.head();
    let changed = [];
    if (before && after && before !== after) {
      try { changed = (await this.run(["diff", "--name-only", before, after])).split(/\r?\n/).filter(Boolean); }
      catch (e) { changed = []; }
    }
    return Object.assign({ ok: true, branch: name, changed }, await this.summary());
  }

  async log(n) {
    if (!this.isRepo()) return [];
    const out = await this.run(["log", "-n", String(Math.min(40, Math.max(1, Number(n) || 12))), "--format=%h%x09%s%x09%an%x09%ar"], { timeout: 8000 });
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const p = line.split("\t");
      return { hash: p[0], subject: p[1] || "", author: p[2] || "", when: p[3] || "" };
    });
  }

  async init() {
    if (this.isRepo()) return this.summary();
    await this.run(["init", "--quiet"]);
    return this.summary();
  }
}

module.exports = GitScm;
