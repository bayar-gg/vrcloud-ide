"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/css/style.css"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const hub = fs.readFileSync(path.join(__dirname, "../lib/realtime-hub.js"), "utf8");

assert.ok(html.includes("theme-ambiance.js"), "Ambiance is preloaded, not fetched after file-open");
assert.ok(html.includes('name="color-scheme" content="dark"'), "document declares a dark color-scheme");
assert.ok(/style\.css\?v=vrcloud72/.test(html), "CSS cache-buster bumped");
assert.ok(/app\.js\?v=vrcloud72/.test(html), "JS cache-buster bumped");

assert.ok(app.includes("function applySyntaxTheme"), "theme helper reapplies Ambiance if Ace stays on TextMate");
assert.ok(app.includes("ace.config.set(\"useWorker\", false)"), "workers are disabled before the first session");
assert.ok(app.includes("session.setMode(") && app.includes("setUseWorker(!isNarrowView())"), "mode is set after workers are toggled");
assert.ok(app.includes("if (leaf._root) renderLeafTabs(leaf)"), "opening a file reuses the live pane instead of wiping #workarea");
assert.ok(app.includes("function failOpen"), "file-open errors are caught");
assert.ok(app.includes("visualViewport"), "visualViewport is pinned on phones");

assert.ok(css.includes("color-scheme: dark"), "CSS color-scheme is dark");
assert.ok(css.includes(".ace_editor.ace-tm"), "TextMate white sheet is overridden");
assert.ok(css.includes(".pane-editor { display: none; background: var(--editor-bg"), "editor host is dark before Ace paints");
assert.ok(css.includes(".ace_text-input { font-size: 16px !important; }"), "Ace textarea stays 16px");

assert.ok(server.includes("uncaughtException"), "process exceptions are logged");
assert.ok(server.includes("unhandledRejection"), "unhandled rejections are logged");
assert.ok(server.includes("[vrcloud]"), "fatal lines use a stable prefix");
assert.ok(hub.includes("[vrcloud] sync "), "doc-open failures are logged without dropping the process");

console.log("mobile-editor.test.js: ok");
