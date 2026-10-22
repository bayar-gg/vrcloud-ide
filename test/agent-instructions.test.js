"use strict";

// Perilaku agent hampir seluruhnya ditentukan prompt. Test ini mengunci invarian prompt
// yang diandalkan fitur (verifikasi per langkah, state tugas, handoff, panduan desktop/
// browser) supaya perubahan kata-kata yang menghapusnya terlihat sebelum pengguna mengeluh.

const assert = require("assert");
const I = require("../lib/agent-instructions");

function agentPrompt(extra) {
  return I.agentPrompt(Object.assign({
    workspace: "C:/ws", mode: "agent", platform: "win32", userText: "perbaiki login",
    browser: { on: true, mode: "auto" }, desktop: { on: true, mode: "auto" }, memoryEnabled: true,
  }, extra || {}));
}

// Verifikasi per langkah ada di prompt per pesan dan di system prompt Anthropic/Grok.
{
  const p = agentPrompt();
  assert.ok(p.includes("[One step at a time]"), "VERIFY_LOOP in per-message prompt");
  assert.ok(/Never mark several todos completed at once/.test(p));
  const sys = I.anthropicSystem({ workspace: "C:/ws", platform: "linux" }).join("\n");
  assert.ok(sys.includes("[One step at a time]"), "VERIFY_LOOP in system prompt");
  assert.ok(/diagnostics\(path\)/.test(sys), "system prompt points at diagnostics tool");
  const ask = I.agentPrompt({ workspace: "C:/ws", mode: "ask", userText: "apa ini" });
  assert.ok(!ask.includes("[One step at a time]"), "ask mode has no verify loop");
}

// Panduan browser: ref dari snapshot, ref basi setelah navigasi, koordinat sebagai pilihan terakhir.
{
  const p = agentPrompt();
  assert.ok(/browser_snapshot lists every interactive element with a ref/.test(p));
  assert.ok(/FRESH browser_snapshot before using any ref/.test(p));
  assert.ok(/coordinates only as a last resort/.test(p));
}

// Panduan desktop: klik berdasarkan nama lebih dulu, baris status pointer, satu aksi per langkah.
{
  const p = agentPrompt();
  assert.ok(/Click by NAME before clicking by coordinates/.test(p));
  assert.ok(/desktop_find/.test(p));
  assert.ok(/pointer position in both pixels and fractions/.test(p));
  assert.ok(/never click the same point a third time/.test(p));
  const off = agentPrompt({ desktop: { on: false, mode: "off" } });
  assert.ok(/Computer use is OFF/.test(off));
}

// State tugas + prompt lanjutan: tanda resume, langkah selesai, file, verifikasi, peringatan, tekanan konteks.
{
  const state = {
    request: "perbaiki login",
    todos: [
      { id: "a", content: "baca kode", status: "completed" },
      { id: "b", content: "perbaiki bug", status: "in_progress" },
      { id: "c", content: "tes", status: "pending" },
    ],
    files: ["src/auth.js"],
    verification: "npm test: passed",
    warnings: ["[Verification required] This step was NOT marked completed because no check ran since it started: \u201ctes\u201d."],
    usedPercent: 82,
  };
  const p = I.continuePrompt(state);
  assert.ok(p.startsWith("Continue the task."));
  assert.ok(p.includes(I.TASK_STATE_HEADER));
  assert.ok(/\[x\] baca kode/.test(p) && /\[>\] perbaiki bug\s+<-- resume here/.test(p) && /\[ \] tes/.test(p));
  assert.ok(/Files already changed in this run: src\/auth\.js/.test(p));
  assert.ok(/Last verification: npm test: passed/.test(p));
  assert.ok(/\[Verification required\]/.test(p), "enforcer warning survives into the continue prompt");
  assert.ok(/\[Context budget\] About 82%/.test(p), "pressure note at >= 70%");
  assert.ok(!/\[Context budget\]/.test(I.continuePrompt(Object.assign({}, state, { usedPercent: 40 }))), "no pressure note under 70%");
  assert.strictEqual(I.taskStateText({}), "", "empty state renders nothing");
  const bare = I.continuePrompt({});
  assert.ok(!bare.includes(I.TASK_STATE_HEADER) && /How to continue:/.test(bare));
}

// Handoff: permintaan memuat bagian wajib dan melarang tool; prelude membawa handoff + state.
{
  const req = I.handoffRequest({ request: "x", todos: [{ id: "1", content: "a", status: "in_progress" }] });
  ["## Goal", "## Done so far", "## In progress", "## Key findings", "## Remaining"].forEach((h) => assert.ok(req.includes(h), h));
  assert.ok(/Do not call any tools/.test(req));
  assert.ok(req.includes(I.TASK_STATE_HEADER));
  const pre = I.handoffPrelude("## Goal\nselesaikan x", { todos: [{ id: "1", content: "a", status: "in_progress" }] });
  assert.ok(/Handoff from your previous context/.test(pre) && /selesaikan x/.test(pre) && /resume here/.test(pre));
  assert.ok(/produced no handoff/.test(I.handoffPrelude("", {})));
}

