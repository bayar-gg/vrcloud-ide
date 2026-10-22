"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const SessionStore = require("../lib/session-store");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-store-"));
const file = path.join(dir, "session.json");
const store = new SessionStore(file);

store.change((state) => {
  state.layout = { type: "leaf", _id: 1, active: null, tabs: [] };
  state.docs["demo.txt"] = {
    path: "demo.txt",
    content: "unsaved",
    dirty: true,
    revision: 1,
  };
});
store.flush();

const restored = new SessionStore(file);
assert.strictEqual(restored.state.docs["demo.txt"].content, "unsaved");
assert.strictEqual(restored.state.docs["demo.txt"].dirty, true);
assert.strictEqual(restored.state.layout.type, "leaf");
assert.ok(restored.state.revision > 0);

fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : fs.rmdirSync(dir, { recursive: true });
console.log("session-store: ok");
