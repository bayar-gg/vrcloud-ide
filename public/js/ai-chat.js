/*
 * VRCloud IDE - AI Chat panel (kanan), gaya Cursor.
 * - Toggle di menubar (Alt+A), panel bisa di-resize.
 * - Balasan di-stream dan dirender sebagai Markdown (code block + Copy,
 *   syntax highlight via Ace yang sudah dimuat editor).
 * - Indikator "berpikir", tombol Stop (hanya Stop yang membatalkan run),
 *   riwayat di server (dibagi semua browser), setelan API (key/model) di web.
 * Backend: /api/ai/* (Cursor SDK). Self-contained, tidak menyentuh app.js.
 */
(function () {
  "use strict";

  var WIDTH_KEY = "vrcloud_ai_width";
  var OPEN_KEY = "vrcloud_ai_open";
  // Di bawah lebar ini panel dianggap "sempit": tombol Mode/Browser/Skills jadi ikon saja,
  // parameter model & hint disembunyikan agar bar composer tidak berdesakan/terpotong.
  var NARROW_W = 600;
  var CONVS_KEY = "vrcloud_ai_convs";   // cache lokal (migrasi)
  var ACTIVE_KEY = "vrcloud_ai_active"; // id percakapan yang sedang dilihat tab ini
  var HIST_PREFIX = "vrcloud_ai_hist:";
  var HIST_MAX = 120;
  var convsCache = [];

  // Teks DOM diterjemahkan otomatis oleh i18n.js; T() untuk properti yang diubah
  // setelah elemen terpasang (placeholder/title) dan pesan bukan-DOM.
  function T(s) { return window.I18N ? window.I18N.t(s) : s; }
  var alert = function (m) { window.alert(T(m)); };
  var confirm = function (m) { return window.confirm(T(m)); };
  function newId() { return "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  function getConvs() { return convsCache; }
  function setConvs(list) { convsCache = list || []; }
  function localConvs() { try { return JSON.parse(localStorage.getItem(CONVS_KEY) || "[]") || []; } catch (e) { return []; } }
  function localHist(id) { try { return JSON.parse(localStorage.getItem(HIST_PREFIX + id) || "[]") || []; } catch (e) { return []; } }

  function titleFrom(text) {
    var t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "Chat baru";
    return t.length > 42 ? t.slice(0, 42) + "\u2026" : t;
  }

  function relTime(ts) {
    var s = Math.floor((Date.now() - (ts || 0)) / 1000);
    if (s < 60) return "baru saja";
    var m = Math.floor(s / 60); if (m < 60) return m + "m lalu";
    var h = Math.floor(m / 60); if (h < 24) return h + "j lalu";
    var d = Math.floor(h / 24); if (d < 7) return d + "h lalu";
    try { return new Date(ts).toLocaleDateString(); } catch (e) { return ""; }
  }

  function migrateOldLocal(convs) {
    var old = localStorage.getItem("vrcloud_ai_session");
    if (old && localStorage.getItem(HIST_PREFIX + old) && !convs.some(function (c) { return c.id === old; })) {
      var msgs = []; try { msgs = JSON.parse(localStorage.getItem(HIST_PREFIX + old) || "[]"); } catch (e) {}
      var first = null; msgs.forEach(function (m) { if (!first && m.role === "user") first = m; });
      convs.unshift({ id: old, title: first ? titleFrom(first.text) : "Chat", updatedAt: Date.now() });
    }
    if (old) localStorage.removeItem("vrcloud_ai_session");
    return convs;
  }

  function sessionId() { return localStorage.getItem(ACTIVE_KEY) || (convsCache[0] && convsCache[0].id) || ""; }

  function touchConv(id, title) {
    var convs = getConvs(), found = null;
    convs.forEach(function (c) { if (c.id === id) found = c; });
    if (!found) found = { id: id, title: title || "Chat baru", updatedAt: Date.now(), busy: false };
    if (title) found.title = title;
    found.updatedAt = Date.now();
    convs = convs.filter(function (c) { return c.id !== id; });
    convs.unshift(found);
    setConvs(convs);
  }

  function apiJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ("HTTP " + r.status)); e.busy = !!(j && j.busy); e.status = r.status; throw e; }
        return j;
      }, function () { throw new Error("HTTP " + r.status); });
    });
  }

  function fetchSessions() {
    return apiJson("/api/ai/sessions", { credentials: "same-origin" })
      .then(function (d) { return d.sessions || []; });
  }

  function fetchSession(id) {
    return apiJson("/api/ai/session?id=" + encodeURIComponent(id), { credentials: "same-origin" });
  }

  function migrateLocalToServer(serverList) {
    if (serverList && serverList.length) return Promise.resolve(serverList);
    if (localStorage.getItem("vrcloud_ai_migrated") === "1") return Promise.resolve(serverList || []);
    var local = migrateOldLocal(localConvs());
    if (!local.length) return Promise.resolve([]);
    var payload = local.map(function (c) {
      return { id: c.id, title: c.title, updatedAt: c.updatedAt, messages: localHist(c.id) };
    });
    return apiJson("/api/ai/sessions/import", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: payload }),
    }).then(function (d) {
      try { localStorage.setItem("vrcloud_ai_migrated", "1"); } catch (e) {}
      return d.sessions || [];
    });
  }

  function pickActive(list) {
    var id = localStorage.getItem(ACTIVE_KEY);
    if (!id || !list.some(function (c) { return c.id === id; })) id = list.length ? list[0].id : "";
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    return id;
  }

  function ensureServerActive() {
    return fetchSessions().then(migrateLocalToServer).then(function (list) {
      convsCache = list || [];
      var id = pickActive(convsCache);
      if (id) return id;
      return apiJson("/api/ai/session", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      }).then(function (s) {
        convsCache = [{ id: s.id, title: s.title, updatedAt: s.updatedAt, busy: false }];
        localStorage.setItem(ACTIVE_KEY, s.id);
        return s.id;
      });
    });
  }

  function openSession(id, opts) {
    opts = opts || {};
    if (!id) { history = []; renderConversation(); return Promise.resolve(); }
    localStorage.setItem(ACTIVE_KEY, id);
    return fetchSession(id).then(function (d) {
      history = (d && d.messages) || [];
      sessionUsage = (d && d.usage) || null; renderUsage();
      if (d && typeof d.checkpoints === "boolean") checkpointsOn = d.checkpoints;
      saveHistory();
      renderConversation();
      if (d && d.busy && !opts.skipLive) attachLive(id);
    }).catch(function () { loadHistory(); renderConversation(); });
  }

  // ------------------------------------------------------------------ CSS
  var CSS =
    "#ai-panel{width:380px;flex:none;display:none;flex-direction:column;background:var(--bg2,#16232e);" +
    "border-left:1px solid var(--line,#2b4256);min-width:280px;position:relative;overflow:hidden;font-size:13px}" +
    "#ai-panel.open{display:flex}" +
    "#ai-resize{position:absolute;left:-3px;top:0;width:6px;height:100%;cursor:col-resize;z-index:5}" +
    "#ai-head{display:flex;align-items:center;gap:6px;padding:0 10px;height:36px;flex:none;" +
    "border-bottom:1px solid var(--line,#2b4256)}" +
    "#ai-head .ai-title{font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:6px}" +
    "#ai-head .ai-title .spark{color:var(--accent2,#4da3ff);display:inline-flex;align-items:center}" +
    "#ai-head .ai-spacer{flex:1}" +
    ".ai-ibtn{cursor:pointer;opacity:.7;padding:3px 7px;border-radius:5px;user-select:none;font-size:13px;line-height:1}" +
    ".ai-ibtn:hover{opacity:1;background:var(--bg3,#22384a)}" +
    "#ai-msgs{flex:1;overflow:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth}" +
    /* empty state */
    ".ai-empty{margin:auto;text-align:center;opacity:.6;max-width:260px;line-height:1.6}" +
    ".ai-empty .big{display:flex;justify-content:center;color:var(--accent2,#4da3ff);margin-bottom:6px}" +
    ".ai-empty .tips{font-size:11px;opacity:.8;margin-top:10px}" +
    ".ai-empty kbd{background:var(--bg3,#22384a);border:1px solid var(--line,#2b4256);border-radius:4px;padding:0 5px;font:inherit;font-size:10px}" +
    /* messages — gaya Claude/ChatGPT: pengguna di gelembung kanan, agent lebar penuh tanpa kotak */
    ".ai-msg{line-height:1.6;word-break:break-word;min-width:0;font-size:13.5px}" +
    ".ai-msg.user{display:flex;flex-direction:column;align-items:flex-end}" +
    ".ai-msg.user .card{background:var(--bg3,#22384a);border:1px solid transparent;border-radius:16px 16px 4px 16px;" +
    "padding:9px 13px;white-space:pre-wrap;max-width:88%;box-shadow:0 1px 2px rgba(0,0,0,.25)}" +
    ".ai-msg.ai{padding-right:4px}" +
    ".ai-msg.ai .who{font-size:11px;opacity:.5;margin-bottom:6px;display:flex;align-items:center;gap:6px;letter-spacing:.2px}" +
    ".ai-msg.ai .who .spark{color:var(--accent2,#4da3ff);opacity:1;display:inline-flex;align-items:center}" +
    ".ai-msg.ai .body{color:var(--text,#dfe9f2)}" +
    ".ai-flow{display:flex;flex-direction:column;gap:8px;min-width:0}" +
    ".ai-flow>.body{margin:0}" +
    ".ai-flow>.ai-think,.ai-flow>.ai-plan,.ai-flow>.ai-step{margin:0}" +
    ".ai-wait{padding:2px 0}" +
    /* aksi di bawah jawaban (salin) — muncul saat hover, seperti ChatGPT */
    ".ai-acts{display:flex;gap:2px;margin-top:2px;opacity:0;transition:opacity .15s;height:22px}" +
    ".ai-msg.ai:hover .ai-acts,.ai-acts:focus-within{opacity:1}" +
    ".ai-act{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 7px;border-radius:6px;cursor:pointer;opacity:.7;color:var(--text,#dfe9f2);background:transparent;border:0;font:inherit;font-size:11px}" +
    ".ai-act:hover{opacity:1;background:rgba(255,255,255,.07)}.ai-act.done{color:#7ee2a0;opacity:1}" +
    ".ai-msg.note .card{background:transparent;border:1px dashed var(--line,#2b4256);border-radius:10px;padding:10px 12px;opacity:.9;white-space:pre-wrap}" +
    ".ai-msg.err .body{color:#ffb4bc}" +
    ".ai-link{cursor:pointer;color:var(--accent2,#4da3ff);text-decoration:underline}" +
    /* thinking dots */
    ".ai-thinking{display:inline-flex;gap:4px;align-items:center;height:18px;opacity:.7}" +
    ".ai-thinking i{width:6px;height:6px;border-radius:50%;background:currentColor;animation:aiPulse 1.2s infinite ease-in-out}" +
    ".ai-thinking i:nth-child(2){animation-delay:.2s}.ai-thinking i:nth-child(3){animation-delay:.4s}" +
    "@keyframes aiPulse{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}" +
    ".ai-cursor{display:inline-block;width:7px;height:14px;background:var(--accent2,#4da3ff);vertical-align:-2px;margin-left:2px;animation:aiBlink 1s steps(1) infinite}" +
    "@keyframes aiBlink{50%{opacity:0}}" +
    /* thinking / reasoning — gaya Claude: label berkilau saat berjalan, teks reasoning mengalir sebagai prosa redup, lalu \"Berpikir selama Ns\" */
    ".ai-think{margin:0}" +
    ".ai-think-head{display:inline-flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;font-size:12px;opacity:.7;user-select:none;border-radius:6px}" +
    ".ai-think-head:hover{opacity:1}" +
    ".ai-think .chev{display:inline-block;transition:transform .15s;font-size:10px;opacity:.7}" +
    ".ai-think[data-open='0'] .chev{transform:rotate(-90deg)}" +
    ".ai-think[data-open='0'] .ai-think-body{display:none}" +
    ".ai-think.live .lbl{background:linear-gradient(90deg,var(--text-dim,#7f929e) 0%,#fff 50%,var(--text-dim,#7f929e) 100%);background-size:200% 100%;" +
    "-webkit-background-clip:text;background-clip:text;color:transparent;animation:aiShimmer 1.6s linear infinite}" +
    ".ai-think.live .chev{color:var(--accent2,#4da3ff)}" +
    "@keyframes aiShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}" +
    "@keyframes aiThinkPulse{0%,100%{opacity:.55}50%{opacity:1}}" +
    ".ai-think-body{margin:4px 0 2px 5px;padding:2px 0 2px 12px;border-left:2px solid var(--line,#2b4256);" +
    "font-size:12.5px;line-height:1.6;color:var(--text-dim,#9fb0bd);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}" +
    ".ai-think.live .ai-think-body{max-height:200px}" +
    /* rencana kerja (todo agent) */
    ".ai-plan{margin:0 0 8px;border:1px solid var(--line,#2b4256);border-radius:8px;background:rgba(0,0,0,.14);overflow:hidden}" +
    ".ai-plan-hd{display:flex;align-items:center;gap:6px;padding:5px 9px;font-size:11px;opacity:.75;cursor:pointer;user-select:none}" +
    ".ai-plan-hd:hover{opacity:1}" +
    ".ai-plan-hd .chev{display:inline-block;transition:transform .15s;font-size:10px}" +
    ".ai-plan[data-open='0'] .chev{transform:rotate(-90deg)}" +
    ".ai-plan[data-open='0'] .ai-plan-body{display:none}" +
    ".ai-plan-hd .cnt{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.8}" +
    ".ai-plan-hd .bar{width:60px;height:4px;border-radius:2px;background:var(--bg3,#22384a);overflow:hidden;flex:none}" +
    ".ai-plan-hd .bar i{display:block;height:100%;background:#3fb950;transition:width .3s}" +
    ".ai-plan-body{border-top:1px solid var(--line,#2b4256);padding:4px 0}" +
    ".ai-plan-it{display:flex;align-items:flex-start;gap:7px;padding:3px 10px;font-size:12px;line-height:1.45}" +
    ".ai-plan-it .ic{flex:none;width:14px;text-align:center;opacity:.7}" +
    ".ai-plan-it.completed{opacity:.6}.ai-plan-it.completed .tx{text-decoration:line-through}.ai-plan-it.completed .ic{color:#3fb950;opacity:1}" +
    ".ai-plan-it.inProgress .ic{color:var(--accent2,#4da3ff);opacity:1;animation:aiThinkPulse 1s ease-in-out infinite}" +
    ".ai-plan-it.cancelled{opacity:.45}.ai-plan-it.cancelled .tx{text-decoration:line-through}" +
    ".ai-iter{font-size:10px;opacity:.5;margin:6px 0 2px;letter-spacing:.3px}" +
    /* persetujuan perintah berisiko */
    ".ai-approve{border:1px solid #7d5a2e;border-radius:8px;background:rgba(255,170,60,.08);overflow:hidden}" +
    ".ai-approve-hd{display:flex;align-items:center;gap:7px;padding:6px 10px;font-size:12px;color:#ffcf8a}" +
    ".ai-approve pre{margin:0;padding:8px 10px;background:#0b1017;font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;border-top:1px solid #7d5a2e;border-bottom:1px solid #7d5a2e}" +
    ".ai-approve-ft{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:11px}" +
    ".ai-approve-ft .why{opacity:.6;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ai-approve button{border:0;border-radius:6px;padding:5px 11px;cursor:pointer;font:inherit;font-size:12px}" +
    ".ai-approve .ok{background:#2e7d46;color:#fff}.ai-approve .no{background:#5a1f27;color:#ffd7db}" +
    ".ai-approve.done .ai-approve-ft button{display:none}" +
    ".ai-approve.allowed{border-color:#2e7d46}.ai-approve.allowed .ai-approve-hd{color:#8ff0ab}" +
    ".ai-approve.denied,.ai-approve.timeout{opacity:.75}" +
    /* kembalikan (checkpoint) */
    ".ai-msg.user{position:relative}" +
    ".ai-msg.user .ai-restore{display:none;position:absolute;right:6px;bottom:-9px;font-size:10px;padding:1px 7px;border-radius:9px;" +
    "background:var(--bg3,#22384a);border:1px solid var(--line,#2b4256);cursor:pointer;opacity:.85;z-index:2}" +
    ".ai-msg.user:hover .ai-restore{display:inline-block}.ai-msg.user .ai-restore:hover{opacity:1;border-color:var(--accent2,#4da3ff)}" +
    ".ai-note-ok{font-size:11px;opacity:.7;padding:2px 0}" +
    /* gambar di pesan */
    ".ai-imgs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}" +
    ".ai-imgs img{max-width:160px;max-height:120px;border-radius:6px;border:1px solid var(--line,#2b4256);cursor:zoom-in}" +
    ".ai-chip img{width:28px;height:20px;object-fit:cover;border-radius:3px}" +
    /* menu lampiran (+) */
    "#ai-plus{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-size:17px;line-height:1;cursor:pointer;opacity:.7;border-radius:6px;user-select:none;flex:none}" +
    "#ai-plus:hover{opacity:1;background:rgba(255,255,255,.08)}" +
    "#ai-plusmenu{position:absolute;left:10px;bottom:60px;background:var(--bg2,#16232e);border:1px solid var(--line,#2b4256);border-radius:9px;" +
    "box-shadow:0 12px 30px rgba(0,0,0,.5);z-index:9;display:none;min-width:230px;overflow:hidden}" +
    "#ai-plusmenu.open{display:block}" +
    "#ai-plusmenu .it{display:flex;justify-content:space-between;gap:10px;padding:8px 12px;font-size:12.5px;cursor:pointer}" +
    "#ai-plusmenu .it:hover{background:var(--bg3,#22384a)}#ai-plusmenu .it kbd{font:inherit;font-size:10px;opacity:.5}" +
    /* autocomplete @file */
    "#ai-mention{position:absolute;left:10px;right:10px;bottom:60px;max-height:240px;overflow:auto;background:var(--bg2,#16232e);" +
    "border:1px solid var(--line,#2b4256);border-radius:9px;box-shadow:0 12px 30px rgba(0,0,0,.5);z-index:9;display:none}" +
    "#ai-mention.open{display:block}" +
    ".ai-mi{display:flex;gap:8px;align-items:center;padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden}" +
    ".ai-mi .nm{font-weight:600;display:inline-flex;align-items:center}.ai-mi .nm .ai-ico{color:var(--accent2,#4da3ff)}" +
    ".ai-mi .dir{opacity:.5;overflow:hidden;text-overflow:ellipsis;font-size:11px}" +
    ".ai-mi.sel,.ai-mi:hover{background:var(--bg3,#22384a)}" +
    /* antrean pesan */
    /* indikator terminal latar belakang (klik untuk buka tab Agent shell) */
    "#ai-bgterms{margin-bottom:6px;border:1px solid var(--line,#2b4256);border-radius:8px;background:var(--bg2,#16232e);overflow:hidden;font-size:12px}" +
    "#ai-bgterms .bgt-head{display:flex;align-items:center;gap:7px;padding:6px 9px;cursor:pointer;user-select:none}" +
    "#ai-bgterms .bgt-head:hover{background:rgba(255,255,255,.04)}" +
    "#ai-bgterms .bgt-head .ai-ico{color:var(--accent2,#4da3ff);flex:none}" +
    "#ai-bgterms .bgt-cvt{flex:none;opacity:.5;font-size:12px;transition:transform .15s}" +
    "#ai-bgterms.open .bgt-cvt{transform:rotate(90deg)}" +
    "#ai-bgterms .bgt-n{font-weight:600}" +
    "#ai-bgterms .grow{flex:1 1 0;min-width:0}" +
    "#ai-bgterms .bgt-open{flex:none;font-size:10.5px;padding:1px 8px;border-radius:999px;border:1px solid var(--editor-line,rgba(255,255,255,.12));opacity:.8}" +
    "#ai-bgterms .bgt-open:hover{opacity:1;background:rgba(255,255,255,.08)}" +
    "#ai-bgterms .bgt-stop{flex:none;font-size:10.5px;padding:1px 8px;border-radius:999px;border:1px solid rgba(255,107,116,.45);color:#ff8b93;cursor:pointer;opacity:.9}" +
    "#ai-bgterms .bgt-stop:hover{opacity:1;background:rgba(255,107,116,.12)}" +
    "#ai-bgterms.active .bgt-head .ai-ico{animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    "#ai-bgterms .bgt-body{display:none;border-top:1px solid var(--line,#2b4256);max-height:130px;overflow:auto}" +
    "#ai-bgterms.open .bgt-body{display:block}" +
    "#ai-bgterms .bgt-row{display:flex;align-items:center;gap:7px;padding:5px 9px 5px 22px;cursor:pointer}" +
    "#ai-bgterms .bgt-row:hover{background:rgba(255,255,255,.05)}" +
    "#ai-bgterms .bgt-row .ai-ico{opacity:.6;flex:none}" +
    "#ai-bgterms .bgt-cmd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px}" +
    "#ai-bgterms .bgt-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#3fb950;box-shadow:0 0 6px #3fb950;animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    "#ai-queue{display:none;flex-direction:column;gap:4px;margin-bottom:6px}" +
    ".ai-qi{display:flex;align-items:center;gap:8px;font-size:11px;padding:4px 8px;border:1px dashed var(--line,#2b4256);border-radius:7px;opacity:.85}" +
    ".ai-qi .qt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ai-qi .qx{cursor:pointer;opacity:.6}.ai-qi .qx:hover{opacity:1}" +
    /* badge notifikasi di tombol menubar */
    "#menubar .mb-ai.pulse{animation:aiThinkPulse 1.2s ease-in-out 3}" +
    /* pemakaian token di header */
    /* riwayat: cari, ubah nama, ekspor */
    ".ai-hist-search{margin:6px 8px 2px;display:flex}" +
    ".ai-hist-search input{flex:1;background:var(--code-bg,#0f1923);color:var(--text,#dfe9f2);border:1px solid var(--line,#34506690);border-radius:6px;padding:5px 8px;font:inherit;font-size:12px;outline:none}" +
    ".ai-hist-act{opacity:0;padding:2px 6px;border-radius:5px;font-size:12px;flex:none;cursor:pointer}" +
    ".ai-hist-row:hover .ai-hist-act{opacity:.6}.ai-hist-act:hover{opacity:1!important;background:var(--bg3,#22384a)}" +
    ".ai-hist-usage{font-size:10px;opacity:.45;margin-left:6px}" +
    /* setelan tambahan */
    ".ai-cfg-sec{border-top:1px solid var(--line,#2b4256);padding-top:10px;margin-top:4px}" +
    ".ai-chk{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.85;cursor:pointer}" +
    /* tool steps (aksi agent) */
    ".ai-step .tool-tag{font-size:10px;opacity:.6;margin-left:5px}" +
    ".ai-step.err .tool-tag{color:#ff6b74;opacity:1}" +
    /* shell latar belakang (server dev, watcher): kartu bergaris kiri kuning + tag berjalan */
    ".ai-step.bg{border-left:2px solid #e4bd64}.ai-step .tool-tag.bg{color:#e4bd64;opacity:1;border:1px solid rgba(228,189,100,.45);border-radius:8px;padding:0 6px}" +
    ".ai-step.bg.running .tool-tag.bg{animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    ".ai-step-run.ashell{font-size:11px}" +
    ".ai-step{font-size:12px;background:rgba(255,255,255,.03);border:1px solid var(--line,#2b4256);border-radius:8px;overflow:hidden}" +
    ".ai-step-hd{display:flex;align-items:flex-start;gap:7px;padding:5px 9px}" +
    ".ai-step[data-has='1'] .ai-step-hd{cursor:pointer}" +
    ".ai-step[data-has='1'] .ai-step-hd:hover{background:rgba(255,255,255,.04)}" +
    ".ai-step-ic{flex:none;margin-top:1px;font-size:11px}" +
    ".ai-step.running .ai-step-ic{color:var(--accent2,#4da3ff);animation:aiThinkPulse 1s ease-in-out infinite}" +
    ".ai-step.done .ai-step-ic{color:#3fb950}" +
    ".ai-step.err .ai-step-ic{color:#ff6b74}" +
    ".ai-step-txt{word-break:break-word;min-width:0;flex:1}" +
    ".ai-step .verb{opacity:.85;margin-right:5px}" +
    ".ai-step-txt code{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;background:transparent;padding:0}" +
    ".ai-step-cvt{flex:none;margin-left:6px;opacity:.45;font-size:11px;transition:transform .15s}" +
    ".ai-step[data-has='1']:not(.open) .ai-step-cvt{transform:none}" +
    ".ai-step.open .ai-step-cvt{transform:rotate(90deg)}" +
    ".ai-step:not([data-has='1']) .ai-step-cvt{display:none}" +
    ".ai-step .fname{font-weight:600;margin-right:6px;cursor:pointer}.ai-step .fname:hover{text-decoration:underline;color:var(--accent2,#4da3ff)}" +
    ".ai-step .badge{font-size:10px;margin-right:4px;padding:0 6px;border-radius:10px;border:1px solid var(--line,#2b4256)}" +
    ".ai-step .badge.add{color:#3fb950;border-color:#2e7d46}" +
    ".ai-step .badge.del{color:#ff6b74;border-color:#7d2e34}" +
    ".ai-step-detail{display:none;border-top:1px solid var(--line,#2b4256);margin:0;background:var(--code-bg,#0f1923)}" +
    ".ai-step.open .ai-step-detail{display:block}" +
    /* kartu browser (gaya ChatGPT): bilah alamat + screenshot */
    ".ai-step.browser .ai-step-txt .ai-ico{color:var(--accent2,#4da3ff);margin-right:2px}" +
    ".ai-browser{background:#0b0f14;border-bottom:1px solid var(--line,#2b4256)}" +
    ".ai-browser .ab{display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg3,#22384a);font-size:10.5px;min-width:0}" +
    ".ai-browser .ab .ai-ico{margin:0;opacity:.6;flex:none}" +
    ".ai-browser .ab .url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,'Cascadia Mono',Menlo,monospace;opacity:.9}" +
    ".ai-browser .ab .ttl{flex:0 1 40%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;text-align:right}" +
    ".ai-browser .ab .tab{flex:none;font-size:9.5px;opacity:.6;border:1px solid var(--line,#2b4256);border-radius:8px;padding:0 5px}" +
    ".ai-browser img{display:block;width:100%;height:auto;max-height:420px;object-fit:cover;object-position:top;cursor:zoom-in;background:#fff}" +
    ".ai-browser + pre{max-height:260px}" +
    ".ai-browser-wall,.ai-browse-wall{padding:6px 10px;background:rgba(245,158,11,.14);border-bottom:1px solid rgba(245,158,11,.4);font-size:11px;color:#f5c26b}" +
    ".ai-browser-wall .ai-link,.ai-browse-wall .ai-link{margin-left:4px}" +
    ".ai-step .tool-tag.warn{color:#f5c26b;opacity:1;border:1px solid rgba(245,158,11,.45);border-radius:8px;padding:0 6px}" +
    /* kartu gabungan "Menjelajah web": bingkai besar + daftar langkah bernomor dengan thumbnail */
    ".ai-browse{margin:6px 0;border:1px solid var(--line,#2b4256);border-radius:8px;overflow:hidden;background:var(--bg2,#182634);font-size:12px}" +
    ".ai-browse-hd{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;user-select:none;min-width:0}" +
    ".ai-browse-hd .ai-ico{color:var(--accent2,#4da3ff);flex:none}" +
    ".ai-browse-hd .lbl{font-weight:600}" +
    ".ai-browse.running .ai-browse-hd .lbl{animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    ".ai-browse-hd .cnt{opacity:.6;font-size:11px}" +
    ".ai-browse-hd .sites{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;font-size:11px}" +
    ".ai-browse-hd .ai-step-cvt{margin-left:auto}" +
    ".ai-browse-pw{flex:none;font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--line,#2b4256);opacity:.75;cursor:pointer;color:var(--accent2,#4da3ff)}" +
    ".ai-browse-pw:hover{opacity:1;background:rgba(77,163,255,.14)}.ai-browse-pw.busy{opacity:.4;pointer-events:none}" +
    ".ai-browse.open .ai-browse-hd .ai-step-cvt{transform:rotate(90deg)}" +
    ".ai-browse-body{display:none;border-top:1px solid var(--line,#2b4256)}" +
    ".ai-browse.open .ai-browse-body{display:block}" +
    ".ai-browse-main{background:#0b0f14}" +
    ".ai-browse-main .ab{display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg3,#22384a);font-size:10.5px;min-width:0}" +
    ".ai-browse-main .ab .ai-ico{margin:0;opacity:.6;flex:none}" +
    ".ai-browse-main .ab .url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,'Cascadia Mono',Menlo,monospace;opacity:.9}" +
    ".ai-browse-main .ab .ttl{flex:0 1 40%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;text-align:right}" +
    ".ai-browse-main img{display:block;width:100%;height:auto;max-height:380px;object-fit:cover;object-position:top;cursor:zoom-in;background:#fff}" +
    ".ai-browse-noshot{padding:14px;text-align:center;font-size:11px;opacity:.5}" +
    ".ai-browse-steps{list-style:none;margin:0;padding:4px 0;max-height:220px;overflow:auto;counter-reset:bstep}" +
    ".ai-browse-step{display:flex;align-items:center;gap:8px;padding:4px 10px;cursor:pointer;min-width:0;counter-increment:bstep}" +
    ".ai-browse-step:hover{background:rgba(255,255,255,.04)}" +
    ".ai-browse-step.sel{background:rgba(77,163,255,.12)}" +
    ".ai-browse-step::before{content:counter(bstep);flex:none;width:18px;font-size:10px;opacity:.45;text-align:right}" +
    ".ai-browse-step .ic{flex:none;width:12px;font-size:11px}" +
    ".ai-browse-step.done .ic{color:#3fb950}.ai-browse-step.error .ic{color:#ff6b74}.ai-browse-step.running .ic{color:var(--accent2,#4da3ff);animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    ".ai-browse-step .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}" +
    ".ai-browse-step .th{flex:none;width:44px;height:28px;object-fit:cover;object-position:top;border-radius:3px;border:1px solid var(--line,#2b4256);background:#fff}" +
    ".ai-browse-detail{display:none;margin:0;padding:8px 10px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;border-top:1px solid var(--line,#2b4256);background:var(--code-bg,#0f1923);" +
    "font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;line-height:1.5}" +
    ".ai-browse-src{display:none}" +
    ".ai-step-detail pre{margin:0;padding:8px 10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;" +
    "font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;line-height:1.5}" +
    /* diff view */
    ".ai-diff{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;line-height:1.55;padding:6px 0;max-height:340px;overflow:auto}" +
    ".ai-diff .l{padding:0 10px;white-space:pre-wrap;word-break:break-word}" +
    ".ai-diff .add{background:rgba(63,185,80,.14);color:#8ff0ab}" +
    ".ai-diff .del{background:rgba(248,81,73,.14);color:#ffb3ba}" +
    ".ai-diff .hunk{color:var(--accent2,#4da3ff)}" +
    ".ai-diff .meta{opacity:.45}" +
    /* terminal view */
    ".ai-term{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;line-height:1.55;padding:8px 10px;" +
    "max-height:340px;overflow:auto;background:#0b1017}" +
    ".ai-term .tl{white-space:pre-wrap;word-break:break-word}" +
    ".ai-term .cmd{color:#8ff0ab}" +
    /* attachments (drop file) */
    "#ai-attach{display:none;flex-wrap:wrap;gap:6px;margin-bottom:6px}" +
    ".ai-chip{display:inline-flex;align-items:center;gap:6px;background:var(--bg3,#22384a);border:1px solid var(--line,#2b4256);" +
    "border-radius:14px;padding:2px 8px;font-size:11px;max-width:100%}" +
    ".ai-chip-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}" +
    ".ai-chip-x{cursor:pointer;opacity:.6}.ai-chip-x:hover{opacity:1}" +
    "#ai-panel.ai-dragover{outline:2px dashed var(--accent,#2f6feb);outline-offset:-6px}" +
    "#ai-drop-hint{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,25,35,.6);" +
    "z-index:12;font-size:13px;color:var(--accent2,#4da3ff);pointer-events:none}" +
    "#ai-panel.ai-dragover #ai-drop-hint{display:flex}" +
    /* markdown — tipografi ala Claude/ChatGPT */
    ".ai-md{font-size:13.5px;line-height:1.65}" +
    ".ai-md p{margin:0 0 10px}.ai-md>*:last-child{margin-bottom:0}.ai-md>*:first-child{margin-top:0}" +
    ".ai-md h1,.ai-md h2,.ai-md h3,.ai-md h4{margin:16px 0 8px;line-height:1.3;font-weight:600;color:var(--text,#eef4f8)}" +
    ".ai-md h1{font-size:17px}.ai-md h2{font-size:15.5px}.ai-md h3{font-size:14px}.ai-md h4{font-size:13.5px}" +
    ".ai-md ul,.ai-md ol{margin:4px 0 10px;padding-left:22px}.ai-md li{margin:3px 0}.ai-md li>ul,.ai-md li>ol{margin:3px 0 3px}" +
    ".ai-md li.task{list-style:none;margin-left:-18px}.ai-md li.task input{margin:0 6px 0 0;vertical-align:-1px;pointer-events:none}" +
    ".ai-md blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid var(--line,#3a5570);color:var(--text-dim,#9fb0bd)}" +
    ".ai-md hr{border:0;border-top:1px solid var(--line,#2b4256);margin:14px 0}" +
    ".ai-md a{color:var(--accent2,#4da3ff);text-decoration:none}.ai-md a:hover{text-decoration:underline}" +
    ".ai-md strong{font-weight:600;color:var(--text,#eef4f8)}" +
    ".ai-md code{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:12px;background:rgba(255,255,255,.08);" +
    "padding:1.5px 5px;border-radius:5px;border:1px solid rgba(255,255,255,.06)}" +
    ".ai-tbl{overflow:auto;margin:8px 0 12px;border:1px solid var(--line,#2b4256);border-radius:8px}" +
    ".ai-md table{border-collapse:collapse;font-size:12.5px;min-width:100%}" +
    ".ai-md th,.ai-md td{padding:6px 10px;border-bottom:1px solid var(--line,#2b4256);text-align:left;vertical-align:top}" +
    ".ai-md th{background:rgba(255,255,255,.05);font-weight:600;white-space:nowrap}.ai-md tr:last-child td{border-bottom:0}" +
    ".ai-md td code,.ai-md th code{font-size:11.5px}" +
    /* code block */
    ".ai-code{margin:10px 0 12px;border:1px solid var(--line,#2b4256);border-radius:10px;overflow:hidden;background:var(--code-bg,#0f1923)}" +
    ".ai-code-head{display:flex;align-items:center;justify-content:space-between;padding:5px 8px 5px 12px;" +
    "background:rgba(255,255,255,.04);border-bottom:1px solid var(--line,#2b4256);font-size:11px;opacity:.9}" +
    ".ai-code-head .lang{opacity:.75;letter-spacing:.3px}" +
    ".ai-copy{background:transparent;border:1px solid var(--line,#2b4256);color:var(--text,#dfe9f2);border-radius:5px;" +
    "padding:2px 8px;cursor:pointer;font:inherit;font-size:11px;opacity:.85}" +
    ".ai-copy:hover{opacity:1;background:var(--code-bg,#0f1923)}.ai-copy.done{border-color:#3fb950;color:#7ee2a0}" +
    ".ai-code-body{margin:0;padding:10px 12px;overflow:auto;font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:12px;line-height:1.5}" +
    ".ai-code-body code{background:transparent;padding:0;font-size:inherit;white-space:pre}" +
    ".ai-code-body .ace_static_highlight{font-family:inherit;font-size:inherit;line-height:inherit;background:transparent!important;white-space:pre;overflow:visible}" +
    ".ai-code-body .ace_static_highlight .ace_line{clear:none;white-space:pre}" +
    /* composer */
    /* Composer: latar & garis senada dengan editor (Ambiance #202020). */
    "#ai-composer{flex:none;padding:8px 10px 10px;border-top:1px solid var(--line,#2b4256)}" +
    "#ai-box{border:1px solid var(--editor-line,rgba(255,255,255,.09));border-radius:10px;background:var(--editor-bg,#202020);padding:8px 8px 6px;transition:border-color .12s}" +
    "#ai-box:focus-within{border-color:rgba(255,255,255,.18)}" +
    "#ai-input{width:100%;box-sizing:border-box;resize:none;min-height:38px;max-height:180px;background:transparent;" +
    "color:var(--text,#dfe9f2);border:0;padding:4px 4px 2px;font:inherit;font-size:13px;outline:none;line-height:1.5}" +
    "#ai-input::placeholder{color:var(--text-dim,#7f929e);opacity:.8}" +
    "#ai-input:disabled{opacity:.5}" +
    "#ai-bar{display:flex;align-items:center;gap:6px;margin-top:6px;min-height:28px}" +
    /* Desktop: wrapper is transparent so chips stay in the same row as + / model / mic / send. */
    "#ai-bar-tools{display:contents}" +
    /* chip model + konfigurasi (mode, thinking, effort, context) */
    "#ai-model-chip .seg{opacity:.7;white-space:nowrap}#ai-model-chip .seg.mname{opacity:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:36px}" +
    "#ai-model-chip .sep{opacity:.35;margin:0 3px;flex:none}#ai-model-chip .cw{opacity:.5;margin-left:4px;font-size:10px;flex:none}" +
    "#ai-panel.narrow #ai-model-chip .xtra,#ai-panel.narrow #ai-model-chip .sep.xtra{display:none}" +
    /* panel sempit: model chip menciut & boleh dipotong; tombol Mode/Browser/Skills jadi ikon saja */
    "#ai-panel.narrow #ai-model-chip{flex:0 1 auto;min-width:0}" +
    "#ai-panel.narrow #ai-model-chip .mname{min-width:24px}" +
    "#ai-panel.narrow .ai-optchip .lbl,#ai-panel.narrow .ai-optchip .cw{display:none}" +
    "#ai-panel.narrow .ai-optchip{padding:0 8px;gap:0}" +
    "#ai-panel.narrow #ai-skills-btn .lbl{display:none}#ai-panel.narrow #ai-skills-btn{padding:0 8px}" +
    /* tombol & menu skills */
    "#ai-skills-btn{font-size:11px;opacity:.75;cursor:pointer;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--editor-line,rgba(255,255,255,.1));" +
    "background:rgba(255,255,255,.03);white-space:nowrap;user-select:none;flex:none;display:inline-flex;align-items:center}" +
    "#ai-skills-btn .ai-ico{color:var(--accent2,#4da3ff)}" +
    "#ai-skills-btn:hover{opacity:1;background:rgba(255,255,255,.08)}" +
    /* tombol opsi terpisah: Mode (Agent/Plan/Ask) & Browser tools (Auto/On/Off) */
    ".ai-optchip{font-size:11px;opacity:.75;cursor:pointer;height:24px;padding:0 8px 0 9px;border-radius:999px;border:1px solid var(--editor-line,rgba(255,255,255,.1));" +
    "background:rgba(255,255,255,.03);white-space:nowrap;user-select:none;flex:none;display:inline-flex;align-items:center;gap:4px}" +
    ".ai-optchip .ai-ico{color:var(--accent2,#4da3ff);margin:0}" +
    ".ai-optchip .cw{opacity:.5;font-size:10px;margin-left:1px}" +
    ".ai-optchip:hover{opacity:1;background:rgba(255,255,255,.08)}" +
    ".ai-optchip.off .ai-ico{color:var(--text-dim,#8aa0b3);opacity:.6}.ai-optchip.off .lbl{opacity:.7}" +
    ".ai-optchip.on{border-color:rgba(77,163,255,.45);background:rgba(77,163,255,.10);opacity:1}" +
    "#ai-skillsmenu{position:absolute;left:10px;right:10px;bottom:60px;max-height:60%;overflow:auto;background:var(--bg2,#16232e);border:1px solid var(--line,#2b4256);" +
    "border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.5);z-index:9;display:none}" +
    "#ai-skillsmenu.open{display:block}" +
    ".ai-sk-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;font-size:12px;font-weight:600;border-bottom:1px solid var(--line,#2b4256)}" +
    ".ai-sk-head .ai-link{font-weight:400;font-size:11px}" +
    ".ai-sk-row{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04)}" +
    ".ai-sk-row:hover{background:rgba(255,255,255,.03)}" +
    ".ai-sk-main{flex:1;min-width:0;cursor:pointer}" +
    ".ai-sk-name{font-size:12.5px;font-weight:600}.ai-sk-name .auto{font-weight:400;font-size:10px;opacity:.5;margin-left:6px}" +
    ".ai-sk-desc{font-size:11px;opacity:.6;line-height:1.4;max-height:2.8em;overflow:hidden}" +
    ".ai-sk-act{display:flex;gap:2px;flex:none}" +
    ".ai-sk-act span{cursor:pointer;opacity:.55;padding:2px 6px;border-radius:5px;font-size:12px}.ai-sk-act span:hover{opacity:1;background:var(--bg3,#22384a)}" +
    ".ai-sk-use{background:var(--accent,#2f6feb);color:#fff;border:0;border-radius:6px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer;flex:none}" +
    ".ai-sk-empty{padding:16px 12px;font-size:12px;opacity:.6;line-height:1.5}" +
    ".ai-sk-note{padding:8px 12px;font-size:10.5px;opacity:.5;line-height:1.4}" +
    /* editor skill */
    "#ai-skilledit{position:absolute;left:0;right:0;top:36px;bottom:0;background:var(--bg2,#16232e);display:none;flex-direction:column;gap:8px;padding:12px;overflow:auto;z-index:10}" +
    "#ai-skilledit.open{display:flex}" +
    "#ai-skilledit textarea{min-height:200px;font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:12px}" +
    ".ai-chip.skill{border-color:var(--accent,#2f6feb)}" +
    /* kartu tinjau perubahan */
    ".ai-changes{border:1px solid var(--line,#2b4256);border-radius:8px;background:rgba(0,0,0,.14);overflow:hidden}" +
    ".ai-ch-hd{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;cursor:pointer;user-select:none}" +
    ".ai-ch-hd .lbl{font-weight:600}.ai-ch-hd .st{opacity:.7;font-size:11px}" +
    ".ai-ch-hd .add{color:#3fb950}.ai-ch-hd .del{color:#ff6b74}" +
    ".ai-ch-hd .sp{flex:1}" +
    ".ai-ch-hd .chev{display:inline-block;transition:transform .15s;font-size:10px;opacity:.6}" +
    ".ai-changes[data-open='0'] .ai-ch-hd .chev{transform:rotate(-90deg)}" +
    ".ai-changes[data-open='0'] .ai-ch-body{display:none}" +
    /* setelah Terima/Tolak: kartu diganti satu baris ringkasan hasil (tidak bisa dibuka lagi) */
    ".ai-changes.gone{border:0;background:transparent;border-radius:0}" +
    ".ai-changes.gone .ai-ch-hd,.ai-changes.gone .ai-ch-body{display:none!important}" +
    ".ai-ch-done{display:none;align-items:center;gap:8px;font-size:12px;padding:4px 2px;color:var(--text-dim,#9fb0bd)}" +
    ".ai-changes.gone .ai-ch-done{display:flex}" +
    ".ai-ch-done .ic{font-weight:700}.ai-ch-done.ok .ic{color:#3fb950}.ai-ch-done.rej .ic{color:#ff6b74}.ai-ch-done.mix .ic{color:#d4a72c}" +
    ".ai-ch-done .files{display:flex;flex-wrap:wrap;gap:4px 8px}" +
    ".ai-ch-done .f{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;cursor:pointer;opacity:.85}.ai-ch-done .f:hover{color:var(--accent2,#4da3ff);text-decoration:underline}" +
    ".ai-ch-done .f.rej{text-decoration:line-through;opacity:.55}" +
    ".ai-changes.accepted{opacity:.7}.ai-changes.accepted .ai-ch-hd .lbl::after{content:' \u2713 diterima';font-weight:400;opacity:.7}" +
    ".ai-changes.reviewed{opacity:.75}.ai-changes.reviewed .ai-ch-hd .lbl::after{content:' \u2713 ditinjau';font-weight:400;opacity:.7}" +
    ".ai-changes.pending-review{border-color:rgba(77,163,255,.45)}" +
    ".ai-ch-row.accepted .sc{color:#3fb950}.ai-ch-row.rejected .pth{text-decoration:line-through;opacity:.55}" +
    ".ai-ch-row .okf{color:#3fb950}.ai-ch-row .nof{color:#ff6b74}.ai-ch-row .rev{color:var(--accent2,#4da3ff)}" +
    ".ai-ch-ft .no{background:#7a2e36;color:#fff}.ai-ch-ft button:disabled{opacity:.4;cursor:default}" +
    ".ai-ch-body{border-top:1px solid var(--line,#2b4256)}" +
    ".ai-ch-row{display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer}" +
    ".ai-ch-row:hover{background:rgba(255,255,255,.03)}" +
    ".ai-ch-row .sc{width:14px;text-align:center;font-size:10px;font-weight:700;flex:none}" +
    ".ai-ch-row .sc.A{color:#3fb950}.ai-ch-row .sc.M{color:#d4a72c}.ai-ch-row .sc.D{color:#ff6b74}.ai-ch-row .sc.R{color:var(--accent2,#4da3ff)}" +
    ".ai-ch-row .pth{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11.5px}" +
    ".ai-ch-row .pth:hover{text-decoration:underline;color:var(--accent2,#4da3ff)}" +
    ".ai-ch-row .num{font-size:11px;white-space:nowrap}.ai-ch-row .num .add{color:#3fb950}.ai-ch-row .num .del{color:#ff6b74;margin-left:4px}" +
    ".ai-ch-row .bt{cursor:pointer;opacity:.85;padding:3px 8px;border-radius:5px;font-size:11px;flex:none;border:1px solid var(--line,#2b4256);background:transparent;color:inherit;font:inherit}" +
    ".ai-ch-row .bt:hover{opacity:1;background:var(--bg3,#22384a)}" +
    ".ai-ch-diff{display:none;background:var(--code-bg,#0f1923);border-bottom:1px solid rgba(255,255,255,.04)}.ai-ch-diff.open{display:block}" +
    ".ai-ch-ft{display:flex;gap:8px;padding:7px 10px;justify-content:flex-end;align-items:center;flex-wrap:wrap}" +
    ".ai-ch-ft .msg{flex:1;min-width:0;font-size:11px;opacity:.7}" +
    ".ai-ch-ft button{border:0;border-radius:6px;padding:5px 11px;cursor:pointer;font:inherit;font-size:12px}" +
    ".ai-ch-ft .ok{background:#2e7d46;color:#fff}" +
    /* nama file di kartu tool bisa diklik */
    ".ai-step-run{flex:none;margin-left:4px;opacity:.5;font-size:10px;cursor:pointer;padding:0 5px;border-radius:4px}.ai-step-run:hover{opacity:1;background:rgba(255,255,255,.08)}" +
    ".ai-step-run.preview{opacity:.95;color:var(--accent2,#4da3ff);border:1px solid rgba(77,163,255,.45);border-radius:999px;padding:0 7px;font-size:10.5px}" +
    ".ai-step-run.preview:hover{background:rgba(77,163,255,.15)}" +
    /* grup rentetan tool baca */
    ".ai-stepgroup{border:1px solid var(--line,#2b4256);border-radius:7px;background:var(--bg3,#22384a);overflow:hidden}" +
    ".ai-sg-hd{display:flex;align-items:center;gap:7px;padding:5px 9px;font-size:12px;cursor:pointer;user-select:none}" +
    ".ai-sg-hd .ai-step-ic{color:#3fb950}.ai-sg-hd .cnt{opacity:.75}.ai-sg-hd .names{opacity:.55;font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ai-sg-hd .ai-step-cvt{margin-left:auto;opacity:.45;font-size:11px;transition:transform .15s}" +
    ".ai-stepgroup.open .ai-sg-hd .ai-step-cvt{transform:rotate(90deg)}" +
    ".ai-sg-body{display:none;flex-direction:column;gap:4px;padding:4px;border-top:1px solid var(--line,#2b4256);background:var(--bg2,#16232e)}" +
    ".ai-stepgroup.open .ai-sg-body{display:flex}" +
    /* mic */
    "#ai-mic{width:28px;height:28px;border-radius:50%;border:1px solid var(--editor-line,rgba(255,255,255,.1));background:transparent;color:var(--text,#dfe9f2);" +
    "cursor:pointer;display:inline-flex;align-items:center;justify-content:center;opacity:.6;font:inherit;flex:none}" +
    "#ai-mic:hover{opacity:1;background:rgba(255,255,255,.08)}#ai-mic.on{opacity:1;border-color:#e5533d;color:#e5533d;animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    /* tab Skills/Rules */
    ".ai-sk-tabs{display:flex;gap:2px}.ai-sk-tab{padding:3px 9px;border-radius:6px;cursor:pointer;font-size:11.5px;opacity:.6}" +
    ".ai-sk-tab.on{opacity:1;background:var(--bg3,#22384a)}" +
    ".ai-sk-name .badge{font-weight:400;font-size:10px;opacity:.6;margin-left:6px;padding:0 5px;border:1px solid var(--line,#2b4256);border-radius:8px}" +
    /* statistik diff di riwayat */
    ".ai-hist-stats{font-size:10px;margin-left:6px}.ai-hist-stats .add{color:#3fb950}.ai-hist-stats .del{color:#ff6b74;margin-left:3px}" +
    /* layar sempit: panel overlay di atas workarea, di antara menubar dan bilah navigasi bawah */
    "@media (max-width:768px){#ai-panel.open{position:fixed;top:calc(var(--mb-h,48px) + env(safe-area-inset-top,0px));left:0;right:0;bottom:calc(var(--mob-nav-h,52px) + env(safe-area-inset-bottom,0px));width:100%!important;min-width:0;z-index:70;border-left:0}" +
    "#ai-resize{display:none}#ai-close-btn{display:inline-flex;min-width:44px;min-height:44px;align-items:center;justify-content:center}" +
    "#ai-head{height:48px;padding:0 8px}#ai-head .ai-ibtn{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center}" +
    "#ai-modelpop,#ai-skillsmenu,#ai-mention,#ai-plusmenu{left:6px;right:6px;bottom:168px}#ai-bar .hint{display:none}" +
    "#ai-input{font-size:16px}#ai-plus,#ai-send,#ai-stop,#ai-mic{min-width:44px;min-height:44px}" +
    /* Submenu is appended to <body> (z-index 11). Raise it above the agent overlay + bottom nav. */
    "#ai-submenu{z-index:96;width:min(360px,calc(100vw - 16px))}" +
    "#ai-submenu .ai-sub-item,#ai-plusmenu .it{min-height:44px;padding-top:10px;padding-bottom:10px}}" +
    "@media (max-width:480px){#menubar .mb-ai{display:none!important}}" +
    ".ai-ico{vertical-align:-2px;margin-right:4px;flex:none}" +
    ".ai-chip.skill .ai-chip-nm{display:inline-flex;align-items:center}.ai-chip.skill .ai-ico{color:var(--accent2,#4da3ff)}" +
    ".ai-sktags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}" +
    ".ai-sktag{display:inline-flex;align-items:center;font-size:10.5px;padding:1px 7px 1px 5px;border-radius:9px;" +
    "background:rgba(77,163,255,.14);border:1px solid rgba(77,163,255,.35);color:var(--accent2,#4da3ff);white-space:nowrap}" +
    ".ai-sktag .ai-ico{margin-right:3px}" +
    "#ai-model-chip{font-size:11px;opacity:.9;cursor:pointer;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--editor-line,rgba(255,255,255,.1));" +
    "background:rgba(255,255,255,.03);display:inline-flex;align-items:center;min-width:0;flex:0 1 auto;white-space:nowrap;overflow:hidden}" +
    "#ai-model-chip .cw{flex:none}" +
    "#ai-model-chip:hover{opacity:1;background:rgba(255,255,255,.08)}" +
    "#ai-bar .grow{flex:1 1 0;min-width:0}" +
    "#ai-bar .hint{font-size:10px;opacity:.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 100 auto;min-width:0}" +
    "#ai-panel.narrow #ai-bar .hint{display:none}" +
    ".ai-round{width:28px;height:28px;border-radius:50%;border:0;cursor:pointer;display:inline-flex;align-items:center;" +
    "justify-content:center;font:inherit;font-size:14px;line-height:1;flex:none}" +
    "#ai-send{background:var(--accent,#2f6feb);color:#fff}#ai-send:hover:not(:disabled){filter:brightness(1.12)}#ai-send:disabled{opacity:.35;cursor:default}" +
    "#ai-stop{background:#5a1f27;color:#ffd7db;display:none}#ai-stop.show{display:inline-flex}" +
    /* settings */
    "#ai-settings{position:absolute;left:0;right:0;top:36px;bottom:0;background:var(--bg2,#16232e);" +
    "display:none;flex-direction:column;gap:10px;padding:12px;overflow:auto;z-index:8}" +
    "#ai-settings.open{display:flex}" +
    "#ai-settings .ai-cfg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:-12px;margin:-12px -12px 0;padding:10px 12px;background:var(--bg2,#16232e);z-index:2;border-bottom:1px solid var(--line,#2b4256)}" +
    "#ai-settings .ai-cfg-head .ai-cfg-title{margin:0}" +
    "#ai-settings .ai-cfg-x{cursor:pointer;opacity:.7;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;font-size:14px;user-select:none;flex:none}" +
    "#ai-settings .ai-cfg-x:hover{opacity:1;background:var(--bg3,#22384a)}" +
    ".ai-field{display:flex;flex-direction:column;gap:4px}" +
    ".ai-field label{font-size:11px;opacity:.7}" +
    ".ai-field input,.ai-field textarea,.ai-field select{background:var(--editor-bg,#202020);color:var(--text,#dfe9f2);border:1px solid var(--editor-line,rgba(255,255,255,.09));" +
    "border-radius:6px;padding:7px;font:inherit;font-size:13px;outline:none}" +
    ".ai-field select{cursor:pointer}" +
    ".ai-field input:focus,.ai-field textarea:focus,.ai-field select:focus{border-color:var(--accent,#2f6feb)}" +
    ".ai-field textarea{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11px;min-height:110px;resize:vertical}" +
    ".ai-cfg-status{font-size:12px;opacity:.85;line-height:1.5}" +
    ".ai-cfg-actions{display:flex;gap:8px;margin-top:2px;flex-wrap:wrap}" +
    ".ai-cfg-actions button{border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit;font-size:12px}" +
    ".ai-cfg-actions .save{background:var(--accent,#2f6feb);color:#fff}" +
    ".ai-cfg-actions .ghost{background:var(--bg3,#22384a);color:var(--text,#dfe9f2)}" +
    ".ai-cfg-note{font-size:11px;opacity:.55;line-height:1.4;margin-top:2px}" +
    ".ai-grok-box{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line,#2b4256);border-radius:8px;background:rgba(255,255,255,.02)}" +
    ".ai-grok-code{font:600 22px/1.2 Consolas,'Cascadia Mono',Menlo,monospace;letter-spacing:2px;user-select:all;padding:8px 4px}" +
    ".ai-grok-link{font-size:12px;word-break:break-all;color:var(--accent2,#4da3ff)}" +
    "@media (max-width:768px){.ai-cfg-actions button,.ai-grok-box button{min-height:44px;padding:10px 14px;font-size:14px}.ai-grok-code{font-size:20px}}" +
    /* rahasia browser */
    ".ai-secrets{display:flex;flex-direction:column;gap:4px;margin:4px 0}" +
    ".ai-secret{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--line,#2b4256);border-radius:6px;font-size:12px;min-width:0}" +
    ".ai-secret .ai-ico{opacity:.6;flex:none}.ai-secret code{font-family:Consolas,'Cascadia Mono',Menlo,monospace;font-size:11.5px}" +
    ".ai-secret .dots{flex:1;opacity:.35;letter-spacing:1px;font-size:10px}" +
    ".ai-secret button,.ai-secret-add button{border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;font-size:11.5px}" +
    ".ai-secret button.ghost{background:var(--bg3,#22384a);color:var(--text,#dfe9f2)}.ai-secret button.ghost:hover{background:#7d2e34;color:#fff}" +
    ".ai-secret-add{display:flex;gap:6px;align-items:center}" +
    ".ai-secret-add input{flex:1;min-width:0;background:var(--bg,var(--code-bg,#0f1923));color:var(--text,#dfe9f2);border:1px solid var(--line,#2b4256);border-radius:6px;padding:6px 8px;font:inherit;font-size:12px}" +
    ".ai-secret-add .save{background:var(--accent,#2f6feb);color:#fff}" +
    ".ai-mem-ta{width:100%;min-height:110px;resize:vertical;background:var(--bg,var(--code-bg,#0f1923));color:var(--text,#dfe9f2);border:1px solid var(--line,#2b4256);border-radius:6px;padding:8px;font:12px/1.5 Consolas,'Cascadia Mono',Menlo,monospace;box-sizing:border-box}" +
    /* history dropdown */
    "#ai-history{position:absolute;left:0;right:0;top:36px;max-height:62%;background:var(--bg2,#16232e);" +
    "border-bottom:1px solid var(--line,#2b4256);display:none;flex-direction:column;z-index:7;box-shadow:0 10px 24px rgba(0,0,0,.4)}" +
    "#ai-history.open{display:flex}" +
    ".ai-hist-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;font-size:12px;" +
    "font-weight:600;border-bottom:1px solid var(--line,#2b4256)}" +
    ".ai-hist-list{overflow:auto;padding:4px}" +
    ".ai-hist-empty{opacity:.6;padding:16px;text-align:center;font-size:12px}" +
    ".ai-hist-row{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:7px;cursor:pointer}" +
    ".ai-hist-row:hover{background:var(--bg3,#22384a)}" +
    ".ai-hist-row.active{background:var(--bg3,#22384a);outline:1px solid var(--accent,#2f6feb);outline-offset:-1px}" +
    ".ai-hist-row.busy .ai-hist-title{color:var(--accent2,#4da3ff)}" +
    ".ai-live-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent2,#4da3ff);" +
    "margin-left:6px;vertical-align:middle;animation:aiThinkPulse 1.2s ease-in-out infinite}" +
    ".ai-hist-main{flex:1;min-width:0}" +
    ".ai-hist-title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".ai-hist-time{font-size:10px;opacity:.5;margin-top:1px}" +
    ".ai-hist-del{opacity:.5;padding:2px 7px;border-radius:5px;font-size:12px;flex:none}" +
    ".ai-hist-del:hover{opacity:1;background:#5a1f27;color:#ffd7db}" +
    /* model/settings popover (gaya Cursor) */
    "#ai-modelpop{position:absolute;left:10px;right:10px;bottom:60px;background:var(--bg2,#16232e);" +
    "border:1px solid var(--line,#2b4256);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.5);z-index:9;display:none;overflow:hidden}" +
    "#ai-modelpop.open{display:block}" +
    ".ai-pop-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;font-size:12.5px;cursor:pointer}" +
    ".ai-pop-row:hover{background:var(--bg3,#22384a)}" +
    ".ai-pop-row .k{opacity:.92}" +
    ".ai-pop-row .v{opacity:.7;display:flex;align-items:center;gap:6px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ai-pop-row .v .chev{opacity:.55;font-size:11px}" +
    ".ai-pop-sep{height:1px;background:var(--line,#2b4256)}" +
    ".ai-pop-note{padding:10px 12px;font-size:11px;opacity:.65;line-height:1.5}" +
    ".ai-pop-note .ai-link{margin-left:4px}" +
    ".ai-sw{width:34px;height:18px;border-radius:999px;background:var(--bg3,#22384a);position:relative;flex:none;transition:background .15s;border:1px solid var(--line,#2b4256)}" +
    ".ai-sw.on{background:var(--accent,#2f6feb);border-color:var(--accent,#2f6feb)}" +
    ".ai-sw i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}" +
    ".ai-sw.on i{left:18px}" +
    /* side submenu (flyout) */
    "#ai-submenu{position:fixed;width:220px;max-height:340px;overflow:auto;background:var(--bg2,#16232e);" +
    "border:1px solid var(--line,#2b4256);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.55);z-index:11;display:none}" +
    "#ai-submenu.open{display:block}" +
    ".ai-sub-head{padding:8px 12px;font-size:11px;opacity:.6;border-bottom:1px solid var(--line,#2b4256)}" +
    ".ai-sub-item{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12.5px;cursor:pointer}" +
    ".ai-sub-item .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".ai-sub-item:hover{background:var(--bg3,#22384a)}" +
    ".ai-sub-item .ck{color:var(--accent2,#4da3ff);opacity:0;flex:none}" +
    ".ai-mlogo{flex:none;vertical-align:middle}" +
    "#ai-model-chip .ai-mlogo{margin-right:5px}" +
    ".ai-sub-item .ai-mlogo{margin-right:2px}" +
    ".ai-mval{display:inline-flex;align-items:center;gap:5px}" +
    ".ai-sub-item.sel .ck{opacity:1}" +
    ".ai-sub-item.act{border-top:1px solid var(--line,#2b4256);color:var(--accent2,#4da3ff);font-size:12px}" +
    ".ai-sub-item.act .ck{display:none}.ai-sub-item.act.busy{opacity:.6;pointer-events:none}" +
    /* api key menu title */
    ".ai-cfg-title{font-weight:600;font-size:13px;margin-bottom:2px}" +
    /* menubar toggle */
    "#menubar .mb-ai{cursor:pointer;user-select:none;padding:2px 8px;border-radius:4px;font-size:12px;display:inline-flex;align-items:center;gap:5px}" +
    "#menubar .mb-ai .ai-ico,#ai-head .ai-title .spark .ai-ico,.ai-msg.ai .who .spark .ai-ico,.ai-empty .big .ai-ico{margin:0;vertical-align:middle;display:block}" +
    "#menubar .mb-ai:hover{background:var(--bg3,#22384a)}" +
    "#menubar .mb-ai.active{background:var(--accent,#2f6feb);color:#fff}" +
    /* Phone / tablet composer: ~44px hit targets, tools on a second row (scroll if needed).
       Placed last so these beat the compact desktop chip sizes above. Desktop ≥1024 is unchanged. */
    "@media (max-width:768px){" +
    "#ai-composer{position:relative;z-index:4;padding:8px 10px 12px;pointer-events:auto}" +
    "#ai-box{overflow:visible}" +
    "#ai-bar{flex-wrap:wrap;align-items:center;gap:8px 10px;margin-top:8px;min-height:44px;" +
    "touch-action:manipulation;position:relative;z-index:2;pointer-events:auto}" +
    "#ai-plus{order:1}#ai-model-chip{order:2}#ai-bar .grow{order:3;flex:1 1 8px;min-width:4px}" +
    "#ai-mic{order:4}#ai-stop{order:5}#ai-send{order:6}" +
    "#ai-bar-tools{display:flex;flex:1 1 100%;order:20;align-items:center;justify-content:space-between;" +
    "gap:8px;min-width:0;max-width:100%;min-height:44px;overflow-x:auto;overflow-y:hidden;" +
    "-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;scrollbar-width:none;" +
    "padding:2px 0;pointer-events:auto}" +
    "#ai-bar-tools::-webkit-scrollbar{display:none}" +
    "#ai-plus,#ai-model-chip,#ai-bar-tools .ai-optchip,#ai-skills-btn,#ai-mic,#ai-send,#ai-stop{" +
    "min-width:44px;min-height:44px;flex:none;pointer-events:auto;-webkit-tap-highlight-color:transparent}" +
    "#ai-plus{width:44px;height:44px;font-size:22px;border-radius:10px}" +
    "#ai-model-chip{height:44px;padding:0 14px;flex:0 1 auto;max-width:min(42vw,180px)}" +
    "#ai-panel.narrow #ai-model-chip{min-width:72px}" +
    "#ai-panel.narrow .ai-optchip,#ai-panel.narrow #ai-skills-btn{" +
    "width:44px;height:44px;padding:0;gap:0;justify-content:center}" +
    "#ai-bar-tools .ai-ico,#ai-skills-btn .ai-ico{margin-right:0}" +
    "#ai-mic,.ai-round,#ai-send,#ai-stop{width:44px;height:44px}" +
    "}" +
    "@media (max-width:480px){" +
    "#ai-bar{gap:8px 12px}" +
    "#ai-bar-tools{gap:10px}" +
    "#ai-model-chip{max-width:min(36vw,130px)}" +
    "#ai-composer{padding:8px 8px 10px}" +
    "}";

  function injectStyle() {
    var st = document.createElement("style");
    st.id = "ai-chat-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Ikon SVG monokrom (mengikuti warna teks), pengganti emoji yang tampil beda-beda tiap OS.
  var ICONS = {
    // Skill = otak (dua belahan). Dipakai tombol & chip Skills.
    skill: '<path d="M9.5 2A3.5 3.5 0 0 0 6 5.5q0 .5.1.9A3.5 3.5 0 0 0 4 9.6q0 1.3.8 2.2A3.5 3.5 0 0 0 6 18a3 3 0 0 0 3 3 2 2 0 0 0 2-2V4a2 2 0 0 0-1.5-2z"/><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5q0 .5-.1.9A3.5 3.5 0 0 1 20 9.6q0 1.3-.8 2.2A3.5 3.5 0 0 1 18 18a3 3 0 0 1-3 3 2 2 0 0 1-2-2V4a2 2 0 0 1 1.5-2z"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
    rule: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
    // Ikon agent: robot (kepala + antena + dua mata).
    robot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    review: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M3 6l1.4 1.4L6.8 5M3 12l1.4 1.4L6.8 11M3 18l1.4 1.4L6.8 17"/>',
  };
  // Dikte suara ke composer.
  var recog = null;
  function toggleMic(SR, btn) {
    if (recog) { try { recog.stop(); } catch (e) {} recog = null; btn.classList.remove("on"); return; }
    try {
      recog = new SR(); recog.lang = "id-ID"; recog.interimResults = true; recog.continuous = true;
      var base = input.value;
      recog.onresult = function (ev) {
        var finalTxt = "", interim = "";
        for (var i = 0; i < ev.results.length; i++) { var r = ev.results[i]; if (r.isFinal) finalTxt += r[0].transcript + " "; else interim += r[0].transcript; }
        input.value = (base + (base && !/\s$/.test(base) ? " " : "") + finalTxt + interim).replace(/\s+$/, "") ; autoGrow();
      };
      recog.onerror = function (ev) { setHint("Mikrofon: " + (ev.error || "gagal")); btn.classList.remove("on"); recog = null; };
      recog.onend = function () { btn.classList.remove("on"); recog = null; input.focus(); };
      recog.start(); btn.classList.add("on"); setHint("Mendengarkan\u2026 klik lagi untuk berhenti.");
    } catch (e) { setHint("Dikte tidak tersedia di browser ini."); recog = null; }
  }
  function svgIcon(kind, size) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size || 12); s.setAttribute("height", size || 12);
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    s.classList.add("ai-ico"); s.innerHTML = ICONS[kind] || "";
    return s;
  }

  // Logo provider model AI (Claude/GPT/Gemini/Grok/Cursor, dll). Warna khas provider bila ada.
  // Claude: sunburst (ikon aplikasi Claude) — 12 sinar dengan panjang bergantian.
  var CLAUDE_RAYS = (function () {
    var out = "";
    for (var i = 0; i < 12; i++) {
      var len = i % 3 === 0 ? 9.6 : i % 3 === 1 ? 7.6 : 8.6;
      out += '<line x1="0" y1="-3.2" x2="0" y2="' + (-len) + '" transform="rotate(' + (i * 30 + 15) + ')"/>';
    }
    return '<g transform="translate(12 12)" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">' + out + "</g>";
  })();
  var MODEL_LOGOS = {
    anthropic: { c: "#d97757", s: CLAUDE_RAYS },
    // OpenAI blossom (bentuk resmi, mengikuti warna teks).
    openai: { c: "", s: '<path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>' },
    // Gemini: bintang empat sisi cekung dengan gradien biru→ungu.
    google: { c: "", s: '<defs><linearGradient id="vrGem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4e8ef7"/><stop offset=".55" stop-color="#8b6cf7"/><stop offset="1" stop-color="#d96570"/></linearGradient></defs><path fill="url(#vrGem)" d="M12 24A14.3 14.3 0 0 0 0 12 14.3 14.3 0 0 0 12 0a14.3 14.3 0 0 0 12 12 14.3 14.3 0 0 0-12 12"/>' },
    // xAI / Grok: X dengan satu diagonal utuh dan satu diagonal terputus.
    xai: { c: "", s: '<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M4 4l16 16"/><path d="M20 4l-6.2 6.2M9.8 14.2 4 20"/></g>' },
    // DeepSeek: paus dengan sirip (ringkas).
    deepseek: { c: "#4d6bfe", s: '<path fill="currentColor" d="M21.6 6.4c-.5-.2-.8.2-1.1.5-.1.1-.2.2-.3.3-.8-.5-1.7-.6-2.7-.5-.5-.9-1.2-1.4-2.2-1.6-.3-.1-.6 0-.7.3-.1.3 0 .6.3.7.6.2 1 .6 1.3 1.1-1.8.6-3.1 1.9-3.9 3.6-.6-.3-1.3-.4-2-.3-.9-1.1-2.2-1.7-3.7-1.6-.3 0-.6.3-.6.6 0 .3.3.6.6.6 1 0 1.9.4 2.6 1.1-1 .7-1.7 1.7-2 2.9-.9.2-1.6.7-2.1 1.5-.2.3-.1.7.2.8.3.2.7.1.8-.2.4-.6.9-.9 1.6-1 .1 1.9 1.1 3.5 2.8 4.4.3.2.7 0 .8-.3.2-.3 0-.7-.3-.8-.9-.5-1.5-1.3-1.8-2.2 1.2.3 2.5.1 3.6-.5.7.9 1.7 1.5 2.9 1.7 2 .3 3.9-.7 4.9-2.4.4-.8.6-1.7.5-2.6.9-.4 1.6-1 2.1-1.9.3-.5.4-1.1.4-1.6 0-.4.1-.9.3-1.3.2-.4.4-.8.3-1.3z"/>' },
    // Cursor: kubus isometrik.
    cursor: { c: "", s: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.2l8.5 4.9v9.8L12 21.8l-8.5-4.9V7.1z"/><path d="M12 12l8.5-4.9M12 12v9.8M12 12L3.5 7.1"/></g>' },
    // Mistral: blok-blok oranye bertingkat.
    mistral: { c: "#f7931e", s: '<g fill="currentColor"><rect x="2" y="3" width="4" height="4"/><rect x="18" y="3" width="4" height="4"/><rect x="2" y="7" width="8" height="4"/><rect x="14" y="7" width="8" height="4"/><rect x="2" y="11" width="20" height="4"/><rect x="2" y="15" width="4" height="4"/><rect x="10" y="15" width="4" height="4"/><rect x="18" y="15" width="4" height="4"/><rect x="2" y="19" width="4" height="2.5"/><rect x="18" y="19" width="4" height="2.5"/></g>' },
    // Meta (Llama): simpul tak hingga biru.
    meta: { c: "#0866ff", s: '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M2.5 15.5c0-4.5 2.2-8.5 4.6-8.5 2.2 0 3.7 3 4.9 6 1.2 3 2.7 6 4.9 6 2.4 0 4.6-4 4.6-8.5"/><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M21.5 8.5c0 4.5-2.2 8.5-4.6 8.5-2.2 0-3.7-3-4.9-6-1.2-3-2.7-6-4.9-6-2.4 0-4.6 4-4.6 8.5"/>' },
    // Qwen (Alibaba): heksagon berlapis.
    qwen: { c: "#615ced", s: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/><path d="M12 7.2l4.2 2.4v4.8L12 16.8l-4.2-2.4V9.6z"/></g>' },
    // Kimi (Moonshot): bulan sabit.
    kimi: { c: "", s: '<path fill="currentColor" d="M14.5 2.5a9.5 9.5 0 1 0 7 15.8A8 8 0 0 1 14.5 2.5z"/>' },
    // GLM (Zhipu): lingkaran dengan lengkung.
    zhipu: { c: "#3b5bff", s: '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M7.5 12a4.5 4.5 0 0 1 9 0"/></g>' },
    generic: { c: "", s: '<path fill="currentColor" d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/>' },
  };
  function modelProvider(text) {
    var s = String(text || "").toLowerCase();
    if (/claude|anthropic|sonnet|opus|haiku/.test(s)) return "anthropic";
    if (/gpt|openai|davinci|codex|\bo[1-4](-mini|-pro)?\b/.test(s)) return "openai";
    if (/gemini|gemma|palm|bard|google/.test(s)) return "google";
    if (/grok|xai/.test(s)) return "xai";
    if (/deepseek/.test(s)) return "deepseek";
    if (/mistral|mixtral|codestral|devstral|magistral/.test(s)) return "mistral";
    if (/llama|\bmeta\b/.test(s)) return "meta";
    if (/qwen|qwq|alibaba/.test(s)) return "qwen";
    if (/kimi|moonshot/.test(s)) return "kimi";
    if (/\bglm\b|zhipu|chatglm/.test(s)) return "zhipu";
    if (/composer|cursor|muse|fast/.test(s)) return "cursor";
    return "";
  }
  // Elemen <svg> logo model. text: gabungan displayName + id agar deteksi akurat.
  function modelLogo(text) {
    var d = MODEL_LOGOS[modelProvider(text)] || MODEL_LOGOS.generic;
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", 13); s.setAttribute("height", 13); s.setAttribute("aria-hidden", "true");
    s.classList.add("ai-mlogo"); s.innerHTML = d.s; if (d.c) s.style.color = d.c;
    return s;
  }
  function modelLogoFor(model) { var it = model && findModel(model); return modelLogo(((it && it.displayName) || "") + " " + (model || "")); }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function hash(s) { // djb2
    var h = 5381, i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }

  // ------------------------------------------------------------ Markdown
  // Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url). Input sudah di-escape.
  function inline(t) {
    var codes = [];
    t = t.replace(/`([^`\n]+)`/g, function (_, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/\u0000(\d+)\u0000/g, function (_, i) { return "<code>" + codes[+i] + "</code>"; });
    return t;
  }

  // Tabel GFM: baris header, baris pemisah |---|:--:|, lalu baris data.
  function isTableSep(ln) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(ln) && ln.indexOf("-") !== -1; }
  function splitRow(ln) {
    var s = ln.trim(); if (s[0] === "|") s = s.slice(1); if (s[s.length - 1] === "|") s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, "|"); });
  }
  function renderTable(head, aligns, rows) {
    var h = "<tr>" + head.map(function (c, i) { return "<th" + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "") + ">" + inline(c) + "</th>"; }).join("") + "</tr>";
    var b = rows.map(function (r) { return "<tr>" + head.map(function (_, i) { return "<td" + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "") + ">" + inline(r[i] || "") + "</td>"; }).join("") + "</tr>"; }).join("");
    return '<div class="ai-tbl"><table><thead>' + h + "</thead><tbody>" + b + "</tbody></table></div>";
  }

  // Daftar bertingkat: item {text, depth, type}; kedalaman dari indentasi (2 spasi / tab per level).
  function renderList(items) {
    var html = "", stack = []; // stack of types
    function openL(type) { html += "<" + type + ">"; stack.push(type); }
    function closeL() { html += "</li></" + stack.pop() + ">"; }
    items.forEach(function (it, idx) {
      var depth = it.depth + 1;
      if (!stack.length) openL(it.type);
      else if (depth > stack.length) { while (stack.length < depth) openL(it.type); }
      else {
        while (stack.length > depth) closeL();
        html += "</li>";
        if (stack[stack.length - 1] !== it.type) { html += "</" + stack.pop() + ">"; openL(it.type); }
      }
      var t = it.text, task = /^\[( |x|X)\]\s+/.exec(t);
      if (task) html += '<li class="task"><input type="checkbox" disabled' + (task[1] !== " " ? " checked" : "") + ">" + inline(t.slice(task[0].length));
      else html += "<li>" + inline(t);
    });
    while (stack.length) closeL();
    return html;
  }

  // Blok: heading, list (bertingkat, task), tabel, blockquote, hr, paragraf (baris tunggal -> <br>).
  function blocks(text) {
    var lines = esc(text).split("\n");
    var out = [], para = [], list = null; // list: items [{text, depth, type}]
    var quote = [];
    function flushPara() { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } }
    function flushList() { if (list) { out.push(renderList(list)); list = null; } }
    function flushQuote() { if (quote.length) { out.push("<blockquote>" + quote.map(inline).join("<br>") + "</blockquote>"); quote = []; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], m;
      if (!ln.trim()) { flushPara(); flushList(); flushQuote(); continue; }
      if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); flushQuote(); var lv = Math.min(4, m[1].length); out.push("<h" + lv + ">" + inline(m[2].replace(/\s+#+\s*$/, "")) + "</h" + lv + ">"); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { flushPara(); flushList(); flushQuote(); out.push("<hr>"); continue; }
      // Tabel: baris ini punya '|' dan baris berikutnya pemisah.
      if (ln.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara(); flushList(); flushQuote();
        var head = splitRow(ln), aligns = splitRow(lines[i + 1]).map(function (c) { var l = c[0] === ":", r = c[c.length - 1] === ":"; return l && r ? "center" : r ? "right" : l ? "left" : ""; });
        var rows = []; i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) { rows.push(splitRow(lines[i])); i++; }
        i--; out.push(renderTable(head, aligns, rows)); continue;
      }
      if ((m = ln.match(/^(\s*)[-*+]\s+(.*)$/))) { flushPara(); flushQuote(); if (!list) list = []; list.push({ text: m[2], depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2), type: "ul" }); continue; }
      if ((m = ln.match(/^(\s*)\d+[.)]\s+(.*)$/))) { flushPara(); flushQuote(); if (!list) list = []; list.push({ text: m[2], depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2), type: "ol" }); continue; }
      // Lanjutan item daftar (baris menjorok tanpa penanda) digabung ke item terakhir.
      if (list && /^\s{2,}\S/.test(ln)) { list[list.length - 1].text += " " + ln.trim(); continue; }
      if ((m = ln.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      flushList(); flushQuote(); para.push(ln);
    }
    flushPara(); flushList(); flushQuote();
    return out.join("");
  }

  var codeByKey = {}; // key -> kode mentah (untuk Copy & highlight)

  function codeBlock(lang, code, closed) {
    var key = (lang || "text") + ":" + hash(code);
    codeByKey[key] = code;
    var label = lang || "text";
    return '<div class="ai-code" data-key="' + esc(key) + '" data-lang="' + esc(lang || "") + '" data-closed="' + (closed ? 1 : 0) + '">' +
      '<div class="ai-code-head"><span class="lang">' + esc(label) + '</span>' +
      '<button type="button" class="ai-copy" title="Salin kode">Copy</button></div>' +
      '<pre class="ai-code-body"><code>' + esc(code) + '</code></pre></div>';
  }

  // Markdown lengkap, aman untuk teks yang masih streaming (fence belum ditutup).
  function renderMarkdown(src) {
    var out = "", pos = 0;
    while (true) {
      var open = src.indexOf("```", pos);
      if (open === -1) { out += blocks(src.slice(pos)); break; }
      out += blocks(src.slice(pos, open));
      var nl = src.indexOf("\n", open + 3);
      var lang = (nl === -1 ? src.slice(open + 3) : src.slice(open + 3, nl)).trim().split(/\s+/)[0].toLowerCase();
      if (nl === -1) { out += codeBlock(lang, "", false); break; }
      var close = src.indexOf("\n```", nl);
      if (close === -1) { out += codeBlock(lang, src.slice(nl + 1), false); break; }
      out += codeBlock(lang, src.slice(nl + 1, close), true);
      pos = close + 4;
      if (src[pos] === "\n") pos++;
    }
    return out;
  }

  // --------------------------------------------------- Syntax highlight (Ace)
  var hlCache = {}, hlPending = {}, hlCssDone = {};
  var LANG_ALIAS = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
    py: "python", rb: "ruby", sh: "sh", bash: "sh", zsh: "sh", shell: "sh", ps: "powershell", ps1: "powershell",
    powershell: "powershell", yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown", html: "html", htm: "html",
    css: "css", scss: "scss", json: "json", sql: "sql", go: "golang", golang: "golang", rs: "rust", rust: "rust",
    c: "c_cpp", h: "c_cpp", cpp: "c_cpp", "c++": "c_cpp", cc: "c_cpp", hpp: "c_cpp", java: "java", php: "php", xml: "xml",
    dockerfile: "dockerfile", kt: "kotlin", kotlin: "kotlin", swift: "swift", dart: "dart", lua: "lua", ini: "ini",
    toml: "toml", txt: "text", text: "text", plain: "text", "": "text" };

  function aceMode(lang) {
    var name = LANG_ALIAS[lang] || lang || "text";
    try {
      var ml = ace.require("ace/ext/modelist");
      if (ml && ml.modesByName && ml.modesByName[name]) return ml.modesByName[name].mode;
    } catch (e) {}
    return "ace/mode/" + (name === "text" ? "text" : name);
  }
  // Tema highlight blok kode = tema editor (Ambiance, tetap; lihat app.js SYNTAX_THEME).
  function aceTheme() { return "ace/theme/ambiance"; }

  function highlightBlocks(root) {
    if (typeof ace === "undefined") return;
    var hl; try { hl = ace.require("ace/ext/static_highlight"); } catch (e) { return; }
    if (!hl || typeof hl.render !== "function") return;
    var theme = aceTheme();
    var nodes = root.querySelectorAll('.ai-code[data-closed="1"]');
    Array.prototype.forEach.call(nodes, function (node) {
      var key = node.getAttribute("data-key");
      var body = node.querySelector(".ai-code-body");
      if (!body || node.getAttribute("data-hl") === "1") return;
      var cacheKey = theme + "|" + key;
      if (hlCache[cacheKey]) { body.innerHTML = hlCache[cacheKey]; node.setAttribute("data-hl", "1"); return; }
      if (hlPending[cacheKey]) return;
      var code = codeByKey[key]; if (code == null) return;
      hlPending[cacheKey] = true;
      try {
        hl.render(code, aceMode(node.getAttribute("data-lang")), theme, 1, true, function (res) {
          delete hlPending[cacheKey];
          if (!res || !res.html) return;
          if (res.css && !hlCssDone[theme]) {
            var st = document.createElement("style"); st.textContent = res.css; document.head.appendChild(st);
            hlCssDone[theme] = true;
          }
          hlCache[cacheKey] = res.html;
          // Terapkan ke semua node dengan key yang sama yang masih hidup di DOM.
          Array.prototype.forEach.call(document.querySelectorAll('.ai-code[data-key="' + key.replace(/"/g, '\\"') + '"]'), function (n) {
            var b = n.querySelector(".ai-code-body");
            if (b && n.getAttribute("data-hl") !== "1") { b.innerHTML = res.html; n.setAttribute("data-hl", "1"); }
          });
        });
      } catch (e) { delete hlPending[cacheKey]; }
    });
  }

  // ------------------------------------------------------------ State/DOM
  var panel, msgs, input, sendBtn, stopBtn, toggleBtn, settings, cfgKey, modelChip, modeChip, browserChip, desktopChip, reviewChip, mentionEl, plusMenu, skillsBtn, skillsMenu, skillEdit, bgTermsEl;
  var REVIEW_KEY = "vrcloud_ai_review";
  var reviewOn = (function () { try { return localStorage.getItem(REVIEW_KEY) === "1"; } catch (e) { return false; } })();
  var bgTermsOpen = false; // daftar perintah terminal latar belakang sedang dibentang
  var skillsCache = [];        // daftar skill di workspace/.vrcloud-agent/skills
  var queue = [];              // pesan menunggu giliran saat agent sibuk
  var unread = 0;              // balasan selesai saat panel tertutup / tab tidak aktif
  var sessionUsage = null;     // pemakaian token percakapan aktif
  var checkpointsOn = false;   // server punya git untuk checkpoint
  var historyPanel, historyOpen = false;
  var popover, popoverOpen = false, modelCatalog = [], submenu = null;
  var statusReason = "", enabled = false, busy = false, currentStatus = null, aborter = null;
  // Ringkasan keadaan agent untuk status bar IDE (app.js mendengarkan event "vrcloud-ai-status").
  var agentPlan = null, agentPending = 0, agentEmitTimer = null;
  function emitAgentStatus() {
    clearTimeout(agentEmitTimer);
    agentEmitTimer = setTimeout(function () {
      var model = "";
      try { model = (currentStatus && currentStatus.model) ? chipLabel() : ""; } catch (e) {}
      try {
        window.dispatchEvent(new CustomEvent("vrcloud-ai-status", { detail: {
          enabled: enabled, busy: busy, pending: agentPending,
          plan: agentPlan ? { done: agentPlan.done, total: agentPlan.total } : null,
          usage: sessionUsage && sessionUsage.totalTokens ? { totalTokens: sessionUsage.totalTokens, costCents: sessionUsage.costCents,
            inputTokens: sessionUsage.inputTokens, outputTokens: sessionUsage.outputTokens, cacheReadTokens: sessionUsage.cacheReadTokens } : null,
          unread: unread, model: model,
        } }));
      } catch (e) {}
    }, 30);
  }
  var history = [];
  var streamGen = 0;
  var pollTimer = null;

  function histKey() { return HIST_PREFIX + sessionId(); }
  function loadHistory() { try { history = JSON.parse(localStorage.getItem(histKey()) || "[]") || []; } catch (e) { history = []; } }
  // Cache lokal riwayat (fallback saat server tidak terjangkau). Data gambar base64
  // tidak ikut disimpan — bisa berukuran MB dan melampaui kuota localStorage.
  function saveHistory() {
    if (history.length > HIST_MAX) history = history.slice(history.length - HIST_MAX);
    var slim = history.map(function (m) {
      if (!m.images || !m.images.length) return m;
      return Object.assign({}, m, { images: m.images.map(function (im) { return { name: im.name, mimeType: im.mimeType, image: im.image }; }) });
    });
    try { localStorage.setItem(histKey(), JSON.stringify(slim)); } catch (e) {}
  }

  function buildToggle() {
    var bar = document.getElementById("menubar");
    toggleBtn = el("span", "mb-ai"); toggleBtn.appendChild(svgIcon("robot", 14)); toggleBtn.appendChild(document.createTextNode("AI"));
    toggleBtn.title = "AI Chat (Alt+A)";
    toggleBtn.addEventListener("click", toggle);
    var gear = document.getElementById("gear");
    if (bar && gear) bar.insertBefore(toggleBtn, gear);
    else if (bar) bar.appendChild(toggleBtn);
  }

  function buildPanel() {
    panel = el("div"); panel.id = "ai-panel";
    var resize = el("div"); resize.id = "ai-resize"; panel.appendChild(resize);

    var head = el("div"); head.id = "ai-head";
    var title = el("span", "ai-title"); var tIco = el("span", "spark"); tIco.appendChild(svgIcon("robot", 15)); title.appendChild(tIco); title.appendChild(el("span", null, "Agent"));
    head.appendChild(title);
    head.appendChild(el("span", "ai-spacer"));
    var histBtn = el("span", "ai-ibtn", "\u2637"); histBtn.id = "ai-hist-btn"; histBtn.title = "Riwayat chat"; histBtn.addEventListener("click", toggleHistory); head.appendChild(histBtn);
    var newBtn = el("span", "ai-ibtn", "+"); newBtn.title = "Chat baru"; newBtn.addEventListener("click", newConversation); head.appendChild(newBtn);
    var cfgBtn = el("span", "ai-ibtn", "\u2699"); cfgBtn.title = "Setelan API"; cfgBtn.addEventListener("click", openSettings); head.appendChild(cfgBtn);
    var closeBtn = el("span", "ai-ibtn", "\u2715"); closeBtn.id = "ai-close-btn"; closeBtn.title = "Tutup"; closeBtn.addEventListener("click", function () { setOpen(false); }); head.appendChild(closeBtn);
    panel.appendChild(head);

    msgs = el("div"); msgs.id = "ai-msgs";
    msgs.addEventListener("click", onMsgsClick);
    panel.appendChild(msgs);

    var composer = el("div"); composer.id = "ai-composer";
    bgTermsEl = el("div"); bgTermsEl.id = "ai-bgterms"; bgTermsEl.style.display = "none"; composer.appendChild(bgTermsEl); // indikator terminal latar belakang agent
    var queueEl = el("div"); queueEl.id = "ai-queue"; composer.appendChild(queueEl); // pesan menunggu giliran
    var attach = el("div"); attach.id = "ai-attach"; composer.appendChild(attach); // chip lampiran file
    var box = el("div"); box.id = "ai-box";
    input = el("textarea"); input.id = "ai-input"; input.rows = 1; input.placeholder = "Beri tugas atau tanya apa saja\u2026";
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
    input.addEventListener("input", function () { autoGrow(); onMentionInput(); lastLocalEdit = Date.now(); broadcastDraft(); });
    input.addEventListener("keydown", onMentionKey, true);
    input.addEventListener("paste", onPaste);
    input.addEventListener("blur", function () { setTimeout(closeMention, 150); });
    box.appendChild(input);
    var bar = el("div"); bar.id = "ai-bar";
    var plus = el("span", null, "+"); plus.id = "ai-plus"; plus.title = "Tambah konteks (seleksi editor, output terminal, file, gambar)";
    plus.addEventListener("click", function (e) { e.stopPropagation(); togglePlusMenu(); });
    bar.appendChild(plus);
    modelChip = el("span"); modelChip.id = "ai-model-chip"; modelChip.title = "Pengaturan model"; modelChip.textContent = "model";
    modelChip.addEventListener("click", function (e) { e.stopPropagation(); toggleModelPop(); });
    bar.appendChild(modelChip);
    // Group tool chips so phones can put them on a second row without shrinking hit targets.
    var tools = el("div"); tools.id = "ai-bar-tools";
    // Dua tombol terpisah di samping Skills: Mode (Agent/Plan/Ask) dan Browser tools (Auto/On/Off).
    modeChip = el("span", "ai-optchip"); modeChip.id = "ai-mode-chip"; modeChip.title = "Mode agent: Agent (rencanakan & kerjakan), Plan (hanya rencana), Ask (baca-saja)";
    modeChip.addEventListener("click", function (e) { e.stopPropagation(); toggleChipMenu(modeChip, "mode"); });
    tools.appendChild(modeChip);
    browserChip = el("span", "ai-optchip"); browserChip.id = "ai-browser-chip"; browserChip.title = "Browser tools: Auto (agent memutuskan), On (utamakan browser untuk tugas web), Off (dimatikan)";
    browserChip.addEventListener("click", function (e) { e.stopPropagation(); toggleChipMenu(browserChip, "browser"); });
    tools.appendChild(browserChip);
    // Computer use (desktop_*): Auto / On / Off — agent melihat & mengendalikan desktop server.
    desktopChip = el("span", "ai-optchip"); desktopChip.id = "ai-desktop-chip"; desktopChip.title = "Computer use: Auto (agent memutuskan), On (utamakan GUI desktop), Off (dimatikan)";
    desktopChip.addEventListener("click", function (e) { e.stopPropagation(); toggleChipMenu(desktopChip, "desktop"); });
    tools.appendChild(desktopChip);
    reviewChip = el("span", "ai-optchip"); reviewChip.id = "ai-review-chip";
    reviewChip.addEventListener("click", function (e) { e.stopPropagation(); setReviewOn(!reviewOn); });
    tools.appendChild(reviewChip);
    skillsBtn = el("span"); skillsBtn.id = "ai-skills-btn"; skillsBtn.title = "Skills agent: pakai skill untuk pesan ini, atau buat/kelola skill (.vrcloud-agent/skills). Ketik / di composer untuk memilih cepat.";
    skillsBtn.appendChild(svgIcon("skill", 11)); skillsBtn.appendChild(el("span", "lbl", "Skills"));
    skillsBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleSkillsMenu(); });
    tools.appendChild(skillsBtn);
    bar.appendChild(tools);
    bar.appendChild(el("span", "grow"));
    bar.appendChild(el("span", "hint", "Enter \u21b5 \u00b7 @file \u00b7 /skill"));
    // Input suara (Web Speech API) — hanya bila browser mendukung.
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      var mic = el("button"); mic.id = "ai-mic"; mic.type = "button"; mic.title = "Dikte suara (Bahasa Indonesia)"; mic.appendChild(svgIcon("mic", 12));
      mic.addEventListener("click", function () { toggleMic(SR, mic); });
      bar.appendChild(mic);
    }
    stopBtn = el("button", "ai-round", "\u25a0"); stopBtn.id = "ai-stop"; stopBtn.type = "button"; stopBtn.title = "Stop";
    stopBtn.addEventListener("click", doStop);
    bar.appendChild(stopBtn);
    sendBtn = el("button", "ai-round", "\u2191"); sendBtn.id = "ai-send"; sendBtn.type = "button"; sendBtn.title = "Kirim (Enter)";
    sendBtn.addEventListener("click", doSend);
    bar.appendChild(sendBtn);
    box.appendChild(bar);
    composer.appendChild(box);
    panel.appendChild(composer);

    buildSettings();
    buildHistory();
    buildModelPop();
    buildPlusMenu();
    buildSkillsMenu();
    buildSkillEditor();
    buildCtxMenu();
    mentionEl = el("div"); mentionEl.id = "ai-mention"; panel.appendChild(mentionEl);
    var fileIn = el("input"); fileIn.type = "file"; fileIn.multiple = true; fileIn.id = "ai-file-in"; fileIn.style.display = "none";
    fileIn.addEventListener("change", function () { handleDropFiles(fileIn.files); fileIn.value = ""; });
    panel.appendChild(fileIn);

    var dropHint = el("div"); dropHint.id = "ai-drop-hint"; dropHint.textContent = "Lepas file untuk dilampirkan ke chat"; panel.appendChild(dropHint);
    setupDrop();

    var main = document.getElementById("main");
    if (main) main.appendChild(panel);

    var w = parseInt(localStorage.getItem(WIDTH_KEY) || "380", 10);
    if (w >= 280 && w <= 760) panel.style.width = w + "px";
    panel.classList.toggle("narrow", (w || 380) < NARROW_W);
    setupResize(resize);
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(180, input.scrollHeight) + "px";
  }

  // ------------------------------------------------- Lampiran (drop file)
  var attachments = [];
  // Menerima: file dari OS (Files), tab editor yang di-drag, dan file dari file tree.
  function hasFiles(e) { return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1); }
  function hasInternal(e) {
    var dt = e.dataTransfer; if (!dt) return false;
    if (Array.prototype.indexOf.call(dt.types || [], "text/x-vrcloud-path") !== -1) return true;
    var tab = document.querySelector(".pane-tab.dragging");
    return !!(tab && tab.getAttribute("data-path"));
  }
  function setupDrop() {
    if (!panel) return;
    ["dragenter", "dragover"].forEach(function (evt) {
      panel.addEventListener(evt, function (e) {
        if (!hasFiles(e) && !hasInternal(e)) return;
        e.preventDefault(); e.stopPropagation();
        // Untuk drag internal (tab: effectAllowed=move) biarkan dropEffect default agar tidak "dilarang".
        if (hasFiles(e)) { try { e.dataTransfer.dropEffect = "copy"; } catch (x) {} }
        panel.classList.add("ai-dragover");
      });
    });
    panel.addEventListener("dragleave", function (e) { if (e.target === panel || (e.target && e.target.id === "ai-drop-hint")) panel.classList.remove("ai-dragover"); });
    panel.addEventListener("drop", function (e) {
      var files = hasFiles(e) ? e.dataTransfer.files : null;
      var internal = hasInternal(e);
      if (!(files && files.length) && !internal) return;
      e.preventDefault(); e.stopPropagation(); panel.classList.remove("ai-dragover");
      if (files && files.length) { handleDropFiles(files); return; }
      var path = "";
      try { path = e.dataTransfer.getData("text/x-vrcloud-path") || ""; } catch (x) {}
      if (!path) { var tab = document.querySelector(".pane-tab.dragging"); if (tab) path = tab.getAttribute("data-path") || ""; }
      if (path) attachFromWorkspace(path);
      ensureOpen();
    });
  }
  // Ambil isi file workspace lewat API lalu jadikan lampiran.
  function attachFromWorkspace(relPath) {
    var name = basename(relPath);
    apiJson("/api/read?path=" + encodeURIComponent(relPath), { credentials: "same-origin" })
      .then(function (d) {
        if (d.binary) { addAttachment({ name: name, path: relPath, content: "", note: "file biner, tidak dilampirkan" }); return; }
        addAttachment({ name: name, path: relPath, content: String(d.content || "").slice(0, 200000) });
      })
      .catch(function (e) { addAttachment({ name: name, path: relPath, content: "", note: (e && e.message) || "gagal dibaca" }); });
  }
  function handleDropFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      if (/^image\//.test(f.type || "")) { addImageFile(f); return; }
      if (f.size > 512 * 1024) { addAttachment({ name: f.name, content: "", note: "terlalu besar, dilewati" }); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var txt = String(reader.result || "");
        if (txt.indexOf("\u0000") !== -1) { addAttachment({ name: f.name, content: "", note: "file biner, tidak dilampirkan" }); return; }
        addAttachment({ name: f.name, content: txt.slice(0, 200000) });
      };
      reader.onerror = function () { addAttachment({ name: f.name, content: "", note: "gagal dibaca" }); };
      reader.readAsText(f);
    });
    ensureOpen();
  }
  function addAttachment(a) {
    if (a.path && !a.range && attachments.some(function (x) { return x.path === a.path && !x.range && !x.image; })) return;
    attachments.push(a); renderAttachments();
  }
  function removeAttachment(i) { attachments.splice(i, 1); renderAttachments(); }
  function renderAttachments() {
    var c = document.getElementById("ai-attach"); if (!c) return;
    c.innerHTML = "";
    attachments.forEach(function (a, i) {
      var chip = el("span", "ai-chip" + (a.kind === "skill" ? " skill" : ""));
      if (a.image) { var im = el("img"); im.src = a.image; im.alt = a.name; chip.appendChild(im); chip.appendChild(el("span", "ai-chip-nm", a.name)); }
      else if (a.kind === "skill") { var sn = el("span", "ai-chip-nm"); sn.appendChild(svgIcon("skill", 11)); sn.appendChild(document.createTextNode(a.name)); chip.appendChild(sn); }
      else {
        var label = (a.kind === "terminal" ? "\u276f " : a.range ? "\u2630 " : "\uD83D\uDCCE ") + a.name + (a.range ? ":" + a.range : "") + (a.note ? " (" + a.note + ")" : "");
        chip.appendChild(el("span", "ai-chip-nm", label));
      }
      chip.title = a.kind === "skill" ? "Skill: " + a.name + (a.description ? " \u2014 " + a.description : "") : (a.path || a.name);
      var x = el("span", "ai-chip-x", "\u2715"); x.title = "Hapus lampiran";
      x.addEventListener("click", function () { removeAttachment(i); });
      chip.appendChild(x); c.appendChild(chip);
    });
    c.style.display = attachments.length ? "flex" : "none";
  }

  // ------------------------------------------ Konteks: menu +, seleksi, terminal, gambar
  function buildPlusMenu() {
    plusMenu = el("div"); plusMenu.id = "ai-plusmenu";
    function item(label, kbd, fn) {
      var it = el("div", "it"); it.appendChild(el("span", null, label)); if (kbd) it.appendChild(el("kbd", null, kbd));
      it.addEventListener("click", function (e) { e.stopPropagation(); closePlusMenu(); fn(); }); plusMenu.appendChild(it);
    }
    item("Seleksi di editor", "Ctrl+L", addEditorSelection);
    item("File yang sedang dibuka", "", addActiveFile);
    item("Output terminal (200 baris)", "", addTerminalOutput);
    item("Gambar / file dari komputer", "", function () { var f = document.getElementById("ai-file-in"); if (f) f.click(); });
    panel.appendChild(plusMenu);
  }
  function togglePlusMenu() { if (plusMenu.classList.contains("open")) closePlusMenu(); else { closeMention(); closeModelPop(); plusMenu.classList.add("open"); } }
  function closePlusMenu() { if (plusMenu) plusMenu.classList.remove("open"); }

  function addEditorSelection() {
    var api = window.VRCloud;
    var sel = api && api.getSelection ? api.getSelection() : null;
    if (!sel) {
      var f = api && api.getActiveFile ? api.getActiveFile() : null;
      if (f) return addActiveFile();
      setHint("Tidak ada teks terpilih di editor."); return;
    }
    addAttachment({ name: sel.name || basename(sel.path), path: sel.path, range: "L" + sel.startLine + (sel.endLine !== sel.startLine ? "-" + sel.endLine : ""), content: sel.text.slice(0, 200000) });
    ensureOpen();
    setTimeout(function () { input.focus(); }, 20);
  }
  function addActiveFile() {
    var api = window.VRCloud;
    var f = api && api.getActiveFile ? api.getActiveFile() : null;
    if (!f) { setHint("Tidak ada file yang dibuka."); return; }
    attachFromWorkspace(f.path);
    ensureOpen();
  }
  function addTerminalOutput() {
    var api = window.VRCloud;
    var t = api && api.getTerminalText ? api.getTerminalText(200) : null;
    if (!t || !t.text) { setHint("Terminal kosong atau tidak ada."); return; }
    addAttachment({ name: "terminal: " + t.title, kind: "terminal", content: t.text.slice(-60000) });
    ensureOpen();
  }
  var hintTimer = null;
  function setHint(text) {
    var h = panel.querySelector("#ai-bar .hint"); if (!h) return;
    var prev = h.getAttribute("data-prev") || h.textContent;
    h.setAttribute("data-prev", prev); h.textContent = text; h.style.opacity = "1";
    clearTimeout(hintTimer); hintTimer = setTimeout(function () { h.textContent = prev; h.style.opacity = ""; }, 2500);
  }
  // Tempel gambar (screenshot) langsung ke composer.
  function onPaste(e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var found = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === "file" && /^image\//.test(it.type)) {
        var f = it.getAsFile(); if (!f) continue;
        found = true; addImageFile(f);
      }
    }
    if (found) e.preventDefault();
  }
  function addImageFile(f) {
    if (f.size > 2 * 1024 * 1024) { setHint("Gambar terlalu besar (maks 2MB)."); return; }
    if (attachments.filter(function (a) { return a.image; }).length >= 4) { setHint("Maksimal 4 gambar."); return; }
    var r = new FileReader();
    r.onload = function () {
      var url = String(r.result || "");
      var m = /^data:([^;]+);base64,(.*)$/.exec(url); if (!m) return;
      addAttachment({ name: f.name || ("gambar-" + (attachments.length + 1) + ".png"), image: url, mimeType: m[1], data: m[2] });
    };
    r.readAsDataURL(f);
  }

  // ------------------------------------------ Aksi AI untuk menu klik-kanan editor
  // Menu-nya sendiri dibangun app.js (satu menu: aksi edit standar + aksi AI);
  // panel ini hanya menyediakan aksinya lewat window.VRCloudAI.
  var CTX_ACTIONS = [
    { label: "Jelaskan kode ini", prompt: "Jelaskan kode terlampir: apa yang dilakukannya, alur utamanya, dan hal yang perlu diperhatikan. Ringkas." },
    { label: "Perbaiki masalah di kode ini", prompt: "Periksa kode terlampir, temukan bug/masalah, lalu perbaiki langsung di file-nya. Jelaskan singkat apa yang diubah." },
    { label: "Tulis test untuk kode ini", prompt: "Tulis test otomatis untuk kode terlampir mengikuti framework/test yang sudah ada di proyek (buat bila belum ada), lalu jalankan dan pastikan lulus." },
    { label: "Refactor / rapikan", prompt: "Refactor kode terlampir agar lebih bersih dan mudah dibaca tanpa mengubah perilaku. Terapkan langsung di file-nya dan verifikasi." },
    { label: "Tambahkan komentar/dokumentasi", prompt: "Tambahkan komentar dan dokumentasi (docstring/JSDoc sesuai bahasanya) yang ringkas dan berguna pada kode terlampir, langsung di file-nya." },
  ];
  function buildCtxMenu() {
    window.VRCloudAI = {
      ready: function () { return !!panel; },
      open: function () { setOpen(true); },
      setOpen: function (o, remote) { setOpen(o, remote); },
      isOpen: function () { return !!(panel && panel.classList.contains("open")); },
      actions: function () { return CTX_ACTIONS.slice(); },
      addSelection: function () { addEditorSelection(); },
      quickAction: function (prompt) { quickAction(prompt); },
    };
  }
  // Lampirkan seleksi + kirim prompt aksi cepat langsung ke agent.
  function quickAction(prompt) {
    addEditorSelection();
    if (!attachments.some(function (a) { return a.range; })) return;
    if (!enabled) { setHint("AI belum aktif."); return; }
    input.value = prompt; autoGrow();
    doSend();
  }

  // ------------------------------------- Autocomplete @file dan /skill di composer
  var mentionItems = [], mentionSel = 0, mentionQuery = null, mentionTimer = null, mentionStart = -1, mentionKind = "file";
  // Pemicu: "@" (file) atau "/" (skill) di awal kata. "/" di dalam @path
  // (mis. @lib/ai) bukan pemicu skill, jadi autocomplete file tidak tertutup.
  function mentionContext() {
    var pos = input.selectionStart, val = input.value;
    var start = val.lastIndexOf(" ", pos - 1) + 1; // awal kata yang sedang diketik
    var nl = val.lastIndexOf("\n", pos - 1) + 1; if (nl > start) start = nl;
    var word = val.slice(start, pos);
    var c = word.charAt(0);
    if (c !== "@" && c !== "/") return null;
    var q = word.slice(1);
    if (/\s/.test(q)) return null;
    return { start: start, query: q, kind: c === "/" ? "skill" : "file" };
  }
  function onMentionInput() {
    var ctx = mentionContext();
    if (!ctx) { closeMention(); return; }
    mentionStart = ctx.start; mentionQuery = ctx.query; mentionKind = ctx.kind;
    clearTimeout(mentionTimer);
    if (ctx.kind === "skill") {
      var q = ctx.query.toLowerCase();
      if (q.indexOf("/") !== -1 || q.indexOf(".") !== -1) { closeMention(); return; } // path Unix, bukan /skill
      var show = function () {
        if (mentionQuery !== ctx.query) return;
        mentionItems = skillsCache.filter(function (s) { return !q || s.name.indexOf(q) !== -1 || (s.description || "").toLowerCase().indexOf(q) !== -1; }).slice(0, 10);
        if (!mentionItems.length && q) { closeMention(); return; } // tidak ada yang cocok: jangan ganggu pengetikan
        mentionSel = 0; renderMention();
      };
      if (skillsCache.length) show(); else loadSkills().then(show).catch(function () {});
      return;
    }
    mentionTimer = setTimeout(function () {
      apiJson("/api/files?q=" + encodeURIComponent(ctx.query) + "&limit=12", { credentials: "same-origin" }).then(function (d) {
        if (mentionQuery !== ctx.query) return;
        mentionItems = d.files || []; mentionSel = 0; renderMention();
      }).catch(function () {});
    }, 120);
  }
  function renderMention() {
    if (!mentionEl) return;
    mentionEl.innerHTML = "";
    if (!mentionItems.length) {
      if (mentionKind === "skill") { mentionEl.appendChild(el("div", "ai-sk-empty", "Belum ada skill yang cocok. Buat lewat tombol Skills.")); mentionEl.classList.add("open"); }
      else mentionEl.classList.remove("open");
      return;
    }
    mentionItems.forEach(function (p, i) {
      var row = el("div", "ai-mi" + (i === mentionSel ? " sel" : ""));
      if (mentionKind === "skill") {
        var snm = el("span", "nm"); snm.appendChild(svgIcon("skill", 11)); snm.appendChild(document.createTextNode(p.name)); row.appendChild(snm);
        if (p.description) row.appendChild(el("span", "dir", p.description));
      } else {
        var dir = p.indexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "";
        row.appendChild(el("span", "nm", basename(p))); if (dir) row.appendChild(el("span", "dir", dir));
      }
      row.addEventListener("mousedown", function (e) { e.preventDefault(); pickMention(p); });
      mentionEl.appendChild(row);
    });
    mentionEl.classList.add("open");
  }
  function closeMention() { if (mentionEl) mentionEl.classList.remove("open"); mentionItems = []; mentionQuery = null; }
  function pickMention(p) {
    var val = input.value, pos = input.selectionStart;
    var before = val.slice(0, mentionStart), after = val.slice(pos);
    if (mentionKind === "skill") {
      input.value = (before + after).replace(/^\s+/, ""); // token /skill diganti chip
      input.setSelectionRange(before.length, before.length);
      closeMention(); autoGrow(); useSkill(p); input.focus(); return;
    }
    input.value = before + "@" + p + " " + after;
    var np = before.length + p.length + 2; input.setSelectionRange(np, np);
    closeMention(); autoGrow();
    attachFromWorkspace(p);
    input.focus();
  }

  // ------------------------------------------------------------- Skills
  function loadSkills() {
    return apiJson("/api/ai/skills", { credentials: "same-origin" }).then(function (d) { skillsCache = d.skills || []; return skillsCache; });
  }
  function useSkill(s) {
    if (!s || !s.name) return;
    if (attachments.some(function (a) { return a.kind === "skill" && a.name === s.name; })) return;
    attachments.push({ kind: "skill", name: s.name, description: s.description || "" }); renderAttachments();
    ensureOpen();
  }
  function buildSkillsMenu() {
    skillsMenu = el("div"); skillsMenu.id = "ai-skillsmenu"; panel.appendChild(skillsMenu);
  }
  function toggleSkillsMenu() { if (skillsMenu.classList.contains("open")) closeSkillsMenu(); else openSkillsMenu(); }
  function closeSkillsMenu() { if (skillsMenu) skillsMenu.classList.remove("open"); }
  function openSkillsMenu() {
    closeMention(); closeModelPop(); closePlusMenu(); closeHistory();
    skillsMenu.classList.add("open");
    renderSkillsMenu();
    loadSkills().then(renderSkillsMenu).catch(function () {});
  }
  var skillsTab = "skills", rulesCache = [];
  function loadRules() {
    return apiJson("/api/ai/rules", { credentials: "same-origin" }).then(function (d) { rulesCache = d.rules || []; return rulesCache; });
  }
  function renderSkillsMenu() {
    if (!skillsMenu) return;
    skillsMenu.innerHTML = "";
    var head = el("div", "ai-sk-head");
    var tabs = el("div", "ai-sk-tabs");
    [["skills", "Skills"], ["rules", "Rules"]].forEach(function (t) {
      var b = el("span", "ai-sk-tab" + (skillsTab === t[0] ? " on" : ""), t[1]);
      b.addEventListener("click", function (e) { e.stopPropagation(); skillsTab = t[0]; renderSkillsMenu(); if (t[0] === "rules") loadRules().then(renderSkillsMenu).catch(function () {}); });
      tabs.appendChild(b);
    });
    head.appendChild(tabs);
    if (skillsTab === "rules") {
      var addR = el("span", "ai-link", "+ Rule baru"); addR.addEventListener("click", function (e) { e.stopPropagation(); closeSkillsMenu(); openRuleEditor(null); });
      head.appendChild(addR); skillsMenu.appendChild(head);
      renderRulesTab(); return;
    }
    var add = el("span", "ai-link", "+ Skill baru"); add.addEventListener("click", function (e) { e.stopPropagation(); closeSkillsMenu(); openSkillEditor(null); });
    head.appendChild(add); skillsMenu.appendChild(head);
    if (!skillsCache.length) {
      skillsMenu.appendChild(el("div", "ai-sk-empty", "Belum ada skill di workspace ini. Skill = SKILL.md berisi instruksi khusus (gaya commit, standar review, alur deploy, dsb.) yang dipakai agent saat relevan atau saat Anda memilihnya."));
    }
    skillsCache.forEach(function (s) {
      skillsMenu.appendChild(skRow({
        name: s.name, badge: s.autoInvoke ? "otomatis" : "", badgeClass: "auto", desc: s.description,
        onOpen: function () { openSkillEditor(s.name); },
        useLabel: "Pakai", useTitle: "Pakai skill ini untuk pesan berikutnya", onUse: function () { useSkill(s); input.focus(); },
        deleteTitle: "Hapus skill", confirmText: "Hapus skill \"" + s.name + "\" (folder .vrcloud-agent/skills/" + s.name + ")?",
        onDelete: function () { return apiJson("/api/ai/skills/" + encodeURIComponent(s.name), { method: "DELETE", credentials: "same-origin" }).then(loadSkills); },
      }));
    });
    var note = el("div", "ai-sk-note");
    note.textContent = "Ketik / di composer untuk memilih skill cepat. Skill \u201cotomatis\u201d juga dipakai agent sendiri bila deskripsinya cocok (berlaku di percakapan baru).";
    var gen = el("span", "ai-link", " Minta agent membuat skill\u2026");
    gen.addEventListener("click", function (e) {
      e.stopPropagation(); closeSkillsMenu();
      input.value = "Buat skill Cursor baru di .vrcloud-agent/skills/<nama-skill>/SKILL.md (frontmatter: name, description yang menjelaskan KAPAN skill dipakai; isi: instruksi ringkas & contoh) untuk: ";
      autoGrow(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    });
    note.appendChild(gen); skillsMenu.appendChild(note);
  }

  // Satu baris daftar untuk skill maupun rule: nama (+ikon/badge), deskripsi,
  // klik → editor, tombol pakai/buat (opsional), hapus dengan konfirmasi (opsional).
  function skRow(o) {
    var row = el("div", "ai-sk-row");
    var main = el("div", "ai-sk-main");
    var nm = el("div", "ai-sk-name");
    if (o.icon) nm.appendChild(svgIcon(o.icon, 11));
    nm.appendChild(document.createTextNode(o.name));
    if (o.badge) nm.appendChild(el("span", o.badgeClass || "badge", o.badge));
    main.appendChild(nm);
    main.appendChild(el("div", "ai-sk-desc", o.desc || "(tanpa deskripsi)"));
    main.title = "Klik untuk melihat/mengubah";
    main.addEventListener("click", function (e) { e.stopPropagation(); closeSkillsMenu(); o.onOpen(); });
    row.appendChild(main);
    if (o.onUse) {
      var use = el("button", "ai-sk-use", o.useLabel || "Pakai"); use.type = "button"; if (o.useTitle) use.title = o.useTitle;
      use.addEventListener("click", function (e) { e.stopPropagation(); closeSkillsMenu(); o.onUse(); });
      row.appendChild(use);
    }
    if (o.onDelete) {
      var act = el("div", "ai-sk-act");
      var del = el("span", null, "\u2715"); del.title = o.deleteTitle || "Hapus";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!confirm(o.confirmText)) return;
        o.onDelete().then(renderSkillsMenu).catch(function (er) { alert("Gagal: " + er.message); });
      });
      act.appendChild(del); row.appendChild(act);
    }
    return row;
  }

  // Tab Rules: AGENTS.md + .vrcloud-agent/rules/*.mdc (aturan permanen untuk semua percakapan).
  function renderRulesTab() {
    var hasAgents = rulesCache.some(function (r) { return r.path === "AGENTS.md"; });
    if (!hasAgents) {
      skillsMenu.appendChild(skRow({
        name: "AGENTS.md", icon: "rule", badge: "belum ada", desc: "Instruksi proyek yang selalu dimuat: gaya kode, bahasa, larangan, cara menjalankan/test.",
        onOpen: function () { openRuleEditor("AGENTS.md"); }, useLabel: "Buat", onUse: function () { openRuleEditor("AGENTS.md"); },
      }));
    }
    if (!rulesCache.length && hasAgents === false) {
      skillsMenu.appendChild(el("div", "ai-sk-empty", "Belum ada rule di .vrcloud-agent/rules. Rule = instruksi yang berlaku otomatis (selalu, atau untuk file yang cocok globs) di semua percakapan."));
    }
    rulesCache.forEach(function (r) {
      skillsMenu.appendChild(skRow({
        name: r.name, icon: "rule", badge: r.alwaysApply ? "selalu" : (r.globs || "sesuai deskripsi"), desc: r.description,
        onOpen: function () { openRuleEditor(r.path); },
        deleteTitle: "Hapus rule", confirmText: "Hapus " + r.path + "?",
        onDelete: function () { return apiJson("/api/ai/rules?path=" + encodeURIComponent(r.path), { method: "DELETE", credentials: "same-origin" }).then(loadRules); },
      }));
    });
    skillsMenu.appendChild(el("div", "ai-sk-note", "Rules dimuat lewat settingSources \u201cproject\u201d; perubahan berlaku untuk percakapan baru. Skill = dipilih per kebutuhan; Rule = selalu berlaku."));
  }

  // Label & bidang editor per jenis (skill / rule / AGENTS.md) — satu panel editor dipakai bersama.
  var EDITOR_MODES = {
    skill: { nameLabel: "Nama (huruf kecil, angka, tanda hubung)", namePh: "mis. commit-message, review-api",
      descLabel: "Deskripsi \u2014 apa yang dilakukan & KAPAN dipakai (dibaca agent untuk memutuskan)",
      autoLabel: "Boleh dipakai agent secara otomatis bila relevan (tanpa dipilih lewat /)",
      bodyLabel: "Instruksi (Markdown) \u2014 langkah, aturan, contoh; ringkas", save: "Simpan skill", useBtn: true, globs: false, descAuto: true,
      note: "Disimpan sebagai .vrcloud-agent/skills/<nama>/SKILL.md di workspace (ikut repo bila di-commit). File pendukung (reference.md, scripts/) bisa ditambah lewat file tree." },
    rule: { nameLabel: "Nama file (.mdc)", namePh: "mis. gaya-kode, api-conventions",
      descLabel: "Deskripsi \u2014 kapan rule ini relevan (dipakai agent bila tidak 'selalu')",
      autoLabel: "Selalu berlaku (alwaysApply) untuk semua percakapan",
      bodyLabel: "Isi rule (Markdown)", save: "Simpan rule", useBtn: false, globs: true, descAuto: true,
      note: "Disimpan sebagai .vrcloud-agent/rules/<nama>.mdc dengan frontmatter description/globs/alwaysApply." },
    agents: { nameLabel: "File", namePh: "", descLabel: "", autoLabel: "", bodyLabel: "Isi AGENTS.md (Markdown)", save: "Simpan rule", useBtn: false, globs: false, descAuto: false,
      note: "AGENTS.md di root workspace selalu dimuat agent di setiap percakapan baru." },
  };
  function applyEditorMode(kind) {
    var m = EDITOR_MODES[kind];
    skUi.nameLabel.textContent = m.nameLabel; skUi.name.placeholder = T(m.namePh);
    skUi.descLabel.textContent = m.descLabel; skUi.autoLabel.textContent = m.autoLabel; skUi.bodyLabel.textContent = m.bodyLabel;
    skUi.globsWrap.style.display = m.globs ? "" : "none";
    skUi.descWrap.style.display = m.descAuto ? "" : "none"; skUi.autoWrap.style.display = m.descAuto ? "" : "none";
    skUi.saveBtn.textContent = m.save; skUi.useBtn.style.display = m.useBtn ? "" : "none";
    skUi.note.textContent = m.note;
  }
  // Editor rule (AGENTS.md / .vrcloud-agent/rules/<nama>.mdc), memakai panel editor yang sama.
  function openRuleEditor(rulePath) {
    if (settings) settings.classList.remove("open");
    skUi.kind = "rule"; skUi.status.textContent = ""; skUi.editing = rulePath || null;
    var isAgents = rulePath === "AGENTS.md";
    skUi.title.textContent = rulePath ? "Rule: " + rulePath : "Rule baru";
    skUi.name.disabled = !!rulePath;
    applyEditorMode(isAgents ? "agents" : "rule");
    if (!rulePath) { skUi.name.value = ""; skUi.desc.value = ""; skUi.globs.value = ""; skUi.auto.checked = false; skUi.body.value = ""; skillEdit.classList.add("open"); setTimeout(function () { skUi.name.focus(); }, 30); return; }
    apiJson("/api/ai/rules/file?path=" + encodeURIComponent(rulePath), { credentials: "same-origin" }).then(function (r) {
      skUi.name.value = isAgents ? "AGENTS.md" : rulePath.replace(/^\.vrcloud-agent\/rules\//, "");
      skUi.desc.value = r.description || ""; skUi.globs.value = r.globs || ""; skUi.auto.checked = !!r.alwaysApply;
      skUi.body.value = r.content || (isAgents && !r.exists ? "# Instruksi proyek\n\n- Bahasa jawaban: Indonesia.\n- Gaya kode: ...\n- Cara menjalankan: ...\n- Cara test: ...\n- Jangan: ...\n" : "");
      skillEdit.classList.add("open");
    }).catch(function (e) { alert("Gagal memuat rule: " + e.message); });
  }
  function saveRule() {
    var isAgents = skUi.editing === "AGENTS.md";
    var body = isAgents ? { path: "AGENTS.md", content: skUi.body.value }
      : (skUi.editing ? { path: skUi.editing } : { name: skUi.name.value.trim() });
    if (!isAgents) { body.content = skUi.body.value; body.description = skUi.desc.value.trim(); body.globs = skUi.globs.value.trim(); body.alwaysApply = skUi.auto.checked; }
    skUi.status.textContent = "Menyimpan\u2026";
    apiJson("/api/ai/rules", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { skUi.status.textContent = "Tersimpan di " + r.path; skUi.editing = r.path; skUi.name.disabled = true; return loadRules(); })
      .catch(function (e) { skUi.status.textContent = "Gagal: " + e.message; });
  }

  // Editor skill (buat/ubah SKILL.md).
  var skUi = {};
  function buildSkillEditor() {
    skillEdit = el("div"); skillEdit.id = "ai-skilledit";
    skUi.title = el("div", "ai-cfg-title", "Skill baru"); skillEdit.appendChild(skUi.title);
    skUi.status = el("div", "ai-cfg-status"); skillEdit.appendChild(skUi.status);
    var f1 = el("div", "ai-field"); skUi.nameLabel = el("label", null, "Nama (huruf kecil, angka, tanda hubung)"); f1.appendChild(skUi.nameLabel);
    skUi.name = el("input"); skUi.name.type = "text"; skUi.name.placeholder = "mis. commit-message, review-api"; skUi.name.autocomplete = "off"; f1.appendChild(skUi.name); skillEdit.appendChild(f1);
    var f2 = el("div", "ai-field"); skUi.descLabel = el("label", null, "Deskripsi \u2014 apa yang dilakukan & KAPAN dipakai (dibaca agent untuk memutuskan)"); f2.appendChild(skUi.descLabel);
    skUi.desc = el("input"); skUi.desc.type = "text"; skUi.desc.placeholder = "Menulis pesan commit gaya Conventional Commits. Dipakai saat pengguna minta commit message."; f2.appendChild(skUi.desc); skillEdit.appendChild(f2);
    skUi.descWrap = f2;
    var fg = el("div", "ai-field"); fg.appendChild(el("label", null, "Globs (opsional) \u2014 rule berlaku untuk file yang cocok, mis. src/**/*.ts"));
    skUi.globs = el("input"); skUi.globs.type = "text"; skUi.globs.placeholder = "**/*.py"; fg.appendChild(skUi.globs); fg.style.display = "none"; skillEdit.appendChild(fg); skUi.globsWrap = fg;
    var chk = el("label", "ai-chk"); skUi.auto = el("input"); skUi.auto.type = "checkbox"; chk.appendChild(skUi.auto);
    skUi.autoLabel = document.createTextNode("Boleh dipakai agent secara otomatis bila relevan (tanpa dipilih lewat /)"); chk.appendChild(skUi.autoLabel); skillEdit.appendChild(chk); skUi.autoWrap = chk;
    var f3 = el("div", "ai-field"); skUi.bodyLabel = el("label", null, "Instruksi (Markdown) \u2014 langkah, aturan, contoh; ringkas"); f3.appendChild(skUi.bodyLabel);
    skUi.body = el("textarea"); skUi.body.spellcheck = false; skUi.body.placeholder = "# Nama Skill\n\n## Instructions\n1. ...\n2. ...\n\n## Examples\n..."; f3.appendChild(skUi.body); skillEdit.appendChild(f3);
    var act = el("div", "ai-cfg-actions");
    var save = el("button", "save", "Simpan skill"); save.type = "button"; save.addEventListener("click", function () { if (skUi.kind === "rule") saveRule(); else saveSkill(); }); skUi.saveBtn = save;
    var use = el("button", "ghost", "Simpan & pakai"); use.type = "button"; use.addEventListener("click", function () { saveSkill(true); }); skUi.useBtn = use;
    var cancel = el("button", "ghost", "Tutup"); cancel.type = "button"; cancel.addEventListener("click", closeSkillEditor);
    act.appendChild(save); act.appendChild(use); act.appendChild(cancel); skillEdit.appendChild(act);
    skUi.note = el("div", "ai-cfg-note", "Disimpan sebagai .vrcloud-agent/skills/<nama>/SKILL.md di workspace (ikut repo bila di-commit). File pendukung (reference.md, scripts/) bisa ditambah lewat file tree.");
    skillEdit.appendChild(skUi.note);
    panel.appendChild(skillEdit);
  }
  function openSkillEditor(name) {
    if (settings) settings.classList.remove("open");
    skUi.kind = "skill"; skUi.status.textContent = "";
    skUi.editing = name || null;
    skUi.name.disabled = !!name;
    applyEditorMode("skill");
    if (!name) {
      skUi.title.textContent = "Skill baru"; skUi.name.value = ""; skUi.desc.value = ""; skUi.auto.checked = false; skUi.body.value = "";
      skillEdit.classList.add("open"); setTimeout(function () { skUi.name.focus(); }, 30); return;
    }
    skUi.title.textContent = "Skill: " + name;
    apiJson("/api/ai/skills/" + encodeURIComponent(name), { credentials: "same-origin" }).then(function (s) {
      skUi.name.value = s.name; skUi.desc.value = s.description || ""; skUi.auto.checked = !!s.autoInvoke; skUi.body.value = s.content || "";
      if (s.extras && s.extras.length) skUi.status.textContent = "File pendukung: " + s.extras.join(", ");
      skillEdit.classList.add("open");
    }).catch(function (e) { alert("Gagal memuat skill: " + e.message); });
  }
  function closeSkillEditor() { skillEdit.classList.remove("open"); }
  function saveSkill(andUse) {
    var body = { name: skUi.name.value.trim().toLowerCase(), description: skUi.desc.value.trim(), autoInvoke: skUi.auto.checked, content: skUi.body.value };
    skUi.status.textContent = "Menyimpan\u2026";
    apiJson("/api/ai/skills", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (s) {
        skUi.status.textContent = "Tersimpan di " + s.path;
        return loadSkills().then(function () { if (andUse) { useSkill(s); closeSkillEditor(); input.focus(); } });
      })
      .catch(function (e) { skUi.status.textContent = "Gagal: " + e.message; });
  }
  function onMentionKey(e) {
    if (!mentionEl || !mentionEl.classList.contains("open")) return;
    // stopImmediatePropagation: listener keydown lain di textarea yang sama (Enter →
    // doSend) tidak boleh ikut jalan, kalau tidak pesan "@path " terkirim mentah.
    var swallow = function () { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "ArrowDown") { mentionSel = (mentionSel + 1) % mentionItems.length; renderMention(); swallow(); }
    else if (e.key === "ArrowUp") { mentionSel = (mentionSel - 1 + mentionItems.length) % mentionItems.length; renderMention(); swallow(); }
    else if (e.key === "Enter" || e.key === "Tab") { if (mentionItems[mentionSel]) { pickMention(mentionItems[mentionSel]); swallow(); } }
    else if (e.key === "Escape") { closeMention(); swallow(); }
  }

  // ---------------------------------------------------------- Antrean pesan
  function renderQueue() {
    var q = document.getElementById("ai-queue"); if (!q) return;
    q.innerHTML = "";
    queue.forEach(function (m, i) {
      var row = el("div", "ai-qi");
      row.appendChild(el("span", null, "\u23f3"));
      row.appendChild(el("span", "qt", m.display));
      var x = el("span", "qx", "\u2715"); x.title = "Batalkan"; x.addEventListener("click", function () { queue.splice(i, 1); renderQueue(); });
      row.appendChild(x); q.appendChild(row);
    });
    q.style.display = queue.length ? "flex" : "none";
  }
  function flushQueue() {
    if (busy || !enabled || !queue.length) return;
    var m = queue.shift(); renderQueue();
    setTimeout(function () { sendMessage(m); }, 50);
  }

  // ------------------------------------------------------------ Notifikasi
  var NOTIFY_KEY = "vrcloud_ai_notify";
  // Pusat notifikasi IDE (bel di status bar, toast, notifikasi browser) lewat window.VRCloud.notify.
  function notifyDone(title, kind) {
    var hidden = document.hidden || !panel.classList.contains("open");
    if (!hidden && kind !== "warn" && kind !== "err") return;
    if (hidden) { unread++; renderBadge(); }
    var head = kind === "warn" ? "Agent menunggu izin" : kind === "err" ? "Agent gagal" : "Agent selesai";
    if (window.VRCloud && window.VRCloud.notify) {
      window.VRCloud.notify({ kind: kind || "ok", title: head, body: title || "Balasan siap di VRCloud IDE", act: "ai", toast: hidden || kind === "warn" || kind === "err" });
    } else if (localStorage.getItem(NOTIFY_KEY) === "1" && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      try { var n = new Notification(head, { body: title || "Balasan siap di VRCloud IDE", tag: "vrcloud-ai" }); n.onclick = function () { window.focus(); setOpen(true); }; } catch (e) {}
    }
  }
  // Angka belum-dibaca ditampilkan satu kali: badge bel di status bar (lewat event
  // vrcloud-ai-status). Tombol AI di menubar hanya berkedip sebagai isyarat.
  function renderBadge() {
    emitAgentStatus();
    if (!toggleBtn) return;
    toggleBtn.classList.remove("pulse");
    if (unread) { void toggleBtn.offsetWidth; toggleBtn.classList.add("pulse"); }
  }
  function clearUnread() { if (unread) { unread = 0; renderBadge(); } emitAgentStatus(); }

  // ------------------------------------------------------ Pemakaian token
  // Ditampilkan di status bar IDE (item token) lewat event vrcloud-ai-status;
  // panel tidak mengulanginya di header.
  function fmtTok(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n); }
  function fmtCost(cents) { return typeof cents === "number" ? "$" + (cents / 100).toFixed(cents < 100 ? 3 : 2) : ""; }
  function renderUsage() { emitAgentStatus(); }

  function setupResize(handle) {
    var dragging = false;
    handle.addEventListener("mousedown", function (e) { dragging = true; e.preventDefault(); document.body.style.userSelect = "none"; });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var right = Math.max(280, Math.min(760, window.innerWidth - e.clientX));
      panel.style.width = right + "px";
      panel.classList.toggle("narrow", right < NARROW_W);
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = "";
      localStorage.setItem(WIDTH_KEY, parseInt(panel.style.width, 10) || 380);
    });
  }

  // ------------------------------------------------------------ Messages
  function nearBottom() { return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60; }
  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

  function clearEmpty() { var e = msgs.querySelector(".ai-empty"); if (e) e.remove(); }
  function showEmptyIfNeeded() {
    if (msgs.querySelector(".ai-msg") || msgs.querySelector(".ai-empty")) return;
    var e = el("div", "ai-empty");
    var big = el("div", "big"); big.appendChild(svgIcon("robot", 30)); e.appendChild(big);
    e.appendChild(el("div", null, "Beri tugas \u2014 agent menyusun rencana, mengedit file, menjalankan perintah, dan menyelesaikannya sendiri."));
    var tips = el("div", "tips");
    tips.innerHTML = "Kirim dengan <kbd>Enter</kbd> \u00b7 baris baru <kbd>Shift+Enter</kbd> \u00b7 buka/tutup <kbd>Alt+A</kbd> \u00b7 seret file ke sini untuk melampirkan";
    e.appendChild(tips);
    msgs.appendChild(e);
  }

  // Pesan pengguna; opsional gambar tempel dan tombol "Kembalikan ke sebelum pesan ini".
  function addUser(text, extra) {
    extra = extra || {};
    clearEmpty();
    var m = el("div", "ai-msg user");
    var card = el("div", "card");
    if (extra.skills && extra.skills.length) {
      var tags = el("div", "ai-sktags");
      extra.skills.forEach(function (n) { var t = el("span", "ai-sktag"); t.appendChild(svgIcon("skill", 10)); t.appendChild(document.createTextNode(n)); t.title = "Skill dipakai: " + n; tags.appendChild(t); });
      card.appendChild(tags);
    }
    card.appendChild(document.createTextNode(text || ""));
    if (extra.images && extra.images.length) {
      var wrap = el("div", "ai-imgs");
      extra.images.forEach(function (im) {
        var src = im.data ? ("data:" + (im.mimeType || "image/png") + ";base64," + im.data) : im.image;
        if (!src) return;
        var img = el("img"); img.src = src; img.alt = im.name || "gambar"; img.title = im.name || "";
        img.addEventListener("click", function () { window.open(src, "_blank"); });
        wrap.appendChild(img);
      });
      card.appendChild(wrap);
    }
    m.appendChild(card);
    if (extra.checkpoint) setUserCheckpoint(m, extra.checkpoint);
    msgs.appendChild(m);
    return m;
  }
  function setUserCheckpoint(m, hash) {
    if (!hash || !checkpointsOn || m.querySelector(".ai-restore")) return;
    var b = el("span", "ai-restore", "\u21b6 Kembalikan ke sebelum pesan ini");
    b.title = "Kembalikan seluruh workspace ke keadaan sebelum pesan ini (checkpoint " + hash.slice(0, 8) + ")";
    b.addEventListener("click", function (e) { e.stopPropagation(); restoreCheckpoint(hash, null, m); });
    m.appendChild(b);
  }
  function restoreCheckpoint(hash, relPath, anchorEl, opts) {
    opts = opts || {};
    var what = relPath ? "file " + relPath : "seluruh workspace";
    if (!opts.silent && !confirm("Kembalikan " + what + " ke checkpoint " + hash.slice(0, 8) + "?\nPerubahan setelah titik itu (oleh agent maupun Anda) akan ditimpa.")) {
      return Promise.resolve(null);
    }
    return apiJson("/api/ai/restore", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash: hash, path: relPath || undefined }) })
      .then(function (r) {
        if (!opts.quiet) {
          var n = (r.changed || []).length;
          var note = el("div", "ai-note-ok", "\u21b6 Dikembalikan: " + (n ? n + " file" + (relPath ? " (" + relPath + ")" : "") : "tidak ada perubahan"));
          if (anchorEl && anchorEl.parentNode) anchorEl.parentNode.insertBefore(note, anchorEl.nextSibling); else msgs.appendChild(note);
          setTimeout(function () { note.remove(); }, 6000);
        }
        return r;
      })
      .catch(function (e) { if (!opts.quiet) alert("Gagal mengembalikan: " + e.message); throw e; });
  }

  // Kartu rencana kerja (todo dari agent).
  var PLAN_ICON = { pending: "\u25cb", inProgress: "\u25d0", completed: "\u2713", cancelled: "\u2298" };
  function renderPlan(planEl, todos, live) {
    if (!planEl) return;
    todos = todos || [];
    if (!todos.length) { planEl.style.display = "none"; return; }
    planEl.style.display = "block";
    var done = 0, total = todos.length;
    todos.forEach(function (t) { if (t.status === "completed" || t.status === "cancelled") done++; });
    var hd = planEl.querySelector(".ai-plan-hd");
    hd.querySelector(".lbl").textContent = (live && done < total) ? "Rencana kerja" : "Rencana";
    hd.querySelector(".cnt").textContent = done + "/" + total;
    hd.querySelector(".bar i").style.width = Math.round(100 * done / total) + "%";
    var body = planEl.querySelector(".ai-plan-body"); body.innerHTML = "";
    todos.forEach(function (t) {
      var it = el("div", "ai-plan-it " + (t.status || "pending"));
      it.appendChild(el("span", "ic", PLAN_ICON[t.status] || PLAN_ICON.pending));
      it.appendChild(el("span", "tx", t.content || ""));
      body.appendChild(it);
    });
  }
  function makePlanEl() {
    var plan = el("div", "ai-plan"); plan.style.display = "none"; plan.setAttribute("data-open", "1");
    var hd = el("div", "ai-plan-hd");
    hd.appendChild(el("span", "chev", "\u25be"));
    hd.appendChild(el("span", "lbl", "Rencana"));
    var bar = el("span", "bar"); bar.appendChild(el("i")); hd.appendChild(bar);
    hd.appendChild(el("span", "cnt", ""));
    hd.addEventListener("click", function () { plan.setAttribute("data-open", plan.getAttribute("data-open") === "1" ? "0" : "1"); });
    plan.appendChild(hd);
    plan.appendChild(el("div", "ai-plan-body"));
    return plan;
  }

  // Pesan AI = alur kronologis blok (berpikir, aksi tool, teks, rencana,
  // penanda putaran) dalam urutan kejadian — bukan dikelompokkan per jenis.
  function addAi(live) {
    clearEmpty();
    var m = el("div", "ai-msg ai");
    var who = el("div", "who"); var wIco = el("span", "spark"); wIco.appendChild(svgIcon("robot", 12)); who.appendChild(wIco); who.appendChild(el("span", null, "VRCloud AI"));
    m.appendChild(who);
    var flow = el("div", "ai-flow"); m.appendChild(flow);
    var dots = null;
    if (live) {
      dots = el("div", "ai-wait"); var d = el("span", "ai-thinking"); d.appendChild(el("i")); d.appendChild(el("i")); d.appendChild(el("i"));
      dots.appendChild(d); flow.appendChild(dots);
    }
    msgs.appendChild(m);
    return { msg: m, flow: flow, dots: dots };
  }

  // Blok "Berpikir": header dulu; terbuka saat reasoning mengalir, lalu
  // dilipat jadi "Berpikir Ns" ketika agent beralih ke aksi/teks.
  function makeThinkEl() {
    var think = el("div", "ai-think"); think.setAttribute("data-open", "0");
    var thead = el("div", "ai-think-head");
    thead.appendChild(el("span", "chev", "\u25be"));
    var lbl = el("span", "lbl", "Berpikir\u2026"); thead.appendChild(lbl);
    thead.addEventListener("click", function () { think.setAttribute("data-user", "1"); think.setAttribute("data-open", think.getAttribute("data-open") === "1" ? "0" : "1"); });
    var tbody = el("div", "ai-think-body");
    think.appendChild(thead); think.appendChild(tbody);
    return { el: think, body: tbody, label: lbl, acc: "", has: false, start: Date.now() };
  }
  function makeTextEl() { return el("div", "body ai-md"); }
  // Baris aksi di bawah jawaban agent (muncul saat hover): salin teks jawaban.
  function addMsgActions(msgEl, getText) {
    if (!msgEl || msgEl.querySelector(".ai-acts")) return;
    var acts = el("div", "ai-acts");
    var cp = el("button", "ai-act"); cp.type = "button"; cp.title = "Salin jawaban";
    cp.appendChild(svgIcon("copy", 12)); cp.appendChild(el("span", null, "Salin"));
    cp.addEventListener("click", function () {
      var t = typeof getText === "function" ? getText() : String(getText || "");
      if (!t) return;
      copyText(t).then(function () { cp.classList.add("done"); cp.lastChild.textContent = "Tersalin"; setTimeout(function () { cp.classList.remove("done"); cp.lastChild.textContent = "Salin"; }, 1400); });
    });
    acts.appendChild(cp);
    msgEl.appendChild(acts);
  }
  function makeIterEl(n, max) { return el("div", "ai-iter", "\u21bb lanjut otomatis \u00b7 putaran " + n + "/" + max); }

  // Render markdown per segmen teks (RAF per elemen, aman untuk banyak segmen).
  function renderSeg(elm, text, streaming) {
    elm._txt = text; elm._stream = streaming;
    if (elm._raf) return;
    elm._raf = requestAnimationFrame(function () {
      elm._raf = 0;
      var stick = nearBottom();
      elm.innerHTML = renderMarkdown(elm._txt) + (elm._stream ? '<span class="ai-cursor"></span>' : "");
      highlightBlocks(elm);
      if (stick) scrollBottom();
    });
  }

  // Kartu persetujuan perintah berisiko (dari hook beforeShellExecution).
  var APPROVE_LABEL = { pending: "Perintah berisiko \u2014 perlu izin Anda", allowed: "Diizinkan", denied: "Ditolak", timeout: "Waktu habis \u2014 ditolak", stopped: "Dibatalkan", ended: "Dibatalkan" };
  // Buka file workspace di editor (opsional ke baris tertentu).
  function openInEditor(relPath, line) {
    var api = window.VRCloud;
    if (!api || !api.openFile || !relPath) return;
    try { api.openFile(relPath, line || undefined); } catch (e) {}
  }
  // Baris pertama yang berubah dari diff unified (@@ -a,b +c,d @@).
  function firstChangedLine(detail) {
    var lines = String(detail || "").split(/\r?\n/), cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], m = /^@@\s*-\d+(?:,\d+)?\s*\+(\d+)/.exec(l);
      if (m) { cur = parseInt(m[1], 10); continue; }
      if (cur == null) continue;
      if (l[0] === "+") return cur;               // baris pertama yang ditambah/diubah di file baru
      if (l[0] === "-") { if (i + 1 < lines.length && lines[i + 1][0] !== "-" && lines[i + 1][0] !== "+") return cur; continue; } // hanya penghapusan: posisi setelahnya
      if (l[0] === " " || l === "") cur++;
    }
    var h = /@@\s*-\d+(?:,\d+)?\s*\+(\d+)/.exec(String(detail || ""));
    return h ? parseInt(h[1], 10) : undefined;
  }

  // Kartu "Tinjau perubahan": daftar file, diff, Terima/Tolak per file & semua.
  var STATUS_LABEL = { A: "baru", M: "diubah", D: "dihapus", R: "dipindah", C: "disalin", T: "tipe" };
  function persistReview(data, review) {
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i] && history[i].role === "ai" && history[i].after === data.after) { history[i].review = review; break; }
    }
    saveHistory();
    if (!data.after) return;
    apiJson("/api/ai/review", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId(), after: data.after, review: review }) }).catch(function () {});
  }
  function makeChangesEl(data, opts) {
    opts = opts || {};
    var files = (data && data.files) || [];
    var review = Object.assign({}, opts.review || {});
    var box = el("div", "ai-changes");
    var added = 0, removed = 0;
    files.forEach(function (f) { added += f.added || 0; removed += f.removed || 0; });
    var hd = el("div", "ai-ch-hd");
    hd.appendChild(el("span", "chev", "\u25be"));
    hd.appendChild(el("span", "lbl", reviewOn ? "Tinjau perubahan" : "Perubahan"));
    var stEl = el("span", "st", files.length + " file"); hd.appendChild(stEl);
    var num = el("span", "st"); num.appendChild(el("span", "add", "+" + added)); num.appendChild(document.createTextNode(" ")); num.appendChild(el("span", "del", "\u2212" + removed)); hd.appendChild(num);
    hd.appendChild(el("span", "sp"));
    hd.addEventListener("click", function () {
      if (box.classList.contains("gone")) return;
      box._userToggle = true;
      box.setAttribute("data-open", box.getAttribute("data-open") === "1" ? "0" : "1");
    });
    box.appendChild(hd);
    var body = el("div", "ai-ch-body");
    var rows = [];
    var ftMsg = el("span", "msg");
    function note(text) { ftMsg.textContent = text || ""; }
    function counts() {
      var acc = 0, rej = 0;
      files.forEach(function (f) { if (review[f.path] === "accepted") acc++; else if (review[f.path] === "rejected") rej++; });
      return { acc: acc, rej: rej, pending: files.length - acc - rej };
    }
    function paintState() {
      var c = counts();
      box.classList.toggle("accepted", !!files.length && c.acc === files.length);
      box.classList.toggle("reviewed", !!files.length && c.pending === 0 && c.rej > 0);
      box.classList.toggle("pending-review", reviewOn && c.pending > 0);
      stEl.textContent = c.pending && reviewOn
        ? c.pending + " menunggu review"
        : files.length + " file";
      if (!box.getAttribute("data-open")) {
        if (reviewOn && c.pending > 0) box.setAttribute("data-open", "1");
        else box.setAttribute("data-open", (opts.collapsed && !reviewOn) ? "0" : "1");
      }
      rows.forEach(function (r) {
        var v = review[r.file.path];
        r.row.classList.toggle("accepted", v === "accepted");
        r.row.classList.toggle("rejected", v === "rejected");
        r.ok.textContent = v === "accepted" ? "\u2713" : "Terima";
        r.ok.title = v === "accepted" ? "Diterima" : "Terima perubahan file ini";
        r.no.textContent = v === "rejected" ? "Pulihkan" : "Tolak";
        r.no.title = v === "rejected" ? "Kembalikan versi agent" : "Tolak dan kembalikan file ke sebelum pesan";
        r.no.className = "bt " + (v === "rejected" ? "rev" : "nof");
        r.ok.className = "bt okf";
      });
    }
    // Buka file di editor tepat di baris pertama yang berubah (dari hunk diff).
    function jumpTo(r) {
      if (r.file.status === "D") return;
      if (r.line != null) { openInEditor(r.file.path, r.line || undefined); return; }
      if (!data.before || !data.after) { openInEditor(r.file.path); return; }
      apiJson("/api/ai/diff?from=" + encodeURIComponent(data.before) + "&to=" + encodeURIComponent(data.after) + "&path=" + encodeURIComponent(r.file.path), { credentials: "same-origin" })
        .then(function (res) { r.diff = res.diff || ""; r.line = firstChangedLine(r.diff) || 0; openInEditor(r.file.path, r.line || undefined); })
        .catch(function () { openInEditor(r.file.path); });
    }
    function loadDiff(r) {
      var diffEl = r.diffEl;
      var open = diffEl.classList.toggle("open");
      if (!open) { note(""); return; }
      jumpTo(r);
      if (diffEl.getAttribute("data-loaded")) return;
      diffEl.textContent = "Memuat diff\u2026";
      if (!data.before || !data.after) {
        diffEl.textContent = "Diff tidak tersedia (checkpoint hilang).";
        note("Diff tidak tersedia.");
        return;
      }
      apiJson("/api/ai/diff?from=" + encodeURIComponent(data.before) + "&to=" + encodeURIComponent(data.after) + "&path=" + encodeURIComponent(r.file.path), { credentials: "same-origin" })
        .then(function (res) { r.diff = res.diff || ""; if (r.line == null) r.line = firstChangedLine(r.diff) || 0; diffEl.innerHTML = ""; diffEl.setAttribute("data-loaded", "1"); renderDetail(diffEl, { name: "edit", detail: res.diff || "(tidak ada perbedaan)" }); note("Diff: " + r.file.path); })
        .catch(function (e2) { diffEl.textContent = "Gagal memuat diff: " + e2.message; note("Gagal memuat diff: " + e2.message); });
    }
    files.forEach(function (f) {
      var st = String(f.status || "M").charAt(0);
      var row = el("div", "ai-ch-row");
      var sc = el("span", "sc " + st, st); sc.title = STATUS_LABEL[st] || st; row.appendChild(sc);
      var p = el("span", "pth", f.path); p.title = (f.from ? f.from + " \u2192 " : "") + f.path; row.appendChild(p);
      var n = el("span", "num"); n.appendChild(el("span", "add", "+" + (f.added || 0))); n.appendChild(el("span", "del", "\u2212" + (f.removed || 0))); row.appendChild(n);
      var diffEl = el("div", "ai-ch-diff");
      var db = el("button", "bt"); db.type = "button"; db.textContent = "Diff"; db.title = "Lihat diff";
      var ok = el("button", "bt okf"); ok.type = "button"; ok.textContent = "Terima";
      var no = el("button", "bt nof"); no.type = "button"; no.textContent = "Tolak";
      var rec = { file: f, row: row, ok: ok, no: no, diffEl: diffEl, line: null };
      row.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest(".bt")) return;
        // Klik nama file: langsung lompat ke kode yang berubah; klik area lain: buka diff + lompat.
        if (e.target.closest && e.target.closest(".pth")) { jumpTo(rec); return; }
        loadDiff(rec);
      });
      p.title = (f.from ? f.from + " \u2192 " : "") + f.path + " \u2014 klik untuk membuka di baris yang berubah";
      db.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); loadDiff(rec); });
      ok.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); acceptFile(f); });
      no.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); rejectFile(f); });
      row.appendChild(db); row.appendChild(ok); row.appendChild(no);
      body.appendChild(row); body.appendChild(diffEl);
      rows.push(rec);
    });
    // Setelah keputusan: kartu diganti ringkasan hasil di tempat yang sama (file tetap bisa diklik
    // untuk lompat ke kodenya), header Tinjau tidak bisa dibuka lagi.
    function renderDone() {
      var c = counts();
      var old = box.querySelector(".ai-ch-done"); if (old) old.remove();
      var d = el("div", "ai-ch-done " + (c.rej && c.acc ? "mix" : c.rej ? "rej" : "ok"));
      d.appendChild(el("span", "ic", c.rej && !c.acc ? "\u21b6" : "\u2713"));
      var txt = c.rej && c.acc ? c.acc + " diterima, " + c.rej + " ditolak" : c.rej ? "Perubahan ditolak (" + c.rej + " file dikembalikan)" : "Perubahan diterima (" + c.acc + " file)";
      d.appendChild(el("span", "tx", txt));
      var fl = el("span", "files");
      rows.forEach(function (r) {
        var s = el("span", "f" + (review[r.file.path] === "rejected" ? " rej" : ""), r.file.path.split("/").pop());
        s.title = r.file.path + (review[r.file.path] === "rejected" ? " (dikembalikan)" : " \u2014 klik untuk membuka di baris yang berubah");
        if (review[r.file.path] !== "rejected") s.addEventListener("click", function () { jumpTo(r); });
        fl.appendChild(s);
      });
      d.appendChild(fl);
      box.appendChild(d);
    }
    function hideChanges() {
      box.classList.add("gone");
      box.setAttribute("data-open", "0");
      renderDone();
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i] && history[i].role === "ai" && history[i].after === data.after) {
          history[i].changesHidden = true;
          break;
        }
      }
      saveHistory();
    }
    function acceptFile(f) {
      if (review[f.path] === "rejected" && data.after) {
        restoreCheckpoint(data.after, f.path, box, { silent: true, quiet: true }).catch(function () {});
      }
      review[f.path] = "accepted";
      persistReview(data, review); paintState(); hideChanges();
      if (opts.onAccept) opts.onAccept(f.path);
    }
    function rejectFile(f) {
      if (review[f.path] === "rejected" && data.after) {
        restoreCheckpoint(data.after, f.path, box, { silent: true, quiet: true }).then(function () {
          review[f.path] = "accepted"; persistReview(data, review); paintState(); hideChanges();
        }).catch(function () { hideChanges(); });
        return;
      }
      review[f.path] = "rejected";
      persistReview(data, review); paintState(); hideChanges();
      if (data.before) restoreCheckpoint(data.before, f.path, box, { silent: true, quiet: true }).catch(function () {});
    }
    function acceptAll() {
      files.forEach(function (f) {
        if (review[f.path] === "rejected" && data.after) restoreCheckpoint(data.after, f.path, box, { silent: true, quiet: true }).catch(function () {});
        review[f.path] = "accepted";
      });
      persistReview(data, review); paintState(); hideChanges();
      if (opts.onAccept) opts.onAccept();
    }
    function rejectAll() {
      if (!files.length) return;
      if (!confirm("Tolak semua perubahan agent pada " + files.length + " file dan kembalikan ke sebelum pesan ini?")) return;
      files.forEach(function (f) {
        if (review[f.path] === "rejected") return;
        review[f.path] = "rejected";
        if (data.before) restoreCheckpoint(data.before, f.path, box, { silent: true, quiet: true }).catch(function () {});
      });
      persistReview(data, review); paintState(); hideChanges();
    }
    var ft = el("div", "ai-ch-ft");
    ft.appendChild(ftMsg);
    var noAll = el("button", "no", "Tolak semua"); noAll.type = "button"; noAll.title = "Kembalikan semua file ke sebelum pesan ini";
    noAll.addEventListener("click", function (e) { e.preventDefault(); rejectAll(); });
    var okAll = el("button", "ok", "Terima semua"); okAll.type = "button"; okAll.title = "Tandai semua file sudah ditinjau";
    okAll.addEventListener("click", function (e) { e.preventDefault(); acceptAll(); });
    ft.appendChild(noAll); ft.appendChild(okAll);
    body.appendChild(ft);
    box.appendChild(body);
    paintState();
    if (!box.getAttribute("data-open")) box.setAttribute("data-open", (opts.collapsed && !reviewOn) ? "0" : "1");
    if (files.length && counts().pending === 0) hideChanges();
    return box;
  }

  // Rentetan tool baca (read/grep/glob/ls/semSearch) dilipat jadi satu grup.
  var READ_TOOLS = { read: 1, grep: 1, glob: 1, ls: 1, semsearch: 1, readlints: 1 };
  function isReadTool(tool) { return !!READ_TOOLS[String(tool && tool.name || "").toLowerCase()]; }
  function groupReadStep(flow, st, tool) {
    if (!isReadTool(tool)) return;
    var prev = st.previousElementSibling;
    while (prev && prev.classList.contains("ai-wait")) prev = prev.previousElementSibling; // lewati indikator menunggu
    if (!prev) return;
    var grp = null;
    if (prev.classList.contains("ai-stepgroup")) grp = prev;
    else if (prev.classList.contains("ai-step") && prev.getAttribute("data-read") === "1") {
      grp = el("div", "ai-stepgroup");
      var hd = el("div", "ai-sg-hd");
      hd.appendChild(el("span", "ai-step-ic", "\u2713"));
      hd.appendChild(el("span", "cnt", ""));
      hd.appendChild(el("span", "names", ""));
      hd.appendChild(el("span", "ai-step-cvt", "\u203a"));
      hd.addEventListener("click", function () { grp.classList.toggle("open"); });
      grp.appendChild(hd);
      var bd = el("div", "ai-sg-body"); grp.appendChild(bd);
      flow.insertBefore(grp, prev);
      bd.appendChild(prev);
    } else return;
    grp.querySelector(".ai-sg-body").appendChild(st);
    var items = grp.querySelectorAll(".ai-sg-body > .ai-step");
    var names = Array.prototype.map.call(items, function (s) { var f = s.querySelector(".fname"); return f ? f.textContent : (s.querySelector("code") || {}).textContent || ""; }).filter(Boolean);
    grp.querySelector(".cnt").textContent = "Membaca " + items.length + " item";
    grp.querySelector(".names").textContent = names.join(", ");
    var running = Array.prototype.some.call(items, function (s) { return s.classList.contains("running"); });
    grp.querySelector(".ai-sg-hd .ai-step-ic").textContent = running ? "\u25cf" : "\u2713";
  }

  function makeApproveEl(p) {
    var box = el("div", "ai-approve"); box.setAttribute("data-id", p.id || "");
    var hd = el("div", "ai-approve-hd"); hd.appendChild(el("span", null, "\u26a0")); hd.appendChild(el("span", "lbl", "")); box.appendChild(hd);
    var pre = el("pre"); pre.textContent = p.command || ""; box.appendChild(pre);
    var ft = el("div", "ai-approve-ft");
    ft.appendChild(el("span", "why", p.pattern ? "cocok pola: " + p.pattern : ""));
    var ok = el("button", "ok", "Izinkan"); ok.type = "button";
    var no = el("button", "no", "Tolak"); no.type = "button";
    ok.addEventListener("click", function () { decide(true); }); no.addEventListener("click", function () { decide(false); });
    ft.appendChild(no); ft.appendChild(ok); box.appendChild(ft);
    function decide(allow) {
      ok.disabled = no.disabled = true;
      apiJson("/api/ai/approve", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, allow: allow }) }).catch(function () {});
    }
    var api = { el: box, set: function (status) {
      box.className = "ai-approve " + (status || "pending") + (status && status !== "pending" ? " done" : "");
      hd.querySelector(".lbl").textContent = APPROVE_LABEL[status] || status;
    } };
    api.set(p.status || "pending");
    return api;
  }

  // Replay blok tersimpan (dari server) ke dalam alur. ctx.before = hash checkpoint pesan.
  function renderBlocks(flow, blocks, ctx) {
    ctx = ctx || {};
    var stepMap = {};
    (blocks || []).forEach(function (b) {
      if (!b) return;
      if (b.type === "think") {
        if (!b.text) return;
        var th = makeThinkEl(); th.body.textContent = b.text; th.label.textContent = b.secs ? "Berpikir selama " + b.secs + " detik" : "Berpikir"; flow.appendChild(th.el);
      } else if (b.type === "text") {
        if (!b.text) return;
        var seg = makeTextEl(); seg.innerHTML = renderMarkdown(b.text); highlightBlocks(seg); flow.appendChild(seg);
      } else if (b.type === "tool" && b.tool) {
        var tl = b.tool;
        if (tl.status === "running") tl = Object.assign({}, tl, { status: "error", meta: Object.assign({}, tl.meta || {}, { unfinished: true }) });
        var key = tl.callId || ("k" + Object.keys(stepMap).length), fresh = !stepMap[key];
        renderStep(flow, tl, stepMap, ctx.before);
        if (fresh) { groupReadStep(flow, stepMap[key], tl); groupBrowserStep(flow, stepMap[key], tl); groupDesktopStep(flow, stepMap[key], tl); }
      } else if (b.type === "plan" && b.todos && b.todos.length) {
        var pe = makePlanEl(); flow.appendChild(pe); renderPlan(pe, b.todos, false); pe.setAttribute("data-open", "1"); // rencana selalu terlihat
      } else if (b.type === "iter") {
        flow.appendChild(makeIterEl(b.n, b.max));
      } else if (b.type === "approval") {
        var ap = makeApproveEl(b); if (b.status === "pending") ap.set("ended"); flow.appendChild(ap.el);
      }
    });
  }

  var DESKTOP_VERB = { desktop_screenshot: "Screenshot layar", desktop_click: "Klik", desktop_drag: "Menyeret", desktop_move: "Geser kursor", desktop_type: "Mengetik", desktop_key: "Tekan tombol", desktop_scroll: "Menggulir", desktop_wait: "Menunggu UI", desktop_setup: "Menyiapkan desktop" };
  function toolVerb(name, tool) {
    if (String(name || "").toLowerCase() === "mcp") {
      var dv = DESKTOP_VERB[String(tool || "").toLowerCase()];
      if (dv) return dv;
      return "Tool " + (tool || "MCP");
    }
    switch (String(name || "").toLowerCase()) {
      case "shell": return "Menjalankan";
      case "edit": case "applyagentdiff": return "Mengedit";
      case "write": case "create": return "Menulis";
      case "delete": return "Menghapus";
      case "read": return "Membaca";
      case "ls": return "Melihat";
      case "grep": case "glob": case "semsearch": return "Mencari";
      case "webfetch": return "Mengambil";
      case "websearch": return "Menelusuri web";
      case "readlints": return "Cek lint";
      case "updatetodos": case "readtodos": return "Todo";
      case "generateimage": return "Membuat gambar";
      case "task": return "Subagent";
      default: return name || "Alat";
    }
  }
  function stepClass(s) { return "ai-step " + (s === "completed" ? "done" : s === "error" ? "err" : "running"); }
  // Lipat kartu langkah yang sudah selesai (kecuali yang dibuka pengguna atau `except`).
  function collapseSteps(flow, except) {
    if (!flow) return;
    flow.querySelectorAll(".ai-step.open").forEach(function (s) {
      if (s === except || s.classList.contains("running") || s.getAttribute("data-useropen") === "1") return;
      s.classList.remove("open");
    });
  }
  function stepIcon(s) { return s === "completed" ? "\u2713" : s === "error" ? "\u2717" : "\u25cf"; }
  function basename(p) { p = String(p || ""); var i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i >= 0 ? p.slice(i + 1) : p; }
  function renderDetail(dt, tool) {
    dt.innerHTML = "";
    var name = String(tool.name || "").toLowerCase();
    var text = String(tool.detail || "");
    if (name === "shell") {
      var term = el("div", "ai-term");
      text.split("\n").forEach(function (line) {
        var l = el("div", "tl"); if (line.indexOf("$ ") === 0) l.className = "tl cmd"; l.textContent = line || " "; term.appendChild(l);
      });
      dt.appendChild(term); return;
    }
    if (name === "edit" || name === "applyagentdiff" || /^(---|\+\+\+|@@)/.test(text)) {
      var diff = el("div", "ai-diff");
      text.split("\n").forEach(function (line) {
        var l = el("div", "l"), c = line.charAt(0);
        if (line.indexOf("+++") === 0 || line.indexOf("---") === 0) l.className = "l meta";
        else if (line.indexOf("@@") === 0) l.className = "l hunk";
        else if (c === "+") l.className = "l add";
        else if (c === "-") l.className = "l del";
        l.textContent = line || " "; diff.appendChild(l);
      });
      dt.appendChild(diff); return;
    }
    var pre = el("pre"); pre.textContent = text; dt.appendChild(pre);
  }
  var EDIT_TOOLS = { edit: 1, write: 1, create: 1, delete: 1, applyagentdiff: 1, multiedit: 1 };
  // Deteksi server lokal dari perintah/output shell → URL preview (0.0.0.0/:: dinormalkan ke 127.0.0.1).
  function detectLocalUrl(text) {
    text = String(text || "");
    var m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))?(\/[^\s"'<>)\]]*)?/i.exec(text);
    if (m) return "http://127.0.0.1" + (m[1] ? ":" + m[1] : "") + (m[2] || "");
    var p = /(?:port\s*[:=]?\s*|localhost:|127\.0\.0\.1:|--port[= ]|-p\s+|PORT=)(\d{2,5})\b/i.exec(text) || /http\.server\s+(\d{2,5})\b/.exec(text) || /(?:serve|dev|start)\b[^\n]*?\b(\d{4,5})\b/.exec(text);
    if (p) { var port = parseInt(p[1], 10); var own = Number(location.port || (location.protocol === "https:" ? 443 : 80)); if (port >= 80 && port <= 65535 && port !== own) return "http://127.0.0.1:" + port; }
    return "";
  }
  // Path relatif workspace dari summary tool (bisa absolut di beberapa event).
  function relPathOf(p) {
    p = String(p || "").replace(/\\/g, "/");
    var ws = (window.VRCLOUD_INFO && window.VRCLOUD_INFO.workspace) || "";
    if (ws) { ws = String(ws).replace(/\\/g, "/").replace(/\/+$/, ""); if (p.toLowerCase().indexOf(ws.toLowerCase() + "/") === 0) p = p.slice(ws.length + 1); }
    return p.replace(/^\.\//, "");
  }
  function renderStep(container, tool, map, before) {
    var key = tool.callId || ("k" + Object.keys(map).length);
    var st = map[key];
    if (!st) {
      st = el("div", "ai-step");
      var hd = el("div", "ai-step-hd");
      hd.appendChild(el("span", "ai-step-ic"));
      hd.appendChild(el("span", "ai-step-txt"));
      // Kembalikan per file hanya lewat kartu "Perubahan" (punya diff/konteks) — tidak diulang di tiap kartu tool.
      hd.appendChild(el("span", "ai-step-cvt", "\u203a"));
      st.appendChild(hd);
      st.appendChild(el("div", "ai-step-detail"));
      hd.addEventListener("click", function () {
        if (st.getAttribute("data-has") !== "1") return;
        var open = st.classList.toggle("open");
        st.setAttribute("data-userclosed", open ? "0" : "1");
        st.setAttribute("data-useropen", open ? "1" : "0"); // dibuka pengguna: jangan dilipat otomatis
      });
      container.appendChild(st); map[key] = st;
    }
    var openState = st.classList.contains("open");
    st.className = stepClass(tool.status) + (openState ? " open" : "");
    st.querySelector(".ai-step-ic").textContent = stepIcon(tool.status);
    var tx = st.querySelector(".ai-step-txt"); tx.innerHTML = "";
    var lname = String(tool.name || "").toLowerCase();
    if (lname === "mcp" && tool.meta && tool.meta.isError && tool.status === "completed") st.className = "ai-step err" + (openState ? " open" : "");
    tx.appendChild(el("span", "verb", toolVerb(tool.name, tool.tool)));
    st.setAttribute("data-read", READ_TOOLS[lname] ? "1" : "0");
    if (lname === "shell") {
      st.setAttribute("data-shell", "1"); // dipakai indikator "terminal berjalan" di atas composer
      if (tool.meta && tool.meta.background) { st.classList.add("bg"); st.setAttribute("data-bg", "1"); tx.querySelector(".verb").textContent = "Background shell"; }
      if (tool.meta && tool.meta.pid) st.setAttribute("data-pid", String(tool.meta.pid)); else st.removeAttribute("data-pid");
      if (tool.summary) { var c = el("code"); c.textContent = tool.summary; tx.appendChild(c); }
      if (tool.meta && tool.meta.denied) tx.appendChild(el("span", "tool-tag", "ditolak"));
      else if (tool.meta && tool.meta.unfinished) tx.appendChild(el("span", "tool-tag", "tidak selesai"));
      else if (tool.meta && tool.meta.background) tx.appendChild(el("span", "tool-tag bg", tool.status === "running" ? "berjalan" : "latar belakang"));
      else if (tool.meta && typeof tool.meta.exit === "number" && tool.meta.exit !== 0) tx.appendChild(el("span", "tool-tag", "exit " + tool.meta.exit));
      // Buka tab "Agent shell" (view-only) yang mencerminkan output perintah ini.
      if (window.VRCloud && window.VRCloud.showAgentShell) {
        var shBtn = el("span", "ai-step-run ashell", "\u25a3"); shBtn.title = "Lihat di tab Agent shell (view-only)";
        shBtn.addEventListener("click", function (e) { e.stopPropagation(); window.VRCloud.showAgentShell(sessionId()); });
        tx.appendChild(shBtn);
      }
      // Server dev terdeteksi (URL/port lokal di perintah atau output) → buka preview di tab Browser agent.
      var pvUrl = detectLocalUrl((tool.summary || "") + "\n" + (tool.detail || ""));
      if (pvUrl && window.VRCloud && window.VRCloud.openPreview) {
        var pvBtn = el("span", "ai-step-run preview", "Preview \u25b8"); pvBtn.title = "Buka " + pvUrl + " di tab Browser agent";
        pvBtn.addEventListener("click", function (e) { e.stopPropagation(); window.VRCloud.openPreview(pvUrl); });
        tx.appendChild(pvBtn);
      }
      if (tool.summary && window.VRCloud && window.VRCloud.runInTerminal) {
        var runBtn = el("span", "ai-step-run", "\u25b6"); runBtn.title = "Jalankan perintah ini di terminal IDE";
        runBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          var ok = window.VRCloud.runInTerminal(tool.summary);
          setHint(ok ? "Dikirim ke terminal IDE." : "Tidak ada terminal aktif — buka terminal dulu.");
        });
        tx.appendChild(runBtn);
      }
    } else if (lname === "mcp" && isBrowserTool(tool)) {
      // Kartu browser (gaya ChatGPT): ikon globe + aksi + target, lalu bingkai browser
      // dengan bilah alamat dan screenshot di bagian detail.
      st.classList.add("browser");
      var bt = String((tool.meta && tool.meta.browserTool) || tool.tool || "").replace(/^browser_/i, "");
      var tabAct = bt === "tabs" && tool.meta && tool.meta.browser && tool.meta.browser.args ? tool.meta.browser.args.action : "";
      tx.querySelector(".verb").textContent = (tabAct && TAB_VERB[tabAct]) || BROWSER_VERB[bt] || ("Browser " + bt);
      tx.insertBefore(svgIcon("globe", 12), tx.firstChild);
      var bTarget = browserTarget(tool, bt);
      if (bTarget) { var bc = el("code"); bc.textContent = bTarget; tx.appendChild(bc); }
      if (tool.meta && tool.meta.isError) tx.appendChild(el("span", "tool-tag", "gagal"));
      else if (tool.status === "running") tx.appendChild(el("span", "tool-tag", "browser bekerja\u2026"));
    } else if (lname === "mcp") {
      if (tool.summary) { var mc = el("code"); mc.textContent = tool.summary; tx.appendChild(mc); }
      if (tool.meta && tool.meta.isError) tx.appendChild(el("span", "tool-tag", "gagal"));
    } else {
      var fn = el("span", "fname", basename(tool.summary || "")); fn.title = (tool.summary || "") + " \u2014 klik untuk membuka di editor"; tx.appendChild(fn);
      var openPath = relPathOf(tool.summary || "");
      if (openPath && lname !== "delete" && !/[*?]/.test(openPath) && lname !== "grep" && lname !== "glob" && lname !== "semsearch" && lname !== "ls") {
        fn.addEventListener("click", function (e) { e.stopPropagation(); openInEditor(openPath, EDIT_TOOLS[lname] ? firstChangedLine(tool.detail) : undefined); });
      } else fn.style.cursor = "default";
      if (tool.meta) {
        if (tool.meta.added) tx.appendChild(el("span", "badge add", "+" + tool.meta.added));
        if (tool.meta.removed) tx.appendChild(el("span", "badge del", "-" + tool.meta.removed));
      }
    }
    var dt = st.querySelector(".ai-step-detail");
    var bstep = lname === "mcp" && isBrowserTool(tool) && tool.meta && tool.meta.browser;
    if (bstep) st.__bstep = bstep; // dipakai tombol "Playwright" di kartu Menjelajah web
    var dshot = tool.meta && tool.meta.desktopShot; // screenshot dari tool desktop_*
    if (tool.detail || bstep || dshot) {
      renderDetail(dt, tool);
      if (bstep) dt.insertBefore(makeBrowserFrame(bstep), dt.firstChild);
      if (dshot) dt.insertBefore(makeDesktopFrame(dshot), dt.firstChild);
      st.setAttribute("data-has", "1");
      // Terbuka selama langkah berjalan (progres terlihat); setelah agent lanjut, dilipat otomatis
      // oleh collapseSteps(). Replay riwayat: terlipat (lihat renderBlocks).
      if (st.getAttribute("data-userclosed") !== "1" && !openState && tool.status === "running") st.classList.add("open");
    } else { st.removeAttribute("data-has"); dt.innerHTML = ""; }
    // Langkah browser yang sudah dilipat ke kartu "Menjelajah web": segarkan kartunya.
    var bgrp = st.parentElement && st.parentElement.classList.contains("ai-browse-src") ? st.parentElement.parentElement.parentElement : null;
    if (bgrp) { if (bgrp.classList.contains("ai-desktop")) syncDesktopGroup(bgrp); else syncBrowserGroup(bgrp); }
  }

  // ---- Kartu browser (tool browser_* dari otomasi CDP) ----
  var BROWSER_VERB = { navigate: "Membuka", tabs: "Tab", click: "Klik", hover: "Hover", type: "Mengetik", select: "Memilih", upload: "Mengunggah", drag: "Menyeret",
    press_key: "Tekan tombol", scroll: "Menggulir", screenshot: "Screenshot", snapshot: "Membaca halaman", extract: "Mengekstrak", console: "Console browser",
    network: "Network browser", evaluate: "Menjalankan JS", wait: "Menunggu", request_user: "Minta bantuan Anda", secrets: "Rahasia tersimpan", emulate: "Emulasi perangkat",
    download: "Mengunduh", pdf: "Menyimpan PDF", back: "Kembali", close: "Menutup browser" };
  var TAB_VERB = { list: "Daftar tab", new: "Tab baru", switch: "Pindah tab", close: "Tutup tab" };
  function isBrowserTool(tool) { return /^browser_/i.test(String((tool.meta && tool.meta.browserTool) || tool.tool || "")); }
  function isDesktopTool(tool) { return /^desktop_/i.test(String((tool && tool.tool) || "")) || !!(tool && tool.meta && tool.meta.desktopShot); }
  function browserTarget(tool, bt) {
    var s = tool.summary || "";
    var b = tool.meta && tool.meta.browser;
    var a = (b && b.args) || {};
    if (bt === "navigate") return (b && b.url) || s;
    if (bt === "click" || bt === "type" || bt === "hover" || bt === "select" || bt === "upload" || bt === "drag") return a.target || a.ref || a.text_match || a.selector || s;
    if (bt === "scroll") return a.target || a.ref || a.selector || a.direction || s;
    if (bt === "tabs") return a.action ? (a.id ? "#" + a.id : "") + (a.url ? (a.id ? " " : "") + a.url : "") : s;
    if (bt === "download" || bt === "pdf") return a.file || a.url || a.target || s;
    if (bt === "emulate") return a.device || (a.width ? a.width + "x" + a.height : "") || a.locale || a.timezone || s;
    if (bt === "extract") return a.format || "markdown";
    if (bt === "request_user") return a.message || s;
    if (bt === "press_key") return s;
    if (bt === "evaluate") return s.length > 60 ? s.slice(0, 60) + "\u2026" : s;
    return "";
  }
  var WALL_LABEL = { captcha: "CAPTCHA / verifikasi manusia", login: "Halaman login" };
  // Tautan "Ambil alih" → tab Browser agent dalam mode kendali pengguna.
  function takeoverLink() {
    var lk = el("span", "ai-link", "Ambil alih di tab Browser agent");
    lk.addEventListener("click", function (e) { e.stopPropagation(); if (window.VRCloud && window.VRCloud.showBrowserAgent) window.VRCloud.showBrowserAgent(true); });
    return lk;
  }
  // Bingkai screenshot desktop (tool desktop_*): gambar layar server; klik = buka ukuran penuh.
  function makeDesktopFrame(src) {
    var f = el("div", "ai-browser");
    var bar = el("div", "ab");
    bar.appendChild(svgIcon("desktop", 10));
    bar.appendChild(el("span", "url", "Remote desktop"));
    f.appendChild(bar);
    var im = document.createElement("img"); im.src = src; im.alt = "Desktop"; im.loading = "lazy";
    im.addEventListener("click", function (e) { e.stopPropagation(); window.open(src, "_blank"); });
    f.appendChild(im);
    return f;
  }

  // Bingkai mini browser: bilah alamat (judul + URL) dan screenshot; klik gambar = buka ukuran penuh.
  function makeBrowserFrame(b) {
    var f = el("div", "ai-browser");
    var bar = el("div", "ab");
    bar.appendChild(svgIcon("lock", 10));
    var u = el("span", "url", b.url || "about:blank"); u.title = b.url || ""; bar.appendChild(u);
    if (b.title) bar.appendChild(el("span", "ttl", b.title));
    if (b.tab && b.tabs > 1) bar.appendChild(el("span", "tab", "tab #" + b.tab)); // hanya bila agent memakai >1 tab
    f.appendChild(bar);
    if (b.wall) { var w = el("div", "ai-browser-wall"); w.appendChild(el("span", null, "\u26a0 " + (WALL_LABEL[b.wall] || b.wall) + " terdeteksi. ")); w.appendChild(takeoverLink()); f.appendChild(w); }
    if (b.shot) {
      var img = el("img"); img.src = b.shot; img.alt = b.title || b.url || "screenshot"; img.loading = "lazy";
      img.addEventListener("click", function (e) { e.stopPropagation(); window.open(b.shot, "_blank"); });
      f.appendChild(img);
    }
    return f;
  }

  // Rentetan langkah browser dilipat jadi satu kartu "Menjelajah web" (gaya ChatGPT):
  // bingkai besar untuk langkah terpilih + daftar langkah bernomor dengan thumbnail.
  // Kartu .ai-step.browser asli tetap ada (tersembunyi) sebagai sumber data.
  function groupBrowserStep(flow, st, tool) {
    if (!st || !isBrowserTool(tool)) return;
    var prev = st.previousElementSibling;
    while (prev && prev.classList.contains("ai-wait")) prev = prev.previousElementSibling;
    var grp = null;
    if (prev && prev.classList.contains("ai-browse") && !prev.classList.contains("ai-desktop")) grp = prev;
    else {
      grp = el("div", "ai-browse open");
      var hd = el("div", "ai-browse-hd");
      hd.appendChild(svgIcon("globe", 13));
      hd.appendChild(el("span", "lbl", "Menjelajah web"));
      hd.appendChild(el("span", "cnt", ""));
      hd.appendChild(el("span", "sites", ""));
      // Ekspor rentetan langkah ini jadi skrip Playwright (.spec.js) yang bisa dijalankan ulang.
      var pwBtn = el("span", "ai-browse-pw", "Playwright"); pwBtn.title = "Ekspor langkah browsing ini menjadi skrip Playwright Test di workspace";
      pwBtn.addEventListener("click", function (e) { e.stopPropagation(); exportBrowsePlaywright(grp, pwBtn); });
      hd.appendChild(pwBtn);
      hd.appendChild(el("span", "ai-step-cvt", "\u203a"));
      hd.addEventListener("click", function () { grp.classList.toggle("open"); });
      grp.appendChild(hd);
      var body = el("div", "ai-browse-body");
      var main = el("div", "ai-browse-main");
      var bar = el("div", "ab"); bar.appendChild(svgIcon("lock", 10)); bar.appendChild(el("span", "url", "")); bar.appendChild(el("span", "ttl", "")); main.appendChild(bar);
      main.appendChild(el("div", "ai-browse-wall"));
      var img = el("img"); img.alt = "screenshot"; img.addEventListener("click", function (e) { e.stopPropagation(); if (img.src) window.open(img.src, "_blank"); }); main.appendChild(img);
      main.appendChild(el("div", "ai-browse-noshot", "Langkah ini tidak menghasilkan screenshot."));
      body.appendChild(main);
      body.appendChild(el("ol", "ai-browse-steps"));
      body.appendChild(el("div", "ai-browse-detail"));
      body.appendChild(el("div", "ai-browse-src"));
      grp.appendChild(body);
      flow.insertBefore(grp, st);
    }
    grp.querySelector(".ai-browse-src").appendChild(st);
    syncBrowserGroup(grp);
  }
  function exportBrowsePlaywright(grp, btn) {
    var steps = Array.prototype.map.call(grp.querySelectorAll(".ai-browse-src .ai-step"), function (s) { return s.__bstep; }).filter(Boolean)
      .map(function (b) { return { action: b.action, url: b.url, title: b.title, args: b.args || {} }; });
    if (!steps.length) { setHint("Tidak ada langkah yang bisa diekspor."); return; }
    if (btn) btn.classList.add("busy");
    apiJson("/api/ai/browser/script", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: steps }) })
      .then(function (r) { setHint("Skrip Playwright tersimpan: " + r.path + " (" + r.steps + " langkah)"); openInEditor(r.path); })
      .catch(function (e) { setHint("Gagal ekspor: " + e.message); })
      .then(function () { if (btn) btn.classList.remove("busy"); });
  }
  function stepBrowserMeta(step) {
    var fr = step.querySelector(".ai-browser");
    var img = fr && fr.querySelector("img");
    var u = fr && fr.querySelector(".url");
    var b = step.__bstep || {};
    return { shot: b.shot || (img ? img.getAttribute("src") : "") || "", shotError: b.shotError || "", url: b.url || (u ? u.textContent : ""), title: b.title || (fr && fr.querySelector(".ttl") || {}).textContent || "", wall: fr && fr.querySelector(".ai-browser-wall"), text: (step.querySelector(".ai-step-txt") || {}).textContent || "", status: step.classList.contains("running") ? "running" : step.classList.contains("err") || step.classList.contains("error") ? "error" : "done", pre: step.querySelector(".ai-step-detail pre") };
  }
  function syncBrowserGroup(grp) {
    var steps = grp.querySelectorAll(".ai-browse-src > .ai-step");
    var list = grp.querySelector(".ai-browse-steps");
    var sel = Number(grp.getAttribute("data-sel") || -1);
    var follow = grp.getAttribute("data-follow") !== "0";
    var sites = {}, running = false, lastShot = -1;
    list.innerHTML = "";
    Array.prototype.forEach.call(steps, function (step, i) {
      var m = stepBrowserMeta(step);
      if (m.status === "running") running = true;
      if (m.shot) lastShot = i;
      try { if (m.url && /^https?:/.test(m.url)) sites[new URL(m.url).hostname.replace(/^www\./, "")] = 1; } catch (e) {}
      var li = el("li", "ai-browse-step " + m.status + (i === sel ? " sel" : ""));
      li.appendChild(el("span", "ic", m.status === "running" ? "\u25cf" : m.status === "error" ? "\u2717" : "\u2713"));
      var tx = el("span", "tx", m.text.replace(/browser bekerja\u2026$/, "").trim()); tx.title = m.url || ""; li.appendChild(tx);
      if (m.wall) li.appendChild(el("span", "tool-tag warn", (m.wall.textContent.indexOf("CAPTCHA") !== -1 ? "CAPTCHA" : "login")));
      if (m.shot) { var th = el("img", "th"); th.src = m.shot; th.loading = "lazy"; li.appendChild(th); }
      li.addEventListener("click", function (e) {
        e.stopPropagation();
        var again = Number(grp.getAttribute("data-sel")) === i;
        grp.setAttribute("data-sel", String(i)); grp.setAttribute("data-follow", "0");
        grp.classList.toggle("detail", again ? !grp.classList.contains("detail") : grp.classList.contains("detail"));
        syncBrowserGroup(grp);
      });
      list.appendChild(li);
    });
    if (follow || sel < 0 || sel >= steps.length) { sel = lastShot >= 0 ? lastShot : steps.length - 1; grp.setAttribute("data-sel", String(sel)); }
    grp.querySelector(".cnt").textContent = steps.length + " langkah";
    grp.querySelector(".sites").textContent = Object.keys(sites).slice(0, 3).join(", ") + (Object.keys(sites).length > 3 ? " +" + (Object.keys(sites).length - 3) : "");
    grp.classList.toggle("running", running);
    grp.querySelector(".lbl").textContent = running ? "Menjelajah web\u2026" : "Menjelajah web";
    // Bingkai utama = langkah terpilih.
    var cur = steps[sel]; var main = grp.querySelector(".ai-browse-main");
    if (cur) {
      var cm = stepBrowserMeta(cur);
      main.querySelector(".url").textContent = cm.url || ""; main.querySelector(".url").title = cm.url || "";
      main.querySelector(".ttl").textContent = cm.title || "";
      var mi = main.querySelector("img");
      var shown = cm.shot;
      if (!shown) { for (var j = sel; j >= 0; j--) { var older = stepBrowserMeta(steps[j]); if (older.shot) { shown = older.shot; break; } } }
      var noshot = main.querySelector(".ai-browse-noshot");
      if (shown) { if (mi.getAttribute("src") !== shown) mi.src = shown; mi.style.display = ""; noshot.style.display = "none"; }
      else { mi.removeAttribute("src"); mi.style.display = "none"; noshot.textContent = cm.shotError ? ("Screenshot gagal: " + cm.shotError) : "Langkah ini tidak menghasilkan screenshot."; noshot.style.display = ""; }
      var wl = main.querySelector(".ai-browse-wall"); wl.innerHTML = "";
      if (cm.wall) { wl.appendChild(el("span", null, cm.wall.firstChild ? cm.wall.firstChild.textContent : "")); wl.appendChild(takeoverLink()); wl.style.display = ""; } else wl.style.display = "none";
      var det = grp.querySelector(".ai-browse-detail");
      det.textContent = cm.pre ? cm.pre.textContent : "";
      det.style.display = cm.pre && cm.pre.textContent && grp.classList.contains("detail") ? "block" : "none";
    }
    var selEl = list.children[sel]; if (selEl && follow) selEl.scrollIntoView({ block: "nearest" });
  }

  // ---- Kartu "Mengendalikan komputer" (tool desktop_*): computer-use gaya GrokBot ----
  // Rentetan langkah desktop dilipat jadi satu kartu dengan tampilan layar besar (live) +
  // daftar langkah bernomor + thumbnail. Reuse gaya .ai-browse.
  function groupDesktopStep(flow, st, tool) {
    if (!st || !isDesktopTool(tool)) return;
    var prev = st.previousElementSibling;
    while (prev && prev.classList.contains("ai-wait")) prev = prev.previousElementSibling;
    var grp = null;
    if (prev && prev.classList.contains("ai-desktop")) grp = prev;
    else {
      grp = el("div", "ai-browse ai-desktop open");
      var hd = el("div", "ai-browse-hd");
      hd.appendChild(svgIcon("desktop", 13));
      hd.appendChild(el("span", "lbl", "Mengendalikan komputer"));
      hd.appendChild(el("span", "cnt", ""));
      hd.appendChild(el("span", "sites", ""));
      hd.appendChild(el("span", "ai-step-cvt", "\u203a"));
      hd.addEventListener("click", function () { grp.classList.toggle("open"); });
      grp.appendChild(hd);
      var body = el("div", "ai-browse-body");
      var main = el("div", "ai-browse-main");
      var bar = el("div", "ab"); bar.appendChild(svgIcon("desktop", 10)); bar.appendChild(el("span", "url", "Remote desktop")); main.appendChild(bar);
      var img = el("img"); img.alt = "desktop"; img.addEventListener("click", function (e) { e.stopPropagation(); if (img.src) window.open(img.src, "_blank"); }); main.appendChild(img);
      main.appendChild(el("div", "ai-browse-noshot", "Langkah ini tidak menghasilkan screenshot."));
      body.appendChild(main);
      body.appendChild(el("ol", "ai-browse-steps"));
      body.appendChild(el("div", "ai-browse-detail"));
      body.appendChild(el("div", "ai-browse-src"));
      grp.appendChild(body);
      flow.insertBefore(grp, st);
    }
    grp.querySelector(".ai-browse-src").appendChild(st);
    syncDesktopGroup(grp);
  }
  function stepDesktopMeta(step) {
    var fr = step.querySelector(".ai-browser");
    var img = fr && fr.querySelector("img");
    return { shot: img ? img.getAttribute("src") : "", text: (step.querySelector(".ai-step-txt") || {}).textContent || "", status: step.classList.contains("running") ? "running" : (step.classList.contains("err") || step.classList.contains("error")) ? "error" : "done", pre: step.querySelector(".ai-step-detail pre") };
  }
  function syncDesktopGroup(grp) {
    var steps = grp.querySelectorAll(".ai-browse-src > .ai-step");
    var list = grp.querySelector(".ai-browse-steps");
    var sel = Number(grp.getAttribute("data-sel") || -1);
    var follow = grp.getAttribute("data-follow") !== "0";
    var running = false, lastShot = -1;
    list.innerHTML = "";
    Array.prototype.forEach.call(steps, function (step, i) {
      var m = stepDesktopMeta(step);
      if (m.status === "running") running = true;
      if (m.shot) lastShot = i;
      var li = el("li", "ai-browse-step " + m.status + (i === sel ? " sel" : ""));
      li.appendChild(el("span", "ic", m.status === "running" ? "\u25cf" : m.status === "error" ? "\u2717" : "\u2713"));
      li.appendChild(el("span", "tx", m.text));
      if (m.shot) { var th = el("img", "th"); th.src = m.shot; th.loading = "lazy"; li.appendChild(th); }
      li.addEventListener("click", function (e) {
        e.stopPropagation();
        var again = Number(grp.getAttribute("data-sel")) === i;
        grp.setAttribute("data-sel", String(i)); grp.setAttribute("data-follow", "0");
        grp.classList.toggle("detail", again ? !grp.classList.contains("detail") : grp.classList.contains("detail"));
        syncDesktopGroup(grp);
      });
      list.appendChild(li);
    });
    if (follow || sel < 0 || sel >= steps.length) { sel = lastShot >= 0 ? lastShot : steps.length - 1; grp.setAttribute("data-sel", String(sel)); }
    grp.querySelector(".cnt").textContent = steps.length + " langkah";
    grp.classList.toggle("running", running);
    grp.querySelector(".lbl").textContent = running ? "Mengendalikan komputer\u2026" : "Mengendalikan komputer";
    var cur = steps[sel]; var main = grp.querySelector(".ai-browse-main");
    if (cur) {
      var cm = stepDesktopMeta(cur);
      var mi = main.querySelector("img");
      if (cm.shot) { if (mi.getAttribute("src") !== cm.shot) mi.src = cm.shot; mi.style.display = ""; main.querySelector(".ai-browse-noshot").style.display = "none"; }
      else { mi.removeAttribute("src"); mi.style.display = "none"; main.querySelector(".ai-browse-noshot").style.display = ""; }
      var det = grp.querySelector(".ai-browse-detail");
      det.textContent = cm.pre ? cm.pre.textContent : "";
      det.style.display = cm.pre && cm.pre.textContent && grp.classList.contains("detail") ? "block" : "none";
    }
    var selEl = list.children[sel]; if (selEl && follow) selEl.scrollIntoView({ block: "nearest" });
  }

  function addNote(text, withSettingsLink) {
    var m = el("div", "ai-msg note");
    var card = el("div", "card", text);
    if (withSettingsLink) {
      card.appendChild(document.createElement("br"));
      var link = el("span", "ai-link", "\u2699 Atur API key di sini");
      link.addEventListener("click", openSettings);
      card.appendChild(link);
    }
    m.appendChild(card);
    msgs.appendChild(m);
    return m;
  }

  function renderConversation() {
    msgs.innerHTML = "";
    var lastCheckpoint = null;
    history.forEach(function (h) {
      if (h.role === "user") { lastCheckpoint = h.checkpoint || null; addUser(h.text, { images: h.images, checkpoint: h.checkpoint, skills: h.skills }); }
      else if (h.role === "ai") {
        var a = addAi(false);
        var ctx = { before: h.before || lastCheckpoint };
        renderBlocks(a.flow, blocksOf(h), ctx);
        if (h.changes && h.changes.length && h.before && h.after) {
          a.flow.appendChild(makeChangesEl({ before: h.before, after: h.after, files: h.changes }, { collapsed: true, review: h.review || {} }));
        }
        if (h.err) a.msg.classList.add("err");
        if (h.text) addMsgActions(a.msg, h.text);
      }
    });
    if (!enabled) addNote("AI Chat belum aktif.\n" + statusReason, true);
    else if (!history.length) showEmptyIfNeeded();
    bgTermsOpen = false; renderBgTerms(); // rebuild indikator saat ganti/replay percakapan
    scrollBottom();
  }

  function onMsgsClick(e) {
    var btn = e.target.closest && e.target.closest(".ai-copy");
    if (!btn) return;
    var block = btn.closest(".ai-code");
    var code = block ? codeByKey[block.getAttribute("data-key")] : null;
    if (code == null) { var c = block && block.querySelector("code"); code = c ? c.textContent : ""; }
    copyText(code).then(function () {
      btn.textContent = "Copied"; btn.classList.add("done");
      setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1400);
    });
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).catch(function () { return legacyCopy(t); });
    return Promise.resolve(legacyCopy(t));
  }
  function legacyCopy(t) {
    var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove();
  }

  // ------------------------------------------------------------ Actions
  function toggle() { setOpen(!panel.classList.contains("open")); }

  function ensureOpen() { if (!panel.classList.contains("open")) setOpen(true); }
  // Blok kronologis sebuah pesan agent; pesan lama (tanpa `blocks`) disusun
  // think -> rencana -> aksi -> teks.
  function blocksOf(m) {
    if (m.blocks && m.blocks.length) return m.blocks;
    var out = [];
    if (m.think) out.push({ type: "think", text: m.think });
    if (m.plan && m.plan.length) out.push({ type: "plan", todos: m.plan });
    (m.tools || []).forEach(function (t) { out.push({ type: "tool", tool: t }); });
    if (m.text) out.push({ type: "text", text: m.text });
    return out;
  }
  // Salinan ringkas kartu tool untuk disimpan (detail dipotong 2000 karakter).
  function trimTool(t) {
    return { callId: t.callId, name: t.name, tool: t.tool, status: t.status, summary: t.summary, lang: t.lang, meta: t.meta, detail: t.detail ? String(t.detail).slice(0, 2000) : undefined };
  }
  function setOpen(open, remote) {
    panel.classList.toggle("open", open);
    toggleBtn.classList.toggle("active", open);
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    if (open) { clearUnread(); refreshStatus(); setTimeout(function () { input && !input.disabled && input.focus(); scrollBottom(); }, 30); }
    // Panel AI mengikuti browser lain (dan sebaliknya) — kecuali perubahan ini datang dari remote.
    if (!remote && window.VRCloudViewSync) { try { window.VRCloudViewSync(); } catch (e) {} }
    if (window.VRCloudMobile && window.VRCloudMobile.onAiToggle) { try { window.VRCloudMobile.onAiToggle(open); } catch (e) {} }
  }

  // Saat sibuk, composer tetap aktif: pesan baru masuk antrean dan dikirim
  // otomatis setelah agent selesai.
  function setBusy(b) {
    busy = b;
    if (!b) { agentPlan = null; agentPending = 0; }
    renderBgTerms(); // pulsa indikator terminal latar belakang mengikuti status sibuk
    emitAgentStatus();
    sendBtn.disabled = !enabled;
    sendBtn.title = T(b ? "Tambahkan ke antrean (dikirim setelah agent selesai)" : "Kirim (Enter)");
    stopBtn.classList.toggle("show", b); if (!b) stopBtn.disabled = false;
    input.disabled = !enabled;
    var mode = currentStatus && currentStatus.mode;
    input.placeholder = T(b ? "Agent sedang bekerja\u2026 ketik pesan berikutnya untuk diantrekan"
      : mode === "ask" ? "Tanya tentang kode (mode Ask: tidak mengubah apa pun)\u2026"
      : mode === "plan" ? "Jelaskan tugas \u2014 agent hanya menyusun rencana\u2026"
      : "Beri tugas atau tanya apa saja\u2026");
  }

  function detachUi() {
    streamGen++;
    if (aborter) { try { aborter.abort(); } catch (e) {} }
    aborter = null;
    queue = []; renderQueue(); // antrean milik percakapan yang ditinggalkan
    sessionUsage = null; renderUsage();
    setBusy(false);
  }

  // Stop: minta server membatalkan run, tetapi JANGAN putus stream lokal. Server
  // masih sibuk sampai cancel selesai; kalau stream diputus di sini, polling 3 s
  // melihat "server sibuk, klien tidak" dan menyambung ulang → balasan tampil dua
  // kali. Stream berakhir sendiri dengan frame done:"cancelled". Pengaman: bila
  // server tidak menutup dalam 20 s, putus lokal.
  function doStop() {
    if (!busy) return;
    stopBtn.disabled = true;
    apiJson("/api/ai/stop", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionId() }) }).catch(function () {});
    var ab = aborter;
    setTimeout(function () { if (busy && aborter === ab && ab) { try { ab.abort(); } catch (e) {} } stopBtn.disabled = false; }, 20000);
  }

  // Stream -> alur kronologis. Setiap perubahan jenis (berpikir -> aksi ->
  // teks -> berpikir lagi ...) membuat blok baru di bawah blok sebelumnya.
  function bindStream(ai) {
    var myGen = streamGen;
    var flow = ai.flow;
    var blocks = [];                 // untuk riwayat lokal, urutan sama dengan tampilan
    var acc = "";                    // gabungan teks balasan (judul notifikasi, dedup riwayat)
    var curThink = null, curText = null;
    var toolsList = [], stepMap = {}, planEl = null, planList = null, planBlock = null;
    function alive() { return myGen === streamGen; }
    function bump() { if (ai.dots) flow.appendChild(ai.dots); if (nearBottom()) scrollBottom(); renderBgTerms(); }

    function showWait(on) { if (ai.dots) ai.dots.style.display = on ? "" : "none"; }
    function openThink() {
      if (curThink) return;
      curThink = makeThinkEl(); curThink.el.classList.add("live");
      curThink.block = { type: "think", text: "" }; blocks.push(curThink.block);
      flow.appendChild(curThink.el); bump();
    }
    function closeThink() {
      if (!curThink) return;
      var th = curThink; curThink = null;
      th.el.classList.remove("live");
      if (th.has) {
        var elapsed = Date.now() - th.start, secs = Math.max(1, Math.round(elapsed / 1000));
        th.label.textContent = "Berpikir selama " + secs + " detik";
        th.block.secs = secs;
        // Lipat saat agent lanjut ke aksi/teks — tetapi reasoning singkat dibiarkan terbaca dulu (min. 4 dtk tampil).
        var fold = function () { if (th.el.getAttribute("data-user") !== "1") th.el.setAttribute("data-open", "0"); };
        if (elapsed >= 4000) fold(); else setTimeout(fold, 4000 - elapsed);
      } else {
        th.el.remove(); // header tanpa isi (model tak membagikan reasoning)
        var bi = blocks.indexOf(th.block); if (bi >= 0) blocks.splice(bi, 1);
      }
      showWait(true);
    }
    function closeText() {
      if (!curText) return;
      renderSeg(curText.el, curText.acc, false);
      curText = null;
    }
    function onThink(v) {
      if (!alive()) return;
      closeText();
      if (!curThink) openThink();
      if (!curThink.has && v.trim()) { curThink.has = true; curThink.el.setAttribute("data-open", "1"); curThink.start = Date.now(); }
      if (v.trim()) showWait(false); // ada isi berpikir: tampilkan teksnya, bukan titik loading
      curThink.acc += v; curThink.block.text = curThink.acc;
      var stick = nearBottom();
      curThink.body.textContent = curThink.acc;
      curThink.body.scrollTop = curThink.body.scrollHeight;
      if (stick) scrollBottom();
    }
    function onText(v) {
      if (!alive()) return;
      closeThink();
      if (!curText) {
        collapseSteps(flow); // agent lanjut menulis teks: kartu langkah sebelumnya dilipat
        curText = { el: makeTextEl(), acc: "", block: { type: "text", text: "" } };
        blocks.push(curText.block); flow.appendChild(curText.el); bump();
      }
      curText.acc += v; acc += v; curText.block.text = curText.acc;
      renderSeg(curText.el, curText.acc, true);
    }
    function onTool(p) {
      if (!alive() || !p) return;
      closeThink(); closeText();
      var t = null;
      for (var i = 0; i < toolsList.length; i++) { if (toolsList[i].callId && toolsList[i].callId === p.callId) { t = toolsList[i]; break; } }
      if (t) {
        t.status = p.status; if (p.summary) t.summary = p.summary; if (p.name) t.name = p.name; if (p.tool) t.tool = p.tool; if (p.detail) t.detail = p.detail; if (p.lang) t.lang = p.lang;
        // Gabungkan meta (background/exit/browser step, dsb.) — jangan hanya kunci tertentu.
        if (p.meta && typeof p.meta === "object") t.meta = Object.assign({}, t.meta || {}, p.meta);
      }
      else { t = { callId: p.callId, name: p.name, tool: p.tool, status: p.status, summary: p.summary, detail: p.detail, lang: p.lang, meta: p.meta }; toolsList.push(t); blocks.push({ type: "tool", tool: t }); }
      var tkey = t.callId || ("k" + Object.keys(stepMap).length), fresh = !stepMap[tkey];
      renderStep(flow, t, stepMap, beforeHash); // baru -> ditambahkan di bawah; lama -> diperbarui di tempat
      if (fresh) { collapseSteps(flow, stepMap[tkey]); groupReadStep(flow, stepMap[tkey], t); groupBrowserStep(flow, stepMap[tkey], t); groupDesktopStep(flow, stepMap[tkey], t); }
      else if (stepMap[tkey] && stepMap[tkey].parentNode && stepMap[tkey].parentNode.classList.contains("ai-sg-body")) {
        var grp = stepMap[tkey].parentNode.parentNode, its = grp.querySelectorAll(".ai-sg-body > .ai-step");
        grp.querySelector(".ai-sg-hd .ai-step-ic").textContent = Array.prototype.some.call(its, function (s) { return s.classList.contains("running"); }) ? "\u25cf" : "\u2713";
      }
      bump();
    }
    var changesData = null;
    function onChanges(d) {
      if (!alive() || !d || !d.files || !d.files.length) return;
      changesData = d;
      closeThink(); closeText();
      flow.appendChild(makeChangesEl(d, { collapsed: !reviewOn }));
      bump();
    }
    var beforeHash = null, approvals = {};
    function onCheckpoint(v) {
      if (!alive() || !v || !v.before) return;
      beforeHash = v.before;
      // tombol "Kembalikan" di pesan pengguna terakhir
      var users = msgs.querySelectorAll(".ai-msg.user");
      if (users.length) setUserCheckpoint(users[users.length - 1], beforeHash);
      var lastUser = null; for (var i = history.length - 1; i >= 0; i--) if (history[i].role === "user") { lastUser = history[i]; break; }
      if (lastUser && !lastUser.checkpoint) { lastUser.checkpoint = beforeHash; saveHistory(); }
    }
    function onUsage(u) {
      if (!alive() || !u) return;
      liveUsage = u;
      var base = usageBase || {};
      sessionUsage = { inputTokens: (base.inputTokens || 0) + (u.inputTokens || 0), outputTokens: (base.outputTokens || 0) + (u.outputTokens || 0),
        totalTokens: (base.totalTokens || 0) + (u.totalTokens || 0), cacheReadTokens: (base.cacheReadTokens || 0) + (u.cacheReadTokens || 0), costCents: base.costCents };
      renderUsage();
    }
    function onApproval(p) {
      if (!alive() || !p || !p.id) return;
      var ap = approvals[p.id];
      if (!ap) {
        closeThink(); closeText();
        ap = makeApproveEl(p); approvals[p.id] = ap; flow.appendChild(ap.el);
        blocks.push({ type: "approval", id: p.id, command: p.command, pattern: p.pattern, status: p.status });
        if (p.status === "pending") { notifyDone((p.command || "Perintah berisiko").slice(0, 120), "warn"); bump(); }
      } else {
        ap.set(p.status);
        blocks.forEach(function (b) { if (b.type === "approval" && b.id === p.id) b.status = p.status; });
      }
      agentPending = blocks.filter(function (b) { return b.type === "approval" && b.status === "pending"; }).length; emitAgentStatus();
      // (lanjutan) Perintah yang ditolak tidak pernah mengirim event "selesai": tandai kartunya.
      if (p.status && p.status !== "pending" && p.status !== "allowed") {
        toolsList.forEach(function (t) {
          if (String(t.name).toLowerCase() === "shell" && t.status === "running" && (t.summary || "").trim() === String(p.command || "").trim()) {
            t.status = "error"; t.meta = Object.assign({}, t.meta || {}, { denied: true }); renderStep(flow, t, stepMap, beforeHash);
          }
        });
      }
    }
    var liveUsage = null, usageBase = sessionUsage ? Object.assign({}, sessionUsage) : null;
    function onPlan(todos) {
      if (!alive() || !Array.isArray(todos)) return;
      closeThink(); closeText();
      planList = todos;
      if (!planEl) { planEl = makePlanEl(); planBlock = { type: "plan", todos: todos }; }
      // Kartu Rencana mengikuti progres: setiap pembaruan dipindah ke posisi terkini di alur
      // (di bawah aksi yang baru dikerjakan), bukan dipaku di atas pesan.
      var bi = blocks.indexOf(planBlock); if (bi !== -1) blocks.splice(bi, 1); blocks.push(planBlock);
      collapseSteps(flow); // progres rencana diperbarui: langkah sebelumnya dilipat
      flow.appendChild(planEl);
      planEl.setAttribute("data-open", "1");
      planBlock.todos = todos;
      renderPlan(planEl, todos, true);
      var done = 0; todos.forEach(function (t) { if (t.status === "completed" || t.status === "cancelled") done++; });
      agentPlan = { done: done, total: todos.length }; emitAgentStatus();
      bump();
    }
    function onIter(v) {
      if (!alive() || !v || !v.n || v.n < 2) return;
      closeThink(); closeText();
      flow.appendChild(makeIterEl(v.n, v.max)); blocks.push({ type: "iter", n: v.n, max: v.max });
      bump();
    }
    if (thinkingEnabled()) openThink();
    function handleFrame(line) {
      if (!alive()) return;
      line = line.trim(); if (!line) return;
      var obj; try { obj = JSON.parse(line); } catch (e) { return; }
      if (!obj || typeof obj.t !== "string") return;
      if (obj.t === "text") onText(String(obj.v || ""));
      else if (obj.t === "think") onThink(String(obj.v || ""));
      else if (obj.t === "tool") onTool(obj.v);
      else if (obj.t === "plan") onPlan(obj.v);
      else if (obj.t === "iter") onIter(obj.v);
      else if (obj.t === "checkpoint") onCheckpoint(obj.v);
      else if (obj.t === "usage") onUsage(obj.v);
      else if (obj.t === "approval") onApproval(obj.v);
      else if (obj.t === "changes") onChanges(obj.v);
      else if (obj.t === "done") endStatus = String(obj.v || "");
      else if (obj.t === "error") throw new Error(String(obj.v || "error"));
    }
    var endStatus = "";
    var buf = "";
    function feed(chunk, flush) {
      buf += chunk;
      var idx;
      while ((idx = buf.indexOf("\n")) >= 0) { var line = buf.slice(0, idx); buf = buf.slice(idx + 1); handleFrame(line); }
      if (flush && buf) { handleFrame(buf); buf = ""; }
    }
    function finish(isErr, stopped, note) {
      if (!alive()) return;
      // Server menutup dengan status "cancelled" (Stop dari tab ini/tab lain) → tandai dihentikan.
      if (!stopped && !isErr && endStatus === "cancelled") { stopped = true; if (!note) note = "*(dihentikan)*"; }
      else if (!stopped && !isErr && endStatus === "error" && !note) { isErr = true; note = "**Error:** run gagal di server"; }
      closeThink();
      if (note) onText((curText && curText.acc ? "\n\n" : "") + note);
      closeText();
      if (ai.dots) { ai.dots.remove(); ai.dots = null; }
      // Run selesai: kartu langkah (Menulis/Edit/Shell, dsb.) dilipat otomatis — bisa dibuka lagi dengan klik;
      // kartu Rencana tetap terbuka.
      collapseSteps(flow);
      if (planEl && planList) { renderPlan(planEl, planList, false); planEl.setAttribute("data-open", "1"); }
      if (!blocks.length && !isErr && !stopped) {
        if (ai.msg && ai.msg.parentNode) ai.msg.remove();
        aborter = null;
        setBusy(false);
        fetchSession(sessionId()).then(function (d) {
          if (!d || !alive()) return;
          history = d.messages || [];
          saveHistory();
          renderConversation();
        }).catch(function () {});
        flushQueue(); // pesan yang diantrekan selama run sebelumnya tetap terkirim
        return;
      }
      if (!acc && !isErr && !stopped && !toolsList.length) onText("*(tidak ada balasan)*"), closeText();
      if (isErr) ai.msg.classList.add("err");
      Object.keys(approvals).forEach(function (k) { var b = blocks.filter(function (x) { return x.type === "approval" && x.id === k; })[0]; if (b && b.status === "pending") { approvals[k].set("ended"); b.status = "ended"; } });
      // Tool yang masih "running" saat run berakhir tidak pernah selesai (dibatalkan/ditolak).
      toolsList.forEach(function (t) { if (t.status === "running") { t.status = "error"; t.meta = Object.assign({}, t.meta || {}, { unfinished: true }); } });
      // Tombol kembalikan per file aktif setelah tool selesai.
      toolsList.forEach(function (t) { renderStep(flow, t, stepMap, beforeHash); });
      if (acc) addMsgActions(ai.msg, function () { return acc; });
      var last = history.length ? history[history.length - 1] : null;
      if (!(last && last.role === "ai" && last.text === acc)) {
        // Cache lokal hanya menyimpan urutan blok (sumber kebenaran ada di server).
        var blocksSaved = blocks.map(function (b) { return b.type === "tool" ? { type: "tool", tool: trimTool(b.tool) } : b; });
        history.push({ role: "ai", text: acc, blocks: blocksSaved, before: beforeHash || undefined, usage: liveUsage || undefined, err: !!isErr,
          after: changesData ? changesData.after : undefined, changes: changesData ? changesData.files : undefined, review: {} });
        saveHistory();
      }
      aborter = null;
      setBusy(false);
      if (isErr) notifyDone(String(note || "Run gagal").replace(/\*\*Error:\*\*\s*/, "").slice(0, 160), "err");
      else if (!stopped) notifyDone(titleFrom(acc || "Agent selesai"));
      setTimeout(function () { if (!input.disabled && !queue.length) input.focus(); }, 20);
      fetchSessions().then(function (list) { convsCache = list; if (historyOpen) renderHistoryList(); }).catch(function () {});
      // Biaya dari server datang belakangan: segarkan angka pemakaian.
      setTimeout(function () { if (!alive()) return; fetchSession(sessionId()).then(function (d) { if (d && d.usage) { sessionUsage = d.usage; renderUsage(); } }).catch(function () {}); }, 6000);
      flushQueue();
    }
    function fail(msg) { finish(true, false, "**Error:** " + (msg || "error")); }
    function stoppedBy() { finish(false, true, "*(dihentikan)*"); }
    return { feed: feed, finish: finish, alive: alive, fail: fail, stopped: stoppedBy };
  }

  function readNdjson(resp, stream) {
    if (!resp.body || !resp.body.getReader) return resp.text().then(function (t) { stream.feed(t, true); });
    var reader = resp.body.getReader(), dec = new TextDecoder();
    function pump() {
      return reader.read().then(function (r) {
        if (!stream.alive()) { try { reader.cancel(); } catch (e) {} return; }
        if (r.done) { stream.feed("", true); return; }
        stream.feed(dec.decode(r.value, { stream: true }), false);
        return pump();
      });
    }
    return pump();
  }

  // Error dari respons JSON server (pesan `error`, fallback kode HTTP).
  function errFromResp(resp) {
    return resp.json().then(function (j) { throw new Error((j && j.error) || ("HTTP " + resp.status)); },
      function () { throw new Error("HTTP " + resp.status); });
  }
  // Bootstrap stream NDJSON — satu implementasi untuk /api/ai/chat dan /api/ai/live:
  // gelembung Assistant baru, bindStream, abort stream sebelumnya, baca sampai habis.
  // onResponse(resp, ai) boleh mengembalikan Promise untuk menangani status khusus (409).
  function startStream(url, body, onResponse) {
    streamGen++;
    if (aborter) { try { aborter.abort(); } catch (e) {} } // stream lama (mis. sesi yang ditinggalkan) tidak boleh menggantung
    setBusy(true);
    var ai = addAi(true);
    var stream = bindStream(ai);
    scrollBottom();
    aborter = (typeof AbortController !== "undefined") ? new AbortController() : null;
    fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: aborter ? aborter.signal : undefined,
    }).then(function (resp) {
      var handled = onResponse ? onResponse(resp, ai) : null;
      if (handled) return handled;
      if (!resp.ok) return errFromResp(resp);
      return readNdjson(resp, stream);
    }).then(function () {
      if (stream.alive()) stream.finish(false, false);
    }).catch(function (e) {
      if (!stream.alive()) return;
      if (e && e.name === "AbortError") { stream.stopped(); return; }
      stream.fail((e && e.message) || String(e));
    });
    return { ai: ai, stream: stream };
  }
  function attachLive(id) {
    if (!id) id = sessionId();
    if (!id || !enabled) return;
    startStream("/api/ai/live", { sessionId: id });
  }

  // Susun pesan dari composer (teks + lampiran + gambar). Saat agent sibuk,
  // pesan masuk antrean dan dikirim otomatis setelah selesai.
  function doSend() {
    if (!enabled) return;
    if (mentionEl && mentionEl.classList.contains("open")) return; // Enter dipakai memilih @file
    var text = (input.value || "").trim();
    var skills = attachments.filter(function (a) { return a.kind === "skill"; });
    if (!text && !attachments.filter(function (a) { return a.kind !== "skill"; }).length) {
      if (skills.length) { setHint("Tulis permintaan yang mau dikerjakan dengan skill ini."); }
      return;
    }
    var atts = attachments.filter(function (a) { return !a.image && a.kind !== "skill"; });
    var imgs = attachments.filter(function (a) { return a.image; });
    var sendText = text;
    if (atts.length) {
      var blocks = atts.map(function (a) {
        var label = a.kind === "terminal" ? "Terminal output (" + a.name + ")" : "File `" + (a.path || a.name) + "`" + (a.range ? " lines " + a.range.replace(/^L/, "") : "");
        if (a.content) return label + ":\n```\n" + a.content + "\n```";
        return label + " (" + (a.note || "unreadable") + ")";
      });
      sendText = blocks.join("\n\n") + (text ? "\n\n" + text : "");
    }
    var names = attachments.filter(function (a) { return a.kind !== "skill"; }).map(function (a) { return a.name + (a.range ? ":" + a.range : ""); });
    var displayText = text + (names.length ? (text ? "\n" : "") + "\uD83D\uDCCE " + names.join(", ") : "");
    var m = {
      sendText: sendText, display: displayText,
      images: imgs.map(function (a) { return { data: a.data, mimeType: a.mimeType, name: a.name }; }),
      skills: skills.map(function (s) { return s.name; }),
    };
    input.value = ""; autoGrow(); broadcastDraft(); // browser lain ikut kosong
    attachments = []; renderAttachments(); closeMention();
    if (busy) { queue.push(m); renderQueue(); return; }
    sendMessage(m);
  }

  function sendMessage(m) {
    var isFirst = !history.some(function (x) { return x.role === "user"; });
    var title = isFirst ? titleFrom(m.display || (m.images.length ? "Gambar" : "Chat")) : "";
    addUser(m.display, { images: m.images, skills: m.skills });
    history.push({ role: "user", text: m.display, images: m.images.length ? m.images : undefined, skills: (m.skills && m.skills.length) ? m.skills : undefined }); saveHistory();
    touchConv(sessionId(), title || null);
    if (historyOpen) renderHistoryList();
    startStream("/api/ai/chat",
      { sessionId: sessionId(), message: m.sendText, display: m.display, title: title, images: m.images.length ? m.images : undefined, skills: (m.skills && m.skills.length) ? m.skills : undefined },
      function (resp, ai) {
        if (resp.status !== 409) return null;
        // Server masih memproses pesan sebelumnya (dikirim dari tab lain): batalkan
        // gelembung lokal dan sambung ke run yang sedang berjalan.
        return resp.json().catch(function () { return null; }).then(function () {
          if (ai.msg && ai.msg.parentNode) ai.msg.remove();
          if (history.length && history[history.length - 1].role === "user") {
            history.pop(); saveHistory();
            var users = msgs.querySelectorAll(".ai-msg.user");
            if (users.length) users[users.length - 1].remove();
          }
          attachLive(sessionId());
        });
      });
  }

  // ------------------------------------------------- Conversations (threads)
  var histQuery = "";
  function buildHistory() {
    historyPanel = el("div"); historyPanel.id = "ai-history";
    var head = el("div", "ai-hist-head");
    head.appendChild(el("span", null, "Riwayat chat")); // chat baru: tombol + di header panel
    historyPanel.appendChild(head);
    var sw = el("div", "ai-hist-search");
    var si = el("input"); si.type = "search"; si.placeholder = "Cari percakapan\u2026";
    si.addEventListener("input", function () { histQuery = si.value.trim().toLowerCase(); renderHistoryList(); });
    si.addEventListener("keydown", function (e) { if (e.key === "Escape") { si.value = ""; histQuery = ""; renderHistoryList(); } });
    sw.appendChild(si); historyPanel.appendChild(sw);
    historyPanel.appendChild(el("div", "ai-hist-list"));
    panel.appendChild(historyPanel);
  }

  function renameConversation(c) {
    var t = prompt("Nama percakapan:", c.title || "");
    if (t == null) return;
    t = t.trim(); if (!t) return;
    apiJson("/api/ai/session/rename", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, title: t }) })
      .then(function (r) { convsCache.forEach(function (x) { if (x.id === c.id) x.title = r.title; }); renderHistoryList(); })
      .catch(function (e) { alert("Gagal mengubah nama: " + e.message); });
  }

  // Ekspor percakapan ke Markdown (rencana, aksi tool, teks) lalu unduh.
  function exportConversation(c) {
    fetchSession(c.id).then(function (d) {
      var out = ["# " + (d.title || "Percakapan"), "", "_Diekspor " + new Date().toLocaleString() + " dari VRCloud IDE_", ""];
      (d.messages || []).forEach(function (m) {
        if (m.role === "user") { out.push("## Anda", "", m.text || "", ""); if (m.images && m.images.length) out.push("_(" + m.images.length + " gambar terlampir)_", ""); return; }
        out.push("## Agent", "");
        blocksOf(m).forEach(function (b) {
          if (b.type === "think") out.push("<details><summary>Berpikir</summary>", "", b.text, "", "</details>", "");
          else if (b.type === "text") out.push(b.text, "");
          else if (b.type === "plan") { out.push("**Rencana**", ""); (b.todos || []).forEach(function (t) { out.push("- [" + (t.status === "completed" ? "x" : " ") + "] " + t.content + (t.status === "cancelled" ? " _(dibatalkan)_" : "")); }); out.push(""); }
          else if (b.type === "tool" && b.tool) {
            var t = b.tool; out.push("- **" + toolVerb(t.name, t.tool) + "** `" + (t.summary || "") + "`" + (t.status === "error" ? " (gagal)" : ""));
            if (t.detail) out.push("", "  ```" + (t.lang || ""), t.detail.split("\n").map(function (l) { return "  " + l; }).join("\n"), "  ```", "");
          } else if (b.type === "approval") out.push("- \u26a0 Perintah berisiko `" + (b.command || "") + "` \u2014 " + (APPROVE_LABEL[b.status] || b.status), "");
          else if (b.type === "iter") out.push("_\u21bb lanjut otomatis (putaran " + b.n + ")_", "");
        });
        if (m.usage && m.usage.totalTokens) out.push("_Token usage " + fmtTok(m.usage.totalTokens) + "_", "");
      });
      var blob = new Blob([out.join("\n")], { type: "text/markdown;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = (d.title || "percakapan").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) + ".md";
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }).catch(function (e) { alert("Gagal mengekspor: " + e.message); });
  }

  function renderHistoryList() {
    if (!historyPanel) return;
    var list = historyPanel.querySelector(".ai-hist-list");
    list.innerHTML = "";
    var convs = getConvs(), active = localStorage.getItem(ACTIVE_KEY);
    if (histQuery) convs = convs.filter(function (c) { return String(c.title || "").toLowerCase().indexOf(histQuery) !== -1; });
    if (!convs.length) { list.appendChild(el("div", "ai-hist-empty", histQuery ? "Tidak ada yang cocok." : "Belum ada chat.")); return; }
    convs.forEach(function (c) {
      var row = el("div", "ai-hist-row" + (c.id === active ? " active" : "") + (c.busy ? " busy" : ""));
      var main = el("div", "ai-hist-main");
      var titleEl = el("div", "ai-hist-title", c.title || "Chat");
      if (c.busy) titleEl.appendChild(el("span", "ai-live-dot"));
      main.appendChild(titleEl);
      var sub = el("div", "ai-hist-time", c.busy ? "sedang berjalan" : relTime(c.updatedAt));
      if (c.usage && c.usage.totalTokens) sub.appendChild(el("span", "ai-hist-usage", "Token usage " + fmtTok(c.usage.totalTokens) + (typeof c.usage.costCents === "number" ? " \u00b7 " + fmtCost(c.usage.costCents) : "")));
      if (c.stats && c.stats.files) {
        var stt = el("span", "ai-hist-stats"); stt.title = c.stats.files + " file berubah";
        stt.appendChild(el("span", "add", "+" + c.stats.added)); stt.appendChild(el("span", "del", "\u2212" + c.stats.removed));
        stt.appendChild(document.createTextNode(" \u00b7 " + c.stats.files + " file")); sub.appendChild(stt);
      }
      main.appendChild(sub);
      main.addEventListener("click", function () { switchConversation(c.id); });
      row.appendChild(main);
      var rn = el("span", "ai-hist-act", "\u270e"); rn.title = "Ubah nama"; rn.addEventListener("click", function (e) { e.stopPropagation(); renameConversation(c); }); row.appendChild(rn);
      var ex = el("span", "ai-hist-act", "\u2913"); ex.title = "Ekspor Markdown"; ex.addEventListener("click", function (e) { e.stopPropagation(); exportConversation(c); }); row.appendChild(ex);
      var del = el("span", "ai-hist-del", "\u2715"); del.title = "Hapus chat";
      del.addEventListener("click", function (e) { e.stopPropagation(); deleteConversation(c.id); });
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function toggleHistory() { if (historyOpen) closeHistory(); else openHistory(); }
  function openHistory() { if (settings) settings.classList.remove("open"); closeModelPop(); renderHistoryList(); historyPanel.classList.add("open"); historyOpen = true; }
  function closeHistory() { historyPanel.classList.remove("open"); historyOpen = false; }

  function newConversation() {
    detachUi();
    apiJson("/api/ai/session", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: "{}",
    }).then(function (s) {
      convsCache = [{ id: s.id, title: s.title || "Chat baru", updatedAt: s.updatedAt, busy: false }].concat(
        convsCache.filter(function (c) { return c.id !== s.id; })
      );
      localStorage.setItem(ACTIVE_KEY, s.id);
      history = []; saveHistory();
      renderConversation();
      renderHistoryList();
      setTimeout(function () { if (!input.disabled) input.focus(); }, 20);
    }).catch(function () {});
  }

  function switchConversation(id) {
    if (id === localStorage.getItem(ACTIVE_KEY)) { closeHistory(); return; }
    detachUi();
    closeHistory();
    openSession(id).then(function () { renderHistoryList(); });
  }

  function deleteConversation(id) {
    if (id === sessionId()) detachUi();
    try { localStorage.removeItem(HIST_PREFIX + id); } catch (e) {}
    apiJson("/api/ai/reset", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(function () {});
    convsCache = convsCache.filter(function (c) { return c.id !== id; });
    if (localStorage.getItem(ACTIVE_KEY) === id) {
      if (convsCache.length) {
        localStorage.setItem(ACTIVE_KEY, convsCache[0].id);
        openSession(convsCache[0].id);
      } else {
        newConversation();
      }
    }
    renderHistoryList();
  }

  // ------------------------------------------------------------ Status
  // Gabungkan, bukan timpa: respons /api/ai/config dan /api/ai/config-light hanya
  // berisi status inti (tanpa checkpoints/guard), jadi field itu harus dipertahankan.
  function mergeStatus(s) { currentStatus = Object.assign({}, currentStatus || {}, s || {}); return currentStatus; }
  function applyStatus(s) {
    var wasOn = enabled, wasWhy = statusReason;
    mergeStatus(s);
    enabled = !!currentStatus.enabled; statusReason = currentStatus.reason || "";
    if (currentStatus.checkpoints) checkpointsOn = !!currentStatus.checkpoints.available;
    renderChip();
    // Jangan rebuild seluruh chat tiap poll status — itu menghapus Diff yang baru dibuka
    // dan membuat klik di kartu Perubahan seolah tidak ada respons.
    if (!busy && (wasOn !== enabled || wasWhy !== statusReason) && !msgs.querySelector(".ai-changes, .ai-step.running")) renderConversation();
    if (popoverOpen) renderPopover();
    updateCfgStatus();
    renderGrokAuth();
    renderGuardSettings();
    renderCpNote();
    fillVerify();
    renderPromptCache();
    setBusy(busy); // composer aktif/nonaktif & placeholder mengikuti enabled + mode
    emitAgentStatus();
    // Ambil katalog model diam-diam untuk label chip & opsi popover.
    if (enabled && !modelCatalog.length) {
      fetchModels().then(function () {
        renderChip(); emitAgentStatus();
        if (popoverOpen) renderPopover();
      }).catch(function () {});
    }
  }

  function refreshStatus() {
    apiJson("/api/ai/status", { credentials: "same-origin" }).then(applyStatus).catch(function () {});
  }

  // ------------------------------------------------- Model settings popover
  function findModel(id) { for (var i = 0; i < modelCatalog.length; i++) if (modelCatalog[i].id === id) return modelCatalog[i]; return null; }
  function chipLabel() {
    var m = currentStatus && currentStatus.model; if (!m) return "pilih model";
    var it = findModel(m); return it ? (it.displayName || m) : m;
  }
  function modeLabel(m) { return m === "plan" ? "Plan" : m === "ask" ? "Ask" : "Agent"; }
  // Tool browser: auto (agent memutuskan sendiri), on (diutamakan untuk tugas web), off (dimatikan).
  var BROWSER_TOOLS_LABEL = { auto: "Auto", on: "On", off: "Off" };
  function browserToolsVal() { var v = currentStatus && currentStatus.browserTools; return BROWSER_TOOLS_LABEL[v] ? v : "auto"; }
  // Computer use (desktop_*): auto / on / off — pola sama dengan browser tools.
  function desktopToolsVal() { var v = currentStatus && currentStatus.desktopTools; return BROWSER_TOOLS_LABEL[v] ? v : "auto"; }
  // Chip di composer: nama model + konfigurasi model (thinking, effort, context...).
  // Mode dan Browser tools punya tombol sendiri di samping Skills (bukan bagian chip ini).
  function chipParts() {
    var parts = [{ label: chipLabel(), main: true }];
    if (!currentStatus || !currentStatus.model) return parts;
    var it = findModel(currentStatus.model);
    var defs = (it && it.parameters) || [];
    var params = currentStatus.params || {};
    if (defs.length) {
      defs.forEach(function (p) {
        var cur = paramValue(p);
        if (isBooleanParam(p)) { if (cur === toggleParts(p).on) parts.push({ label: p.displayName || p.id }); }
        else parts.push({ label: (p.displayName || p.id) + " " + valueLabel(p, cur) });
      });
    } else {
      Object.keys(params).forEach(function (k) {
        var v = String(params[k]);
        if (/^(true|on|1|yes|enabled)$/i.test(v)) parts.push({ label: k });
        else if (!/^(false|off|0|no|disabled)$/i.test(v)) parts.push({ label: k + " " + v });
      });
    }
    return parts;
  }
  function renderChip() {
    if (!modelChip) return;
    modelChip.innerHTML = "";
    if (currentStatus && currentStatus.model) modelChip.appendChild(modelLogoFor(currentStatus.model)); // logo provider di depan nama model
    var parts = chipParts();
    // Nama model + mode selalu tampil; parameter lain (.xtra) disembunyikan saat panel sempit
    // agar tidak terpotong di tengah kata.
    parts.forEach(function (p, i) {
      // Panel sempit: semua parameter model (Thinking/Context/Effort/...) disembunyikan,
      // hanya nama model yang tersisa agar tidak tumpang tindih dengan tombol lain.
      var xtra = i >= 1 ? " xtra" : "";
      if (i) modelChip.appendChild(el("span", "sep" + xtra, "\u00b7"));
      modelChip.appendChild(el("span", "seg" + (p.main ? " mname" : "") + xtra, p.label));
    });
    modelChip.appendChild(el("span", "cw", "\u25be"));
    modelChip.title = T("Pengaturan model \u2014 " + parts.map(function (p) { return p.label; }).join(" \u00b7 ") + " (klik untuk mengubah)");
    renderOptChips();
  }
  // Tombol Mode & Browser tools di samping Skills.
  function renderOptChips() {
    if (modeChip) {
      modeChip.innerHTML = ""; modeChip.appendChild(svgIcon("robot", 11));
      modeChip.appendChild(el("span", "lbl", modeLabel(currentStatus && currentStatus.mode))); modeChip.appendChild(el("span", "cw", "\u25be"));
    }
    if (browserChip) {
      var v = browserToolsVal(), avail = !currentStatus || currentStatus.browserAvailable !== false;
      browserChip.innerHTML = ""; browserChip.appendChild(svgIcon("globe", 11));
      var bl = el("span", "lbl"); bl.appendChild(el("span", "pfx", "Browser ")); bl.appendChild(document.createTextNode(BROWSER_TOOLS_LABEL[v])); // panel sempit: hanya "Auto/On/Off"
      browserChip.appendChild(bl); browserChip.appendChild(el("span", "cw", "\u25be"));
      browserChip.classList.toggle("off", v === "off" || !avail);
      browserChip.classList.toggle("on", v === "on" && avail);
      browserChip.title = avail
        ? "Browser tools: Auto (agent memutuskan), On (utamakan browser untuk tugas web), Off (dimatikan)"
        : "Browser Chrome/Edge/Chromium tidak ditemukan di server \u2014 pasang atau unduh lewat Preferences \u2192 Server.";
    }
    if (desktopChip) {
      var dv = desktopToolsVal(), davail = !currentStatus || currentStatus.desktopAvailable !== false;
      desktopChip.innerHTML = ""; desktopChip.appendChild(svgIcon("desktop", 11));
      var dl = el("span", "lbl"); dl.appendChild(el("span", "pfx", "Computer ")); dl.appendChild(document.createTextNode(BROWSER_TOOLS_LABEL[dv])); // panel sempit: hanya "Auto/On/Off"
      desktopChip.appendChild(dl); desktopChip.appendChild(el("span", "cw", "\u25be"));
      desktopChip.classList.toggle("off", dv === "off" || !davail);
      desktopChip.classList.toggle("on", dv === "on" && davail);
      desktopChip.title = davail
        ? "Computer use: Auto (agent memutuskan), On (utamakan GUI desktop untuk tugas aplikasi/jendela), Off (tool desktop dimatikan)"
        : "Remote desktop tidak tersedia di server ini \u2014 di Linux tanpa GUI, buka Remote Desktop (klik badge OS di menubar) untuk memasang desktop virtual.";
    }
    if (reviewChip) {
      reviewChip.innerHTML = ""; reviewChip.appendChild(svgIcon("review", 11));
      reviewChip.appendChild(el("span", "lbl", "Review"));
      reviewChip.classList.toggle("on", reviewOn);
      reviewChip.classList.toggle("off", !reviewOn);
      reviewChip.title = reviewOn
        ? "Mode review ON \u2014 terima atau tolak perubahan agent per file. Klik untuk mematikan."
        : "Mode review OFF \u2014 perubahan agent langsung diterapkan (tetap bisa dikembalikan). Klik untuk mengaktifkan.";
    }
  }
  function setReviewOn(on) {
    reviewOn = !!on;
    try { localStorage.setItem(REVIEW_KEY, reviewOn ? "1" : "0"); } catch (e) {}
    renderOptChips();
  }
  // ---- Indikator terminal agent: hanya proses yang BENAR-BENAR masih hidup. ----
  // Kartu "background shell" yang prosesnya sudah selesai tidak ditampilkan.
  var aliveProcs = {}; // pid -> { pid, command }
  var bgPollAt = 0;
  function hintedPids() {
    var out = [];
    if (!msgs) return out;
    msgs.querySelectorAll(".ai-step[data-pid]").forEach(function (st) {
      var p = Number(st.getAttribute("data-pid")); if (p > 1) out.push(p);
    });
    return out;
  }
  function applyProcList(list) {
    var next = {};
    (list || []).forEach(function (p) { if (p && p.pid) next[String(p.pid)] = p; });
    aliveProcs = next;
  }
  function pollBgProcs(force) {
    var now = Date.now();
    if (!force && now - bgPollAt < 2000) return;
    bgPollAt = now;
    var hinted = hintedPids();
    apiJson("/api/ai/procs" + (hinted.length ? "?pids=" + hinted.join(",") : ""), { credentials: "same-origin" })
      .then(function (r) { applyProcList(r.procs); renderBgTerms(true); })
      .catch(function () {});
  }
  function stopBgProcs(pid) {
    apiJson("/api/ai/procs/stop", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pid ? { pid: pid } : { all: true }),
    }).then(function (r) { applyProcList(r.procs); renderBgTerms(true); })
      .catch(function (e) { setHint(T("Gagal menghentikan: ") + e.message); });
  }
  function collectBgTerms() {
    if (!msgs) return [];
    var out = [], seen = {};
    msgs.querySelectorAll(".ai-step[data-shell]").forEach(function (st) {
      var running = st.classList.contains("running");
      var pid = st.getAttribute("data-pid") || "";
      var live = pid && aliveProcs[pid];
      // Latar belakang: hanya bila PID-nya masih hidup. Foreground: hanya saat langkah masih berjalan.
      if (st.hasAttribute("data-bg")) { if (!live) return; }
      else if (!running) return;
      var code = st.querySelector(".ai-step-txt code");
      var cmd = (live && live.command) || (code ? code.textContent.trim() : "");
      var key = pid || cmd;
      if (!key || seen[key]) return; seen[key] = 1;
      out.push({ cmd: cmd || ("pid " + pid), running: running || !!live, pid: pid });
    });
    // Proses hidup yang tidak punya kartu di percakapan ini (mis. sesi lain) tetap ditampilkan.
    Object.keys(aliveProcs).forEach(function (pid) {
      if (seen[pid]) return;
      var p = aliveProcs[pid];
      out.push({ cmd: p.command || ("pid " + pid), running: true, pid: pid });
    });
    return out;
  }
  function renderBgTerms(fromPoll) {
    if (!bgTermsEl) return;
    if (!fromPoll) pollBgProcs(false);
    var list = collectBgTerms();
    if (!list.length) { bgTermsEl.style.display = "none"; bgTermsEl.innerHTML = ""; return; }
    var active = list.some(function (x) { return x.running; });
    bgTermsEl.style.display = "";
    bgTermsEl.className = active ? "active" : "";
    bgTermsEl.classList.toggle("open", bgTermsOpen);
    bgTermsEl.innerHTML = "";
    var head = el("div", "bgt-head");
    var cvt = el("span", "bgt-cvt", "\u203a"); head.appendChild(cvt);
    head.appendChild(svgIcon("terminal", 12));
    head.appendChild(el("span", "bgt-n", list.length + " terminal agent"));
    head.appendChild(el("span", "grow"));
    var stopAll = el("span", "bgt-stop", "Stop"); stopAll.title = T("Hentikan semua proses ini"); head.appendChild(stopAll);
    var openBtn = el("span", "bgt-open", "Buka"); head.appendChild(openBtn);
    head.addEventListener("click", function (e) {
      if (e.target === openBtn) { openAgentShell(); return; }
      if (e.target === stopAll) { stopBgProcs(); return; }
      bgTermsOpen = !bgTermsOpen; bgTermsEl.classList.toggle("open", bgTermsOpen);
    });
    bgTermsEl.appendChild(head);
    var body = el("div", "bgt-body");
    list.forEach(function (it) {
      var row = el("div", "bgt-row" + (it.running ? " running" : ""));
      row.appendChild(svgIcon("terminal", 11));
      var c = el("span", "bgt-cmd"); c.textContent = it.cmd; c.title = it.cmd; row.appendChild(c);
      if (it.running) row.appendChild(el("span", "bgt-dot"));
      var pv = detectLocalUrl(it.cmd);
      if (pv && window.VRCloud && window.VRCloud.openPreview) {
        var pvb = el("span", "bgt-open", "Preview \u25b8"); pvb.title = "Buka " + pv + " di tab Browser agent";
        pvb.addEventListener("click", function (e) { e.stopPropagation(); window.VRCloud.openPreview(pv); }); row.appendChild(pvb);
      }
      if (it.pid) {
        var sb = el("span", "bgt-stop", "Stop"); sb.title = T("Hentikan proses ") + it.pid;
        sb.addEventListener("click", function (e) { e.stopPropagation(); stopBgProcs(Number(it.pid)); });
        row.appendChild(sb);
      }
      row.addEventListener("click", function (e) { e.stopPropagation(); openAgentShell(); });
      body.appendChild(row);
    });
    bgTermsEl.appendChild(body);
  }
  function openAgentShell() {
    if (window.VRCloud && window.VRCloud.showAgentShell) {
      var ok = window.VRCloud.showAgentShell(sessionId());
      if (!ok) setHint("Tidak bisa membuka Agent shell (layout belum siap).");
    }
  }

  var chipMenuFor = null; // chip yang submenu-nya sedang terbuka
  function toggleChipMenu(anchor, kind) {
    if (submenu && chipMenuFor === kind) { closeSubmenu(); chipMenuFor = null; return; }
    closeModelPop(); closePlusMenu(); closeSkillsMenu(); closeHistory();
    chipMenuFor = kind;
    if (kind === "mode") {
      var modeVal = (currentStatus && currentStatus.mode) || "agent";
      openSubmenu(anchor, "Mode", [
        { value: "agent", label: "Agent \u2014 rencanakan & kerjakan" },
        { value: "plan", label: "Plan \u2014 hanya susun rencana" },
        { value: "ask", label: "Ask \u2014 baca-saja, tanpa edit/shell" },
      ], modeVal, function (v) { chipMenuFor = null; setMode(v); }, "above");
    } else if (kind === "desktop") {
      openSubmenu(anchor, "Computer use", [
        { value: "auto", label: "Auto \u2014 agent mengendalikan desktop bila tugas membutuhkan GUI" },
        { value: "on", label: "On \u2014 utamakan GUI desktop untuk tugas aplikasi/jendela" },
        { value: "off", label: "Off \u2014 tool desktop (computer use) dimatikan" },
      ], desktopToolsVal(), function (v) { chipMenuFor = null; postConfigLight({ desktopTools: v }); }, "above");
    } else {
      openSubmenu(anchor, "Browser tools", [
        { value: "auto", label: "Auto \u2014 agent memakai browser bila tugas membutuhkan" },
        { value: "on", label: "On \u2014 utamakan browser untuk semua tugas web" },
        { value: "off", label: "Off \u2014 tool browser dimatikan" },
      ], browserToolsVal(), function (v) { chipMenuFor = null; postConfigLight({ browserTools: v }); }, "above");
    }
  }
  function buildModelPop() { popover = el("div"); popover.id = "ai-modelpop"; panel.appendChild(popover); }
  function toggleModelPop() { if (popoverOpen) closeModelPop(); else openModelPop(); }
  function closeModelPop() { popover.classList.remove("open"); popoverOpen = false; closeSubmenu(); }

  function closeSubmenu() {
    if (submenu) { if (typeof submenu._cleanup === "function") { try { submenu._cleanup(); } catch (e) {} } submenu.remove(); submenu = null; }
    chipMenuFor = null;
  }
  // Tutup otomatis bila pointer meninggalkan submenu DAN anchor-nya lebih dari ~450 ms
  // (memberi waktu melintasi celah antara anchor dan menu).
  function armHoverClose(sm, anchorEl) {
    var timer = null;
    var disarm = function () { if (timer) { clearTimeout(timer); timer = null; } };
    var arm = function () { disarm(); timer = setTimeout(function () { if (submenu === sm) closeSubmenu(); }, 450); };
    sm.addEventListener("mouseenter", disarm); sm.addEventListener("mouseleave", arm);
    if (anchorEl) { anchorEl.addEventListener("mouseenter", disarm); anchorEl.addEventListener("mouseleave", arm); }
    sm._cleanup = function () {
      disarm();
      if (anchorEl) { anchorEl.removeEventListener("mouseenter", disarm); anchorEl.removeEventListener("mouseleave", arm); }
    };
    // Bila pointer sudah di luar saat menu dibuka (mis. klik lalu langsung geser), mulai hitung mundur.
    setTimeout(function () { if (!timer && submenu === sm && !sm.matches(":hover") && !(anchorEl && anchorEl.matches(":hover"))) arm(); }, 600);
  }
  // placement "above": menu muncul di atas anchor (untuk tombol di bar composer); default: di kiri/kanan anchor.
  // footer (opsional): elemen aksi di bawah daftar, mis. tombol "Muat model".
  function openSubmenu(anchorEl, title, items, current, onPick, placement, footer) {
    closeSubmenu();
    submenu = el("div"); submenu.id = "ai-submenu";
    submenu.appendChild(el("div", "ai-sub-head", title));
    items.forEach(function (it) {
      var row = el("div", "ai-sub-item" + (it.value === current ? " sel" : ""));
      if (it.icon) row.appendChild(it.icon);
      row.appendChild(el("span", "lbl", it.label));
      row.appendChild(el("span", "ck", "\u2713"));
      row.addEventListener("click", function (e) { e.stopPropagation(); onPick(it.value); closeSubmenu(); });
      submenu.appendChild(row);
    });
    if (footer) submenu.appendChild(footer);
    document.body.appendChild(submenu);
    submenu.classList.add("open");
    armHoverClose(submenu, anchorEl);
    var r = anchorEl.getBoundingClientRect();
    var w = submenu.offsetWidth || 220, h = submenu.offsetHeight || 200;
    var left, top;
    if (placement === "above") {
      left = r.left; if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      top = r.top - h - 6; if (top < 8) top = r.bottom + 6;
    } else {
      left = r.left - w - 8; if (left < 8) left = r.right + 8;
      top = r.top; if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    }
    submenu.style.left = Math.max(8, left) + "px";
    submenu.style.top = Math.max(8, top) + "px";
  }
  function openModelSubmenu(anchorEl) {
    // Tombol "Muat model": ambil ulang daftar dari provider (lewati cache server).
    function loadBtn(label) {
      var act = el("div", "ai-sub-item act");
      act.appendChild(el("span", "lbl", label || "\u21bb Muat model"));
      act.addEventListener("click", function (e) {
        e.stopPropagation();
        act.classList.add("busy"); act.querySelector(".lbl").textContent = "Memuat model\u2026";
        fetchModels(null, true).then(build).catch(function (err) {
          build([{ value: "", label: "Gagal memuat: " + ((err && err.message) || "cek API key") }]);
        });
      });
      return act;
    }
    function build(fallbackItems) {
      var items = modelCatalog.map(function (m) { return { value: m.id, label: m.displayName || m.id, icon: modelLogo((m.displayName || "") + " " + m.id) }; });
      if (!items.length) items = fallbackItems || [{ value: (currentStatus && currentStatus.model) || "", label: (currentStatus && currentStatus.model) || "(tidak ada)" }];
      openSubmenu(anchorEl, "Model" + (modelCatalog.length ? " (" + modelCatalog.length + ")" : ""), items, currentStatus && currentStatus.model,
        function (v) { if (v) postConfigLight({ model: v }); }, undefined, loadBtn());
    }
    if (!modelCatalog.length) {
      openSubmenu(anchorEl, "Model", [{ value: "__l", label: "Memuat\u2026" }], null, function () {});
      fetchModels().then(build).catch(function (err) {
        build([{ value: "", label: "Gagal memuat: " + ((err && err.message) || "cek API key") }]);
      });
    } else build();
  }
  function openModelPop() {
    if (settings) settings.classList.remove("open"); closeHistory();
    popoverOpen = true; popover.classList.add("open"); renderPopover();
    if (enabled && !modelCatalog.length) fetchModels().then(renderPopover).catch(function () {});
  }

  function paramValue(p) {
    var cur = currentStatus && currentStatus.params && currentStatus.params[p.id];
    if (cur != null && cur !== "") return String(cur);
    return (p.values && p.values.length) ? p.values[0].value : "";
  }
  function valueLabel(p, val) {
    var f = (p.values || []).filter(function (v) { return v.value === val; })[0];
    return f ? (f.displayName || f.value) : val;
  }
  // Param dianggap boolean (toggle) hanya jika 2 nilainya benar-benar on/off.
  // Param seperti Context (300k/1m) bukan boolean -> jadi pilihan (submenu).
  function isBooleanParam(p) {
    var vals = (p.values || []);
    if (vals.length !== 2) return false;
    return vals.every(function (v) { return /^(true|false|on|off|yes|no|enabled|disabled|0|1)$/i.test(v.value); });
  }
  function toggleParts(p) {
    var vals = (p.values || []).map(function (v) { return v.value; });
    var offIdx = -1;
    vals.forEach(function (v, i) { if (offIdx === -1 && /^(off|false|no|0|disabled)$/i.test(v)) offIdx = i; });
    if (offIdx === -1) offIdx = 0;
    var onIdx = offIdx === 0 ? (vals.length > 1 ? 1 : 0) : 0;
    return { off: vals[offIdx], on: vals[onIdx] };
  }
  // Apakah thinking sedang aktif menurut params model saat ini.
  function thinkingEnabled() {
    var p = currentStatus && currentStatus.params; if (!p) return false;
    for (var k in p) { if (/think/i.test(k)) return /^(true|on|1|yes|enabled)$/i.test(String(p[k])); }
    return false;
  }
  function setParam(pid, value) {
    var params = {}, cur = currentStatus && currentStatus.params;
    if (cur) for (var k in cur) params[k] = cur[k];
    params[pid] = value;
    postConfigLight({ params: params });
  }
  function setMode(value) { postConfigLight({ mode: value }); }

  function chev() { return el("span", "chev", "\u203a"); }
  function popRow(k, valueNode, onClick) {
    var row = el("div", "ai-pop-row");
    row.appendChild(el("span", "k", k));
    var v = el("span", "v"); if (valueNode) v.appendChild(valueNode);
    row.appendChild(v);
    if (onClick) row.addEventListener("click", onClick);
    return row;
  }

  function renderPopover() {
    if (!popover) return;
    popover.innerHTML = "";

    // Mode & Browser tools punya tombol sendiri di bar composer (samping Skills).
    var model = findModel(currentStatus && currentStatus.model);
    var params = (model && model.parameters) ? model.parameters : [];
    if (params.length) {
      params.forEach(function (p) {
        var cur = paramValue(p);
        if (isBooleanParam(p)) {
          var t = toggleParts(p);
          var sw = el("span", "ai-sw" + (cur === t.on ? " on" : "")); sw.appendChild(el("i"));
          popover.appendChild(popRow(p.displayName || p.id, sw, function () { setParam(p.id, cur === t.on ? t.off : t.on); }));
        } else {
          var row = popRow(p.displayName || p.id, el("span", null, valueLabel(p, cur)), function () {
            openSubmenu(row, p.displayName || p.id,
              (p.values || []).map(function (v) { return { value: v.value, label: v.displayName || v.value }; }),
              cur, function (val) { setParam(p.id, val); });
          });
          row.querySelector(".v").appendChild(chev());
          popover.appendChild(row);
        }
      });
    }

    if (params.length) popover.appendChild(el("div", "ai-pop-sep"));
    var mval = el("span", "ai-mval"); if (currentStatus && currentStatus.model) mval.appendChild(modelLogoFor(currentStatus.model)); mval.appendChild(el("span", null, chipLabel()));
    var mrow = popRow("Model", mval, function () { openModelSubmenu(mrow); });
    mrow.querySelector(".v").appendChild(chev());
    popover.appendChild(mrow);

    if (!enabled) {
      var note = el("div", "ai-pop-note", "AI belum aktif.");
      var link = el("span", "ai-link", "Atur API key"); link.addEventListener("click", function () { closeModelPop(); openSettings(); });
      note.appendChild(link); popover.appendChild(note);
    }
  }

  // Simpan opsi model/mode tanpa merender ulang seluruh panel.
  function postJsonConfig(body) {
    return apiJson("/api/ai/config", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  function postConfigLight(body) {
    return postJsonConfig(body).then(function (s) {
      mergeStatus(s); enabled = !!currentStatus.enabled;
      renderChip();
      setBusy(busy); // composer tetap bisa dipakai untuk antrean saat sibuk
      if (popoverOpen) renderPopover();
      updateCfgStatus();
      emitAgentStatus();
    }).catch(function () {});
  }

  // ------------------------------------------------------------ Settings
  // Menu API Key tersendiri (model dipilih lewat popover di composer).
  var cfgProvider = null, cfgAnthKey = null;
  function buildSettings() {
    settings = el("div"); settings.id = "ai-settings";
    // Kepala panel: judul + tombol ✕ di kanan atas (menggantikan tombol "Tutup").
    var head = el("div", "ai-cfg-head");
    head.appendChild(el("div", "ai-cfg-title", "Pengaturan Agent"));
    var xBtn = el("span", "ai-cfg-x", "\u2715"); xBtn.title = "Tutup"; xBtn.setAttribute("role", "button"); xBtn.tabIndex = 0;
    xBtn.addEventListener("click", function () { settings.classList.remove("open"); });
    xBtn.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); settings.classList.remove("open"); } });
    head.appendChild(xBtn);
    settings.appendChild(head);
    settings.appendChild(el("div", "ai-cfg-title", "Provider & API Key"));
    var status = el("div", "ai-cfg-status"); status.id = "ai-cfg-status"; settings.appendChild(status);

    // Pilihan provider: Cursor SDK (default) atau Anthropic Claude langsung.
    var f0 = el("div", "ai-field");
    f0.appendChild(el("label", null, "Provider AI"));
    cfgProvider = el("select"); cfgProvider.id = "ai-cfg-provider";
    [["cursor", "Cursor (Cursor SDK)"], ["anthropic", "Anthropic Claude (API key Anthropic)"], ["grok", "Grok (akun xAI)"]].forEach(function (o) {
      var op = el("option", null, o[1]); op.value = o[0]; cfgProvider.appendChild(op);
    });
    cfgProvider.addEventListener("change", function () {
      var p = cfgProvider.value;
      syncProviderFields();
      postConfig({ provider: p }).then(function () { modelCatalog = []; fetchModels().catch(function () {}); renderChip(); });
    });
    f0.appendChild(cfgProvider); settings.appendChild(f0);

    var f1 = el("div", "ai-field"); f1.id = "ai-cfg-field-cursor";
    f1.appendChild(el("label", null, "Cursor API Key"));
    cfgKey = el("input"); cfgKey.type = "password"; cfgKey.id = "ai-cfg-key";
    cfgKey.placeholder = "cursor_\u2026 (kosongkan = tidak diubah)"; cfgKey.autocomplete = "off";
    cfgKey.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveConfigWeb(); } });
    f1.appendChild(cfgKey); settings.appendChild(f1);

    var f2 = el("div", "ai-field"); f2.id = "ai-cfg-field-anthropic";
    f2.appendChild(el("label", null, "Anthropic API Key"));
    cfgAnthKey = el("input"); cfgAnthKey.type = "password"; cfgAnthKey.id = "ai-cfg-anth-key";
    cfgAnthKey.placeholder = "sk-ant-\u2026 (kosongkan = tidak diubah)"; cfgAnthKey.autocomplete = "off";
    cfgAnthKey.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveConfigWeb(); } });
    f2.appendChild(cfgAnthKey); settings.appendChild(f2);

    var fg = el("div", "ai-field"); fg.id = "ai-cfg-field-grok";
    fg.appendChild(el("label", null, "Akun Grok / xAI"));
    var grokBox = el("div", "ai-grok-box"); grokBox.id = "ai-grok-box";
    grokBox.appendChild(el("div", "ai-cfg-status", "")).id = "ai-grok-status";
    var grokCode = el("div", "ai-grok-code"); grokCode.id = "ai-grok-code"; grokCode.hidden = true; grokBox.appendChild(grokCode);
    var grokLink = el("a", "ai-grok-link"); grokLink.id = "ai-grok-link"; grokLink.target = "_blank"; grokLink.rel = "noopener noreferrer"; grokLink.hidden = true; grokBox.appendChild(grokLink);
    var grokAct = el("div", "ai-cfg-actions"); grokAct.id = "ai-grok-actions"; grokBox.appendChild(grokAct);
    grokBox.appendChild(el("div", "ai-cfg-note",
      "Masuk dengan akun Grok/xAI Anda sendiri (SuperGrok atau X Premium+). Server membuka alur resmi device-code di auth.x.ai; buka tautannya di browser apa pun, konfirmasi kode, lalu token disimpan di server (data/grok-session.json), bukan di browser. Tidak perlu API key."));
    fg.appendChild(grokBox); settings.appendChild(fg);

    var act = el("div", "ai-cfg-actions"); act.id = "ai-cfg-key-actions";
    var saveB = el("button", "save", "Simpan"); saveB.type = "button"; saveB.addEventListener("click", saveConfigWeb);
    var clearB = el("button", "ghost", "Hapus key"); clearB.type = "button"; clearB.addEventListener("click", clearKey);
    act.appendChild(saveB); act.appendChild(clearB); settings.appendChild(act);

    settings.appendChild(el("div", "ai-cfg-note",
      "Key Cursor/Anthropic disimpan di server (data/ai-config.json) dan menimpa .env. Grok memakai login akun (bukan API key). Pilih model & opsi (Thinking/Effort/Context) lewat tombol model di bawah composer. " +
      "Provider Anthropic dan Grok memakai tool workspace bawaan (baca/edit file, shell, pencarian, browser)."));

    buildGuardSettings(settings);
    buildSecretsSettings(settings);
    buildMemorySettings(settings);
    buildMiscSettings(settings);
    panel.appendChild(settings);
  }

  // ---- Memori proyek (.vrcloud-agent/memory.md): dimuat ke prompt setiap run, agent boleh memperbarui ----
  var memUi = {};
  function buildMemorySettings(parent) {
    var sec = el("div", "ai-cfg-sec");
    sec.appendChild(el("div", "ai-cfg-title", "Memori proyek"));
    var memChk = el("label", "ai-chk"); memUi.on = el("input"); memUi.on.type = "checkbox"; memUi.on.id = "ai-memory-on";
    memUi.on.checked = !(currentStatus && currentStatus.memory === false);
    memUi.on.addEventListener("change", function () {
      var on = memUi.on.checked;
      postJsonConfig({ memory: on }).then(function (s) { mergeStatus(s); renderMemoryToggle(); memUi.status.textContent = on ? "Memori aktif: disisipkan ke setiap run." : "Memori nonaktif: agent tidak membaca atau menulis memory.md."; })
        .catch(function (e) { memUi.on.checked = !on; memUi.status.textContent = "Gagal: " + e.message; });
    });
    memChk.appendChild(memUi.on); memChk.appendChild(document.createTextNode("Aktifkan memori proyek")); sec.appendChild(memChk);
    sec.appendChild(el("div", "ai-cfg-note", "Catatan tahan-lama lintas percakapan (konvensi kode, keputusan arsitektur, perintah build/test, jebakan yang sudah ditemukan). Disimpan di .vrcloud-agent/memory.md, disisipkan ke setiap run, dan agent sendiri akan menambah/memperbarui isinya. Saat nonaktif, file tetap tersimpan tetapi tidak dipakai agent."));
    memUi.ta = el("textarea"); memUi.ta.spellcheck = false; memUi.ta.placeholder = "- Gunakan pnpm, bukan npm\n- Test: pnpm test (butuh Node 22)\n- Jangan sentuh folder legacy/ tanpa konfirmasi";
    memUi.ta.className = "ai-mem-ta"; sec.appendChild(memUi.ta);
    var act = el("div", "ai-cfg-actions");
    var save = el("button", "save", "Simpan memori"); save.type = "button"; save.addEventListener("click", saveMemory); act.appendChild(save);
    var open = el("button", "ghost", "Buka di editor"); open.type = "button"; open.addEventListener("click", function () { openInEditor(".vrcloud-agent/memory.md"); }); act.appendChild(open);
    var clear = el("button", "ghost", "Kosongkan"); clear.type = "button"; clear.addEventListener("click", function () { if (confirm("Kosongkan memori proyek?")) { memUi.ta.value = ""; saveMemory(); } }); act.appendChild(clear);
    sec.appendChild(act);
    memUi.status = el("div", "ai-cfg-status"); sec.appendChild(memUi.status);
    parent.appendChild(sec);
  }
  function renderMemoryToggle() {
    if (!memUi.on) return;
    var off = !!(currentStatus && currentStatus.memory === false);
    if (document.activeElement !== memUi.on) memUi.on.checked = !off;
    if (memUi.ta) memUi.ta.style.opacity = off ? ".55" : "";
  }
  function loadMemory() {
    if (!memUi.ta) return;
    renderMemoryToggle();
    apiJson("/api/ai/memory", { credentials: "same-origin" }).then(function (m) {
      if (document.activeElement !== memUi.ta) memUi.ta.value = m.content || "";
      var off = !!(currentStatus && currentStatus.memory === false);
      memUi.status.textContent = off
        ? "Memori nonaktif: agent tidak membaca atau menulis memory.md" + (m.exists ? " (" + m.size + " karakter tersimpan)." : ".")
        : (m.exists ? (m.size + " karakter \u00b7 disisipkan ke setiap run (maks 6.000 karakter pertama)") : "Belum ada memori. Agent akan membuatnya saat menemukan hal yang layak diingat, atau tulis sendiri di sini.");
    }).catch(function () {});
  }
  function saveMemory() {
    apiJson("/api/ai/memory", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: memUi.ta.value }) })
      .then(function () { memUi.status.textContent = "Tersimpan."; loadMemory(); })
      .catch(function (e) { memUi.status.textContent = "Gagal: " + e.message; });
  }

  function openSettings() {
    if (!settings) return;
    // Editor skill/rule (z-index lebih tinggi) harus ditutup, kalau tidak setelan terbuka di bawahnya.
    closeHistory(); closeModelPop(); closePlusMenu(); closeSkillsMenu(); closeSkillEditor();
    cfgKey.value = "";
    if (cfgAnthKey) cfgAnthKey.value = "";
    if (cfgProvider && currentStatus && currentStatus.provider) cfgProvider.value = currentStatus.provider;
    syncProviderFields();
    updateCfgStatus();
    renderGrokAuth();
    renderGuardSettings();
    loadSecrets();
    loadMemory();
    settings.classList.add("open");
    setTimeout(function () {
      var p = cfgProvider && cfgProvider.value;
      if (p === "grok") return;
      if (cfgKey) cfgKey.focus();
    }, 30);
  }

  // ---- Rahasia browser (kata sandi/token untuk browser_type({ secret })) ----
  var secretsUi = {};
  function buildSecretsSettings(parent) {
    var sec = el("div", "ai-cfg-sec");
    sec.appendChild(el("div", "ai-cfg-title", "Rahasia browser agent"));
    sec.appendChild(el("div", "ai-cfg-note", "Kata sandi/token yang bisa diketik agent ke formulir web lewat browser_type({ secret: nama }). Disimpan terenkripsi (AES-256-GCM) di server; agent hanya melihat namanya, nilainya tidak pernah masuk percakapan."));
    secretsUi.list = el("div", "ai-secrets"); sec.appendChild(secretsUi.list);
    var row = el("div", "ai-secret-add");
    secretsUi.name = el("input"); secretsUi.name.type = "text"; secretsUi.name.placeholder = "nama (mis. github_password)"; secretsUi.name.autocomplete = "off"; secretsUi.name.spellcheck = false;
    secretsUi.value = el("input"); secretsUi.value.type = "password"; secretsUi.value.placeholder = "nilai"; secretsUi.value.autocomplete = "new-password";
    var add = el("button", "save", "Simpan"); add.type = "button"; add.addEventListener("click", saveSecret);
    secretsUi.value.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveSecret(); } });
    row.appendChild(secretsUi.name); row.appendChild(secretsUi.value); row.appendChild(add); sec.appendChild(row);
    secretsUi.status = el("div", "ai-cfg-status"); sec.appendChild(secretsUi.status);
    parent.appendChild(sec);
  }
  function renderSecrets(items) {
    if (!secretsUi.list) return;
    secretsUi.list.innerHTML = "";
    if (!items || !items.length) { secretsUi.list.appendChild(el("div", "ai-cfg-note", "Belum ada rahasia tersimpan.")); return; }
    items.forEach(function (it) {
      var r = el("div", "ai-secret");
      r.appendChild(svgIcon("lock", 11));
      var nm = el("code", null, it.name); nm.title = "Diperbarui " + new Date(it.updatedAt || it.createdAt || 0).toLocaleString(); r.appendChild(nm);
      r.appendChild(el("span", "dots", "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"));
      var del = el("button", "ghost", "Hapus"); del.type = "button";
      del.addEventListener("click", function () {
        if (!confirm("Hapus rahasia \"" + it.name + "\"?")) return;
        apiJson("/api/ai/browser/secrets/" + encodeURIComponent(it.name), { method: "DELETE", credentials: "same-origin" })
          .then(function (res) { renderSecrets(res.items || []); }).catch(function (e) { secretsUi.status.textContent = "Gagal: " + e.message; });
      });
      r.appendChild(del); secretsUi.list.appendChild(r);
    });
  }
  function loadSecrets() {
    if (!secretsUi.list) return;
    apiJson("/api/ai/browser/secrets", { credentials: "same-origin" }).then(renderSecrets).catch(function () {});
  }
  function saveSecret() {
    var name = secretsUi.name.value.trim(), value = secretsUi.value.value;
    if (!name || !value) { secretsUi.status.textContent = "Isi nama dan nilai."; return; }
    apiJson("/api/ai/browser/secrets", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name, value: value }) })
      .then(function (res) { renderSecrets(res.items || []); secretsUi.name.value = ""; secretsUi.value.value = ""; secretsUi.status.textContent = "Tersimpan: " + name + ". Agent memakainya dengan browser_type({ secret: \"" + name + "\" })."; })
      .catch(function (e) { secretsUi.status.textContent = "Gagal: " + e.message; });
  }

  // ---- Pengaman perintah berbahaya ----
  var guardUi = {};
  function buildGuardSettings(parent) {
    var sec = el("div", "ai-cfg-sec");
    sec.appendChild(el("div", "ai-cfg-title", "Pengaman perintah berbahaya"));
    var st = el("div", "ai-cfg-status"); st.id = "ai-guard-status"; sec.appendChild(st);
    var chk = el("label", "ai-chk"); guardUi.enabled = el("input"); guardUi.enabled.type = "checkbox";
    chk.appendChild(guardUi.enabled); chk.appendChild(document.createTextNode("Minta izin sebelum agent menjalankan perintah yang cocok pola di bawah")); sec.appendChild(chk);
    var f = el("div", "ai-field"); f.appendChild(el("label", null, "Pola (regex JavaScript, satu per baris, tidak peka huruf besar/kecil)"));
    guardUi.patterns = el("textarea"); guardUi.patterns.spellcheck = false; f.appendChild(guardUi.patterns); sec.appendChild(f);
    var f2 = el("div", "ai-field"); f2.appendChild(el("label", null, "Batas waktu menunggu izin (detik; lewat = ditolak)"));
    guardUi.timeout = el("input"); guardUi.timeout.type = "number"; guardUi.timeout.min = "30"; guardUi.timeout.max = "840"; f2.appendChild(guardUi.timeout); sec.appendChild(f2);
    var act = el("div", "ai-cfg-actions");
    var save = el("button", "save", "Simpan pengaman"); save.type = "button"; save.addEventListener("click", saveGuard);
    var reset = el("button", "ghost", "Pola bawaan"); reset.type = "button"; reset.addEventListener("click", function () {
      apiJson("/api/ai/guard", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patterns: null }) })
        .then(function (g) { fillGuard(g); }).catch(function (e) { st.textContent = "Gagal: " + e.message; });
    });
    act.appendChild(save); act.appendChild(reset); sec.appendChild(act);
    sec.appendChild(el("div", "ai-cfg-note",
      "Bekerja lewat hook Cursor beforeShellExecution (.vrcloud-agent/hooks.json di workspace). Perintah yang cocok ditahan sampai Anda klik Izinkan/Tolak di chat."));
    parent.appendChild(sec);
  }
  function fillGuard(g) {
    if (!g || !guardUi.enabled) return;
    guardUi.enabled.checked = g.enabled !== false;
    guardUi.patterns.value = (g.patterns || []).join("\n");
    guardUi.timeout.value = g.timeoutSec || 300; if (g.timeoutMax) guardUi.timeout.max = String(g.timeoutMax);
    var st = document.getElementById("ai-guard-status");
    if (st) st.textContent = (g.enabled !== false ? "Aktif" : "Nonaktif") + " \u00b7 " + (g.patterns || []).length + " pola" + (g.isDefault ? " (bawaan)" : " (kustom)");
  }
  function renderGuardSettings() { if (currentStatus && currentStatus.guard) fillGuard(currentStatus.guard); }
  function saveGuard() {
    var st = document.getElementById("ai-guard-status");
    apiJson("/api/ai/guard", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: guardUi.enabled.checked, patterns: guardUi.patterns.value, timeoutSec: guardUi.timeout.value }) })
      .then(function (g) { fillGuard(g); if (st) st.textContent = "Tersimpan. " + st.textContent; currentStatus.guard = g; })
      .catch(function (e) { if (st) st.textContent = "Gagal: " + e.message; });
  }

  // ---- Lain-lain: notifikasi, checkpoint ----
  function buildMiscSettings(parent) {
    var sec = el("div", "ai-cfg-sec");
    sec.appendChild(el("div", "ai-cfg-title", "Notifikasi & checkpoint"));
    var chk = el("label", "ai-chk"); var n = el("input"); n.type = "checkbox"; n.checked = localStorage.getItem(NOTIFY_KEY) === "1";
    n.addEventListener("change", function () {
      if (n.checked && typeof Notification !== "undefined" && Notification.permission !== "granted") {
        Notification.requestPermission().then(function (p) { if (p !== "granted") n.checked = false; localStorage.setItem(NOTIFY_KEY, n.checked ? "1" : "0"); });
      } else localStorage.setItem(NOTIFY_KEY, n.checked ? "1" : "0");
    });
    chk.appendChild(n); chk.appendChild(document.createTextNode("Notifikasi browser saat agent selesai (bila tab tidak aktif)")); sec.appendChild(chk);
    var cp = el("div", "ai-cfg-note"); cp.id = "ai-cp-note"; sec.appendChild(cp);
    sec.appendChild(el("div", "ai-cfg-note", "Jumlah balasan yang belum dilihat tampil di ikon bel status bar saat panel tertutup; tombol AI di menubar ikut berkedip."));
    parent.appendChild(sec);

    // Verifikasi otomatis setelah edit.
    var sec2 = el("div", "ai-cfg-sec");
    sec2.appendChild(el("div", "ai-cfg-title", "Verifikasi otomatis setelah edit"));
    var f = el("div", "ai-field"); f.appendChild(el("label", null, "Perintah yang dijalankan agent setelah mengubah kode (kosongkan untuk nonaktif)"));
    var vi = el("input"); vi.type = "text"; vi.id = "ai-verify-cmd"; vi.placeholder = "mis. npm test  \u00b7  python -m pytest -q  \u00b7  go test ./..."; vi.autocomplete = "off";
    vi.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveVerify(); } });
    f.appendChild(vi); sec2.appendChild(f);
    var act = el("div", "ai-cfg-actions");
    var sv = el("button", "save", "Simpan"); sv.type = "button"; sv.addEventListener("click", saveVerify); act.appendChild(sv); sec2.appendChild(act);
    var vs = el("div", "ai-cfg-status"); vs.id = "ai-verify-status"; sec2.appendChild(vs);
    sec2.appendChild(el("div", "ai-cfg-note", "Agent diinstruksikan menjalankan perintah ini setelah setiap perubahan kode dan memperbaiki sendiri bila gagal (maks 3 kali), lalu melaporkan hasilnya."));
    parent.appendChild(sec2);

    // Prompt caching: hemat token/biaya dengan menyimpan prefix prompt (system, tool, riwayat) di sisi provider.
    var sec3 = el("div", "ai-cfg-sec");
    sec3.appendChild(el("div", "ai-cfg-title", "Prompt caching"));
    var pcChk = el("label", "ai-chk"); var pc = el("input"); pc.type = "checkbox"; pc.id = "ai-prompt-cache";
    pc.checked = !(currentStatus && currentStatus.promptCache === false);
    pc.addEventListener("change", function () {
      var on = pc.checked; var st = document.getElementById("ai-pc-status");
      postJsonConfig({ promptCache: on }).then(function (s) { mergeStatus(s); renderPromptCache(); if (st) st.textContent = "Tersimpan."; })
        .catch(function (e) { pc.checked = !on; if (st) st.textContent = "Gagal: " + e.message; });
    });
    pcChk.appendChild(pc); pcChk.appendChild(document.createTextNode("Aktifkan prompt caching")); sec3.appendChild(pcChk);
    var pcs = el("div", "ai-cfg-status"); pcs.id = "ai-pc-status"; sec3.appendChild(pcs);
    var pcn = el("div", "ai-cfg-note"); pcn.id = "ai-pc-note"; sec3.appendChild(pcn);
    parent.appendChild(sec3);
    renderPromptCache();
  }
  function renderPromptCache() {
    var pc = document.getElementById("ai-prompt-cache"), note = document.getElementById("ai-pc-note"); if (!pc || !note) return;
    var s = currentStatus || {};
    if (document.activeElement !== pc) pc.checked = s.promptCache !== false;
    var isAnth = s.provider === "anthropic";
    var isGrok = s.provider === "grok";
    note.textContent = isAnth
      ? (s.promptCache !== false
        ? "Anthropic: system prompt, definisi tool, dan riwayat percakapan diberi cache breakpoint (ephemeral) sehingga request lanjutan membaca prefix dari cache — token cache dibaca ~10% harga input. Statistik cache tampil di pemakaian token sesi."
        : "Nonaktif: setiap request mengirim ulang seluruh prompt dengan harga input penuh.")
      : (isGrok
        ? "Grok: prefix prompt dikirim utuh setiap request. Caching sisi xAI (bila ada) tidak dikontrol dari sini."
        : "Cursor: caching prompt dikelola otomatis oleh layanan Cursor untuk semua model; pengaturan ini berpengaruh saat provider Anthropic dipakai.");
  }
  function fillVerify() {
    var vi = document.getElementById("ai-verify-cmd"); if (!vi || document.activeElement === vi) return;
    vi.value = (currentStatus && currentStatus.verifyCmd) || "";
  }
  function saveVerify() {
    var vi = document.getElementById("ai-verify-cmd"), vs = document.getElementById("ai-verify-status");
    postJsonConfig({ verifyCmd: vi.value })
      .then(function (s) { mergeStatus(s); if (vs) vs.textContent = s.verifyCmd ? "Aktif: " + s.verifyCmd : "Nonaktif."; })
      .catch(function (e) { if (vs) vs.textContent = "Gagal: " + e.message; });
  }
  function renderCpNote() {
    var cp = document.getElementById("ai-cp-note"); if (!cp) return;
    var c = currentStatus && currentStatus.checkpoints;
    cp.textContent = c && c.available
      ? "Checkpoint aktif: workspace di-snapshot (shadow git di data/checkpoints.git) sebelum setiap pesan. Arahkan kursor ke pesan Anda untuk \u201cKembalikan\u201d, atau klik \u21b6 di kartu edit untuk satu file."
      : "Checkpoint nonaktif: git tidak ditemukan di server" + (c && c.error ? " (" + c.error + ")" : "") + ". Pasang git agar tombol Kembalikan tersedia.";
  }

  // Tampilkan kolom key / login sesuai provider yang dipilih.
  function syncProviderFields() {
    var p = (cfgProvider && cfgProvider.value) || (currentStatus && currentStatus.provider) || "cursor";
    var fc = document.getElementById("ai-cfg-field-cursor"), fa = document.getElementById("ai-cfg-field-anthropic");
    var fg = document.getElementById("ai-cfg-field-grok"), ka = document.getElementById("ai-cfg-key-actions");
    if (fc) { fc.style.display = p === "grok" ? "none" : ""; fc.style.opacity = p === "cursor" ? "1" : ".55"; }
    if (fa) { fa.style.display = p === "grok" ? "none" : ""; fa.style.opacity = p === "anthropic" ? "1" : ".55"; }
    if (fg) fg.style.display = p === "grok" ? "" : "none";
    if (ka) ka.style.display = p === "grok" ? "none" : "";
    renderGrokAuth();
  }
  function providerLabel(p) { return p === "anthropic" ? "Anthropic Claude" : (p === "grok" ? "Grok" : "Cursor"); }
  var grokPollTimer = 0;
  function stopGrokPoll() { if (grokPollTimer) { clearInterval(grokPollTimer); grokPollTimer = 0; } }
  function renderGrokAuth() {
    var box = document.getElementById("ai-grok-box"); if (!box) return;
    var s = currentStatus || {};
    var g = s.grok || {};
    var st = document.getElementById("ai-grok-status");
    var code = document.getElementById("ai-grok-code");
    var link = document.getElementById("ai-grok-link");
    var act = document.getElementById("ai-grok-actions");
    var pending = g.pending;
    if (st) {
      if (pending) st.textContent = "Menunggu persetujuan di browser\u2026 kode kedaluwarsa " + (pending.expiresAt ? new Date(pending.expiresAt).toLocaleTimeString() : "segera") + ".";
      else if (g.connected) st.textContent = "Terhubung" + (g.emailMasked ? " sebagai " + g.emailMasked : "") + (g.expiresAt ? " \u00b7 sesi sampai " + new Date(g.expiresAt).toLocaleString() : "") + ".";
      else st.textContent = "Belum terhubung. Klik Masuk dengan Grok, lalu konfirmasi di browser.";
    }
    if (code) {
      code.hidden = !pending;
      code.textContent = pending ? (pending.userCode || "") : "";
    }
    if (link) {
      var href = pending && (pending.verificationUriComplete || pending.verificationUri);
      link.hidden = !href;
      if (href) { link.href = href; link.textContent = href; }
    }
    if (act) {
      act.innerHTML = "";
      if (pending) {
        var cancel = el("button", "ghost", "Batalkan masuk"); cancel.type = "button";
        cancel.addEventListener("click", function () { grokLogin({ cancel: true }); });
        act.appendChild(cancel);
      } else if (g.connected) {
        var out = el("button", "ghost", "Keluar dari Grok"); out.type = "button";
        out.addEventListener("click", function () {
          if (!confirm("Putuskan akun Grok dari server ini?")) return;
          apiJson("/api/ai/grok/logout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" })
            .then(function (st2) { applyStatus(st2); renderGrokAuth(); modelCatalog = []; })
            .catch(function (e) { if (st) st.textContent = "Gagal keluar: " + e.message; });
        });
        act.appendChild(out);
      } else {
        var inn = el("button", "save", "Masuk dengan Grok"); inn.type = "button";
        inn.addEventListener("click", function () { grokLogin({}); });
        act.appendChild(inn);
      }
    }
    if (pending && !grokPollTimer) {
      grokPollTimer = setInterval(function () {
        apiJson("/api/ai/status", { credentials: "same-origin" }).then(function (st2) {
          applyStatus(st2);
          renderGrokAuth();
          var g2 = (st2 && st2.grok) || {};
          if (!g2.pending) {
            stopGrokPoll();
            if (g2.connected) { modelCatalog = []; fetchModels().catch(function () {}); }
          }
        }).catch(function () {});
      }, 2000);
    }
    if (!pending) stopGrokPoll();
  }
  function grokLogin(body) {
    var st = document.getElementById("ai-grok-status");
    apiJson("/api/ai/grok/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (s) { applyStatus(s); renderGrokAuth(); })
      .catch(function (e) { if (st) st.textContent = "Gagal memulai masuk: " + e.message; });
  }
  function updateCfgStatus() {
    var line = document.getElementById("ai-cfg-status"); if (!line) return;
    var s = currentStatus || {};
    if (cfgProvider && s.provider && cfgProvider.value !== s.provider) { cfgProvider.value = s.provider; syncProviderFields(); }
    var prov = providerLabel(s.provider || "cursor");
    if (s.provider === "grok") {
      line.textContent = s.enabled
        ? "Status: aktif \u00b7 Grok \u00b7 akun " + (s.keyMasked || "terhubung") + " \u00b7 model " + s.model
        : "Status: nonaktif \u00b7 Grok \u00b7 " + (s.reason || "");
      renderGrokAuth();
      return;
    }
    if (!s.hasSdk) { line.textContent = "Status: modul @cursor/sdk belum terpasang di server (pilih Anthropic Claude atau Grok, atau jalankan npm install)."; return; }
    line.textContent = s.enabled
      ? "Status: aktif \u00b7 " + prov + " \u00b7 sumber " + s.source + " \u00b7 key " + (s.keyMasked || "") + " \u00b7 model " + s.model
      : "Status: nonaktif \u00b7 " + prov + " \u00b7 " + (s.reason || "");
  }

  function postConfig(body) {
    return postJsonConfig(body)
      .then(function (s) { cfgKey.value = ""; if (cfgAnthKey) cfgAnthKey.value = ""; applyStatus(s); var line = document.getElementById("ai-cfg-status"); if (line) line.textContent = "Tersimpan. " + line.textContent; })
      .catch(function (e) { var line = document.getElementById("ai-cfg-status"); if (line) line.textContent = "Gagal menyimpan: " + e.message; });
  }
  function saveConfigWeb() {
    var k = (cfgKey.value || "").trim();
    var ak = cfgAnthKey ? (cfgAnthKey.value || "").trim() : "";
    var line = document.getElementById("ai-cfg-status");
    var body = {};
    if (k) body.apiKey = k;
    if (ak) body.anthropicKey = ak;
    var p = cfgProvider ? cfgProvider.value : "";
    if (p && (!currentStatus || currentStatus.provider !== p)) body.provider = p;
    // Mengisi key Anthropic tanpa key Cursor: langsung aktifkan provider Anthropic.
    if (ak && !k && p !== "anthropic" && cfgProvider) { cfgProvider.value = "anthropic"; body.provider = "anthropic"; syncProviderFields(); }
    if (!Object.keys(body).length) { if (line) line.textContent = "Masukkan API key lalu Simpan."; return; }
    postConfig(body).then(function () {
      modelCatalog = [];
      return fetchModels().catch(function (e) {
        var line2 = document.getElementById("ai-cfg-status");
        if (line2) line2.textContent = "Key tersimpan, tetapi provider mengembalikan error: " + ((e && e.message) || e);
      });
    });
  }
  function clearKey() {
    modelCatalog = [];
    var p = (cfgProvider && cfgProvider.value) || (currentStatus && currentStatus.provider) || "cursor";
    postConfig(p === "anthropic" ? { anthropicKey: "" } : { apiKey: "" });
  }

  function fetchModels(apiKey, refresh) {
    var body = {}; if (apiKey) body.apiKey = apiKey;
    if (refresh) body.refresh = true;
    if (currentStatus && currentStatus.provider) body.provider = currentStatus.provider;
    return apiJson("/api/ai/models", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (d) { modelCatalog = (d && d.models) || []; return modelCatalog; });
  }

  // Segarkan daftar percakapan; bila sesi aktif sedang dijalankan browser lain,
  // muat ulang (pesan pengguna pemicunya ikut) lalu sambung ke stream-nya.
  function syncSessions() {
    return fetchSessions().then(function (list) {
      convsCache = list || [];
      if (historyOpen) renderHistoryList();
      var id = sessionId();
      var cur = null;
      convsCache.forEach(function (c) { if (c.id === id) cur = c; });
      if (cur && cur.busy && !busy && enabled) return openSession(id);
      // Sesi aktif dihapus dari browser lain → pindah ke yang teratas / buat baru.
      if (id && convsCache.length && !cur && !busy) { localStorage.setItem(ACTIVE_KEY, convsCache[0].id); return openSession(convsCache[0].id); }
    }).catch(function () {});
  }
  // Polling hanya cadangan (10 s); sinkron utama lewat event realtime di bawah.
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(syncSessions, 10000);
  }

  // ------------------------------------------ Sinkron realtime antar browser
  // Lewat hub WebSocket IDE (window.VRCloud.onSync): run mulai/selesai & daftar sesi
  // dari server, serta draft composer yang diketik di browser lain.
  var draftTimer = null, lastLocalEdit = 0, suppressDraft = false;
  function bindRealtime() {
    var api = window.VRCloud;
    if (!api || !api.onSync) return;
    api.onSync("ai", function (m) {
      if (!m || !m.event) return;
      if (m.event === "run-start") {
        // Browser ini bukan pengirimnya (kalau pengirim, sudah busy): tampilkan sekarang.
        if (m.sessionId === sessionId() && !busy) openSession(m.sessionId);
        else syncSessions();
      } else if (m.event === "run-end" || m.event === "sessions-changed") {
        syncSessions();
      }
    });
    api.onSync("ai-draft", function (m) {
      if (!m || m.sessionId !== sessionId()) return;
      if (api.clientId && m.source === api.clientId()) return;
      // Pengguna di browser ini sedang mengetik: jangan timpa ketikannya.
      if (document.activeElement === input && Date.now() - lastLocalEdit < 1500) return;
      if (input.value === m.text) return;
      suppressDraft = true;
      input.value = m.text; autoGrow();
      suppressDraft = false;
    });
  }
  function broadcastDraft() {
    var api = window.VRCloud;
    if (!api || !api.syncSend || suppressDraft) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { api.syncSend({ type: "ai-draft", sessionId: sessionId(), text: input.value }); }, 150);
  }

  // ------------------------------------------------------------ Init
  function init() {
    injectStyle();
    buildToggle();
    buildPanel();
    renderConversation();
    refreshStatus();
    ensureServerActive().then(function (id) {
      renderHistoryList();
      return openSession(id);
    }).catch(function () {
      loadHistory();
      renderConversation();
    });
    startPoll();
    bindRealtime();
    window.addEventListener("keydown", function (e) {
      if (e.altKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); toggle(); }
    });
    // Ctrl+L: kirim seleksi editor ke chat (capture: mendahului "goto line" Ace).
    // Tanpa seleksi, biarkan editor menangani seperti biasa.
    window.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || String(e.key).toLowerCase() !== "l") return;
      var api = window.VRCloud;
      var sel = api && api.getSelection ? api.getSelection() : null;
      if (!sel && !e.shiftKey) return;
      e.preventDefault(); e.stopPropagation();
      addEditorSelection();
    }, true);
    // Klik/tekan di luar menu menutupnya. Dipasang pada pointerdown fase capture supaya
    // tetap bekerja walau target (editor Ace, terminal xterm, iframe overlay) menghentikan
    // propagasi click atau memanggil preventDefault.
    function closeOpenMenus(e) {
      var t = e.target;
      var within = function (sel) { return !!(t && t.closest && t.closest(sel)); };
      if (historyOpen && !within("#ai-history") && !within("#ai-hist-btn")) closeHistory();
      if (popoverOpen && !within("#ai-modelpop") && !within("#ai-model-chip") && !within("#ai-submenu")) closeModelPop();
      if (submenu && !within("#ai-submenu") && !within(".ai-optchip") && !within("#ai-modelpop")) closeSubmenu();
      if (plusMenu && plusMenu.classList.contains("open") && !within("#ai-plusmenu") && !within("#ai-plus")) closePlusMenu();
      if (skillsMenu && skillsMenu.classList.contains("open") && !within("#ai-skillsmenu") && !within("#ai-skills-btn")) closeSkillsMenu();
    }
    document.addEventListener("pointerdown", closeOpenMenus, true);
    document.addEventListener("click", closeOpenMenus);
    // Pointer masuk ke iframe (preview/browser agent) tidak memicu event dokumen: tutup saat jendela kehilangan fokus.
    window.addEventListener("blur", function () { if (submenu) closeSubmenu(); if (popoverOpen) closeModelPop(); });
    // Esc menutup menu yang terbuka (submenu dulu, lalu popover/menu lain).
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (submenu) { closeSubmenu(); e.stopPropagation(); return; }
      if (popoverOpen) { closeModelPop(); e.stopPropagation(); return; }
      if (plusMenu && plusMenu.classList.contains("open")) { closePlusMenu(); return; }
      if (skillsMenu && skillsMenu.classList.contains("open")) { closeSkillsMenu(); return; }
      if (historyOpen) closeHistory();
    }, true);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && panel.classList.contains("open")) clearUnread(); });
    if (localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
