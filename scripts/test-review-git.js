"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");
const GitScm = require("../lib/git-scm");
const BrowserAutomation = require("../lib/browser-automation");

function git(dir, args) {
  execFileSync("git", ["-c", "safe.directory=*", "-c", "user.name=T", "-c", "user.email=t@t.t"].concat(args), {
    cwd: dir, stdio: "pipe", windowsHide: true,
  });
}

function testPlaywright() {
  const script = BrowserAutomation.toPlaywright([
    { action: "navigate", url: "https://example.com", args: { url: "https://example.com" } },
    { action: "click", args: { pw: { sel: "#go", text: "Go" } } },
    { action: "type", args: { pw: { sel: "input[name=\"q\"]" }, text: "hello", submit: true } },
    { action: "type", args: { pw: { sel: "#pw" }, secret: "login-pass", text: "•••" } },
    { action: "press_key", args: { key: "Escape" } },
    { action: "request_user", args: { message: "CAPTCHA" } },
  ], { file: "tests/demo.spec.js", title: "demo" });
  assert(script.indexOf("page.goto(\"https://example.com\")") !== -1, "goto");
  assert(script.indexOf("page.locator(\"#go\").click()") !== -1, "click sel");
  assert(script.indexOf("page.locator(\"input[name=\\\"q\\\"]\").fill(\"hello\")") !== -1, "fill");
  assert(script.indexOf("keyboard.press('Enter')") !== -1, "submit");
  assert(script.indexOf("process.env.LOGIN_PASS") !== -1, "secret env");
  assert(script.indexOf("page.pause()") !== -1, "handoff pause");
  assert(script.indexOf("require('@playwright/test')") !== -1, "pw import");
  console.log("ok playwright export");
}

async function testGit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrc-git-"));
  const scm = new GitScm({ workspace: dir, git: true });
  try {
    const empty = await scm.summary();
    assert.strictEqual(empty.repo, false, "not a repo yet");
    await scm.init();
    git(dir, ["commit", "--allow-empty", "-m", "root"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "bee\n");
    let st = await scm.status();
    assert(st.repo, "repo");
    assert(st.files.some((f) => f.path === "a.txt" && f.untracked), "a untracked");
    await scm.stage(["a.txt"]);
    st = await scm.status();
    const a = st.files.find((f) => f.path === "a.txt");
    assert(a && a.staged && !a.untracked, "a staged");
    const c = await scm.commit("add a");
    assert(c.hash, "commit hash");
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    const diff = await scm.diff("a.txt", false);
    assert(diff.indexOf("-one") !== -1 && diff.indexOf("+two") !== -1, "unstaged diff");
    await scm.stage(["a.txt"]);
    const stagedDiff = await scm.diff("a.txt", true);
    assert(stagedDiff.indexOf("+two") !== -1, "staged diff");
    await scm.unstage(["a.txt"]);
    await scm.discard(["a.txt"]);
    assert.strictEqual(fs.readFileSync(path.join(dir, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "one\n", "discard restored");
    await scm.checkout("feat", true);
    const br = await scm.branches();
    assert(br.some((b) => b.name === "feat" && b.current), "new branch");
    console.log("ok git scm");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

testPlaywright();
testGit().catch((e) => { console.error(e); process.exit(1); });
