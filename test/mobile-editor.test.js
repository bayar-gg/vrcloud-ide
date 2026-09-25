"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/css/style.css"), "utf8");
const chat = fs.readFileSync(path.join(__dirname, "../public/js/ai-chat.js"), "utf8");

assert.ok(/style\.css\?v=vrcloud73/.test(html), "CSS cache-buster bumped");
assert.ok(/app\.js\?v=vrcloud73/.test(html), "JS cache-buster bumped");
assert.ok(/ai-chat\.js\?v=vrcloud73/.test(html), "ai-chat cache-buster bumped");

assert.ok(!/data-nav="editor"/.test(html), "Editor button removed from mobile bottom nav");
assert.ok(/data-nav="files"/.test(html) && /data-nav="term"/.test(html) && /data-nav="agent"/.test(html),
  "Files / Terminal / Agent remain");

assert.ok(css.includes("#mob-nav [data-nav=\"editor\"] { display: none !important; }"),
  "CSS hides any leftover Editor nav control");
assert.ok(css.includes("body.narrow:not(.mob-term) #workarea { display: none !important; }"),
  "workarea is hidden on phones unless the terminal pane is showing");
assert.ok(css.includes(".pane-editor,") && css.includes(".ace_editor { display: none !important; }"),
  "Ace / .pane-editor is not shown on the 768px breakpoint");

assert.ok(app.includes("if (isNarrowView()) return null;"), "Ace is not mounted on phones");
assert.ok(app.includes("Narrow viewports stay editor-free"), "setActiveTab skips the editor sheet on phones");
assert.ok(app.includes("Stay on Files / Agent / Terminal. Opening a file must not reveal Ace."),
  "file-open does not switch to the editor");
assert.ok(app.includes("function setMobTerm"), "terminal is the only workarea reveal on phones");
assert.ok(app.includes("let mode = \"agent\""), "default mobile dest is Agent, not Editor");
assert.ok(app.includes("window.VRCloudAI.open();"), "closing the file drawer returns to Agent");

assert.ok(chat.includes("VRCloudMobile.isNarrow()"), "AI panel opens on phones so chat fills the editor gap");

assert.ok(css.includes("color-scheme: dark"), "CSS color-scheme is dark");
assert.ok(html.includes('name="color-scheme" content="dark"'), "document declares a dark color-scheme");

console.log("mobile-editor.test.js: ok");
