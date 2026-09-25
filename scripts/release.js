#!/usr/bin/env node
// Release VRCloud IDE as a single, replaced commit.
//
//   node scripts/release.js 3.1.0            bump to an explicit version
//   node scripts/release.js patch|minor|major bump semantically
//   node scripts/release.js 3.1.0 --no-push  amend locally only
//   node scripts/release.js 3.1.0 --author "Name <email>"
//
// The repository keeps exactly one commit on main. This script writes the new version to
// package.json / package-lock.json, stages the working tree, replaces the root commit
// (message "VRCloud IDE vX.Y.Z") and force-pushes with lease. Installed servers update via
// `git fetch --depth 1` + `git reset --hard FETCH_HEAD`, so rewriting history is safe.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ""; };
const spec = args.find((a) => !a.startsWith("--") && a !== opt("--author") && a !== opt("--branch")) || "";
const branch = opt("--branch") || "main";
const author = opt("--author") || "";
const push = !flag("--no-push");

function git(a, quiet) {
  const base = ["-c", "safe.directory=*", "-c", "core.fileMode=false"];
  if (author) { const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(author); if (m) base.push("-c", "user.name=" + m[1].trim(), "-c", "user.email=" + m[2].trim()); }
  const out = execFileSync("git", base.concat(a), { cwd: ROOT, stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"] });
  return String(out || "").trim();
}
function die(msg) { console.error("release: " + msg); process.exit(1); }

const pkgFile = path.join(ROOT, "package.json"), lockFile = path.join(ROOT, "package-lock.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
const cur = String(pkg.version || "0.0.0");
function bump(v, how) {
  const p = v.split(".").map((n) => parseInt(n, 10) || 0); while (p.length < 3) p.push(0);
  if (how === "major") return (p[0] + 1) + ".0.0";
  if (how === "minor") return p[0] + "." + (p[1] + 1) + ".0";
  if (how === "patch") return p[0] + "." + p[1] + "." + (p[2] + 1);
  return how;
}
if (!spec) die("usage: node scripts/release.js <version|major|minor|patch> [--no-push] [--author \"Name <email>\"]");
const next = bump(cur, spec.replace(/^v/i, ""));
if (!/^\d+\.\d+\.\d+$/.test(next)) die("invalid version: " + next);

// Sanity: correct branch, inside a git repo.
const onBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], true);
if (onBranch !== branch) die("switch to branch '" + branch + "' first (currently on '" + onBranch + "')");

// Version files.
pkg.version = next;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
if (fs.existsSync(lockFile)) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    lock.version = next; if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
  } catch (e) { console.warn("release: could not update package-lock.json: " + e.message); }
}
console.log("version " + cur + " -> " + next);

// One commit: stage everything, then replace the root commit.
git(["add", "-A"]);
const msg = "VRCloud IDE v" + next;
const hasCommit = (() => { try { git(["rev-parse", "--verify", "HEAD"], true); return true; } catch (e) { return false; } })();
if (hasCommit) {
  const tree = git(["write-tree"]);
  const commit = git(["commit-tree", tree, "-m", msg]);   // root commit, no parent
  git(["update-ref", "refs/heads/" + branch, commit]);
} else {
  git(["commit", "-q", "-m", msg]);
}
console.log("commit " + git(["rev-parse", "--short", "HEAD"]) + "  " + msg);

if (push) {
  git(["push", "--force-with-lease", "origin", branch]);
  console.log("pushed " + branch + " (force, with lease)");
} else console.log("not pushed (--no-push)");
