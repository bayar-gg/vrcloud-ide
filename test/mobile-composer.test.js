"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const chat = fs.readFileSync(path.join(__dirname, "../public/js/ai-chat.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/css/style.css"), "utf8");

const lastMobile = chat.lastIndexOf("@media (max-width:768px){");
assert.ok(lastMobile > 0, "mobile composer rules exist");
const tail = chat.slice(lastMobile, lastMobile + 2800);

assert.ok(tail.includes("flex-wrap:nowrap"), "composer stays on one row");
assert.ok(!/flex-wrap:wrap/.test(tail), "does not wrap tools onto a second row");
assert.ok(tail.includes("#ai-plus{width:24px;height:24px"), "plus stays compact");
assert.ok(tail.includes("height:24px") && tail.includes("#ai-model-chip"), "model chip stays compact");
assert.ok(tail.includes("#ai-mic,.ai-round,#ai-send,#ai-stop{width:28px;height:28px"), "mic/send stay compact");
assert.ok(!/#ai-plus\{width:44px/.test(tail), "does not force 44px plus");
assert.ok(!/#ai-model-chip\{height:44px/.test(tail), "does not force 44px model chip");
assert.ok(tail.includes("::after"), "invisible hit padding present");
assert.ok(chat.includes("placeComposerMenu"), "chip menus are positioned above the bar");

assert.ok(app.includes("lockMobileViewport"), "mobile viewport lock exists");
assert.ok(app.includes("shouldFocus = focus && !isNarrowView()"), "Ace is not auto-focused on phones");
assert.ok(app.includes("useWorker: !mobile"), "Ace workers disabled on phones");
assert.ok(css.includes(".ace_text-input { font-size: 16px !important; }"), "Ace textarea is 16px to avoid zoom");
assert.ok(css.includes("body.narrow { position: fixed"), "narrow body is pinned");

console.log("mobile-composer.test.js: ok");