// Pengklasifikasi orkestrasi: jawaban satu kata, tanpa tool, permintaan dipotong.
{
  const p = I.orchestrationClassifierPrompt("x".repeat(5000));
  assert.ok(/MULTI or SINGLE/.test(p) && /do not use any tools/.test(p));
  assert.ok(p.length < 3000, "request is capped");
}

// Deskripsi tool baru ada dan konsisten dengan panduan.
{
  assert.ok(/accessibility tree/.test(I.tool("desktop_find")));
  assert.ok(/name=/.test(I.tool("desktop_click")));
  assert.ok(/language server/.test(I.tool("diagnostics")));
  assert.ok(/only set a todo to completed after a check you actually ran/.test(I.tool("updateTodos")));
  assert.ok(/memory_upsert/.test(I.MEMORY.enabled) && /generated block/.test(I.MEMORY.enabled));
}

// Percakapan: identitas bukan sekadar "coding agent"; prompt obrolan punya sikap, bukan checklist,
// dan tidak menyentuh workspace; system prompt menjelaskan bahwa aturan engineering hanya untuk tugas.
{
  const sys = I.anthropicSystem({ workspace: "C:/ws", platform: "linux" }).join("\n");
  assert.ok(/thinking partner/.test(sys) && /senior software engineer/.test(sys), "identity covers both conversation and engineering");
  assert.ok(/in conversation, follow the \[Conversation\] guidance/.test(sys), "system prompt defers to per-message conversation guidance");
  const chat = I.agentPrompt({
    intent: "chat", workspace: "C:/ws", userText: "menurutmu AI bakal gantiin programmer?",
    browser: { on: true, mode: "auto" }, images: { on: true, via: "custom" },
    userProfile: "- Name: Bayu; likes blunt opinions.", priorTranscript: "[Earlier]\nuser: halo",
    editorContext: "[User's editor]\nActive file: server.js",
  });
  assert.ok(chat.includes("[Conversation]") && /point of view/.test(chat) && /Disagree when you disagree/.test(chat));
  assert.ok(/at most one question/.test(chat) && /WebFetch/.test(chat) && /generate_image/.test(chat));
  assert.ok(/do not start editing files or running commands/.test(chat), "conversation never mutates the workspace on its own");
  assert.ok(/kind "user" and scope "user"/.test(chat), "it learns about the user");
  assert.ok(/Name: Bayu/.test(chat) && /Active file: server.js/.test(chat) && /user: halo/.test(chat));
  assert.ok(!chat.includes("[One step at a time]") && !chat.includes("updateTodos"), "no task playbook in a conversation");
  assert.ok(chat.indexOf("[About the user") < chat.indexOf("User message:"));
  const task = I.agentPrompt({ workspace: "C:/ws", mode: "agent", platform: "win32", userText: "perbaiki login", userProfile: "- Name: Bayu" });
  assert.ok(/Name: Bayu/.test(task) && task.includes("[One step at a time]"), "tasks keep the playbook and know the user too");
  assert.ok(/kind "user"/.test(I.MEMORY.enabled), "memory guidance covers facts about the user");
}

// Riset web: panduan [Research] ada di percakapan, tugas, dan Ask; hilang bila tool dimatikan;
// deskripsi tool web_search dan panduan tool di system prompt menyebutnya.
{
  const chat = I.agentPrompt({ intent: "chat", workspace: "C:/ws", userText: "kapan Node 24 rilis?" });
  const task = I.agentPrompt({ workspace: "C:/ws", mode: "agent", platform: "win32", userText: "upgrade ke Node 24" });
  const ask = I.agentPrompt({ workspace: "C:/ws", mode: "ask", userText: "apa ini" });
  [chat, task, ask].forEach((p) => {
    assert.ok(p.includes("[Research]") && /web_search\(query\)/.test(p) && /Do not answer such questions from memory alone/.test(p));
    assert.ok(/Cross-check important claims/.test(p) && /Cite: end the answer with the URLs you actually used/.test(p));
    assert.ok(/Do not search for what you already know for certain/.test(p), "no gratuitous searching");
  });
  assert.ok(!/web_search\(query\)/.test(I.agentPrompt({ intent: "chat", workspace: "C:/ws", userText: "hai", search: { on: false } })), "no research block without the tool");
  assert.ok(/fetch_top/.test(I.tool("web_search")) && /cite the URLs/.test(I.tool("web_search")));
  const sys = I.anthropicSystem({ workspace: "C:/ws", platform: "linux" }).join("\n");
  assert.ok(/web_search \(when present\) searches the web/.test(sys));
}

console.log("agent-instructions: ok");
