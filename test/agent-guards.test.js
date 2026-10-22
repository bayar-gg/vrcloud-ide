"use strict";

// Pengaman agent yang berjalan di kode, bukan di prompt: gerbang persetujuan perintah,
// penegak bukti todo, batasan subagent, gating orkestrasi, dan frame usage.
// Hermetik: tanpa provider, tanpa jaringan, tanpa server.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AiChat = require("../lib/ai-chat");
const ProviderFactory = require("../lib/provider-factory");
const AgentOrchestrator = require("../lib/agent-orchestrator");
const AnthropicAgent = require("../lib/anthropic-agent");

function makeChat() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-guards-"));
  const chat = new AiChat({
    workspace: root,
    storeFile: path.join(root, "sessions.json"),
    configFile: path.join(root, "config.json"),
    providerFactory: { cursorStatus: () => ({ available: true, error: "" }), create: async () => { throw new Error("not used"); } },
    orchestration: "off",
  });
  return { root, chat, cleanup: async () => { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

(async () => {
  // ---- Command approval -------------------------------------------------------------
  {
    const { chat, cleanup } = makeChat();
    try {
      assert.strictEqual(chat.getGuard().enabled, true, "guard is on by default");
      assert.deepStrictEqual(await chat.reviewShell({ command: "ls -la" }), { permission: "allow" }, "harmless command passes without a session");
      const denied = await chat.reviewShell({ command: "rm -rf /tmp/x" });
      assert.strictEqual(denied.permission, "deny", "dangerous command with no live session is denied, not allowed");

      // Sesi hidup: kartu izin muncul, keputusan pengguna menentukan.
      const s = chat.runtime("s1");
      s.busy = true; s.live = { frames: [], text: "", think: "", tools: [], plan: null, usage: null, touched: [] };
      const frames = [];
      s.listeners.add((kind, val) => frames.push({ kind, val }));
      const pending = chat.reviewShell({ command: "git push --force origin main" }, { sessionId: "s1" });
      await new Promise((r) => setTimeout(r, 10));
      const card = frames.find((f) => f.kind === "approval");
      assert.ok(card && card.val.status === "pending" && /git push --force/.test(card.val.command), "approval frame emitted");
      assert.ok(chat.decideApproval(card.val.id, true, "user"));
      assert.deepStrictEqual(await pending, { permission: "allow" });
      assert.strictEqual(frames.filter((f) => f.kind === "approval").pop().val.status, "allowed");

      const pending2 = chat.reviewShell({ command: "mkfs.ext4 /dev/sda" }, { sessionId: "s1" });
      await new Promise((r) => setTimeout(r, 10));
      const card2 = frames.filter((f) => f.kind === "approval").pop();
      chat.decideApproval(card2.val.id, false, "user");
      const d2 = await pending2;
      assert.strictEqual(d2.permission, "deny");
      assert.ok(/did not approve/.test(d2.agent_message));

      // Guard dimatikan: lolos tanpa kartu.
      chat.setGuard({ enabled: false });
      assert.deepStrictEqual(await chat.reviewShell({ command: "rm -rf /" }, { sessionId: "s1" }), { permission: "allow" });
      s.busy = false; s.live = null;
    } finally { await cleanup(); }
  }

  // Tool shell provider Anthropic/Grok menghormati beforeShell.
  {
    const ctx = { workspace: new AnthropicAgent.Workspace(os.tmpdir(), process.env.SHELL_BIN), customTools: {}, beforeShell: async () => ({ permission: "deny", agent_message: "nope" }) };
    const r = await AnthropicAgent.executeWorkspaceTool(ctx, "shell", { command: "echo hi" }, "c1");
    assert.strictEqual(r.isError, true);
    assert.ok(/Denied: nope/.test(r.content[0].text));
    assert.strictEqual(r.value.denied, true);
  }

  // ---- Evidence enforcer ---------------------------------------------------------------
  {
    const { chat, cleanup } = makeChat();
    try {
      const s = { evidence: { count: 0, started: {}, lastPlan: 0, accepted: null, notes: [] }, todos: null };
      const plan = (list) => chat.enforceTodos(s, list);
      // Rencana awal: satu in_progress.
      let r = plan([{ id: "a", content: "A", status: "in_progress" }, { id: "b", content: "B", status: "pending" }]);
      assert.strictEqual(r.note, "");
      // Selesai tanpa bukti apa pun: dikembalikan ke in_progress + catatan.
      r = plan([{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B", status: "in_progress" }]);
      assert.strictEqual(r.todos[0].status, "in_progress", "no evidence -> reverted");
      assert.ok(/Verification required/.test(r.note) && /\u201cA\u201d/.test(r.note));
      assert.strictEqual(s.evidence.notes.length, 1);
      // Ada pemeriksaan (shell selesai): sekarang boleh completed.
      s.evidence.count++;
      r = plan([{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B", status: "in_progress" }]);
      assert.strictEqual(r.todos[0].status, "completed", "evidence since start -> accepted");
      assert.strictEqual(r.note, "");
      // B selesai tanpa bukti baru sejak pembaruan terakhir: ditolak; setelah bukti: diterima.
      r = plan([{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B", status: "completed" }]);
      assert.strictEqual(r.todos[1].status, "in_progress");
      s.evidence.count++;
      r = plan([{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B", status: "completed" }]);
      assert.strictEqual(r.todos[1].status, "completed");
      // Sudah completed sebelumnya tidak dipersoalkan lagi; cancelled bebas.
      r = plan([{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B", status: "cancelled" }]);
      assert.strictEqual(r.note, "");
      // Tool yang dihitung sebagai bukti.
      ["shell", "diagnostics", "browser_snapshot", "desktop_screenshot", "readLints"].forEach((n) => assert.ok(AiChat.isEvidenceTool(n), n));
      ["read", "edit", "grep", "ast_edit", "memory_upsert"].forEach((n) => assert.ok(!AiChat.isEvidenceTool(n), n));
      // Tanpa runtime bukti (orkestrasi / ask): lewat apa adanya.
      assert.strictEqual(chat.enforceTodos({ evidence: null }, [{ id: "z", status: "completed" }]).todos[0].status, "completed");
    } finally { await cleanup(); }
  }

  // updateTodos di executor bersama memanggil onTodos dan menyisipkan catatannya.
  {
    const ctx = { workspace: null, customTools: {}, todos: null, onTodos: (list) => ({ todos: list.map((t) => Object.assign({}, t, { status: "in_progress" })), note: "[Verification required] x" }) };
    const r = await AnthropicAgent.executeWorkspaceTool(ctx, "updateTodos", { todos: [{ id: "a", content: "A", status: "completed" }] }, "c2");
    assert.strictEqual(ctx.todos[0].status, "in_progress");
    assert.ok(/Verification required/.test(r.content[0].text));
    assert.strictEqual(r.value.todos[0].status, "in_progress");
  }

  // ---- noNativeTask + read-only ladders ------------------------------------------------
  {
    const ladder = ProviderFactory.disallowedCandidates("agent", { noNativeTask: true });
    assert.ok(ladder.length >= 1 && ladder.every((rung) => rung.indexOf("task") !== -1), "every rung forbids task");
    assert.ok(ProviderFactory.disallowedCandidates("agent", {}).some((rung) => rung.length === 0), "plain ladder still degrades to []");
    assert.deepStrictEqual(ProviderFactory.disallowedCandidates("ask", {}), [ProviderFactory.READ_ONLY_BUILTINS]);
    assert.ok(ProviderFactory.isReadOnlyCustomTool("diagnostics", {}), "diagnostics is read-only (allowed in Ask mode)");
  }

  // ---- Parallel-safe classification ----------------------------------------------------
  {
    assert.ok(["read", "grep", "glob", "ls", "ast_search", "memory_search", "diagnostics"].every((n) => AnthropicAgent.isParallelSafe(n)));
    assert.ok(["edit", "write", "shell", "ast_edit", "desktop_click", "browser_click"].every((n) => !AnthropicAgent.isParallelSafe(n)));
  }

  // ---- Orchestration gate -------------------------------------------------------------
  {
    const ex = (text, cfg) => AgentOrchestrator.explainOrchestration({ mode: "agent", text, config: cfg || { mode: "auto" } });
    assert.strictEqual(ex("perbaiki typo").decision, false);
    assert.strictEqual(ex("bagaimana cara kerja fungsi login di auth.js ini sebenarnya?").decision, false);
    assert.strictEqual(ex("tambahkan validasi email di form registrasi dan tampilkan pesan errornya").decision, "ambiguous");
    assert.strictEqual(ex("buat modul A\nubah modul B\nhapus modul C\ntes semuanya").decision, true);
    assert.strictEqual(ex("x".repeat(10), { mode: "off" }).reason, "Smart Agent is off");
    assert.strictEqual(ex("perbaiki a dan b di file c yang panjang sekali ini", { mode: "on" }).decision, true);
    assert.strictEqual(AgentOrchestrator.shouldOrchestrate({ mode: "agent", text: "tambahkan validasi email di form registrasi dan tampilkan pesan errornya", config: { mode: "auto" } }), false, "ambiguous without classifier = direct");
    assert.strictEqual(AgentOrchestrator.normalizeConfig({}).classifier, true);
    assert.strictEqual(AgentOrchestrator.normalizeConfig({ classifier: false }).classifier, false);
  }

  // ---- Usage frames: accumulation vs occupancy vs measured -----------------------------
  {
    const { chat, cleanup } = makeChat();
    try {
      const s = { live: { usage: null } };
      let u = chat.usageFrame(s, { inputTokens: 100, outputTokens: 10, totalTokens: 110 });
      assert.strictEqual(u.contextTokens, 110);
      s.live.usage = u;
      u = chat.usageFrame(s, { inputTokens: 150, outputTokens: 10, totalTokens: 160, cacheReadTokens: 40 });
      assert.strictEqual(u.inputTokens, 250, "input accumulates");
      assert.strictEqual(u.contextTokens, 200, "occupancy is the last round only");
      s.live.usage = u;
      u = chat.usageFrame(s, { measured: true, contextTokens: 123456 });
      assert.strictEqual(u.inputTokens, 250, "measured frame does not touch accumulation");
      assert.strictEqual(u.contextTokens, 123456);
      assert.strictEqual(u.measured, true);
      assert.ok(u.contextLimit > 0);
      s.live.usage = u;
      assert.ok(chat.contextUsedPercent(s) > 0);
    } finally { await cleanup(); }
  }

  // ---- Pill konteks: noEditor membuang file aktif & tab terbuka dari prompt ----
  {
    const { chat, cleanup } = makeChat();
    try {
      chat.openFiles = () => ({ active: "src/secret-active.js", open: ["src/secret-active.js", "src/other-tab.js"] });
      const withCtx = await chat.agentPrompt("perbaiki ini", "");
      assert.ok(/src\/secret-active\.js/.test(withCtx) && /src\/other-tab\.js/.test(withCtx), "editor context is included by default");
      const without = await chat.agentPrompt("perbaiki ini", "", { noEditor: true });
      assert.ok(!/secret-active|other-tab/.test(without), "noEditor drops the active file and open tabs");
      assert.ok(/perbaiki ini/.test(without));
    } finally { await cleanup(); }
  }

  // ---- Rewind: "Kembalikan ke sebelum pesan ini" menghapus pesan itu dan semua sesudahnya ----
  {
    const { chat, cleanup } = makeChat();
    try {
      const deleted = [];
      chat.providerFactory.deleteCursorAgent = async (id) => { deleted.push(id); };
      const disposed = [];
      chat.dispose = async (agent) => { disposed.push(agent); };
      chat.store.sessions.push({
        id: "r1", title: "t", updatedAt: 1,
        agentId: "cursor-agent-1", claudeHistory: [{ role: "user", content: "x" }], grokHistory: [], usage: { totalTokens: 10, contextTokens: 9000 },
        messages: [
          { role: "user", text: "pertama", checkpoint: "aaaaaaa1111111" },
          { role: "ai", text: "jawaban pertama" },
          { role: "user", text: "kedua: ubah login", checkpoint: "bbbbbbb2222222", images: [{ image: "/api/ai/image/x.png" }] },
          { role: "ai", text: "login diubah" },
          { role: "user", text: "ketiga", checkpoint: "ccccccc3333333" },
          { role: "ai", text: "selesai" },
        ],
      });
      const rt = chat.runtime("r1");
      const fakeAgent = { id: "live" };
      rt.agent = fakeAgent;
      const notes = [];
      chat.onNotify = (ev) => notes.push(ev);

      // Sedang bekerja: ditolak sebelum apa pun disentuh.
      rt.busy = true;
      assert.throws(() => chat.assertCanRewind("r1", "bbbbbbb"), (e) => e.status === 409);
      rt.busy = false;
      assert.throws(() => chat.assertCanRewind("r1", "deadbeef"), (e) => e.status === 404);
      assert.throws(() => chat.assertCanRewind("r1", "zz"), (e) => e.status === 404, "invalid hash");

      const r = await chat.rewind("r1", "bbbbbbb"); // hash pendek cocok dengan checkpoint penuh
      assert.deepStrictEqual(r, { removed: 4, text: "kedua: ubah login", hadImages: true });
      const meta = chat.store.sessions.find((m) => m.id === "r1");
      assert.deepStrictEqual(meta.messages.map((m) => m.text), ["pertama", "jawaban pertama"], "the message and everything below it are gone");
      assert.ok(!meta.agentId && !meta.claudeHistory && !meta.grokHistory, "agent memory is discarded");
      assert.strictEqual(meta.usage.contextTokens, undefined);
      assert.strictEqual(meta.usage.totalTokens, 10, "spend history is kept");
      assert.strictEqual(rt.agent, null);
      assert.deepStrictEqual(disposed, [fakeAgent]);
      assert.deepStrictEqual(deleted, ["cursor-agent-1"]);
      const prelude = chat.preludes.r1;
      assert.ok(/rewound the chat/.test(prelude) && /pertama/.test(prelude) && !/kedua|login diubah|ketiga/.test(prelude), "next agent starts from the remaining transcript only");
      assert.ok(notes.some((n) => n.event === "sessions-changed" && n.rewound && n.sessionId === "r1"), "other browsers are told to reload");

      // Mundur ke pesan pertama: percakapan kosong, tanpa prelude.
      const r0 = await chat.rewind("r1", "aaaaaaa1111111");
      assert.strictEqual(r0.removed, 2);
      assert.strictEqual(chat.store.sessions.find((m) => m.id === "r1").messages.length, 0);
      assert.strictEqual(chat.preludes.r1, undefined);
    } finally { await cleanup(); }
  }

  // ---- Rewind dengan hash checkpoint ganda (kasus nyata: "halo" lalu "buat skrip" tanpa file berubah) ----
  {
    const { chat, cleanup } = makeChat();
    try {
      chat.dispose = async () => {};
      const H = "2588cb3060aa38c106a9cb850a238c6b12e4c05d";
      const fresh = () => {
        chat.store.sessions = chat.store.sessions.filter((m) => m.id !== "dup");
        chat.store.sessions.push({ id: "dup", title: "halo", updatedAt: 1, messages: [
          { role: "user", text: "halo", checkpoint: H }, { role: "ai", text: "Halo!" },
          { role: "user", text: "buatakan python cek proxy", checkpoint: H }, { role: "ai", text: "Sudah dibuat." },
        ] });
      };
      fresh();
      // Tanpa petunjuk: kecocokan TERAKHIR, bukan pertama — tidak menghapus seluruh chat.
      assert.strictEqual(chat.rewindIndex("dup", H), 2);
      // Dengan urutan + teks pesan yang ditekan: tepat sasaran untuk kedua pesan.
      assert.strictEqual(chat.rewindIndex("dup", H, { ordinal: 1, text: "buatakan python cek proxy" }), 2);
      assert.strictEqual(chat.rewindIndex("dup", H, { ordinal: 0, text: "halo" }), 0);
      // Urutan tidak cocok dengan teks (UI dan server berbeda): jatuh ke pencocokan teks.
      assert.strictEqual(chat.rewindIndex("dup", H, { ordinal: 0, text: "buatakan python cek proxy" }), 2);
      const r = await chat.rewind("dup", H, { ordinal: 1, text: "buatakan python cek proxy" });
      assert.strictEqual(r.removed, 2);
      assert.deepStrictEqual(chat.store.sessions.find((m) => m.id === "dup").messages.map((m) => m.text), ["halo", "Halo!"], "the first exchange survives");
    } finally { await cleanup(); }
  }

  // ---- Anthropic: "text content blocks must be non-empty" diperbaiki otomatis ----
  {
    const broken = [
      { role: "user", content: [{ type: "text", text: "buat skrip" }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "  " }, { type: "text", text: "lanjut" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "" }] }] },
      { role: "assistant", content: "" },
    ];
    const fixed = AnthropicAgent.repairEmptyBlocks(broken);
    assert.ok(fixed.changed >= 4);
    const allText = [];
    const walk = (c) => (Array.isArray(c) ? c : [c]).forEach((b) => { if (typeof b === "string") allText.push(b); else if (b && b.type === "text") allText.push(b.text); else if (b && b.type === "tool_result") walk(b.content); });
    fixed.messages.forEach((m) => walk(m.content));
    assert.ok(allText.every((t) => String(t).trim()), "no empty or whitespace-only text remains");
    assert.strictEqual(fixed.messages[3].content[0].type, "tool_use", "tool_use is untouched");
    assert.strictEqual(fixed.messages.length, broken.length, "turn order is preserved");
    assert.ok(AnthropicAgent.sanitizeHistory(broken).every((m) => (Array.isArray(m.content) ? m.content : [m.content]).length));

    // Run yang menemui 400 tersebut memperbaiki riwayat lalu mengirim ulang sendiri.
    const ag = new AnthropicAgent({ apiKey: "k", model: "claude-test", workspace: os.tmpdir() });
    ag.messages = [{ role: "user", content: [{ type: "text", text: "hai" }] }, { role: "assistant", content: [{ type: "text", text: "" }] }, { role: "user", content: [{ type: "text", text: "lanjut" }] }];
    const origFetch = global.fetch;
    const sent = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.messages);
      if (sent.length === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "messages: text content blocks must be non-empty" } }) };
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "stop here" } }) };
    };
    try {
      await assert.rejects(ag._callModel({ cancelled: false, ac: new AbortController(), push() {} }, [], "sys"), /401/);
    } finally { global.fetch = origFetch; }
    assert.strictEqual(sent.length, 2, "retried once after repairing");
    assert.ok(sent[1][1].content[0].text.trim(), "the retry carried no empty text block");
  }

  // ---- Balasan Anthropic kosong: retry sekali, lalu catatan yang terlihat (bukan gelembung mati) ----
  {
    const sse = (events) => {
      const body = events.map((e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n").join("");
      const bytes = new TextEncoder().encode(body);
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: () => (sent ? Promise.resolve({ done: true }) : (sent = true, Promise.resolve({ value: bytes, done: false }))) }) } };
    };
    const emptyTurn = () => sse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]);
    const textTurn = (t) => sse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
    const drive = async (planFn) => {
      const ag = await AnthropicAgent.create({ apiKey: "k", model: "claude-test", workspace: os.tmpdir(), customTools: {} });
      let calls = 0; const origFetch = global.fetch;
      global.fetch = async () => planFn(++calls);
      try {
        const run = await ag.send("halo");
        const ev = []; for await (const e of run.stream()) ev.push(e);
        await run.wait();
        const text = ev.filter((e) => e.type === "assistant" && typeof e.text === "string").map((e) => e.text).join("");
        return { calls, text };
      } finally { global.fetch = origFetch; }
    };
    const dead = await drive(() => emptyTurn());
    assert.strictEqual(dead.calls, 2, "an empty turn is retried exactly once");
    assert.ok(dead.text.trim() && /kosong/i.test(dead.text), "a persistently empty turn surfaces a visible note, not silence: " + JSON.stringify(dead.text));
    const healed = await drive((n) => (n === 1 ? emptyTurn() : textTurn("Halo!")));
    assert.strictEqual(healed.calls, 2, "retry happens");
    assert.strictEqual(healed.text, "Halo!", "an empty turn that recovers on retry shows the real reply");
    const normal = await drive(() => textTurn("Langsung jawab"));
    assert.strictEqual(normal.calls, 1, "a normal turn is not retried");
    assert.strictEqual(normal.text, "Langsung jawab");
  }

  // ---- Percakapan vs tugas + mode Chat -----------------------------------------------
  {
    const { chat, cleanup } = makeChat();
    try {
      // Heuristik: obrolan/diskusi tidak masuk mesin tugas; perintah, path, dan kosakata kode masuk.
      assert.strictEqual(chat.intentOf("halo, lagi sibuk?"), "chat");
      assert.strictEqual(chat.intentOf("menurutmu microservices itu overrated nggak?"), "chat");
      assert.strictEqual(chat.intentOf("what do you think about stoicism as a way to handle stress?"), "chat");
      assert.strictEqual(chat.intentOf("perbaiki login yang gagal"), "task");
      assert.strictEqual(chat.intentOf("kenapa server.js error di baris 10"), "task");
      assert.strictEqual(chat.intentOf("lihat src/app/page.tsx"), "task");
      assert.strictEqual(chat.intentOf("lanjutkan"), "task");
      assert.strictEqual(chat.intentOf("apa kabar", { skills: ["review"] }), "task", "attached skill means work");
      assert.strictEqual(chat.intentOf("apa kabar", { intent: "task" }), "task", "explicit override wins");

      // Mode memaksa: Chat selalu percakapan, Plan selalu tugas.
      await chat.setConfig({ mode: "chat" });
      assert.strictEqual(chat.intentOf("perbaiki login yang gagal"), "chat");
      chat.customTools = () => ({ memory_upsert: {}, memory_search: {}, ast_edit: {}, desktop_click: {}, browser_navigate: {} });
      const names = Object.keys(chat.customToolSet()).join(" ");
      assert.ok(/memory_upsert/.test(names), "chat mode can remember facts about the user");
      assert.ok(!/ast_edit/.test(names) && !/desktop_/.test(names), "chat mode never edits code or drives the desktop");
      const ladder = ProviderFactory.disallowedCandidates("chat", Object.assign({}, AiChat.CHAT_RESTRICTIONS));
      assert.ok(ladder[0].includes("edit") && ladder[0].includes("shell") && !ladder[0].includes("generateImage"), "chat: no edit/shell builtins, images allowed");
      const kept = ProviderFactory.filterCustomTools({ browser_navigate: {}, ast_edit: {}, desktop_click: {} }, AiChat.CHAT_RESTRICTIONS);
      assert.deepStrictEqual(Object.keys(kept), ["browser_navigate"], "chat keeps the browser, drops workspace/desktop mutation");
      await chat.setConfig({ mode: "plan" });
      assert.strictEqual(chat.intentOf("halo"), "task");
      await chat.setConfig({ mode: "agent" });

      // Prompt percakapan: ringan, tanpa playbook engineering, dengan profil pengguna dari memori.
      const MemoryStore = require("../lib/memory-store");
      const store = new MemoryStore({ workspace: chat.workspace, dataDir: path.join(chat.workspace, "ctx") });
      chat.contextEngine = { memoryStore: store, buildContext: async () => "" };
      await store.ready;
      await store.upsert({ kind: "user", scope: "user", statement: "Prefers short answers in Indonesian; is building a VR cloud IDE." });
      const p = await chat.agentPrompt("menurutmu apa yang bikin produk itu terasa 'hidup'?", "", { intent: "chat" });
      assert.ok(p.includes("[Conversation]"), "conversation guidance is sent");
      assert.ok(!p.includes("[One step at a time]") && !p.includes("[Project snapshot]"), "no task machinery in a conversation");
      assert.ok(/Prefers short answers in Indonesian/.test(p), "facts about the user reach the prompt");
      assert.ok(p.length < 6000, "conversation prompt stays light: " + p.length);
      const t = await chat.agentPrompt("perbaiki login", "", { intent: "task" });
      assert.ok(t.includes("[One step at a time]") && /Prefers short answers in Indonesian/.test(t), "tasks keep the playbook and still know the user");
    } finally { await cleanup(); }
  }

  // ---- Skills & rules benar-benar sampai ke prompt untuk Anthropic/Grok ----------------
  // Hanya SDK Cursor yang membaca `.cursor/`; provider lain butuh indeks skill di prompt,
  // bahkan saat `.cursor` ada. Dulu bug: `.cursor` ada -> skills tak pernah dikirim ke Anthropic.
  {
    const { root, chat, cleanup } = makeChat();
    try {
      const skDir = path.join(root, ".vrcloud-agent", "skills", "deploy");
      fs.mkdirSync(skDir, { recursive: true });
      fs.writeFileSync(path.join(skDir, "SKILL.md"), "---\nname: deploy\ndescription: Deploy this app to production safely\n---\nSteps...\n");
      fs.mkdirSync(path.join(root, ".cursor"), { recursive: true }); // tautan SDK Cursor ada

      chat.provider = "anthropic";
      const anth = chat.projectContextText();
      assert.ok(/\[Available skills\]/.test(anth), "Anthropic gets the skills index even when .cursor exists");
      assert.ok(/deploy: Deploy this app to production safely/.test(anth), "the skill's description is included");
      assert.ok(/read its SKILL\.md/.test(anth) && /follow it before improvising/i.test(anth), "and an instruction to actually use it");

      chat.provider = "cursor";
      assert.strictEqual(chat.projectContextText(), "", "Cursor with .cursor present skips prompt injection (its SDK reads .cursor)");

      fs.rmSync(path.join(root, ".cursor"), { recursive: true, force: true });
      assert.ok(/\[Available skills\]/.test(chat.projectContextText()), "Cursor without .cursor falls back to prompt injection");
    } finally { await cleanup(); }
  }

  console.log("agent-guards: ok");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
