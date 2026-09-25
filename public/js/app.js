/* VRCloud IDE — frontend realtime dengan tiling panes */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const enc = encodeURIComponent;
  const api = {
    async get(u) { const r = await fetch(u); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); },
    async post(u, b) { const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); },
    async upload(destDir, relName, blob) {
      // Nama di-encode: header HTTP hanya boleh Latin-1 (nama CJK/emoji dulu gagal).
      const r = await fetch("/api/upload?path=" + enc(destDir), { method: "POST", headers: { "X-Filename": encodeURIComponent(relName) }, body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json();
    },
  };
  const basename = (p) => p.split("/").pop();
  const parentOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  // setStatus(pesan): pesan sementara di status bar (hilang otomatis setelah 7 detik).
  let statusMsgTimer = null;
  const setStatus = (l) => {
    if (l == null) return;
    const m = $("#status-file"); const txt = l === "siap" ? "" : String(l);
    m.textContent = txt; m.title = txt; clearTimeout(statusMsgTimer);
    if (txt) statusMsgTimer = setTimeout(() => { if (m.textContent === txt) { m.textContent = ""; m.title = ""; } }, 7000);
  };
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  let INFO = { workspace: "", name: "" };
  // i18n: teks DOM diterjemahkan otomatis oleh i18n.js; alert/confirm lewat T().
  const T = (s) => (window.I18N ? window.I18N.t(s) : s);
  const alert = (m) => window.alert(T(m));
  const confirm = (m) => window.confirm(T(m));
  const fmtVersion = (v) => { v = String(v || "").trim(); if (!v) return ""; const p = v.split("."); return "v" + (p.length === 3 && p[2] === "0" ? p[0] + "." + p[1] : v); };
  // Status bar: state + helper kecil (dideklarasikan di awal agar aman dipanggil dari mana pun).
  const SB = { presence: new Set(), git: null, agent: null };
  const MODE_LABELS = { text: "Plain Text", javascript: "JavaScript", typescript: "TypeScript", python: "Python", html: "HTML", css: "CSS", json: "JSON", markdown: "Markdown", sh: "Shell Script", yaml: "YAML", xml: "XML", sql: "SQL", php: "PHP", java: "Java", c_cpp: "C/C++", golang: "Go", ruby: "Ruby" };
  const sbEl = (id) => document.getElementById(id);
  const sbShow = (el, on) => { if (el) el.hidden = !on; };
  const sbTxt = (id, txt, title) => { const e = sbEl(id); if (!e) return; const t = e.querySelector(".txt"); (t || e).textContent = T(txt); if (title != null) e.title = T(title); };
  const fmtTok = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n); };
  const GLOBE_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  // Ikon robot untuk label pane agent (pane khusus tab Agent shell & Browser agent).
  // ===== Ikon file & folder (SVG berwarna per tipe, gaya Material/Seti) =====
  // Badge huruf untuk bahasa, glyph tergambar untuk gambar/arsip/dokumen/kunci, folder terbuka/tertutup.
  const FILE_BADGES = [
    [/^(js|mjs|cjs)$/, "JS", "#f0db4f", "#1a1a1a"], [/^(ts|mts|cts)$/, "TS", "#3178c6", "#fff"], [/^(jsx)$/, "JSX", "#61dafb", "#1a1a1a"], [/^(tsx)$/, "TSX", "#3178c6", "#fff"],
    [/^(py|pyw|pyi)$/, "PY", "#3b7bbf", "#ffd85a"], [/^(go)$/, "GO", "#00add8", "#fff"], [/^(rs)$/, "RS", "#dea584", "#1a1a1a"], [/^(php)$/, "PHP", "#8993be", "#fff"],
    [/^(rb|erb)$/, "RB", "#cc342d", "#fff"], [/^(java|jar)$/, "JV", "#e76f00", "#fff"], [/^(kt|kts)$/, "KT", "#7f52ff", "#fff"], [/^(swift)$/, "SW", "#f05138", "#fff"],
    [/^(c|h)$/, "C", "#5c6bc0", "#fff"], [/^(cpp|cc|cxx|hpp|hh|c\+\+)$/, "C++", "#00599c", "#fff"], [/^(cs)$/, "C#", "#68217a", "#fff"], [/^(dart)$/, "DA", "#0175c2", "#fff"],
    [/^(lua)$/, "LUA", "#000080", "#fff"], [/^(r)$/, "R", "#276dc3", "#fff"], [/^(scala|sc)$/, "SC", "#dc322f", "#fff"], [/^(ex|exs)$/, "EX", "#6e4a7e", "#fff"], [/^(hs)$/, "HS", "#5e5086", "#fff"],
    [/^(zig)$/, "ZIG", "#f7a41d", "#1a1a1a"], [/^(nim)$/, "NIM", "#ffe953", "#1a1a1a"], [/^(jl)$/, "JL", "#9558b2", "#fff"], [/^(pl|pm)$/, "PL", "#39457e", "#fff"],
    [/^(html?|xhtml)$/, "<>", "#e44d26", "#fff"], [/^(vue)$/, "VUE", "#41b883", "#1a1a1a"], [/^(svelte)$/, "SV", "#ff3e00", "#fff"], [/^(astro)$/, "AS", "#ff5d01", "#fff"],
    [/^(css)$/, "#", "#42a5f5", "#fff"], [/^(scss|sass)$/, "S", "#cd6799", "#fff"], [/^(less)$/, "L", "#1d365d", "#fff"], [/^(styl)$/, "ST", "#b3d107", "#1a1a1a"],
    [/^(json|jsonc|json5)$/, "{}", "#f9c74f", "#1a1a1a"], [/^(ya?ml)$/, "YML", "#cb171e", "#fff"], [/^(toml)$/, "TML", "#9c4221", "#fff"], [/^(xml|xsl|plist)$/, "XML", "#e37933", "#fff"],
    [/^(ini|cfg|conf|properties)$/, "CFG", "#6d8a96", "#fff"], [/^(env)$/, "ENV", "#e8c547", "#1a1a1a"],
    [/^(sh|bash|zsh|fish)$/, ">_", "#4caf50", "#fff"], [/^(ps1|psm1|psd1)$/, "PS", "#012456", "#7cc7ff"], [/^(bat|cmd)$/, "CMD", "#37474f", "#c3e88d"],
    [/^(sql|sqlite|db)$/, "DB", "#26a69a", "#fff"], [/^(graphql|gql)$/, "GQL", "#e10098", "#fff"], [/^(proto)$/, "PB", "#4a90d9", "#fff"],
    [/^(md|mdx|markdown)$/, "M\u2193", "#42a5f5", "#fff"], [/^(txt|log)$/, "TXT", "#78909c", "#fff"], [/^(csv|tsv)$/, "CSV", "#2e7d32", "#fff"], [/^(pdf)$/, "PDF", "#d32f2f", "#fff"],
    [/^(dockerfile)$/, "DK", "#2496ed", "#fff"], [/^(makefile|mk|make)$/, "MK", "#6d4c41", "#fff"], [/^(gradle)$/, "GR", "#02303a", "#fff"], [/^(tf|tfvars)$/, "TF", "#7b42bc", "#fff"],
    [/^(ipynb)$/, "NB", "#f37626", "#fff"], [/^(wasm|wat)$/, "WA", "#654ff0", "#fff"], [/^(vb|vbs)$/, "VB", "#945db7", "#fff"], [/^(asm|s)$/, "ASM", "#6e6e6e", "#fff"],
  ];
  const FOLDER_COLORS = { node_modules: "#8bc34a", ".git": "#f4511e", src: "#42a5f5", lib: "#42a5f5", test: "#66bb6a", tests: "#66bb6a", __tests__: "#66bb6a", spec: "#66bb6a", public: "#ab47bc", assets: "#ab47bc", static: "#ab47bc", images: "#ab47bc", img: "#ab47bc", dist: "#ff7043", build: "#ff7043", out: "#ff7043", docs: "#29b6f6", doc: "#29b6f6", scripts: "#ffca28", bin: "#ffca28", config: "#90a4ae", ".vrcloud-agent": "#4da3ff", ".cursor": "#4da3ff", ".github": "#cfd8dc", ".vscode": "#3f7fd6", data: "#26a69a", db: "#26a69a", components: "#42a5f5", pages: "#42a5f5", api: "#26c6da", styles: "#ec407a", css: "#ec407a", fonts: "#ffa726", vendor: "#8d6e63", venv: "#8d6e63", ".venv": "#8d6e63", __pycache__: "#6d8a96", downloads: "#66bb6a", tmp: "#78909c", temp: "#78909c", logs: "#78909c" };
  const svgEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function fileIconSvg(name, isDir, open) {
    const n = String(name || "").toLowerCase();
    const head = '<svg class="fic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">';
    if (isDir) {
      // Folder biru seragam (gaya VS Code); folder tersembunyi (.git, .cache) sedikit lebih redup.
      const c = n.startsWith(".") ? "#4a86c2" : "#4f9ee8";
      return head + (open
        ? '<path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2l1.3 1.3H13A1.5 1.5 0 0 1 14.5 5.8V6H4.6a1.5 1.5 0 0 0-1.4 1L1.5 11.6z" fill="' + c + '" opacity=".55"/><path d="M3.1 7.6A1 1 0 0 1 4 7h10.2a1 1 0 0 1 .95 1.3l-1.3 4.3a1 1 0 0 1-.95.7H2.3a.8.8 0 0 1-.76-1.05z" fill="' + c + '"/>'
        : '<path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2l1.3 1.3H13A1.5 1.5 0 0 1 14.5 5.8v6.7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" fill="' + c + '"/><path d="M1.5 6h13v1h-13z" fill="rgba(0,0,0,.18)"/>') + "</svg>";
    }
    const base = n.split("/").pop();
    const ext = base.indexOf(".") > 0 ? base.split(".").pop() : base; // Dockerfile/Makefile tanpa ekstensi
    // Glyph tergambar.
    if (/^(png|jpe?g|gif|webp|bmp|ico|svg|avif|tiff?)$/.test(ext)) {
      return head + '<rect x="1.5" y="2.5" width="13" height="11" rx="1.6" fill="#7e57c2"/><circle cx="5.3" cy="6" r="1.4" fill="#fff" opacity=".9"/><path d="M2.5 12.5l3.6-4 2.6 2.7 2-2.2 2.8 3.5z" fill="#fff" opacity=".9"/></svg>';
    }
    if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/.test(ext)) {
      return head + '<rect x="2" y="1.5" width="12" height="13" rx="1.6" fill="#a1887f"/><path d="M7 2h2v1.4H7zM7 4.4h2v1.4H7zM7 6.8h2v1.4H7z" fill="#3e2723" opacity=".8"/><rect x="6.2" y="9" width="3.6" height="3.4" rx=".6" fill="#3e2723" opacity=".8"/></svg>';
    }
    if (/^(lock)$/.test(ext) || /\.lock$/.test(base) || /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(base)) {
      return head + '<rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="#ffb300"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="#ffb300" stroke-width="1.6"/><circle cx="8" cy="10.6" r="1.1" fill="#5d4037"/></svg>';
    }
    if (/^(gitignore|gitattributes|gitmodules|gitkeep)$/.test(ext) || /^\.git/.test(base)) {
      return head + '<circle cx="8" cy="8" r="6.5" fill="#f4511e"/><path d="M5.5 4.5v7M5.5 4.5a2 2 0 1 0 0 .01M10.5 7.2a2 2 0 1 0 .01 0M5.5 11.5a2 2 0 1 0 .01 0M10.5 7.2c0 2.2-1.5 2.6-5 3" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>';
    }
    if (/^(mp3|wav|ogg|flac|m4a|aac)$/.test(ext)) {
      return head + '<path d="M10.5 2v8.2a2.3 2.3 0 1 1-1.5-2.16V4.4L5.5 5.3v6.2a2.3 2.3 0 1 1-1.5-2.16V3.6z" fill="#ec407a"/></svg>';
    }
    if (/^(mp4|mkv|mov|avi|webm)$/.test(ext)) {
      return head + '<rect x="1.5" y="3" width="13" height="10" rx="1.6" fill="#ef5350"/><path d="M6.5 5.5v5l4-2.5z" fill="#fff"/></svg>';
    }
    if (/^(ttf|otf|woff2?|eot)$/.test(ext)) {
      return head + '<rect x="1.5" y="1.5" width="13" height="13" rx="1.6" fill="#ffa726"/><path d="M4.5 5V3.8h7V5h-2.7v7.2H7.2V5z" fill="#fff"/></svg>';
    }
    if (/^(exe|msi|dll|so|dylib|bin|o|class|pyc)$/.test(ext)) {
      return head + '<rect x="2" y="2" width="12" height="12" rx="2" fill="#546e7a"/><path d="M5 8h6M8 5v6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
    }
    if (/^(license|licence|copying|readme|changelog|authors|contributing|security)$/.test(ext)) {
      return head + '<path d="M3.5 1.5h6l3 3v10h-9z" fill="#78909c"/><path d="M9.5 1.5v3h3" fill="#cfd8dc"/><path d="M5.2 7.5h5.6M5.2 9.7h5.6M5.2 11.9h3.6" stroke="#eceff1" stroke-width="1.1" stroke-linecap="round"/></svg>';
    }
    for (const [re, label, bg, fg] of FILE_BADGES) {
      if (re.test(ext)) {
        const fs = label.length >= 3 ? 5.6 : label.length === 2 ? 7 : 8.5;
        return head + '<rect x="1" y="1" width="14" height="14" rx="3" fill="' + bg + '"/><text x="8" y="8.4" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI,Arial,sans-serif" font-weight="700" font-size="' + fs + '" fill="' + fg + '">' + svgEsc(label) + "</text></svg>";
      }
    }
    // Dokumen umum.
    return head + '<path d="M3.5 1.5h6l3 3v10h-9z" fill="#90a4ae"/><path d="M9.5 1.5v3h3" fill="#cfd8dc"/><path d="M5.2 7.5h5.6M5.2 9.7h5.6M5.2 11.9h3.6" stroke="#eceff1" stroke-width="1.1" stroke-linecap="round"/></svg>';
  }
  const ROBOT_PANE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>';
  // Tema tetap (tidak ada pemilih tema): UI Classic Dark + syntax Ambiance.
  const UI_THEME = "classic-dark";
  const SYNTAX_THEME = "ambiance";
  const SYNTAX_THEME_MOD = "ace/theme/" + SYNTAX_THEME;
  // theme-ambiance.js is a separate Ace file (preloaded in index.html). Without
  // it, Ace stays on TextMate — a white sheet that looks like a crash on phones.
  function applySyntaxTheme(ed) {
    if (!ed) return;
    try { ace.require(SYNTAX_THEME_MOD); } catch (e) {}
    try { ed.setTheme(SYNTAX_THEME_MOD); } catch (e) {}
    const paint = () => {
      try {
        const cl = ed.container && ed.container.classList;
        if (cl && !cl.contains("ace-" + SYNTAX_THEME)) ed.setTheme(SYNTAX_THEME_MOD);
      } catch (e) {}
    };
    setTimeout(paint, 0);
    setTimeout(paint, 250);
  }

  // ===== Ace helper =====
  ace.require("ace/ext/language_tools");
  const modelist = ace.require("ace/ext/modelist");
  // Workers are extra script/blob loads. On phones they race the first file
  // open and are unused anyway — disable before any session is created.
  try {
    if (window.matchMedia && window.matchMedia("(max-width: 768px)").matches) {
      ace.config.set("useWorker", false);
    }
  } catch (e) {}

  // ===== State global =====
  const FILES = {};          // path -> { session, dirty, mode }
  const OPENING = {};        // path -> Promise, mencegah double-click membuka dua tab
  const TERMS = {};          // termId -> { id, term, ws, fit, el }
  let tabSeq = 0, termSeq = 0, nid = 0;
  let layout = null;         // pohon pane
  let activeLeaf = null;
  let DRAG = null;           // { leaf, tabId } saat drag tab
  let selNode = null;
  const selectedTreeItems = new Map();
  let selectionAnchorPath = null;
  let clipboard = null;
  const sync = new C9SyncClient();
  const TERMINAL_META = {};
  const REMOTE_CURSORS = {};
  let syncInitialized = false;
  let applyingRemote = false;
  let layoutSyncTimer = null;

  // agent=true: pane khusus agent AI (tab "Agent shell" & "Browser agent") — terpisah dari tab pengguna.
  const newLeaf = (tabs, agent) => ({ type: "leaf", _id: ++nid, tabs: tabs || [], active: tabs && tabs[0] ? tabs[0].id : null, agent: !!agent });
  const newSplit = (dir, children, sizes) => ({ type: "split", _id: ++nid, dir, children, sizes });
  const isAgentTab = (t) => !!t && (t.kind === "ashell" || t.kind === "abrowser");
  // layout masih null sampai snapshot realtime tiba: semua penjelajah harus tahan null.
  function walkLeaves(n, cb) { if (!n) return; if (n.type === "leaf") cb(n); else n.children.forEach((c) => walkLeaves(c, cb)); }
  function firstLeaf() { let f = null; walkLeaves(layout, (l) => { if (!f) f = l; }); return f; }
  function firstUserLeaf() { let f = null; walkLeaves(layout, (l) => { if (!f && !l.agent) f = l; }); return f || firstLeaf(); }
  function findParent(n, id, par) { if (!n) return null; if (n._id === id) return { parent: par, node: n }; if (n.type === "split") { for (const c of n.children) { const r = findParent(c, id, n); if (r) return r; } } return null; }
  // Objek leaf bisa diganti saat layout remote diterapkan di tengah await: ambil yang masih hidup.
  function liveLeaf(leaf) { const info = leaf && findParent(layout, leaf._id, null); return info ? info.node : firstLeaf(); }
  function forEachEditor(cb) { walkLeaves(layout, (l) => { if (l._ed) cb(l._ed); }); }
  function ensureActiveLeaf() { if (!activeLeaf || !findParent(layout, activeLeaf._id, null)) activeLeaf = firstLeaf(); }
  // Pane tujuan untuk file/terminal PENGGUNA: tidak pernah pane agent. Bila hanya pane agent
  // yang tersisa, buat pane pengguna baru di atasnya.
  function userLeaf() {
    ensureActiveLeaf();
    if (activeLeaf && !activeLeaf.agent) return activeLeaf;
    let l = null; walkLeaves(layout, (x) => { if (!l && !x.agent) l = x; });
    if (!l) { l = newLeaf(); wrapLeafInSplit(firstLeaf(), "top", l, [0.35, 0.65]); }
    return l;
  }
  const activeFileTab = () => { if (!activeLeaf) return null; const t = activeLeaf.tabs.find((x) => x.id === activeLeaf.active); return t && t.kind === "file" ? t : null; };
  const activeEditor = () => (activeFileTab() ? activeLeaf._ed : null);

  function serializeLayout(node) {
    if (!node) return null;
    if (node.type === "leaf") {
      return {
        type: "leaf",
        _id: node._id,
        active: node.active,
        agent: !!node.agent,
        tabs: node.tabs.map((t) => Object.assign({}, t)),
      };
    }
    return {
      type: "split",
      _id: node._id,
      dir: node.dir,
      sizes: (node.sizes || []).slice(),
      children: node.children.map(serializeLayout),
    };
  }

  function hydrateLayout(node) {
    if (!node || node.type === "leaf") {
      const leaf = newLeaf((node && node.tabs || []).map((t) => Object.assign({}, t)), !!(node && node.agent));
      if (node && node._id != null) leaf._id = node._id;
      leaf.active = node ? node.active : null;
      nid = Math.max(nid, Number(leaf._id) || 0);
      leaf.tabs.forEach((t) => { tabSeq = Math.max(tabSeq, Number(t.id) || 0); });
      return leaf;
    }
    const split = newSplit(node.dir === "row" ? "row" : "col", node.children.map(hydrateLayout), (node.sizes || []).slice());
    if (node._id != null) split._id = node._id;
    nid = Math.max(nid, Number(split._id) || 0);
    return split;
  }

  function queueLayoutSync() {
    if (!syncInitialized || applyingRemote || !layout) return;
    clearTimeout(layoutSyncTimer);
    layoutSyncTimer = setTimeout(() => {
      sync.send({
        type: "layout",
        layout: serializeLayout(layout),
        activeLeafId: activeLeaf ? activeLeaf._id : null,
        tabSeq,
        nodeSeq: nid,
      });
    }, 60);
  }

  // Editor.destroy() milik Ace ikut menghancurkan session yang sedang dipasang.
  // Session dokumen dibagi antar pane (FILES[p].session), jadi lepaskan dulu ke
  // session kosong — kalau tidak, file itu jadi kosong/error di semua pane lain.
  function destroyEditor(ed) {
    try { ed.setSession(ace.createEditSession("", "ace/mode/text")); } catch (e) {}
    try { ed.destroy(); } catch (e) {}
  }
  function disposeLayoutUI(node) {
    if (!node) return;
    walkLeaves(node, (leaf) => {
      if (leaf._ed) destroyEditor(leaf._ed);
      leaf._ed = null; leaf._root = null; leaf._bar = null; leaf._body = null;
      leaf._edEl = null; leaf._termHost = null; leaf._empty = null; leaf._drop = null;
    });
  }

  api.get("/api/info").then((i) => {
    INFO = i; window.VRCLOUD_INFO = i; $("#ws-name").textContent = i.workspace; document.title = i.name + " — " + (i.product || "VRCloud IDE");
    const ver = fmtVersion(i.version);
    const pv = $("#prefs-version"); if (pv) pv.textContent = ver ? (i.product || "VRCloud IDE") + " " + ver : "";
    const logo = document.querySelector("#menubar .logo"); if (logo && ver) logo.title = (i.product || "VRCloud IDE") + " " + ver;
    updateSyncStatus(); sbRefreshTerm(); // nama shell di status bar butuh INFO.spec
  });

  // Layar sempit (≤768px): drawer file + bilah navigasi bawah. Desktop ≥1024px tidak berubah.
  // Class "narrow" hanya penanda JS; layout utamanya di media query CSS.
  const MQ_NARROW = window.matchMedia ? window.matchMedia("(max-width: 768px)") : null;
  function isNarrowView() { return !!(MQ_NARROW && MQ_NARROW.matches); }
  function applyNarrowClass() { document.body.classList.toggle("narrow", isNarrowView()); }
  // Ace's hidden textarea is often positioned off-screen; focusing it on iOS/Chrome
  // mobile scrolls the page so the IDE looks blank. Keep the viewport pinned.
  function lockMobileViewport() {
    if (!isNarrowView()) return;
    try { window.scrollTo(0, 0); } catch (e) {}
    try { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) {}
  }
  applyNarrowClass();
  const Mobile = {
    isNarrow: isNarrowView,
    afterOpenFile: function () {},
    openFiles: function () {},
    showEditor: function () {},
    syncNav: function () {},
    closeMenus: function () {},
    onAiToggle: function () {},
  };
  window.VRCloudMobile = Mobile;

  // ===== Modal prompt =====
  function promptDlg(title, def) {
    return new Promise((resolve) => {
      const m = $("#prompt-modal"), inp = $("#prompt-input");
      $("#prompt-title").textContent = title; inp.value = def || "";
      m.classList.add("open"); inp.focus(); inp.select();
      const done = (v) => { m.classList.remove("open"); cleanup(); resolve(v); };
      const ok = () => done(inp.value.trim() || null);
      const cancel = () => done(null);
      const key = (e) => { if (e.key === "Enter") ok(); else if (e.key === "Escape") cancel(); };
      function cleanup() { $("#prompt-ok").onclick = null; $("#prompt-cancel").onclick = null; $("#prompt-close").onclick = null; inp.onkeydown = null; }
      $("#prompt-ok").onclick = ok; $("#prompt-cancel").onclick = cancel; $("#prompt-close").onclick = cancel; inp.onkeydown = key;
    });
  }

  // ============================================================
  //  LAYOUT / PANE RENDERING
  // ============================================================
  function renderLayout() {
    const wa = $("#workarea");
    const frag = buildNode(layout);
    // Node yang sebelumnya anak split dapat masih membawa flexGrow 0.32/0.5.
    // Saat menjadi root tunggal, paksa mengisi 100% workarea.
    frag.style.flex = "1 1 0";
    wa.innerHTML = "";
    wa.appendChild(frag);
    walkLeaves(layout, (l) => {
      if (l._ed) l._ed.resize();
      const tt = termViewOf(l.tabs.find((x) => x.id === l.active));
      if (tt) setTimeout(() => fitVisibleTerminal(tt), 0);
    });
    markActiveLeaf();
  }
  // Tampilan xterm untuk tab terminal (interaktif) atau tab "Agent shell" (view-only).
  function termViewOf(tab) {
    if (!tab) return null;
    if (tab.kind === "term") return TERMS[tab.termId] || null;
    if (tab.kind === "ashell") return ASHELLS[tab.shellId] || null;
    return null;
  }
  function buildNode(node) {
    if (node.type === "leaf") return getLeafEl(node);
    const el = document.createElement("div"); el.className = "split " + node.dir; el.dataset.id = node._id;
    if (!node.sizes || node.sizes.length !== node.children.length) node.sizes = node.children.map(() => 1 / node.children.length);
    node.children.forEach((ch, i) => {
      if (i > 0) el.appendChild(makeResizer(node, i));
      const c = buildNode(ch);
      c.style.flexGrow = node.sizes[i]; c.style.flexBasis = "0"; c.style.flexShrink = "1";
      el.appendChild(c);
    });
    return el;
  }
  function makeResizer(node, i) {
    const r = document.createElement("div"); r.className = "resizer";
    r.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const cont = r.parentElement, prev = r.previousElementSibling, next = r.nextElementSibling;
      const horiz = node.dir === "row";
      const start = horiz ? e.clientX : e.clientY;
      const px = horiz ? cont.clientWidth : cont.clientHeight;
      const p0 = node.sizes[i - 1], n0 = node.sizes[i], total = p0 + n0;
      const mv = (ev) => {
        const cur = horiz ? ev.clientX : ev.clientY;
        let d = (cur - start) / px;
        let np = Math.min(total - 0.08, Math.max(0.08, p0 + d));
        let nn = total - np;
        node.sizes[i - 1] = np; node.sizes[i] = nn;
        prev.style.flexGrow = np; next.style.flexGrow = nn;
        resizeSubtree(prev); resizeSubtree(next);
      };
      r.classList.add("dragging");
      const up = () => { r.classList.remove("dragging"); document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); queueLayoutSync(); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    return r;
  }
  function resizeSubtree(el) {
    // querySelectorAll hanya mencari turunan: bila tetangga pembagi adalah leaf itu sendiri, ikutkan.
    const leaves = el.classList.contains("leaf") ? [el] : el.querySelectorAll(".leaf");
    leaves.forEach((lf) => {
      const id = lf.__leaf; if (!id) return;
      if (id._ed) id._ed.resize();
      const tt = termViewOf(id.tabs && id.tabs.find((x) => x.id === id.active));
      if (tt) fitVisibleTerminal(tt);
    });
  }

  function getLeafEl(leaf) {
    if (leaf._root) { renderLeafTabs(leaf); return leaf._root; }
    const root = document.createElement("div"); root.className = "leaf" + (leaf.agent ? " agent" : ""); root.__leaf = leaf;
    const bar = document.createElement("div"); bar.className = "pane-tabs";
    const body = document.createElement("div"); body.className = "pane-body";
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", (leaf.agent ? "Agent pane " : "Pane ") + leaf._id + " drop area");
    const edEl = document.createElement("div"); edEl.className = "pane-editor";
    const host = document.createElement("div"); host.className = "pane-term-host";
    const empty = document.createElement("div"); empty.className = "pane-empty";
    if (leaf.agent) {
      empty.innerHTML = "<div>" + ROBOT_PANE_SVG + " Pane agent<br><span>Tab Agent shell dan Browser agent muncul di sini, terpisah dari tab Anda.</span></div>";
    } else {
      // Layar kosong: logo, aksi cepat, dan shortcut (seperti editor kosong VS Code).
      const acts = [
        ["\u{1F4C4}", "File baru", () => newEntry(false, curDir())],
        ["\u{1F50D}", "Buka file", () => openPalette("files"), "Ctrl+P"],
        ["\u276F", "Terminal baru", () => addTerminal(), "F6"],
        ["\u2728", "Tanya VRCloud AI", () => window.VRCloudAI && window.VRCloudAI.open(), "Alt+A"],
      ];
      const keys = [["Palet perintah", "Ctrl+Shift+P"], ["Cari di workspace", "Ctrl+Shift+F"], ["Source control", "Ctrl+Shift+G"], ["Ke baris", "Ctrl+G"], ["Simpan", "Ctrl+S"]];
      const wrap = document.createElement("div"); wrap.className = "pe-wrap";
      wrap.innerHTML = '<div class="pe-logo"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .4-9A6.5 6.5 0 0 0 5.4 8.6 4 4 0 0 0 6 16.5"/><path d="M8 19h9.5"/></svg></div>'
        + '<div class="pe-title">VRCloud IDE</div><div class="pe-sub">Buka file dari panel kiri, atau mulai dari sini.</div>'
        + '<div class="pe-acts"></div><div class="pe-keys"></div><div class="pe-hint">Geser tab file / terminal ke tepi panel ini untuk split.</div>';
      const actsEl = wrap.querySelector(".pe-acts");
      acts.forEach(([ic, label, fn, key]) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "pe-act";
        b.innerHTML = '<span class="ic"></span><span class="lb"></span>' + (key ? '<kbd></kbd>' : "");
        b.querySelector(".ic").textContent = ic; b.querySelector(".lb").textContent = label; if (key) b.querySelector("kbd").textContent = key;
        b.addEventListener("mousedown", (e) => { e.stopPropagation(); });
        b.addEventListener("click", (e) => { e.stopPropagation(); activeLeaf = leaf; markActiveLeaf(); try { fn(); } catch (x) {} });
        actsEl.appendChild(b);
      });
      const keysEl = wrap.querySelector(".pe-keys");
      keys.forEach(([label, key]) => {
        const r = document.createElement("div"); r.className = "pe-key";
        r.innerHTML = '<span class="lb"></span><kbd></kbd>'; r.querySelector(".lb").textContent = label; r.querySelector("kbd").textContent = key;
        keysEl.appendChild(r);
      });
      empty.appendChild(wrap);
    }
    const drop = document.createElement("div"); drop.className = "pane-drop";
    body.append(edEl, host, empty, drop);
    root.append(bar, body);
    leaf._root = root; leaf._bar = bar; leaf._body = body; leaf._edEl = edEl; leaf._termHost = host; leaf._empty = empty; leaf._drop = drop;
    root.addEventListener("mousedown", () => { activeLeaf = leaf; markActiveLeaf(); });
    wireLeafDrop(leaf);
    renderLeafTabs(leaf);
    return root;
  }
  function markActiveLeaf() {
    document.querySelectorAll(".leaf.active").forEach((x) => x.classList.remove("active"));
    if (activeLeaf && activeLeaf._root) activeLeaf._root.classList.add("active");
    sbRefreshFile(); sbRefreshTerm(); // status bar mengikuti pane aktif
  }
  function bindCursorSync(ed, leaf) {
    if (ed._c9CursorBound) return;
    ed._c9CursorBound = true;
    let cursorTimer = null;
    const publish = () => {
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        const tab = leaf.tabs.find((t) => t.id === leaf.active);
        if (!tab || tab.kind !== "file") return;
        const pos = ed.getCursorPosition();
        const range = ed.getSelectionRange();
        sync.send({
          type: "cursor",
          path: tab.path,
          row: pos.row,
          column: pos.column,
          selection: {
            start: { row: range.start.row, column: range.start.column },
            end: { row: range.end.row, column: range.end.column },
          },
        });
      }, 50);
    };
    // Event di level editor (bukan ed.selection): setSession() mengganti objek
    // selection, sehingga listener di sana mati setelah dokumen pertama diganti.
    // Ini juga menangkap gerakan programatik (find, Go to Line, dokumen remote).
    ed.on("changeSelection", () => { publish(); if (activeEditor() === ed) sbRefreshPos(ed); });
  }
  function ensureLeafEditor(leaf) {
    if (leaf._ed) return leaf._ed;
    // Phones never mount Ace. The workarea is hidden and file-open stays on
    // Files / Agent; rotating to a wide viewport creates the editor then.
    if (isNarrowView()) return null;
    // Ace dipasang di anak .ace-host; .pane-editor jadi pembungkus untuk editor + minimap.
    const aceEl = document.createElement("div"); aceEl.className = "ace-host"; leaf._edEl.appendChild(aceEl);
    const mobile = isNarrowView();
    leaf._edEl.classList.toggle("no-minimap", !ui.minimap || mobile);
    const ed = ace.edit(aceEl);
    ed.setOptions({
      fontSize: ui.fontSize + "px",
      enableBasicAutocompletion: !mobile,
      enableLiveAutocompletion: !mobile,
      enableSnippets: !mobile,
      showPrintMargin: !!ui.wrapMargin,
      useSoftTabs: true,
      tabSize: 2,
      useWorker: !mobile,
    });
    try { ed.session.setUseWorker(!mobile); } catch (e) {}
    ed.renderer.setShowGutter(!!ui.gutter);
    applySyntaxTheme(ed);
    if (mobile) {
      try {
        const ta = ed.textInput && ed.textInput.getElement && ed.textInput.getElement();
        if (ta) {
          ta.style.fontSize = "16px";
          ta.setAttribute("autocapitalize", "off");
          ta.setAttribute("autocomplete", "off");
          ta.setAttribute("autocorrect", "off");
          ta.setAttribute("spellcheck", "false");
        }
      } catch (e) {}
    }
    ed.on("focus", () => { activeLeaf = leaf; markActiveLeaf(); if (isNarrowView()) lockMobileViewport(); });
    // Pintasan IDE yang bertabrakan dengan bawaan Ace saat editor fokus:
    // Alt-L (Ace: fold) → terminal baru di folder aktif; Ctrl-G → dialog Go To Line kita.
    ed.commands.addCommand({ name: "vrcloudNewTerminalHere", bindKey: { win: "Alt-L", mac: "Alt-L" }, exec: () => addTerminal(null, curDir()) });
    ed.commands.addCommand({ name: "vrcloudGotoLine", bindKey: { win: "Ctrl-G", mac: "Cmd-G" }, exec: () => goToLineDlg() });
    leaf._ed = ed;
    bindCursorSync(ed, leaf);
    if (!mobile) setupMinimap(leaf);
    // Satu menu klik-kanan untuk editor: aksi edit standar + aksi AI (bila panel AI ada).
    leaf._edEl.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      activeLeaf = leaf; markActiveLeaf();
      showEditorCtx(e, ed, leaf);
    });
    return ed;
  }

  function showEditorCtx(e, ed, leaf) {
    ctx.innerHTML = "";
    const tab = leaf.tabs.find((x) => x.id === leaf.active);
    const hasSel = !!ed.getSelectedText();
    const canUndo = ed.session.getUndoManager().hasUndo();
    const canRedo = ed.session.getUndoManager().hasRedo();
    const add = (label, fn, opt) => ctxItem(ctx, label, fn, opt);
    const copySel = () => { const t = ed.getSelectedText(); return t ? copyText(t) : Promise.resolve(); };
    add("Undo", () => { ed.undo(); ed.focus(); }, { key: "Ctrl-Z", disabled: !canUndo });
    add("Redo", () => { ed.redo(); ed.focus(); }, { key: "Ctrl-Y", disabled: !canRedo });
    add("Cut", () => { copySel().then(() => { ed.session.replace(ed.getSelectionRange(), ""); ed.focus(); }); }, { sep: true, key: "Ctrl-X", disabled: !hasSel });
    add("Copy", () => { copySel().then(() => ed.focus()); }, { key: "Ctrl-C", disabled: !hasSel });
    add("Paste", () => {
      if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { if (t) ed.insert(t); ed.focus(); }, () => { setStatus("Akses clipboard ditolak — gunakan Ctrl+V"); ed.focus(); });
      else { setStatus("Clipboard tidak tersedia di koneksi ini — gunakan Ctrl+V"); ed.focus(); }
    }, { key: "Ctrl-V" });
    add("Select All", () => { ed.selectAll(); ed.focus(); }, { key: "Ctrl-A" });
    add("Find", () => ed.execCommand("find"), { sep: true, key: "Ctrl-F" });
    add("Replace", () => ed.execCommand("replace"), { key: "Ctrl-H" });
    add("Go to Line", () => goToLineDlg(), { key: "Ctrl-G" });
    add("Toggle Comment", () => { ed.toggleCommentLines(); ed.focus(); }, { key: "Ctrl-/" });
    add("Save", () => saveActive(), { sep: true, key: "Ctrl-S", disabled: !tab });
    const ai = window.VRCloudAI;
    if (ai && ai.ready && ai.ready()) {
      const selInfo = hasSel ? " baris " + (ed.getSelectionRange().start.row + 1) + "–" + (ed.getSelectionRange().end.row + 1) : "";
      add(hasSel ? "Tambahkan seleksi ke chat" : "Tambahkan file ke chat", () => ai.addSelection(), { sep: true, key: "Ctrl-L", title: hasSel ? (tab ? tab.name : "") + selInfo : "Lampirkan seluruh file yang dibuka" });
      (ai.actions() || []).forEach((a) => add(a.label, () => ai.quickAction(a.prompt), { disabled: !hasSel, title: hasSel ? "" : "Pilih kode dulu" }));
    }
    placeCtx(e);
  }

  function renderLeafTabs(leaf) {
    const bar = leaf._bar; if (!bar) return; bar.innerHTML = "";
    if (leaf.agent) {
      // Label pane agent: menandai tab bar ini milik agent AI, bukan tempat tab pengguna.
      const lbl = document.createElement("div"); lbl.className = "pane-label"; lbl.title = "Pane agent AI \u2014 tab Agent shell & Browser agent. Tab file/terminal Anda tidak ditaruh di sini.";
      lbl.innerHTML = ROBOT_PANE_SVG + "<span>Agent</span>"; bar.appendChild(lbl);
    }
    leaf.tabs.forEach((t) => {
      const el = document.createElement("div"); el.className = "pane-tab" + (t.id === leaf.active ? " active" : "");
      el.dataset.tabId = String(t.id);
      el.setAttribute("role", "tab");
      el.setAttribute("aria-label", t.name);
      el.setAttribute("aria-selected", t.id === leaf.active ? "true" : "false");
      el.draggable = true;
      const dirty = t.kind === "file" && FILES[t.path] && FILES[t.path].dirty;
      const ic = t.kind === "term" ? "&#9002;" : t.kind === "ashell" ? '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>'
        : t.kind === "abrowser" ? GLOBE_SVG : t.kind === "file" ? fileIconSvg(t.name, false) : "";
      el.innerHTML = '<span class="pt-ic">' + ic + '</span><span class="pt-name"></span>' + (dirty ? '<span class="pt-dot">&#9679;</span>' : "") + '<span class="pt-x">&times;</span>';
      if (t.kind === "ashell") el.title = "Agent shell \u2014 hanya tampilan (perintah dijalankan oleh agent AI)";
      if (t.kind === "abrowser") el.title = "Browser agent \u2014 tampilan live browser headless agent; tekan Ambil alih untuk mengendalikan sendiri";
      el.querySelector(".pt-name").textContent = t.name;
      el.addEventListener("click", (e) => {
        if (e.target.closest(".pt-x")) return;
        e.stopPropagation(); activeLeaf = leaf; setActiveTab(leaf, t.id);
      });
      const close = el.querySelector(".pt-x");
      close.draggable = false;
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "Close " + t.name);
      close.title = "Close " + t.name;
      close.tabIndex = 0;
      close.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
      close.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      close.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); closeTab(leaf, t.id); });
      close.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); e.stopPropagation(); closeTab(leaf, t.id);
        }
      });
      if (t.kind === "file" && t.path) el.dataset.path = t.path; // dipakai AI chat saat tab di-drop ke chat
      el.addEventListener("dragstart", (e) => { DRAG = { leaf, tabId: t.id }; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", "tab"); if (t.kind === "file" && t.path) e.dataTransfer.setData("text/x-vrcloud-path", t.path); } catch (x) {} });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); clearDropUI(); DRAG = null; });
      bar.appendChild(el);
    });
    if (leaf.agent) return; // pane agent: tidak ada tombol terminal baru (terminal pengguna punya pane sendiri)
    const add = document.createElement("div"); add.className = "pane-add"; add.title = "Terminal baru di panel ini"; add.textContent = "+";
    add.addEventListener("click", () => { activeLeaf = leaf; addTerminalTab(leaf); });
    bar.appendChild(add);
  }
  function renderAllTabbars() { walkLeaves(layout, (l) => renderLeafTabs(l)); }
  function updateTabSelection() {
    walkLeaves(layout, (l) => {
      if (!l._bar) return;
      l._bar.querySelectorAll(".pane-tab").forEach((el) => {
        const selected = Number(el.dataset.tabId) === l.active;
        el.classList.toggle("active", selected);
        el.setAttribute("aria-selected", selected ? "true" : "false");
      });
    });
  }

  // focus=false: tampilkan tab tanpa merebut fokus dan tanpa menjadikan pane aktif
  // (dipakai saat menerapkan layout dari browser lain / menutup tab di pane lain).
  function setActiveTab(leaf, id, focus) {
    focus = focus !== false;
    leaf.active = id; if (focus) activeLeaf = leaf;
    const tab = leaf.tabs.find((t) => t.id === id);
    const edEl = leaf._edEl, host = leaf._termHost, empty = leaf._empty;
    if (!edEl) return; // leaf sudah dibuang (layout diganti di tengah await)
    if (tab && tab.kind === "file" && !FILES[tab.path]) {
      // Dokumen gagal dimuat (file dihapus di server): buang tab-nya, jangan crash.
      leaf.tabs = leaf.tabs.filter((x) => x !== tab); leaf.active = leaf.tabs.length ? leaf.tabs[0].id : null;
      renderLeafTabs(leaf); return setActiveTab(leaf, leaf.active, focus);
    }
    if (!tab) { edEl.style.display = "none"; host.style.display = "none"; empty.style.display = "flex"; updateTabSelection(); renderOpenFiles(); markActiveLeaf(); queueLayoutSync(); return; }
    empty.style.display = "none";
    if (tab.kind === "file") {
      try {
        // Narrow viewports stay editor-free: no Ace sheet, no workarea takeover.
        if (isNarrowView()) {
          edEl.style.display = "none";
          host.style.display = "none";
          empty.style.display = "none";
          updateTabSelection(); renderOpenFiles(); markActiveLeaf(); queueLayoutSync();
          Mobile.syncNav();
          return;
        }
        ensureLeafEditor(leaf);
        bindCursorSync(leaf._ed, leaf);
        if (FILES[tab.path] && FILES[tab.path].session) {
          try { FILES[tab.path].session.setUseWorker(!isNarrowView()); } catch (e) {}
          leaf._ed.setSession(FILES[tab.path].session);
        }
        applySyntaxTheme(leaf._ed);
        edEl.style.display = "block"; host.style.display = "none";
        // On phones, auto-focusing Ace scrolls the hidden textarea into view
        // (often off-screen) and the browser zooms — the IDE looks blank/frozen.
        const shouldFocus = focus && !isNarrowView();
        setTimeout(() => {
          try { if (leaf._ed) leaf._ed.resize(); } catch (e) {}
          if (shouldFocus) { try { leaf._ed.focus(); } catch (e) {} }
          else if (isNarrowView()) lockMobileViewport();
        }, 0);
      } catch (err) {
        edEl.style.display = "none";
        empty.style.display = "flex";
        setStatus("Gagal membuka editor: " + ((err && err.message) || err));
        try { console.error(err); } catch (e) {}
      }
    } else if (tab.kind === "abrowser") {
      const v = ensureBrowserView();
      host.appendChild(v.el); host.style.display = "block"; edEl.style.display = "none";
    } else {
      const t = tab.kind === "ashell" ? ensureAgentShellView(tab.shellId) : TERMS[tab.termId];
      if (t) host.appendChild(t.el);
      host.style.display = "block"; edEl.style.display = "none";
      setTimeout(() => { if (t) { fitVisibleTerminal(t); if (focus && tab.kind === "term") t.term.focus(); } }, 0);
    }
    // Jangan buat ulang DOM tab saat klik. Ini penting agar tombol close yang
    // sedang menerima event tidak hilang sebelum event click selesai.
    // markActiveLeaf() sudah menyegarkan item status bar (file/terminal aktif).
    updateTabSelection(); renderOpenFiles(); markActiveLeaf(); queueLayoutSync();
    if (ABROWSER) setTimeout(updateBrowserLive, 0); // tab Browser agent terlihat/tersembunyi → mulai/berhenti screencast
    Mobile.syncNav();
  }

  // ---- drop zones (split) ----
  function clearDropUI() {
    document.querySelectorAll(".pane-drop").forEach((d) => (d.className = "pane-drop"));
    document.querySelectorAll(".pane-tabs.bar-drop").forEach((b) => b.classList.remove("bar-drop"));
    document.querySelectorAll(".pane-tab.dragging").forEach((b) => b.classList.remove("dragging"));
    document.querySelectorAll(".pane-tab.ins-left,.pane-tab.ins-right").forEach((b) => b.classList.remove("ins-left", "ins-right"));
  }
  function wireLeafDrop(leaf) {
    const body = leaf._body, drop = leaf._drop, bar = leaf._bar;
    const zoneFrom = (e) => {
      const r = body.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height, T = 0.28;
      if (x < T) return "left"; if (x > 1 - T) return "right"; if (y < T) return "top"; if (y > 1 - T) return "bottom"; return "center";
    };
    // Tab pengguna (file/terminal) tidak boleh dijatuhkan KE DALAM pane agent (tepi/split tetap boleh).
    const dragTab = () => DRAG && DRAG.leaf.tabs.find((t) => t.id === DRAG.tabId);
    const intoAllowed = () => !leaf.agent || isAgentTab(dragTab());
    body.addEventListener("dragover", (e) => { if (!DRAG) return; e.preventDefault(); const z = zoneFrom(e); if (z === "center" && !intoAllowed()) { e.dataTransfer.dropEffect = "none"; drop.className = "pane-drop"; return; } e.dataTransfer.dropEffect = "move"; drop.className = "pane-drop show zone-" + z; });
    body.addEventListener("dragleave", (e) => { if (!body.contains(e.relatedTarget)) drop.className = "pane-drop"; });
    body.addEventListener("drop", (e) => {
      if (!DRAG) return; e.preventDefault(); const z = zoneFrom(e); const ok = z !== "center" || intoAllowed(); const src = DRAG.leaf, id = DRAG.tabId; DRAG = null; clearDropUI();
      if (!ok) { setStatus("Pane agent hanya untuk tab agent \u2014 jatuhkan di pane lain"); return; }
      if (z === "center") moveTabToLeaf(src, id, leaf); else splitWith(leaf, z, src, id);
    });
    // Indeks sisip dari posisi kursor: sebelum tab pertama yang titik tengahnya di kanan kursor
    // (tab yang sedang diseret diabaikan), sehingga geser ke kiri maupun ke kanan sama-sama bekerja.
    const dropIndexFrom = (e) => {
      const tabs = [...bar.querySelectorAll(".pane-tab")].filter((t) => !t.classList.contains("dragging"));
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) return { index: i, el: tabs[i], side: "left" };
      }
      return { index: tabs.length, el: tabs[tabs.length - 1] || null, side: "right" };
    };
    const clearInsert = () => bar.querySelectorAll(".pane-tab.ins-left,.pane-tab.ins-right").forEach((t) => t.classList.remove("ins-left", "ins-right"));
    bar.addEventListener("dragover", (e) => {
      if (!DRAG) return; e.preventDefault();
      if (!intoAllowed()) { e.dataTransfer.dropEffect = "none"; return; }
      e.dataTransfer.dropEffect = "move"; bar.classList.add("bar-drop");
      clearInsert();
      const d = dropIndexFrom(e);
      if (d.el) d.el.classList.add(d.side === "left" ? "ins-left" : "ins-right");
    });
    bar.addEventListener("dragleave", (e) => { if (!bar.contains(e.relatedTarget)) { bar.classList.remove("bar-drop"); clearInsert(); } });
    bar.addEventListener("drop", (e) => {
      if (!DRAG) return; e.preventDefault(); bar.classList.remove("bar-drop"); clearInsert();
      const ok = intoAllowed(); const src = DRAG.leaf, id = DRAG.tabId;
      // Hitung indeks tujuan (relatif ke daftar tab TANPA tab yang diseret) sebelum DOM dibersihkan.
      const at = dropIndexFrom(e).index;
      DRAG = null; clearDropUI();
      if (!ok) { setStatus("Pane agent hanya untuk tab agent \u2014 jatuhkan di pane lain"); return; }
      moveTabToLeaf(src, id, leaf, at);
    });
  }

  // ---- operasi pohon ----
  function removeLeaf(leaf) {
    const info = findParent(layout, leaf._id, null); if (!info) return;
    if (leaf._ed) { destroyEditor(leaf._ed); leaf._ed = null; }
    const parent = info.parent;
    if (!parent) { layout = newLeaf(); activeLeaf = layout; return; }
    const idx = parent.children.indexOf(leaf);
    parent.children.splice(idx, 1); parent.sizes.splice(idx, 1);
    if (parent.children.length === 1) {
      const only = parent.children[0];
      const gp = findParent(layout, parent._id, null);
      if (!gp.parent) layout = only;
      else { const pIdx = gp.parent.children.indexOf(parent); gp.parent.children[pIdx] = only; }
    } else {
      const s = parent.sizes.reduce((a, b) => a + b, 0); parent.sizes = parent.sizes.map((x) => x / s);
    }
  }
  // target boleh leaf maupun split (mis. root layout). sizes: [ukuran target, ukuran leaf baru].
  function wrapLeafInSplit(target, side, newLf, sizes) {
    const info = findParent(layout, target._id, null);
    const dir = side === "left" || side === "right" ? "row" : "col";
    const first = side === "left" || side === "top";
    const children = first ? [newLf, target] : [target, newLf];
    const sz = sizes ? (first ? [sizes[1], sizes[0]] : sizes.slice()) : [0.5, 0.5];
    const split = newSplit(dir, children, sz);
    if (!info || !info.parent) layout = split;
    else { const idx = info.parent.children.indexOf(target); info.parent.children[idx] = split; }
  }
  // ---- Pane agent: satu pane khusus untuk tab Agent shell & Browser agent ----
  function findAgentLeaf() { let hit = null; walkLeaves(layout, (l) => { if (!hit && l.agent) hit = l; }); return hit; }
  function ensureAgentLeaf() {
    let leaf = findAgentLeaf(); if (leaf) return leaf;
    leaf = newLeaf([], true);
    // Ada pane terminal pengguna → pane agent di sebelah kanannya (area bawah);
    // kalau tidak ada → di bawah seluruh area kerja.
    let termLeaf = null; walkLeaves(layout, (l) => { if (!termLeaf && !l.agent && l.tabs.some((t) => t.kind === "term")) termLeaf = l; });
    if (termLeaf && termLeaf !== layout) wrapLeafInSplit(termLeaf, "right", leaf, [0.55, 0.45]);
    else wrapLeafInSplit(layout, "bottom", leaf, [0.66, 0.34]); // hanya satu pane (root): agent di bawahnya
    return leaf;
  }
  // Layout lama: tab agent yang masih menumpang di pane pengguna dipindahkan ke pane agent.
  function migrateAgentTabs() {
    const strays = [];
    walkLeaves(layout, (l) => { if (!l.agent) l.tabs.forEach((t) => { if (isAgentTab(t)) strays.push({ leaf: l, tab: t }); }); });
    if (!strays.length) return false;
    const dst = ensureAgentLeaf();
    strays.forEach(({ leaf, tab }) => {
      const i = leaf.tabs.indexOf(tab); if (i < 0) return;
      leaf.tabs.splice(i, 1); dst.tabs.push(tab);
      if (leaf.active === tab.id) leaf.active = leaf.tabs.length ? leaf.tabs[Math.max(0, i - 1)].id : null;
      if (!leaf.tabs.length) removeLeaf(leaf);
    });
    if (dst.active == null || !dst.tabs.some((t) => t.id === dst.active)) dst.active = dst.tabs[dst.tabs.length - 1].id;
    return true;
  }
  // index (opsional): posisi sisip di dst, dihitung terhadap daftar tab tanpa tab yang dipindah.
  // Tanpa index -> ke ujung kanan (perilaku lama, dipakai drop ke tengah pane).
  function moveTabToLeaf(src, tabId, dst, index) {
    const ti = src.tabs.findIndex((t) => t.id === tabId); if (ti < 0) return; const tab = src.tabs[ti];
    src.tabs.splice(ti, 1);
    const at = (index == null) ? dst.tabs.length : Math.max(0, Math.min(index, dst.tabs.length));
    if (src === dst) {
      if (at === ti) { src.tabs.splice(ti, 0, tab); return; } // dijatuhkan di tempat semula: tidak ada perubahan
      src.tabs.splice(at, 0, tab); renderLayout(); setActiveTab(dst, tab.id); return;
    }
    dst.tabs.splice(at, 0, tab);
    let srcActive = null;
    if (src.tabs.length === 0) removeLeaf(src);
    else { if (src.active === tabId) src.active = src.tabs[Math.max(0, ti - 1)].id; srcActive = src.active; }
    activeLeaf = dst; renderLayout(); setActiveTab(dst, tab.id);
    if (srcActive != null && findParent(layout, src._id, null)) setActiveTab(src, srcActive);
    activeLeaf = dst; markActiveLeaf();
  }
  function splitWith(dst, side, src, tabId) {
    if (src === dst && src.tabs.length <= 1) return;
    const ti = src.tabs.findIndex((t) => t.id === tabId); if (ti < 0) return; const tab = src.tabs[ti];
    src.tabs.splice(ti, 1);
    const nl = newLeaf([tab]); nl.active = tab.id;
    wrapLeafInSplit(dst, side, nl);
    let srcActive = null;
    if (src.tabs.length === 0) removeLeaf(src);
    else { if (src.active === tabId) src.active = src.tabs[Math.max(0, ti - 1)].id; srcActive = src.active; }
    activeLeaf = nl; renderLayout(); setActiveTab(nl, tab.id);
    if (srcActive != null && findParent(layout, src._id, null)) setActiveTab(src, srcActive);
    activeLeaf = nl; markActiveLeaf();
  }

  // ============================================================
  //  FILE TABS
  // ============================================================
  function findFileTab(p) {
    let found = null;
    walkLeaves(layout, (l) => {
      if (found) return;
      const t = l.tabs.find((x) => x.kind === "file" && x.path === p);
      if (t) found = { leaf: l, tab: t };
    });
    return found;
  }
  function focusFileTab(found, gotoLine) {
    if (!found) return false;
    setActiveTab(found.leaf, found.tab.id);
    if (gotoLine && found.leaf._ed) found.leaf._ed.gotoLine(gotoLine, 0, true);
    Mobile.afterOpenFile();
    return true;
  }
  function installSharedDoc(doc, name) {
    const p = doc.path;
    let file = FILES[p];
    if (!file) {
      const m = modelist.getModeForPath(name || basename(p));
      const session = ace.createEditSession(doc.content || "");
      session.setUseSoftTabs(true);
      try { session.setUseWorker(!isNarrowView()); } catch (e) {}
      session.setMode("ace/mode/" + (doc.mode || m.name || "text"));
      file = FILES[p] = {
        session,
        dirty: !!doc.dirty,
        mode: doc.mode || m.name,
        revision: Number(doc.revision) || 0,
        applying: false,
        inflight: false,
        sentContent: null,
        timer: null,
      };
      applyWrapToSession(session);
      session.on("change", () => {
        if (file.applying) return;
        file.dirty = true;
        renderAllTabbars(); renderOpenFiles();
        clearTimeout(file.timer);
        file.timer = setTimeout(() => flushDocChange(p), 40);
      });
    }
    return file;
  }
  function flushDocChange(p) {
    const file = FILES[p];
    if (!file || file.applying) return;
    if (file.inflight) { file.queued = true; return; }
    file.inflight = true;
    file.queued = false;
    file.sentContent = file.session.getValue();
    sync.send({
      type: "doc-change",
      path: p,
      content: file.sentContent,
      mode: file.mode,
      revision: file.revision || 0,
    });
  }
  async function requestSharedDoc(p, name) {
    try {
      const response = await sync.request("doc-open", { path: p });
      return installSharedDoc(response.doc, name);
    } catch (e) {
      const data = await api.get("/api/read?path=" + enc(p));
      if (data.binary) throw new Error("File biner tidak bisa ditampilkan di editor.");
      return installSharedDoc({ path: p, content: data.content, dirty: false, revision: 0 }, name);
    }
  }
  function failOpen(err) {
    const msg = "Gagal buka: " + ((err && err.message) || err);
    if (isNarrowView()) setStatus(msg);
    else alert(msg);
    try { console.error(err); } catch (e) {}
  }
  function showNewFileTab(leaf, tab, gotoLine) {
    leaf.tabs.push(tab);
    // Rebuilding #workarea (innerHTML = "") detaches Ace. On iOS WebKit that
    // can blank the editor into a white sheet. Reuse the live pane root.
    if (leaf._root) renderLeafTabs(leaf);
    else renderLayout();
    setActiveTab(leaf, tab.id);
    if (gotoLine && leaf._ed) leaf._ed.gotoLine(gotoLine, 0, true);
    Mobile.afterOpenFile();
  }
  async function openFile(p, name, gotoLine) {
    // Satu path hanya boleh punya satu tab di seluruh layout, bukan per-pane.
    try {
      const existing = findFileTab(p);
      if (focusFileTab(existing, gotoLine)) return;
      const requestedLeaf = userLeaf(); // file pengguna tidak pernah dibuka di pane agent
      if (!FILES[p]) {
        if (!OPENING[p]) OPENING[p] = requestSharedDoc(p, name);
        try { await OPENING[p]; }
        catch (e) { delete OPENING[p]; return failOpen(e); }
        delete OPENING[p];
      }
      // Permintaan kedua mungkin selesai ketika permintaan pertama sudah membuat tab.
      const openedWhileLoading = findFileTab(p);
      if (focusFileTab(openedWhileLoading, gotoLine)) return;
      const leaf = findParent(layout, requestedLeaf._id, null) ? requestedLeaf : firstUserLeaf();
      if (!leaf) return failOpen(new Error("Tidak ada panel editor"));
      showNewFileTab(leaf, { id: ++tabSeq, kind: "file", path: p, name }, gotoLine);
    } catch (e) {
      failOpen(e);
    }
  }
  function pathOpenElsewhere(p, exceptTabId) {
    let n = 0; walkLeaves(layout, (l) => l.tabs.forEach((t) => { if (t.kind === "file" && t.path === p && t.id !== exceptTabId) n++; })); return n;
  }
  function closeTab(leaf, tabId) {
    const ti = leaf.tabs.findIndex((t) => t.id === tabId); if (ti < 0) return; const tab = leaf.tabs[ti];
    if (tab.kind === "file") {
      const f = FILES[tab.path];
      const lastView = pathOpenElsewhere(tab.path, tabId) === 0;
      if (f && f.dirty && lastView && !confirm("Perubahan belum disimpan. Tutup saja?")) return;
      // Tab terakhir untuk file ini: lepaskan dokumennya agar Save All tidak
      // menulis isi yang sudah dibuang dan session/timer tidak bocor.
      if (f && lastView) { clearTimeout(f.timer); delete FILES[tab.path]; }
    } else if (tab.kind === "ashell") {
      disposeAgentShellView(tab.shellId); // hanya tampilan; tidak ada proses yang dihentikan
    } else if (tab.kind === "abrowser") {
      if (ABROWSER) { try { ABROWSER.el.remove(); } catch (e) {} setBrowserTakeover(false); setTimeout(updateBrowserLive, 0); }
    } else {
      disposeTerminalView(tab.termId);
      if (!applyingRemote) sync.send({ type: "terminal-close", id: tab.termId });
    }
    leaf.tabs.splice(ti, 1);
    if (leaf.active === tabId) leaf.active = leaf.tabs.length ? leaf.tabs[Math.max(0, ti - 1)].id : null;
    const info = findParent(layout, leaf._id, null);
    const removed = leaf.tabs.length === 0 && info && info.parent;
    if (removed) removeLeaf(leaf);
    renderLayout();
    // Pane tempat tab ditutup harus menampilkan tab penggantinya walau bukan pane aktif
    // (tombol × menghentikan mousedown, jadi activeLeaf tidak berpindah ke sana).
    const keep = activeLeaf && findParent(layout, activeLeaf._id, null) ? activeLeaf : firstLeaf();
    if (!removed) setActiveTab(leaf, leaf.active, leaf === keep);
    if (keep && keep !== leaf) setActiveTab(keep, keep.active);
    else if (!keep) { activeLeaf = firstLeaf(); markActiveLeaf(); }
  }
  // Simpan satu dokumen. doc-change yang masih tertunda (timer 40 ms) dibatalkan dan
  // inflight ditandai, supaya tidak ada perubahan lama yang menyusul dengan revisi
  // basi lalu memicu doc-conflict yang menimpa ketikan setelah Ctrl+S.
  async function saveDoc(p) {
    const file = FILES[p]; if (!file) return;
    clearTimeout(file.timer); file.timer = null;
    file.inflight = true;
    const content = file.session.getValue();
    try {
      const ack = await sync.request("doc-save", { path: p, content });
      file.revision = Number(ack.revision) || file.revision;
      file.sentContent = content;
      file.dirty = file.session.getValue() !== content; // diketik lagi selama menunggu?
    } finally {
      file.inflight = false;
      if (file.queued || file.session.getValue() !== content) flushDocChange(p);
    }
  }
  async function saveActive() {
    const t = activeFileTab(); if (!t) return;
    try { await saveDoc(t.path); renderAllTabbars(); renderOpenFiles(); setStatus("tersimpan: " + t.path); scheduleGit(); }
    catch (e) { alert("Gagal simpan: " + e.message); }
  }
  async function saveAll() {
    for (const p in FILES) {
      if (!FILES[p].dirty) continue;
      try { await saveDoc(p); } catch (e) { alert("Gagal simpan " + p + ": " + e.message); }
    }
    renderAllTabbars(); renderOpenFiles(); setStatus("semua tersimpan"); scheduleGit();
  }
  function closeAllTabs() { walkLeaves(layout, (l) => l.tabs.slice().forEach((t) => closeTab(l, t.id))); }

  // ===== OPEN FILES (sidebar) =====
  function focusPath(p) {
    const found = findFileTab(p);
    if (found) setActiveTab(found.leaf, found.tab.id); else openFile(p, basename(p));
  }
  function closePathEverywhere(p) { walkLeaves(layout, (l) => l.tabs.slice().forEach((t) => { if (t.kind === "file" && t.path === p) closeTab(l, t.id); })); }
  // Bagian "File terbuka" bisa dilipat (klik judulnya); pilihan disimpan.
  const OPENFILES_KEY = "c9clone.openFilesCollapsed";
  function setOpenFilesCollapsed(on) {
    $("#openfiles-wrap").classList.toggle("collapsed", !!on);
    localStorage.setItem(OPENFILES_KEY, on ? "1" : "0");
  }
  setOpenFilesCollapsed(localStorage.getItem(OPENFILES_KEY) === "1");
  $("#openfiles-head").addEventListener("click", () => setOpenFilesCollapsed(!$("#openfiles-wrap").classList.contains("collapsed")));
  function renderOpenFiles() {
    sbRefreshFile();
    const wrap = $("#openfiles-wrap"), ul = $("#openlist"); ul.innerHTML = "";
    const paths = []; walkLeaves(layout, (l) => l.tabs.forEach((t) => { if (t.kind === "file" && !paths.includes(t.path)) paths.push(t.path); }));
    wrap.classList.toggle("empty", paths.length === 0);
    const cnt = $("#openfiles-count"); if (cnt) cnt.textContent = paths.length ? String(paths.length) : "";
    const af = activeFileTab();
    paths.forEach((p) => {
      const li = document.createElement("li"); if (af && af.path === p) li.className = "active";
      li.innerHTML = '<span class="ox">&times;</span><span class="oic">' + fileIconSvg(basename(p), false) + '</span><span class="oname"></span><span class="opath"></span>';
      li.querySelector(".oname").textContent = basename(p) + (FILES[p] && FILES[p].dirty ? " •" : "");
      li.querySelector(".opath").textContent = "- /" + p;
      li.addEventListener("click", () => focusPath(p));
      li.querySelector(".ox").addEventListener("click", (e) => { e.stopPropagation(); closePathEverywhere(p); });
      ul.appendChild(li);
    });
  }

  // ============================================================
  //  TERMINAL TABS
  // ============================================================
  const FitAddon = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
  // Tema terminal mengikuti tema UI tetap (Classic Dark).
  const TERM_THEME = {
    background: "#141414", foreground: "#d4d4d4", cursor: "#6a9bd5", selection: "#2d4a63",
    black: "#1c1c1c", red: "#ff5f5f", green: "#5fff87", yellow: "#ffd75f",
    blue: "#5fafff", magenta: "#d787ff", cyan: "#00d7d7", white: "#d0d0d0",
    brightBlack: "#808080", brightRed: "#ff8787", brightGreen: "#87ffaf",
    brightYellow: "#ffff87", brightBlue: "#87afff", brightMagenta: "#ff87ff",
    brightCyan: "#5fffff", brightWhite: "#ffffff",
  };
  const terminalFontSize = () => Math.max(9, Number(ui.fontSize || 13) - 2);
  const currentTermTheme = () => TERM_THEME;
  const wsURL = (id) => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/terminal?id=" + enc(id);
  const sendResize = (ws, term) => { if (ws.readyState === 1) ws.send("\x00" + JSON.stringify({ resize: { cols: term.cols, rows: term.rows } })); };
  function terminalVisible(view) {
    if (!view || !view.el || !view.el.isConnected) return false;
    const host = view.el.closest(".pane-term-host");
    return !!host && getComputedStyle(host).display !== "none" &&
      view.el.offsetWidth >= 120 && view.el.offsetHeight >= 60;
  }
  function fitVisibleTerminal(view) {
    if (!terminalVisible(view)) return false;
    try {
      view.fit.fit();
      if (view.ws) sendResize(view.ws, view.term);
      return true;
    } catch (e) { return false; }
  }
  async function copyTerminal(term) {
    const text = term.getSelection();
    if (!text) return setStatus("Pilih teks terminal terlebih dahulu");
    setStatus((await copyText(text)) ? "Teks terminal disalin" : "Copy terminal gagal: clipboard tidak tersedia");
  }
  async function pasteTerminal(view) {
    let text = "";
    try {
      if (navigator.clipboard && window.isSecureContext) text = await navigator.clipboard.readText();
    } catch (e) {}
    if (!text) text = await promptDlg("Paste ke terminal (Ctrl+V di kotak ini):", "");
    if (text && view.ws && view.ws.readyState === 1) {
      view.ws.send(text);
      view.term.focus();
    }
  }
  function ensureTerminalView(meta, runCmd) {
    if (!meta || !meta.id) return null;
    const id = meta.id;
    TERMINAL_META[id] = Object.assign({}, TERMINAL_META[id] || {}, meta);
    if (TERMS[id]) return TERMS[id];
    const el = document.createElement("div"); el.className = "xterm-holder";
    const term = new Terminal({ fontSize: terminalFontSize(), lineHeight: 1, cursorBlink: true, fontFamily: "Menlo, Consolas, monospace", theme: currentTermTheme() });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(el);
    const view = TERMS[id] = { id, term, ws: null, fit, el, closed: false, ran: false };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = String(event.key || "").toLowerCase();
      const copy = (event.ctrlKey && event.shiftKey && key === "c") ||
        (event.ctrlKey && key === "insert") ||
        (event.ctrlKey && !event.shiftKey && key === "c" && term.hasSelection());
      const paste = (event.ctrlKey && key === "v") || (event.shiftKey && key === "insert");
      if (copy) { copyTerminal(term); return false; }
      // Paste: di konteks aman biarkan event paste bawaan xterm bekerja (satu kali);
      // tanpa clipboard API (HTTP) pakai dialog tempel milik kita.
      if (paste) { if (navigator.clipboard && window.isSecureContext) return true; event.preventDefault(); pasteTerminal(view); return false; }
      return true;
    });
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault(); event.stopPropagation();
      ctxSimple(event, [
        ["Copy", () => copyTerminal(term)],
        ["Paste", () => pasteTerminal(view)],
        ["Select All", () => { term.selectAll(); term.focus(); }],
        ["Clear", () => { term.clear(); term.focus(); }],
      ]);
    });
    function connect() {
      if (view.closed) return;
      const ws = view.ws = new WebSocket(wsURL(id));
      // Perintah awal (tombol Run) dikirim setelah shell menampilkan prompt pertama, dengan
      // Enter "\r" (bukan "\n": PowerShell/ConPTY membaca LF sebagai Shift+Enter → prompt `>>`).
      // Perintah Run dikirim setelah prompt shell terlihat, lalu diverifikasi tergema di buffer;
      // PowerShell (PSReadLine) membuang input pada detik-detik pertama, jadi bila tidak
      // tergema dalam 2 s perintah dikirim ulang (senyap, maks 8 kali).
      let runTimer = null, lastMsgAt = 0, sends = 0, firing = false; const runStart = Date.now();
      // Teks buffer terakhir digabung tanpa pemisah baris: baris panjang yang terlipat (wrap)
      // tetap terdeteksi.
      const tailText = (n) => {
        let out = "";
        try { const buf = term.buffer.active; for (let i = Math.max(0, buf.length - n); i < buf.length; i++) { const l = buf.getLine(i); out += (l ? l.translateToString(true) : "") + (l && l.isWrapped ? "" : "\n"); } } catch (e) {}
        return out;
      };
      const promptReady = () => { const ls = tailText(6).split("\n").filter((s) => s.trim()); const s = ls.length ? ls[ls.length - 1].trimEnd() : ""; return /[>$#%❯»]\s*$/.test(s) || /^PS\s/.test(s); };
      // Gema perintah: potongan awal perintah (tanpa spasi, agar tahan wrap/penataan ulang PSReadLine).
      const cmdKey = String(runCmd).slice(0, 24).replace(/\s+/g, "");
      const cmdEchoed = () => tailText(40).replace(/\s+/g, "").indexOf(cmdKey) !== -1;
      const finish = () => { view.ran = true; clearTimeout(runTimer); };
      const fireRun = () => {
        if (view.ran || firing || ws.readyState !== 1) return;
        firing = true; clearTimeout(runTimer);
        const attempt = () => {
          if (ws.readyState !== 1) { firing = false; return; }
          if (cmdEchoed()) return finish();
          if (sends >= 8) return finish(); // shell tanpa echo (mis. stty -echo): anggap terkirim
          sends++; ws.send(runCmd + "\r");
          runTimer = setTimeout(() => { if (cmdEchoed()) finish(); else attempt(); }, 2000);
        };
        attempt();
      };
      const waitPrompt = () => {
        if (!runCmd || view.ran || firing || ws.readyState !== 1) return;
        const quiet = lastMsgAt ? Date.now() - lastMsgAt : 0;
        if (promptReady() || (lastMsgAt && quiet > 1500) || Date.now() - runStart > 6000) return fireRun();
        runTimer = setTimeout(waitPrompt, 300);
      };
      ws.onopen = () => {
        setTimeout(() => fitVisibleTerminal(view), 80);
        if (runCmd && !view.ran) runTimer = setTimeout(waitPrompt, 400);
      };
      ws.onmessage = (ev) => {
        lastMsgAt = Date.now();
        term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data), () => {
          if (runCmd && !view.ran && firing && cmdEchoed()) finish();
        });
      };
      ws.onclose = () => {
        if (view.closed) return;
        term.write("\r\n\x1b[33m[terminal reconnecting…]\x1b[0m\r\n");
        setTimeout(connect, 1000);
      };
    }
    term.onData((d) => {
      const open = view.ws && view.ws.readyState === 1;
      if (!open) return; // termasuk balasan protokol saat reconnect: jangan ditimbun
      view.ws.send(d);
    });
    term.onResize(() => { if (view.ws && terminalVisible(view)) sendResize(view.ws, term); });
    connect();
    return view;
  }
  function disposeTerminalView(id) {
    const t = TERMS[id]; if (!t) return;
    t.closed = true;
    try { if (t.ws) t.ws.close(); } catch (e) {}
    try { t.term.dispose(); } catch (e) {}
    try { t.el.remove(); } catch (e) {}
    delete TERMS[id];
  }
  // Minta terminal baru ke server dan siapkan tab-nya (dipakai tab biasa & split).
  async function createTermTab(runCmd, cwd) {
    let response;
    try { response = await sync.request("terminal-create", { cwd: cwd || "" }); }
    catch (e) { alert("Gagal membuat terminal: " + e.message); return null; }
    const meta = response.terminal;
    ensureTerminalView(meta, runCmd);
    return { id: ++tabSeq, kind: "term", termId: meta.id, name: meta.title };
  }
  async function addTerminalTab(leaf, runCmd, cwd) {
    leaf = leaf && !leaf.agent ? leaf : userLeaf(); // terminal pengguna tidak masuk pane agent
    const tab = await createTermTab(runCmd, cwd); if (!tab) return;
    leaf = liveLeaf(leaf); // layout bisa diganti browser lain selama menunggu
    if (leaf.agent) leaf = userLeaf();
    leaf.tabs.push(tab); renderLayout(); setActiveTab(leaf, tab.id);
  }
  function addTerminal(runCmd, cwd) { addTerminalTab(userLeaf(), runCmd, cwd); }
  // split aktif dgn terminal baru (dipakai menu)
  async function splitActiveWithTerminal(side) {
    ensureActiveLeaf(); let dst = activeLeaf;
    const tab = await createTermTab(); if (!tab) return;
    dst = liveLeaf(dst);
    const nl = newLeaf([tab]); nl.active = tab.id;
    wrapLeafInSplit(dst, side, nl); activeLeaf = nl; renderLayout(); setActiveTab(nl, tab.id);
  }
  async function splitActiveToFour() {
    // Jadikan pane aktif sebuah grid 2x2. Pane lama tetap di kiri atas,
    // tiga pane lainnya mendapat terminal baru dan tetap bisa diisi file.
    ensureActiveLeaf();
    const topLeft = activeLeaf;
    await splitActiveWithTerminal("right");
    const topRight = activeLeaf;
    activeLeaf = topLeft;
    await splitActiveWithTerminal("bottom");
    activeLeaf = topRight;
    await splitActiveWithTerminal("bottom");
  }

  // ============================================================
  //  MINIMAP: gambaran dokumen di sisi kanan editor (kanvas, 2 px per baris,
  //  1 px per karakter, warna mengikuti jenis token Ace). Klik/seret = gulir.
  // ============================================================
  const MM_LINE = 2;
  const MM_COLORS = [
    [/comment/, "#6b6b6b"], [/string/, "#8f9d6a"], [/keyword|storage/, "#cda869"], [/constant/, "#cf7d34"],
    [/support\.function|entity\.name\.function|function/, "#9b859d"], [/entity|tag|meta\.tag/, "#ac885b"],
    [/variable|identifier/, "#a7adba"], [/punctuation|paren|operator/, "#6f6f6f"],
  ];
  function mmColor(type) { for (const [re, c] of MM_COLORS) if (re.test(type)) return c; return "#9a9a9a"; }
  function setupMinimap(leaf) {
    if (isNarrowView()) { leaf._edEl.classList.add("no-minimap"); return; }
    const cv = document.createElement("canvas"); cv.className = "minimap"; cv.title = "Minimap \u2014 klik/seret untuk menggulir";
    leaf._edEl.appendChild(cv); leaf._mm = cv;
    const ed = leaf._ed;
    let raf = 0;
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; renderMinimap(leaf); }); };
    leaf._mmSchedule = schedule;
    const bindSession = (s) => {
      if (!s || leaf._mmSession === s) return;
      if (leaf._mmSession) { leaf._mmSession.off("change", schedule); leaf._mmSession.off("changeScrollTop", schedule); }
      leaf._mmSession = s; s.on("change", schedule); s.on("changeScrollTop", schedule); schedule();
    };
    ed.on("changeSession", (e) => bindSession(e.session));
    bindSession(ed.session);
    ed.renderer.on("themeLoaded", schedule);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(cv);
    const scrollTo = (clientY) => {
      const r = cv.getBoundingClientRect(); const st = leaf._mmState || { offset: 0 };
      const row = Math.floor((clientY - r.top + st.offset) / MM_LINE);
      ed.scrollToLine(Math.max(0, Math.min(ed.session.getLength() - 1, row)), true, false);
    };
    cv.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation(); scrollTo(e.clientY);
      const mv = (ev) => scrollTo(ev.clientY);
      const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); ed.renderer.scrollBy(0, e.deltaY); }, { passive: false });
    cv.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
  }
  function renderMinimap(leaf) {
    const cv = leaf._mm, ed = leaf._ed;
    if (!cv || !ed || !ui.minimap || isNarrowView() || leaf._edEl.style.display === "none") return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const session = ed.session, lines = session.getLength();
    const first = ed.renderer.getFirstVisibleRow(), last = ed.renderer.getLastVisibleRow();
    const visible = Math.max(1, last - first + 1);
    const total = lines * MM_LINE;
    let offset = 0;
    if (total > h) { const maxFirst = Math.max(1, lines - visible); offset = Math.round(Math.min(1, first / maxFirst) * (total - h)); }
    leaf._mmState = { offset };
    const startRow = Math.max(0, Math.floor(offset / MM_LINE)), endRow = Math.min(lines, Math.ceil((offset + h) / MM_LINE) + 1);
    ctx.globalAlpha = 0.85;
    for (let row = startRow; row < endRow; row++) {
      const y = row * MM_LINE - offset;
      let tokens; try { tokens = session.getTokens(row) || []; } catch (e) { continue; }
      let x = 0;
      for (const t of tokens) {
        const v = String(t.value || ""); const len = v.length;
        if (v.trim()) { ctx.fillStyle = mmColor(String(t.type || "")); ctx.fillRect(x, y, Math.min(len, w - x), MM_LINE - 0.6); }
        x += len; if (x >= w) break;
      }
    }
    // Jendela yang sedang terlihat di editor.
    ctx.globalAlpha = 1; ctx.fillStyle = "rgba(255,255,255,.10)";
    ctx.fillRect(0, first * MM_LINE - offset, w, visible * MM_LINE);
  }
  function refreshMinimaps() { walkLeaves(layout, (l) => { if (l._edEl) l._edEl.classList.toggle("no-minimap", !ui.minimap || isNarrowView()); if (l._mm && !isNarrowView()) { if (l._mmSchedule) l._mmSchedule(); } }); }

  // ============================================================
  //  AGENT SHELL (view-only): cermin perintah shell yang dijalankan agent AI.
  //  Satu tab per percakapan, isi datang dari server lewat event "agent-shell";
  //  tidak ada stdin dan tidak ada proses lokal — hanya tampilan, sama di semua browser.
  // ============================================================
  const ASHELLS = {};
  function ensureAgentShellView(sessionId) {
    if (!sessionId) return null;
    if (ASHELLS[sessionId]) return ASHELLS[sessionId];
    const el = document.createElement("div"); el.className = "xterm-holder ashell";
    const term = new Terminal({ fontSize: terminalFontSize(), lineHeight: 1, cursorBlink: false, disableStdin: true, convertEol: false,
      fontFamily: "Menlo, Consolas, monospace", theme: Object.assign({}, currentTermTheme(), { cursor: currentTermTheme().background }), scrollback: 5000 });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(el);
    const view = ASHELLS[sessionId] = { id: sessionId, term, fit, el, ws: null, closed: false, loaded: false, pending: [] };
    term.write("\x1b[90m[Agent shell \u2014 hanya tampilan. Output perintah agent AI muncul di sini.]\x1b[0m\r\n\r\n");
    // Putar ulang output yang sudah ada di server (browser yang membuka belakangan).
    const ready = () => { view.loaded = true; view.pending.splice(0).forEach((d) => term.write(d)); setTimeout(() => fitVisibleTerminal(view), 120); };
    sync.request("agent-shell-buffer", { sessionId }).then((r) => { if (r && r.data) term.write(r.data); ready(); }).catch(ready);
    // Saat dibuat di dalam pane yang baru dirender, ukuran belum final: fit ulang sebentar lagi.
    setTimeout(() => fitVisibleTerminal(view), 150);
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault(); event.stopPropagation();
      ctxSimple(event, [["Copy", () => copyTerminal(term)], ["Select All", () => { term.selectAll(); }], ["Clear", () => term.clear()]]);
    });
    return view;
  }
  function disposeAgentShellView(sessionId) {
    const v = ASHELLS[sessionId]; if (!v) return;
    try { v.term.dispose(); } catch (e) {}
    try { v.el.remove(); } catch (e) {}
    delete ASHELLS[sessionId];
  }
  function findAgentShellTab(sessionId) {
    let hit = null;
    walkLeaves(layout, (leaf) => { if (hit) return; const t = leaf.tabs.find((x) => x.kind === "ashell" && x.shellId === sessionId); if (t) hit = { leaf, tab: t }; });
    return hit;
  }
  // Pastikan tab "Agent shell" ada di pane agent (dibuat bila belum ada) dan terlihat
  // di pane-nya tanpa merebut fokus editor.
  function ensureAgentShellTab(sessionId, reveal) {
    if (!layout) return null;
    let hit = findAgentShellTab(sessionId);
    if (!hit) {
      const host = ensureAgentLeaf();
      const tab = { id: ++tabSeq, kind: "ashell", shellId: sessionId, name: "Agent shell" };
      host.tabs.push(tab); renderLayout();
      hit = { leaf: host, tab };
      reveal = true;
    }
    if (reveal) setActiveTab(hit.leaf, hit.tab.id, false);
    return hit;
  }
  // ---- Browser agent: tampilan live (screencast) headless Chrome yang dipakai agent ----
  // Selama tab ini terlihat, server mengirim frame JPEG (~8 fps). Pengguna bisa
  // "Ambil alih": mouse/keyboard diteruskan ke browser (login, CAPTCHA, OTP).
  // Tab agent (ikon robot) dan tab pengguna (+) terpisah: agent hanya bekerja di tabnya,
  // pengguna bebas berpindah/menjelajah di tabnya tanpa mengganggu agent.
  let ABROWSER = null;
  function browserSend(event) { if (sync.socket && sync.socket.readyState === WebSocket.OPEN) sync.send({ type: "browser-input", event }); }
  const ROBOT_MINI_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>';
  function ensureBrowserView() {
    if (ABROWSER) return ABROWSER;
    const root = document.createElement("div"); root.className = "abrowser-view";
    root.innerHTML =
      '<div class="ab-tabs"></div>' +
      '<div class="ab">' +
        '<button class="nav back" title="Kembali">\u2039</button><button class="nav fwd" title="Maju">\u203a</button><button class="nav reload" title="Muat ulang">\u21bb</button>' +
        GLOBE_SVG + '<input class="url" spellcheck="false" placeholder="about:blank"><span class="ttl"></span><span class="act"></span>' +
        '<span class="owner"></span><span class="live-dot" title="Live"></span><button class="take">Ambil alih</button>' +
      '</div>' +
      '<div class="ab-banner"><span class="msg"></span><button class="done">Selesai, kembalikan ke agent</button></div>' +
      '<div class="shot"><img alt="Browser agent" draggable="false" tabindex="0"><div class="empty">Belum ada aktivitas browser dari agent.<br><span>Minta agent membuka situs, mis. "buka https://example.com dan rangkum". Tekan + untuk membuka tab Anda sendiri \u2014 terpisah dari tab agent.</span></div><div class="hint">Mode ambil alih: klik & ketik langsung di gambar</div></div>';
    const q = (s) => root.querySelector(s);
    const view = ABROWSER = { el: root, img: q("img"), url: q(".url"), ttl: q(".ttl"), act: q(".act"), owner: q(".owner"), empty: q(".empty"), tabs: q(".ab-tabs"), banner: q(".ab-banner"), take: q(".take"), dot: q(".live-dot"), step: null, frameW: 0, frameH: 0, frameAt: 0, takeover: false, watching: false, tabList: [], viewTab: null, viewOwner: "", agentTab: null };
    // Navigasi manual di tab agent hanya saat ambil alih; di luar itu tombol nav dibiarkan tidak berdampak.
    const canDrive = () => view.viewOwner !== "agent" || view.takeover;
    q(".back").onclick = () => { if (canDrive()) browserSend({ kind: "nav", action: "back" }); };
    q(".fwd").onclick = () => { if (canDrive()) browserSend({ kind: "nav", action: "forward" }); };
    q(".reload").onclick = () => { if (canDrive()) browserSend({ kind: "nav", action: "reload" }); };
    view.url.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // Mengetik URL saat melihat tab agent (tanpa ambil alih) → buka di tab Anda sendiri, jangan bajak tab agent.
        if (canDrive()) browserSend({ kind: "nav", url: view.url.value }); else browserSend({ kind: "tab", action: "new", url: view.url.value });
        view.img.focus();
      }
      e.stopPropagation();
    });
    view.url.addEventListener("focus", () => view.url.select());
    view.take.onclick = () => setBrowserTakeover(!view.takeover);
    q(".done").onclick = () => { sync.send({ type: "browser-handoff-done" }); setBrowserHandoff(null); setBrowserTakeover(false); };
    // Klik gambar (tanpa ambil alih) membuka screenshot langkah terakhir.
    view.img.addEventListener("click", () => { if (!view.takeover && view.step && view.step.shot && !view.frameAt) window.open(view.step.shot, "_blank"); });
    wireBrowserTakeover(view);
    api.get("/api/ai/browser").then((b) => {
      const withShot = (b.steps || []).filter((s) => s.shot).pop(); if (withShot && !view.step) applyBrowserStep(withShot);
      renderBrowserTabs(b.tabs || [], b.active, b.view); if (b.handoff) setBrowserHandoff(b.handoff);
    }).catch(() => {});
    return view;
  }
  // Koordinat klik di <img> → CSS px viewport browser (frame = ukuran viewport).
  function browserPoint(view, e) {
    const r = view.img.getBoundingClientRect(); if (!r.width || !r.height) return null;
    const w = view.frameW || view.img.naturalWidth || r.width, h = view.frameH || view.img.naturalHeight || r.height;
    return { x: Math.round((e.clientX - r.left) / r.width * w * 10) / 10, y: Math.round((e.clientY - r.top) / r.height * h * 10) / 10 };
  }
  function keyMods(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }
  function wireBrowserTakeover(view) {
    const img = view.img; let lastMove = 0;
    const btn = (e) => e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    img.addEventListener("mousedown", (e) => { if (!view.takeover) return; e.preventDefault(); img.focus(); const p = browserPoint(view, e); if (p) browserSend({ kind: "mouse", type: "down", x: p.x, y: p.y, button: btn(e), clickCount: e.detail || 1, modifiers: keyMods(e) }); });
    img.addEventListener("mouseup", (e) => { if (!view.takeover) return; e.preventDefault(); const p = browserPoint(view, e); if (p) browserSend({ kind: "mouse", type: "up", x: p.x, y: p.y, button: btn(e), clickCount: e.detail || 1, modifiers: keyMods(e) }); });
    img.addEventListener("mousemove", (e) => { if (!view.takeover) return; const now = Date.now(); if (now - lastMove < 40) return; lastMove = now; const p = browserPoint(view, e); if (p) browserSend({ kind: "mouse", type: "move", x: p.x, y: p.y, buttons: e.buttons, modifiers: keyMods(e) }); });
    img.addEventListener("wheel", (e) => { if (!view.takeover) return; e.preventDefault(); const p = browserPoint(view, e); if (p) browserSend({ kind: "mouse", type: "wheel", x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: keyMods(e) }); }, { passive: false });
    img.addEventListener("contextmenu", (e) => { if (view.takeover) e.preventDefault(); });
    const key = (type) => (e) => {
      if (!view.takeover) return;
      if (e.key === "F5" || e.key === "F11" || e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J"))) return;
      e.preventDefault(); e.stopPropagation();
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      browserSend({ kind: "key", type, key: e.key, code: e.code, keyCode: e.keyCode || e.which || 0, text: printable && type === "down" ? e.key : "", modifiers: keyMods(e) });
    };
    img.addEventListener("keydown", key("down")); img.addEventListener("keyup", key("up"));
    img.addEventListener("paste", (e) => { if (!view.takeover) return; const t = e.clipboardData && e.clipboardData.getData("text"); if (t) { e.preventDefault(); browserSend({ kind: "text", text: t }); } });
  }
  // silent=true: diaktifkan otomatis (tab milik pengguna) — jangan rebut fokus.
  function setBrowserTakeover(on, silent) {
    const v = ensureBrowserView(); v.takeover = !!on;
    if (!silent) v.autoTake = false;
    v.el.classList.toggle("takeover", v.takeover);
    v.take.textContent = v.takeover ? "Kembalikan ke agent" : "Ambil alih";
    v.take.classList.toggle("on", v.takeover);
    if (v.takeover && !silent) v.img.focus();
  }
  function setBrowserHandoff(h) {
    const v = ensureBrowserView();
    v.banner.style.display = h ? "flex" : "none";
    if (h) { v.banner.querySelector(".msg").textContent = h.message || "Agent membutuhkan bantuan Anda di browser."; ensureBrowserTab(true); setBrowserTakeover(true); }
  }
  // tabs: [{id,url,title,owner,active(=tab kerja agent),view(=yang tampil)}]
  function renderBrowserTabs(tabs, agentActive, view) {
    const v = ensureBrowserView(); v.tabList = tabs || []; v.agentTab = agentActive == null ? null : agentActive;
    const viewId = view == null ? (tabs || []).filter((t) => t.view).map((t) => t.id)[0] : view;
    v.tabs.innerHTML = "";
    (tabs || []).forEach((t) => {
      const el = document.createElement("div"); el.className = "ab-tab " + (t.owner === "agent" ? "agent" : "user") + (t.id === viewId ? " active" : "") + (t.id === agentActive ? " agent-cur" : "");
      el.title = (t.owner === "agent" ? (t.id === agentActive ? "Tab agent (sedang dipakai AI) \u2014 klik untuk melihat / membantu" : "Tab agent \u2014 dikendalikan AI") : "Tab Anda \u2014 tidak disentuh agent") + (t.url ? "\n" + t.url : "");
      el.innerHTML = (t.owner === "agent" ? '<span class="bot">' + ROBOT_MINI_SVG + '</span>' : '') + '<span class="n"></span><span class="x" title="Tutup tab">\u00d7</span>';
      el.querySelector(".n").textContent = t.title || (t.url || "about:blank").replace(/^https?:\/\//, "").slice(0, 40) || "Tab " + t.id;
      el.onclick = (e) => { if (e.target.closest(".x")) browserSend({ kind: "tab", action: "close", id: t.id }); else if (t.id !== viewId) browserSend({ kind: "tab", action: "switch", id: t.id }); };
      v.tabs.appendChild(el);
    });
    const add = document.createElement("div"); add.className = "ab-tab add"; add.textContent = "+"; add.title = "Tab baru milik Anda (terpisah dari tab agent)";
    add.onclick = () => browserSend({ kind: "tab", action: "new" });
    v.tabs.appendChild(add);
    v.tabs.style.display = "flex";
    // Tab tampilan berganti → bilah alamat/judul ikut; frame live menyusul dari server.
    const cur = (tabs || []).find((t) => t.id === viewId);
    const changed = v.viewTab !== (cur ? cur.id : null);
    v.viewTab = cur ? cur.id : null; v.viewOwner = cur ? cur.owner : "";
    if (cur) {
      if (document.activeElement !== v.url) { v.url.value = cur.url && cur.url !== "about:blank" ? cur.url : ""; v.url.title = cur.url || ""; }
      v.ttl.textContent = cur.title || "";
      if (changed) v.act.textContent = "";
    }
    updateBrowserOwnerChip();
  }
  function updateBrowserOwnerChip() {
    const v = ABROWSER; if (!v) return;
    const agent = v.viewOwner === "agent";
    v.owner.textContent = v.viewOwner ? (agent ? "Tab agent" : "Tab Anda") : "";
    v.owner.className = "owner" + (agent ? " agent" : v.viewOwner ? " user" : "");
    v.owner.title = agent ? "Tab ini dikendalikan agent. Tekan Ambil alih untuk membantu (login/CAPTCHA), atau + untuk tab Anda sendiri." : v.viewOwner ? "Tab Anda \u2014 agent tidak melihat atau menyentuhnya." : "";
    v.el.classList.toggle("view-agent", agent);
    // Di tab sendiri pengguna selalu memegang kendali (tanpa tombol); kembali ke tab agent → kendali dilepas lagi.
    v.take.style.display = v.viewOwner === "user" ? "none" : "";
    if (v.viewOwner === "user") { if (!v.takeover) { setBrowserTakeover(true, true); v.autoTake = true; } }
    else if (v.autoTake) { v.autoTake = false; setBrowserTakeover(false); }
  }
  function applyBrowserStep(step) {
    const v = ensureBrowserView(); if (!step) return;
    v.step = step;
    // Langkah agent hanya mengubah tampilan bila tab agent itulah yang sedang dilihat.
    if (v.viewTab != null && step.tab != null && step.tab !== v.viewTab) return;
    if (document.activeElement !== v.url) { v.url.value = step.url || ""; v.url.title = step.url || ""; }
    v.ttl.textContent = step.title || "";
    v.act.textContent = step.action ? T(step.action) : "";
    // Tanpa frame live yang segar (tab tidak terlihat / screencast mati), pakai screenshot langkah.
    if (step.shot && Date.now() - v.frameAt > 2000) { v.img.src = step.shot; v.frameW = 0; v.frameH = 0; v.img.style.display = ""; v.empty.style.display = "none"; }
  }
  function applyBrowserFrame(m) {
    const v = ensureBrowserView();
    v.img.src = "data:image/jpeg;base64," + m.data; v.frameW = m.w || 0; v.frameH = m.h || 0; v.frameAt = Date.now();
    v.img.style.display = ""; v.empty.style.display = "none";
    if (m.tab != null && m.tab !== v.viewTab) { v.viewTab = m.tab; v.viewOwner = m.owner || v.viewOwner; updateBrowserOwnerChip(); }
    if (document.activeElement !== v.url && m.url) { v.url.value = m.url === "about:blank" ? "" : m.url; v.url.title = m.url; }
    if (m.title != null) v.ttl.textContent = m.title;
    v.dot.classList.add("on"); clearTimeout(v.dotTimer); v.dotTimer = setTimeout(() => v.dot.classList.remove("on"), 1500);
  }
  // Mulai/berhenti menonton sesuai apakah tab Browser agent sedang terlihat.
  function updateBrowserLive() {
    if (!ABROWSER) return;
    const v = ABROWSER;
    const visible = document.body.contains(v.el) && v.el.offsetParent !== null && !document.hidden;
    const want = visible;
    if (want === v.watching) return;
    v.watching = want;
    if (sync.socket && sync.socket.readyState === WebSocket.OPEN) sync.send({ type: "browser-live", on: want });
  }
  document.addEventListener("visibilitychange", () => setTimeout(updateBrowserLive, 0));
  sync.on("status", (m) => { if (m.value === "online" && ABROWSER) { ABROWSER.watching = false; setTimeout(updateBrowserLive, 50); } });
  sync.on("browser-frame", (m) => { if (m && m.data) applyBrowserFrame(m); });
  sync.on("browser-tabs", (m) => { if (m) renderBrowserTabs(m.tabs || [], m.active, m.view); });
  sync.on("browser-handoff", (m) => { if (!m) return; setBrowserHandoff(m.handoff || null); if (m.handoff) notifyAgent("Agent minta bantuan di browser", m.handoff.message || ""); });
  function findBrowserTab() {
    let hit = null; walkLeaves(layout, (leaf) => { if (hit) return; const t = leaf.tabs.find((x) => x.kind === "abrowser"); if (t) hit = { leaf, tab: t }; }); return hit;
  }
  function ensureBrowserTab(reveal) {
    if (!layout) return null;
    let hit = findBrowserTab();
    if (!hit) {
      const host = ensureAgentLeaf(); // pane agent, bukan pane tab pengguna
      const tab = { id: ++tabSeq, kind: "abrowser", name: "Browser agent" };
      host.tabs.push(tab); renderLayout(); hit = { leaf: host, tab }; reveal = true;
    }
    if (reveal) setActiveTab(hit.leaf, hit.tab.id, false);
    return hit;
  }
  sync.on("browser-step", (m) => {
    if (!m || !m.step) return;
    if (m.step.shot) { ensureBrowserTab(false); applyBrowserStep(m.step); }
    else if (ABROWSER) applyBrowserStep(Object.assign({}, ABROWSER.step || {}, { action: m.step.action, url: m.step.url || (ABROWSER.step && ABROWSER.step.url), title: m.step.title, tab: m.step.tab }));
  });

  sync.on("agent-shell", (m) => {
    if (!m || !m.sessionId || !m.data) return;
    // Jangan buka tab Agent shell otomatis. Output tetap ditampung (view offscreen) supaya
    // langsung lengkap saat pengguna mengklik indikator "background terminal" di chat.
    const v = ensureAgentShellView(m.sessionId);
    if (!v) return;
    if (v.loaded) v.term.write(m.data); else v.pending.push(m.data);
    // Bila tab-nya memang sudah dibuka pengguna, beri kilat kecil sebagai tanda ada output baru.
    const hit = findAgentShellTab(m.sessionId);
    if (hit) { const bar = hit.leaf._bar; const el = bar && bar.querySelector('.pane-tab[data-tab-id="' + hit.tab.id + '"]'); if (el) { el.classList.add("ashell-live"); setTimeout(() => el.classList.remove("ashell-live"), 1200); } }
    // Server dev terdeteksi di output live (mis. "Serving HTTP on :: port 8137") → tawarkan preview.
    const url = detectLocalUrlFromText(m.data);
    if (url) showPreviewPill(url);
  });

  // ---- Preview server dev di tab Browser agent ----
  function detectLocalUrlFromText(text) {
    text = String(text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // buang kode ANSI
    const own = Number(location.port || (location.protocol === "https:" ? 443 : 80));
    let m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))?(\/[^\s"'<>)\]]*)?/i.exec(text);
    if (m) { const port = m[1] ? Number(m[1]) : 80; if (port === own) return ""; return "http://127.0.0.1" + (m[1] ? ":" + m[1] : "") + (m[2] || ""); }
    m = /(?:listening on|serving http on|running (?:at|on)|started (?:at|on)|available (?:at|on))\b[^\n]*?\bport\s+(\d{2,5})\b/i.exec(text) || /\b(?:localhost|127\.0\.0\.1):(\d{2,5})\b/i.exec(text);
    if (m) { const port = Number(m[1]); if (port >= 80 && port <= 65535 && port !== own) return "http://127.0.0.1:" + port; }
    return "";
  }
  let previewPill = null, previewPillTimer = null;
  function showPreviewPill(url) {
    if (previewPill && previewPill.dataset.url === url && previewPill.isConnected) { clearTimeout(previewPillTimer); previewPillTimer = setTimeout(hidePreviewPill, 25000); return; }
    hidePreviewPill();
    const pill = document.createElement("div"); pill.className = "preview-pill"; pill.dataset.url = url;
    pill.innerHTML = '<span class="dot"></span><span class="lbl"></span><span class="go">Buka preview \u25b8</span><span class="x" title="Tutup">\u00d7</span>';
    pill.querySelector(".lbl").textContent = "Server terdeteksi: " + url.replace(/^https?:\/\//, "");
    pill.querySelector(".go").addEventListener("click", () => { openPreview(url); hidePreviewPill(); });
    pill.querySelector(".x").addEventListener("click", hidePreviewPill);
    document.body.appendChild(pill); previewPill = pill;
    previewPillTimer = setTimeout(hidePreviewPill, 25000);
  }
  function hidePreviewPill() { clearTimeout(previewPillTimer); if (previewPill) { try { previewPill.remove(); } catch (e) {} previewPill = null; } }
  // Buka URL di tab Browser agent sebagai tab PENGGUNA (tab agent tidak diganggu).
  function openPreview(url) {
    if (!url) return false;
    ensureBrowserTab(true);
    const v = ensureBrowserView();
    const send = () => browserSend({ kind: "tab", action: "new", url });
    if (sync.socket && sync.socket.readyState === WebSocket.OPEN) send(); else setTimeout(send, 400);
    if (v) { activeLeaf = findBrowserTab() ? findBrowserTab().leaf : activeLeaf; markActiveLeaf(); }
    return true;
  }

  // ============================================================
  //  FILE TREE
  // ============================================================
  const treeRoot = $("#filetree");
  let showHidden = localStorage.getItem("c9clone.hidden") !== "0";
  // Nomor generasi per <ul>: dua pemuatan yang tumpang tindih (refresh dari
  // fs-change beruntun) tidak boleh menempelkan daftar dua kali.
  const LOAD_GEN = new WeakMap();
  async function loadDir(ulEl, pathStr) {
    const gen = (LOAD_GEN.get(ulEl) || 0) + 1; LOAD_GEN.set(ulEl, gen);
    let items; try { items = await api.get("/api/list?path=" + enc(pathStr)); } catch (e) { return; }
    if (LOAD_GEN.get(ulEl) !== gen) return; // sudah disusul permintaan yang lebih baru
    if (!showHidden) items = items.filter((it) => !it.name.startsWith("."));
    ulEl.innerHTML = "";
    for (const it of items) ulEl.appendChild(makeNode(it));
  }
  function makeNode(it) {
    const li = document.createElement("li");
    li.dataset.path = it.path; li.dataset.dir = it.dir ? "1" : ""; li.dataset.name = it.name;
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<span class="twist">' + (it.dir ? "&#9656;" : "") + '</span><span class="ic ' + (it.dir ? "ic-dir" : "ic-file") + '">' + fileIconSvg(it.name, it.dir, false) + '</span><span class="nm"></span>';
    row.querySelector(".nm").textContent = it.name;
    li.appendChild(row);
    if (!it.dir) { // file di tree bisa di-drag ke AI chat sebagai lampiran
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "copy";
        try { e.dataTransfer.setData("text/x-vrcloud-path", it.path); e.dataTransfer.setData("text/plain", it.path); } catch (x) {}
      });
    }
    if (selectedTreeItems.has(it.path)) li.classList.add("sel");
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const modified = e.ctrlKey || e.metaKey || e.shiftKey;
      select(li, e);
      if (modified) return;
      if (it.dir) toggleDir(li); else openFile(it.path, it.name);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!selectedTreeItems.has(it.path)) select(li);
      else selNode = nodeInfo(li);
      showCtx(e, it);
    });
    return li;
  }
  function nodeInfo(li) {
    return li ? { path: li.dataset.path, name: li.dataset.name, dir: li.dataset.dir === "1" } : null;
  }
  function paintTreeSelection() {
    document.querySelectorAll("#filetree li[data-path]").forEach((li) => {
      li.classList.toggle("sel", selectedTreeItems.has(li.dataset.path));
    });
  }
  function selectedItems() {
    return Array.from(selectedTreeItems.values());
  }
  function topLevelItems(items) {
    return items.filter((item) => !items.some((parent) =>
      parent !== item && parent.dir && item.path.startsWith(parent.path + "/")
    ));
  }
  function select(li, event) {
    if (!li) {
      selectedTreeItems.clear(); selectionAnchorPath = null; selNode = null;
      paintTreeSelection(); return;
    }
    const item = nodeInfo(li);
    const toggle = !!(event && (event.ctrlKey || event.metaKey));
    const range = !!(event && event.shiftKey);
    if (range && selectionAnchorPath) {
      const nodes = Array.from(document.querySelectorAll("#filetree li[data-path]"));
      const start = nodes.findIndex((node) => node.dataset.path === selectionAnchorPath);
      const end = nodes.indexOf(li);
      if (!toggle) selectedTreeItems.clear();
      if (start >= 0 && end >= 0) {
        const low = Math.min(start, end), high = Math.max(start, end);
        for (let i = low; i <= high; i++) {
          const info = nodeInfo(nodes[i]);
          selectedTreeItems.set(info.path, info);
        }
      } else selectedTreeItems.set(item.path, item);
    } else if (toggle) {
      if (selectedTreeItems.has(item.path)) selectedTreeItems.delete(item.path);
      else selectedTreeItems.set(item.path, item);
      selectionAnchorPath = item.path;
    } else {
      selectedTreeItems.clear();
      selectedTreeItems.set(item.path, item);
      selectionAnchorPath = item.path;
    }
    selNode = selectedTreeItems.has(item.path) ? item :
      (selectedItems().length ? selectedItems()[selectedItems().length - 1] : null);
    paintTreeSelection();
    setStatus(selectedTreeItems.size > 1 ? selectedTreeItems.size + " items selected" : (selNode ? selNode.path : "siap"));
  }
  async function toggleDir(li) {
    let sub = li.querySelector(":scope > ul"); const tw = li.querySelector(".twist");
    const ic = li.querySelector(":scope > .row > .ic");
    if (sub) { sub.remove(); tw.innerHTML = "&#9656;"; if (ic) ic.innerHTML = fileIconSvg(li.dataset.name, true, false); return; }
    sub = document.createElement("ul"); li.appendChild(sub); tw.innerHTML = "&#9662;";
    if (ic) ic.innerHTML = fileIconSvg(li.dataset.name, true, true);
    await loadDir(sub, li.dataset.path);
  }
  const treeLi = (p) => document.querySelector('#filetree li[data-path="' + CSS.escape(p) + '"]');
  // Muat ulang root tanpa menutup folder yang sedang terbuka.
  async function refreshTree() {
    const open = [...document.querySelectorAll('#filetree li[data-dir="1"]')].filter((li) => li.querySelector(":scope > ul")).map((li) => li.dataset.path)
      .sort((a, b) => a.split("/").length - b.split("/").length);
    await loadDir(treeRoot, "");
    for (const p of open) { const li = treeLi(p); if (li && !li.querySelector(":scope > ul")) await toggleDir(li); }
  }
  // Segarkan satu folder; bila belum terbuka di tree, naik ke induknya.
  async function refreshNode(pathStr) {
    if (!pathStr) return refreshTree();
    const li = treeLi(pathStr);
    if (li && li.dataset.dir === "1" && li.querySelector(":scope > ul")) return loadDir(li.querySelector(":scope > ul"), pathStr);
    return refreshNode(parentOf(pathStr));
  }
  // Setelah operasi file: beri tahu browser lain + segarkan folder terkait.
  function fsChanged(dir) { sync.send({ type: "fs-change", path: dir || "" }); return refreshNode(dir || ""); }
  async function expandPath(p) { const li = document.querySelector('#filetree li[data-path="' + CSS.escape(p) + '"]'); if (li && !li.querySelector(":scope > ul")) toggleDir(li); }
  const curDir = () => (selNode ? (selNode.dir ? selNode.path : parentOf(selNode.path)) : "");
  $("#tree-refresh").addEventListener("click", refreshTree);
  refreshTree();
  // Shortcut gaya VS Code saat fokus di sidebar: F2 ganti nama, Delete hapus, Enter buka.
  $("#sidebar").addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (!selNode) return;
    if (e.key === "F2") { e.preventDefault(); doRename(selNode); }
    else if (e.key === "Delete") { e.preventDefault(); doDeleteMany(selectedItems()); }
    else if (e.key === "Enter") { e.preventDefault(); if (selNode.dir) { const li = treeLi(selNode.path); if (li) toggleDir(li); } else openFile(selNode.path, selNode.name); }
  });
  treeRoot.tabIndex = 0;
  treeRoot.addEventListener("mousedown", () => { if (document.activeElement !== treeRoot && !(inlineEditing && inlineEditing.inp)) treeRoot.focus({ preventScroll: true }); });

  // gear menu file tree
  const gearMenu = $("#tree-gear-menu");
  function hideGear() { gearMenu.style.display = "none"; }
  $("#tree-gear").addEventListener("click", (e) => {
    e.stopPropagation(); gearMenu.innerHTML = "";
    const add = (label, fn, checked) => ctxItem(gearMenu, label, fn, { checked: checked === undefined ? null : !!checked });
    add("Refresh File Tree", refreshTree);
    add("Collapse All Folders", () => document.querySelectorAll("#filetree li > ul").forEach((u) => { const li = u.parentElement, tw = li.querySelector(".twist"), ic = li.querySelector(":scope > .row > .ic"); if (tw) tw.innerHTML = "&#9656;"; if (ic) ic.innerHTML = fileIconSvg(li.dataset.name, true, false); u.remove(); }));
    add("Show Open Files", () => toggleUI("openFiles"), ui.openFiles);
    add("Show Hidden Files", () => { showHidden = !showHidden; localStorage.setItem("c9clone.hidden", showHidden ? "1" : "0"); refreshTree(); }, showHidden);
    const r = e.target.getBoundingClientRect();
    gearMenu.style.display = "block"; gearMenu.style.left = Math.min(r.left, innerWidth - gearMenu.offsetWidth - 6) + "px"; gearMenu.style.top = r.bottom + 4 + "px";
  });

  // ============================================================
  //  CLIPBOARD & FILE OPS
  // ============================================================
  // ---- Edit nama langsung di tree (gaya VS Code): Enter simpan, Esc batal, klik di luar simpan ----
  let inlineEditing = null;
  function validName(n) {
    n = String(n || "").trim();
    if (!n || n === "." || n === "..") return "Nama tidak boleh kosong";
    if (/[\\/:*?"<>|]/.test(n)) return "Nama tidak boleh berisi \\ / : * ? \" < > |";
    if (n.length > 255) return "Nama terlalu panjang";
    return "";
  }
  function inlineNameInput(row, initial, opts) {
    // row: .row yang .nm-nya diganti input; opts.onCommit(name) -> Promise, opts.onCancel()
    const nm = row.querySelector(".nm");
    const inp = document.createElement("input"); inp.type = "text"; inp.className = "tree-edit"; inp.value = initial || ""; inp.spellcheck = false; inp.autocomplete = "off";
    const err = document.createElement("div"); err.className = "tree-edit-err"; err.hidden = true;
    nm.replaceWith(inp); row.appendChild(err); row.classList.add("editing");
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      if (inlineEditing && inlineEditing.inp === inp) inlineEditing = null;
      const val = inp.value.trim();
      if (!commit || val === (initial || "") && !opts.isNew) { opts.onCancel && opts.onCancel(); return; }
      const bad = validName(val);
      if (bad) { done = false; err.textContent = bad; err.hidden = false; inp.classList.add("bad"); inp.focus(); return; }
      Promise.resolve(opts.onCommit(val)).catch((e) => { done = false; err.textContent = "Gagal: " + e.message; err.hidden = false; inp.classList.add("bad"); inp.focus(); });
    };
    inp.addEventListener("input", () => { const bad = validName(inp.value); inp.classList.toggle("bad", !!bad); err.hidden = !bad; if (bad) err.textContent = bad; });
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => { setTimeout(() => { if (!done && document.activeElement !== inp) finish(true); }, 0); });
    ["click", "mousedown", "dblclick", "contextmenu"].forEach((ev) => inp.addEventListener(ev, (e) => e.stopPropagation()));
    inlineEditing = { inp, cancel: () => finish(false) };
    inp.focus();
    // Pilih nama tanpa ekstensi (seperti VS Code) saat rename file.
    const dot = opts.isDir ? -1 : inp.value.lastIndexOf(".");
    if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    return inp;
  }
  async function newEntry(dir, inDir) {
    if (inlineEditing) inlineEditing.cancel();
    inDir = inDir || "";
    let ul = treeRoot;
    if (inDir) {
      const li = treeLi(inDir); if (!li) return;
      if (!li.querySelector(":scope > ul")) await toggleDir(li);
      ul = li.querySelector(":scope > ul"); if (!ul) return;
    }
    const li = document.createElement("li"); li.className = "tree-new";
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<span class="twist">' + (dir ? "&#9656;" : "") + '</span><span class="ic">' + fileIconSvg("", dir, false) + '</span><span class="nm"></span>';
    li.appendChild(row);
    // Folder di atas file, seperti urutan daftar.
    const firstFile = [...ul.children].find((c) => c.dataset && c.dataset.dir !== "1");
    if (dir || !firstFile) ul.insertBefore(li, dir ? ul.firstChild : null); else ul.insertBefore(li, firstFile);
    li.scrollIntoView({ block: "nearest" });
    const ic = row.querySelector(".ic");
    const inp = inlineNameInput(row, "", {
      isNew: true, isDir: dir,
      onCancel: () => li.remove(),
      onCommit: async (name) => {
        const full = (inDir ? inDir + "/" : "") + name;
        await api.post("/api/create", { path: full, dir });
        li.remove();
        await fsChanged(inDir);
        const created = treeLi(full); if (created) { select(created); created.scrollIntoView({ block: "nearest" }); }
        if (!dir) openFile(full, basename(full));
      },
    });
    if (!dir) inp.addEventListener("input", () => { ic.innerHTML = fileIconSvg(inp.value || "", false, false); });
  }
  async function doPaste(destDir) {
    if (!clipboard) return;
    try {
      const paths = clipboard.paths || [clipboard.path];
      for (const source of paths) {
        if (clipboard.mode === "cut") {
          await api.post("/api/rename", { from: source, to: (destDir ? destDir + "/" : "") + basename(source) });
        } else await api.post("/api/copy", { from: source, to: destDir });
      }
      const srcDirs = clipboard.mode === "cut" ? [...new Set(paths.map(parentOf))] : [];
      if (clipboard.mode === "cut") clipboard = null;
      await fsChanged(destDir);
      for (const d of srcDirs) if (d !== destDir) await fsChanged(d);
    } catch (e) { alert("Paste gagal: " + e.message); }
  }
  async function doDuplicate(p) { try { const r = await api.post("/api/duplicate", { path: p }); await fsChanged(parentOf(p)); setStatus("digandakan: " + r.path); } catch (e) { alert("Gagal: " + e.message); } }
  async function doDeleteMany(items) {
    items = topLevelItems(items);
    if (!items.length || !confirm("Hapus " + items.length + " item terpilih?")) return;
    try {
      for (const it of items) {
        await api.post("/api/delete", { path: it.path });
        closePathEverywhere(it.path);
        walkLeaves(layout, (l) => l.tabs.slice().forEach((t) => {
          if (t.kind === "file" && t.path.startsWith(it.path + "/")) closeTab(l, t.id);
        }));
      }
      const refreshAt = items.every((x) => parentOf(x.path) === parentOf(items[0].path)) ? parentOf(items[0].path) : "";
      selectedTreeItems.clear(); selNode = null; selectionAnchorPath = null;
      await fsChanged(refreshAt);
    } catch (e) { alert("Gagal: " + e.message); }
  }
  async function doDelete(it) { return doDeleteMany([it]); }
  async function doRename(it) {
    if (inlineEditing) inlineEditing.cancel();
    const li = treeLi(it.path);
    if (!li) { // tidak terlihat di tree (mis. dari favorit): pakai dialog
      const n = await promptDlg("Nama baru:", it.name); if (!n) return;
      try { const to = (parentOf(it.path) ? parentOf(it.path) + "/" : "") + n; await api.post("/api/rename", { from: it.path, to }); await fsChanged(parentOf(it.path)); } catch (e) { alert("Gagal: " + e.message); }
      return;
    }
    const row = li.querySelector(":scope > .row");
    const restore = () => { const inp = row.querySelector("input.tree-edit"); if (inp) { const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = it.name; inp.replaceWith(nm); } const er = row.querySelector(".tree-edit-err"); if (er) er.remove(); row.classList.remove("editing"); };
    inlineNameInput(row, it.name, {
      isDir: it.dir,
      onCancel: restore,
      onCommit: async (name) => {
        if (name === it.name) { restore(); return; }
        const to = (parentOf(it.path) ? parentOf(it.path) + "/" : "") + name;
        await api.post("/api/rename", { from: it.path, to });
        // Tab yang terbuka mengikuti nama baru.
        walkLeaves(layout, (l) => l.tabs.forEach((t) => {
          if (t.kind !== "file") return;
          if (t.path === it.path) { t.path = to; t.name = name; if (FILES[it.path]) { FILES[to] = FILES[it.path]; delete FILES[it.path]; } }
          else if (it.dir && t.path.startsWith(it.path + "/")) { const np = to + t.path.slice(it.path.length); if (FILES[t.path]) { FILES[np] = FILES[t.path]; delete FILES[t.path]; } t.path = np; }
        }));
        renderAllTabbars(); renderOpenFiles(); queueLayoutSync();
        await fsChanged(parentOf(it.path));
        const moved = treeLi(to); if (moved) select(moved);
      },
    });
  }
  // Path absolut mengikuti pemisah OS server (Windows: backslash).
  function copyPath(it, absolute) {
    const win = INFO.spec && INFO.spec.platform === "win32";
    const p = absolute ? INFO.workspace + (win ? "\\" + it.path.replace(/\//g, "\\") : "/" + it.path) : it.path;
    navigator.clipboard.writeText(p).then(() => setStatus("path disalin: " + p), () => setStatus("path: " + p));
  }
  function download(it) { const a = document.createElement("a"); a.href = "/api/download?path=" + enc(it.path); a.download = it.name; document.body.appendChild(a); a.click(); a.remove(); }
  function archiveDestination(items) {
    const parent = parentOf(items[0].path);
    return items.every((item) => parentOf(item.path) === parent) ? parent : "";
  }
  function archiveDefaultName(items) {
    return items.length === 1 ? basename(items[0].path).replace(/\.(zip|tar|tgz|tar\.gz)$/i, "") : "archive-" + items.length + "-items";
  }
  async function makeArchive(items, format) {
    const name = await promptDlg("Nama arsip " + format.toUpperCase() + ":", archiveDefaultName(items));
    if (!name) return;
    const dest = archiveDestination(items);
    try {
      const result = await api.post("/api/archive", { paths: items.map((x) => x.path), format, name, dest });
      await fsChanged(dest);
      setStatus("Arsip dibuat: " + result.path);
    } catch (e) { alert("Gagal membuat arsip: " + e.message); }
  }
  async function downloadArchive(items, format) {
    try {
      setStatus("Menyiapkan download " + format.toUpperCase() + "…");
      const response = await fetch("/api/archive-download", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: items.map((x) => x.path), format, name: archiveDefaultName(items) }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.status);
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const name = match ? match[1] : archiveDefaultName(items) + (format === "zip" ? ".zip" : ".tar.gz");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      setStatus("Download siap: " + name);
    } catch (e) { alert("Gagal download arsip: " + e.message); }
  }
  async function extractArchive(it) {
    try {
      const result = await api.post("/api/extract", { path: it.path });
      await fsChanged(parentOf(it.path));
      setStatus("Extract selesai: " + result.path);
    } catch (e) { alert("Gagal extract: " + e.message); }
  }
  const isArchive = (name) => /\.(zip|tar|tar\.gz|tgz)$/i.test(name);
  function preview(it) { window.open("/preview/" + it.path.split("/").map(enc).join("/"), "_blank"); }

  // ===== Favorites =====
  const FAV_KEY = "c9clone.favs";
  const getFavs = () => { try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); } catch (e) { return []; } };
  const setFavs = (a) => localStorage.setItem(FAV_KEY, JSON.stringify(a));
  function addFav(it) { const f = getFavs(); if (!f.some((x) => x.path === it.path)) { f.push({ path: it.path, name: it.name, dir: it.dir }); setFavs(f); renderFavs(); } }
  function removeFav(p) { setFavs(getFavs().filter((x) => x.path !== p)); renderFavs(); }
  function renderFavs() {
    const favs = getFavs(); const wrap = $("#fav-wrap"), ul = $("#favlist"); ul.innerHTML = "";
    wrap.classList.toggle("empty", favs.length === 0);
    favs.forEach((it) => {
      const li = document.createElement("li");
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = '<span class="twist fav-star">&#9733;</span><span class="ic ' + (it.dir ? "ic-dir" : "ic-file") + '">' + fileIconSvg(it.name, it.dir, false) + '</span><span class="nm"></span>';
      row.querySelector(".nm").textContent = it.name; li.appendChild(row);
      row.addEventListener("click", () => { if (it.dir) addTerminal(null, it.path); else openFile(it.path, it.name); });
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ctxSimple(e, [["Buka", () => (it.dir ? addTerminal(null, it.path) : openFile(it.path, it.name))], ["Hapus dari Favorites", () => removeFav(it.path)]]); });
      ul.appendChild(li);
    });
  }
  renderFavs();

  // ===== Panel mengapung (Run terminal, log update): geser, ubah ukuran, kecilkan, dock =====
  let floatZ = 70;
  const FLOAT_POS_KEY = "c9clone.float.";
  function createFloat(opts) {
    opts = opts || {};
    const el = document.createElement("div"); el.className = "vr-float"; if (opts.id) el.dataset.fid = opts.id;
    el.innerHTML = '<div class="hd"><span class="ttl"></span><span class="st"></span>' +
      (opts.onDock ? '<span class="act dock" title="Pindahkan ke tab panel">\u21f1</span>' : "") +
      '<span class="act mn" title="Kecilkan / perbesar">\u2013</span><span class="act x" title="Tutup">\u2715</span></div>' +
      '<div class="body' + (opts.bodyClass ? " " + opts.bodyClass : "") + '"></div><div class="rs" title="Ubah ukuran"></div>';
    const hd = el.querySelector(".hd"), body = el.querySelector(".body"), st = el.querySelector(".st"), ttl = el.querySelector(".ttl");
    ttl.textContent = opts.title || "";
    // Posisi/ukuran tersimpan per id; default kanan bawah.
    let saved = null; try { saved = opts.id ? JSON.parse(localStorage.getItem(FLOAT_POS_KEY + opts.id) || "null") : null; } catch (e) {}
    const w = (saved && saved.w) || opts.w || 600, h = (saved && saved.h) || opts.h || 280;
    el.style.width = w + "px"; el.style.height = h + "px";
    const place = (x, y) => {
      const W = el.offsetWidth || w, H = el.offsetHeight || h;
      x = Math.max(4, Math.min(x, innerWidth - W - 4)); y = Math.max(30, Math.min(y, innerHeight - 60));
      el.style.left = x + "px"; el.style.top = y + "px";
    };
    const save = () => { if (!opts.id) return; try { localStorage.setItem(FLOAT_POS_KEY + opts.id, JSON.stringify({ x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10), w: el.offsetWidth, h: el.offsetHeight })); } catch (e) {} };
    const api = {
      el, body, st,
      open() { el.classList.add("open"); el.classList.remove("min"); api.front(); if (saved && saved.x != null) place(saved.x, saved.y); else place(innerWidth - (el.offsetWidth || w) - 14, innerHeight - (el.offsetHeight || h) - 36); if (opts.onResize) setTimeout(opts.onResize, 30); return api; },
      hide() { el.classList.remove("open"); return api; },
      front() { el.style.zIndex = String(++floatZ); return api; },
      setTitle(t) { ttl.textContent = t; return api; },
      setStatus(t, cls) { st.textContent = t == null ? "" : t; el.classList.remove("ok", "err"); if (cls) el.classList.add(cls); return api; },
      detach() { el.remove(); return api; },
      close() { if (opts.onClose) { try { opts.onClose(); } catch (e) {} } if (opts.hideOnClose) return api.hide(); el.remove(); return api; },
      isOpen() { return el.classList.contains("open") && el.isConnected; },
    };
    // Geser lewat header (pointer events; tidak saat klik tombol aksi).
    hd.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".act")) return;
      api.front();
      const r = el.getBoundingClientRect(); const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => place(ev.clientX - ox, ev.clientY - oy);
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); save(); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      e.preventDefault();
    });
    hd.addEventListener("dblclick", (e) => { if (!e.target.closest(".act")) el.classList.toggle("min"); });
    // Ubah ukuran lewat pegangan kanan bawah.
    el.querySelector(".rs").addEventListener("pointerdown", (e) => {
      api.front();
      const r = el.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height;
      const move = (ev) => { el.style.width = Math.max(320, sw + ev.clientX - sx) + "px"; el.style.height = Math.max(140, sh + ev.clientY - sy) + "px"; if (opts.onResize) opts.onResize(); };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); save(); if (opts.onResize) opts.onResize(); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener("pointerdown", () => api.front());
    el.querySelector(".mn").addEventListener("click", () => { el.classList.toggle("min"); if (!el.classList.contains("min") && opts.onResize) setTimeout(opts.onResize, 30); });
    el.querySelector(".x").addEventListener("click", () => api.close());
    if (opts.onDock) el.querySelector(".dock").addEventListener("click", () => opts.onDock(api));
    document.body.appendChild(el);
    return api;
  }
  window.addEventListener("resize", () => { document.querySelectorAll(".vr-float.open").forEach((f) => { const x = parseInt(f.style.left, 10) || 0, y = parseInt(f.style.top, 10) || 0; f.style.left = Math.max(4, Math.min(x, innerWidth - f.offsetWidth - 4)) + "px"; f.style.top = Math.max(30, Math.min(y, innerHeight - 60)) + "px"; }); });

  // ---- Terminal Run mengapung: terminal server biasa yang dipasang di panel mengapung ----
  const FLOAT_TERMS_KEY = "c9clone.floatTerms";
  const FLOAT_TERMS = {}; // termId -> { tab, f }
  function saveFloatTerms() { try { localStorage.setItem(FLOAT_TERMS_KEY, JSON.stringify(Object.keys(FLOAT_TERMS).map((id) => ({ termId: id, title: FLOAT_TERMS[id].title })))); } catch (e) {} }
  function mountFloatTerm(tab, title, offset) {
    const view = TERMS[tab.termId]; if (!view) return null;
    const f = createFloat({
      id: "runterm", title: title, w: 680, h: 300, bodyClass: "pane-term-host",
      onResize: () => fitVisibleTerminal(view),
      onClose: () => { delete FLOAT_TERMS[tab.termId]; saveFloatTerms(); disposeTerminalView(tab.termId); if (!applyingRemote) sync.send({ type: "terminal-close", id: tab.termId }); },
      onDock: (api) => { // pindahkan ke tab pane pengguna (masuk layout & tersinkron ke browser lain)
        api.detach(); delete FLOAT_TERMS[tab.termId]; saveFloatTerms();
        const leaf = userLeaf(); leaf.tabs.push(tab); renderLayout(); setActiveTab(leaf, tab.id); queueLayoutSync();
      },
    });
    f.body.appendChild(view.el);
    f.open();
    if (offset) { const x = parseInt(f.el.style.left, 10) - offset, y = parseInt(f.el.style.top, 10) - offset; f.el.style.left = Math.max(4, x) + "px"; f.el.style.top = Math.max(30, y) + "px"; }
    setTimeout(() => { fitVisibleTerminal(view); try { view.term.focus(); } catch (e) {} }, 60);
    FLOAT_TERMS[tab.termId] = { tab, f, title };
    saveFloatTerms();
    return f;
  }
  async function openFloatTerminal(runCmd, title, cwd) {
    const tab = await createTermTab(runCmd, cwd); if (!tab) return null;
    const n = Object.keys(FLOAT_TERMS).length;
    return mountFloatTerm(tab, title || tab.name, n ? n * 26 : 0);
  }
  // Setelah reload: pasang kembali terminal Run mengapung yang masih hidup di server.
  function restoreFloatTerms() {
    let list = []; try { list = JSON.parse(localStorage.getItem(FLOAT_TERMS_KEY) || "[]"); } catch (e) {}
    list.forEach((it, i) => {
      if (!it || !it.termId || FLOAT_TERMS[it.termId]) return;
      const meta = TERMINAL_META[it.termId]; if (!meta) return; // terminal sudah tidak ada
      let inLayout = false; walkLeaves(layout, (l) => { if (l.tabs.some((t) => t.termId === it.termId)) inLayout = true; });
      if (inLayout) return;
      ensureTerminalView(meta);
      mountFloatTerm({ id: ++tabSeq, kind: "term", termId: it.termId, name: meta.title }, it.title || meta.title, i * 26);
    });
    saveFloatTerms();
  }

  // ===== Run =====
  function runActive() { const t = activeFileTab(); if (!t) return alert("Buka & pilih file dulu untuk di-Run."); saveActive().then(() => runFile(t.path)); }
  // Runner per ekstensi datang dari server (/api/runners): hanya bahasa yang interpreter/
  // compiler-nya benar-benar terpasang di server. Template memakai {bin} {file} {out} {stem} {dir}.
  let RUNNERS = null;
  let runProbeKey = "", runProbeSeq = 0, runProbeTimer = null;
  function loadRunners(refresh) {
    return api.get("/api/runners" + (refresh ? "?refresh=1" : "")).then((r) => { RUNNERS = r; runProbeKey = ""; updateRunButton(); return r; }).catch(() => RUNNERS);
  }
  loadRunners();
  function fileRunKey(p) {
    const name = String(p || "").split("/").pop();
    const ext = name.indexOf(".") > 0 ? name.split(".").pop().toLowerCase() : "";
    return ext || name;
  }
  function runnerFor(p) {
    const name = String(p || "").split("/").pop();
    const ext = name.indexOf(".") > 0 ? name.split(".").pop().toLowerCase() : "";
    const R = RUNNERS || { runners: {}, missing: {}, byName: [], previewExt: ["html", "htm", "svg", "pdf"] };
    if (ext && R.runners[ext]) return { kind: "run", ext, r: R.runners[ext] };
    for (const b of (R.byName || [])) {
      let re = null; try { re = new RegExp(b.pattern, b.flags || ""); } catch (e) { continue; }
      if (re.test(name)) return b.template ? { kind: "run", ext: name, r: b } : { kind: "missing", ext: name, m: { label: b.label, need: b.need || [] } };
    }
    if (ext && (R.previewExt || []).includes(ext)) return { kind: "preview", ext };
    if (ext && R.missing && R.missing[ext]) return { kind: "missing", ext, m: R.missing[ext] };
    return null;
  }
  function runnerHint(p) {
    const rr = runnerFor(p);
    if (!rr) return "Tidak ada runner untuk file ini";
    if (rr.kind === "preview") return "Buka pratinjau di browser";
    if (rr.kind === "missing") return rr.m.label + ": belum terpasang di server (butuh " + rr.m.need.join(" / ") + ")";
    return "Jalankan dengan " + rr.r.label + " (" + rr.r.bin + ")";
  }
  function probeRunner(key) {
    const seq = ++runProbeSeq;
    runProbeKey = key;
    return api.get("/api/runners?ext=" + enc(key)).then((r) => {
      if (seq !== runProbeSeq) return RUNNERS;
      RUNNERS = r;
      paintRunButton();
      return r;
    });
  }
  function runFile(p) {
    const known = runnerFor(p);
    const go = () => runFileNow(p);
    if (known && known.kind === "preview") return go();
    const key = fileRunKey(p);
    if (!key) return go();
    probeRunner(key).then(go, go);
  }
  function runFileNow(p) {
    const rr = runnerFor(p);
    const name = p.split("/").pop();
    if (!rr) return alert("Belum ada runner untuk \u201c" + name + "\u201d.\nEkstensi ini tidak dikenali. Jalankan manual lewat terminal.");
    if (rr.kind === "preview") return preview({ path: p, name });
    if (rr.kind === "missing") {
      return alert("Runner " + rr.m.label + " untuk \u201c" + name + "\u201d tidak tersedia:\nserver belum memiliki " + rr.m.need.join(" / ") + ".\n\nPasang di server, lalu Alat \u2192 Deteksi ulang runner.");
    }
    const win = RUNNERS && RUNNERS.platform === "win32";
    const quote = win ? (s) => "'" + s.replace(/'/g, "''") + "'" : q;
    const toOs = (s) => (win ? s.replace(/\//g, "\\") : s);
    const stem = name.replace(/\.[^.]+$/, "");
    // Terminal dibuka di folder file itu sendiri (import relatif, file data, output ikut folder skrip).
    const fileDir = p.indexOf("/") !== -1 ? p.slice(0, p.lastIndexOf("/")) : "";
    const outDir = (RUNNERS && RUNNERS.outDir) || "/tmp/vrcloud-run";
    const out = outDir + (win ? "\\" : "/") + stem;
    const t = rr.r.template;
    const fileArg = (win ? ".\\" : "./") + name; // relatif terhadap cwd = folder file
    let cmd = t
      .replace(/\{bin\}/g, rr.r.bin)
      .replace(/\{file\}/g, quote(fileArg))
      .replace(/\{out\}(\.[A-Za-z0-9]+)?/g, (m, sfx) => quote(out + (sfx || "")))
      .replace(/\{stem\}/g, quote(stem))
      .replace(/\{dir\}/g, quote("."));
    // Kompilasi butuh folder keluaran.
    if (t.indexOf("{out}") !== -1) cmd = (win ? "New-Item -ItemType Directory -Force " + quote(outDir) + " | Out-Null; " : "mkdir -p " + quote(outDir) + " && ") + cmd;
    // Jalankan di terminal mengapung (bisa digeser/diubah ukurannya; tombol ⇱ memindahkan ke tab).
    openFloatTerminal(cmd, "\u25b6 " + name + " \u2014 " + rr.r.label, fileDir);
  }
  // Tombol ▶ Jalankan mengikuti ekstensi file aktif (langsung, lalu cek biner di server).
  function paintRunButton() {
    const b = document.querySelector('#menubar [data-act="run"]');
    if (!b) return;
    const t = activeFileTab();
    if (!t || !FILES[t.path]) { b.hidden = true; b.classList.remove("off"); return; }
    b.hidden = false;
    const tr = (s) => (window.I18N && I18N.t ? I18N.t(s) : s);
    if (!RUNNERS) {
      b.classList.remove("off");
      b.textContent = tr("\u25b6 Jalankan");
      b.title = "Mendeteksi runner\u2026";
      return;
    }
    const rr = runnerFor(t.path);
    const ext = fileRunKey(t.path);
    if (!rr) {
      b.classList.add("off");
      b.textContent = tr("\u25b6 Jalankan");
      b.title = "Run \u2014 tidak ada runner untuk ." + ext;
    } else if (rr.kind === "preview") {
      b.classList.remove("off");
      b.textContent = tr("\u25b6 Pratinjau");
      b.title = "Run \u2014 " + runnerHint(t.path);
    } else if (rr.kind === "missing") {
      b.classList.add("off");
      b.textContent = "\u25b6 " + rr.m.label;
      b.title = "Run \u2014 " + runnerHint(t.path);
    } else {
      b.classList.remove("off");
      b.textContent = "\u25b6 " + rr.r.label;
      b.title = "Run \u2014 " + runnerHint(t.path);
    }
  }
  function updateRunButton() {
    paintRunButton();
    const t = activeFileTab();
    if (!t || !FILES[t.path] || !RUNNERS) return;
    const key = fileRunKey(t.path);
    if (!key || key === runProbeKey) return;
    const rr = runnerFor(t.path);
    if (rr && rr.kind === "preview") { runProbeKey = key; return; }
    clearTimeout(runProbeTimer);
    runProbeTimer = setTimeout(() => { probeRunner(key).catch(() => {}); }, 50);
  }
  // ===== Self-update VRCloud (tombol ⟳ Update di menubar) =====
  let UPD = null, updTimer = null;
  function updBtn() { return document.getElementById("mb-update"); }
  async function checkUpdate(force) {
    try { UPD = await api.get("/api/update/status" + (force ? "?force=1" : "")); } catch (e) { UPD = UPD || null; }
    renderUpdateBtn();
    return UPD;
  }
  function fmtDate(iso) { try { return iso ? new Date(iso).toLocaleString() : ""; } catch (e) { return iso || ""; } }
  function renderUpdateBtn() {
    const b = updBtn(); if (!b) return;
    if (!UPD || !UPD.isGit) { b.hidden = true; return; }
    b.hidden = false;
    const avail = !!UPD.updateAvailable, busy = !!UPD.running;
    if (avail && !busy && UPD.remote && UPD.remote.short && typeof notify === "function") {
      notify({ kind: "info", title: T("Update VRCloud tersedia"), body: (UPD.local && UPD.local.short ? UPD.local.short + " \u2192 " : "") + UPD.remote.short + (UPD.remote.subject ? " \u2014 " + UPD.remote.subject : ""), act: "update", dedupe: "update-" + UPD.remote.short, toast: true });
    }
    b.classList.toggle("avail", avail && !busy);
    b.classList.toggle("busy", busy);
    b.textContent = busy ? "\u27f3 Memperbarui\u2026" : (avail ? "\u27f3 Update tersedia" : "\u27f3 Update");
    const lines = ["VRCloud IDE " + (UPD.version ? "v" + UPD.version + " " : "") + "(" + (UPD.local.short || "?") + (UPD.local.date ? ", " + fmtDate(UPD.local.date) : "") + ")"];
    if (UPD.local.subject) lines.push("Commit: " + UPD.local.subject);
    if (UPD.remote.error) lines.push("Cek remote gagal: " + UPD.remote.error);
    else if (avail) lines.push("Versi baru di " + UPD.branch + ": " + UPD.remote.short + " \u2014 klik untuk update (server restart beberapa detik)");
    else lines.push("Sudah versi terbaru (" + UPD.branch + "). Klik untuk cek ulang / paksa update.");
    if (UPD.reason) lines.push(UPD.reason);
    if (busy) lines.push("Update sedang berjalan\u2026");
    b.title = lines.join("\n");
  }
  async function runUpdate() {
    showUpdPanel("memeriksa versi terbaru\u2026"); renderUpdLog(["memeriksa commit terbaru di remote\u2026"], null);
    const hide = () => { if (updPanel) updPanel.hide(); };
    const s = await checkUpdate(true);
    if (!s) { hide(); return alert("Tidak bisa menghubungi server untuk cek update."); }
    if (s.running) { startUpdWatch(null); return; }
    if (!s.canUpdate) { hide(); return alert(s.reason || "Update otomatis tidak tersedia di instalasi ini."); }
    renderUpdLog([s.updateAvailable ? "update tersedia: " + s.local.short + " \u2192 " + s.remote.short : "sudah versi terbaru (" + s.local.short + ")"], "menunggu konfirmasi");
    const msg = s.updateAvailable
      ? "Update VRCloud " + s.local.short + " \u2192 " + s.remote.short + " (" + s.branch + ")?\n\nKode diambil saat server tetap berjalan; server hanya di-restart di akhir (beberapa detik). Tab & terminal tersimpan, halaman dimuat ulang otomatis."
      : "Sudah versi terbaru (" + s.local.short + ").\n\nJalankan update ulang tetap (fetch, cek dependensi, restart server)?";
    if (!confirm(msg)) { hide(); return; }
    try {
      const r = await api.post("/api/update/run", {});
      UPD.running = { pid: r.pid }; renderUpdateBtn();
      setStatus("Update dimulai (" + r.method + ") " + (r.from || "") + " \u2192 " + (r.to || ""));
      startUpdWatch(s.local.commit);
    } catch (e) { alert("Gagal memulai update: " + e.message); }
  }
  // ---- Panel log update (panel mengapung: bisa digeser/diubah ukurannya): tail data/update.log live ----
  let updPanel = null, updPoll = null;
  function updPanelEl() {
    if (updPanel) return updPanel;
    updPanel = createFloat({ id: "update", title: "\u27f3 Update VRCloud \u2014 log", w: 600, h: 280, bodyClass: "logbody", hideOnClose: true });
    const pre = document.createElement("pre"); pre.className = "log"; updPanel.body.appendChild(pre); updPanel.pre = pre;
    return updPanel;
  }
  function showUpdPanel(status) { const p = updPanelEl(); if (!p.isOpen()) p.open(); else p.front(); if (status != null) p.setStatus(status); }
  function renderUpdLog(lines, status, cls) {
    const p = updPanelEl(); const body = p.pre;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 12;
    body.textContent = (lines || []).join("\n");
    if (atBottom) body.scrollTop = body.scrollHeight;
    if (status != null || cls) p.setStatus(status != null ? status : p.st.textContent, cls);
  }
  // Pantau update: tampilkan log, deteksi server mati/hidup lagi, lalu muat ulang halaman.
  function startUpdWatch(prevCommit) {
    showUpdPanel("berjalan\u2026");
    clearInterval(updPoll);
    const start = Date.now(); let wasDown = false, lastLines = [];
    const prevShort = prevCommit ? String(prevCommit).slice(0, 7) : "";
    const tick = async () => {
      let j = null;
      try { const r = await fetch("/api/update/log", { credentials: "same-origin", cache: "no-store" }); if (r.ok) j = await r.json(); else wasDown = true; }
      catch (e) { wasDown = true; }
      if (!j) { renderUpdLog(lastLines.concat(["\u2026 server sedang restart, menunggu kembali \u2026"]), "server restart\u2026"); }
      else {
        lastLines = j.lines || [];
        const newCommit = !!(prevShort && j.commit && j.commit !== prevShort);
        if (j.failed && !j.running) { renderUpdLog(lastLines, "gagal", "err"); clearInterval(updPoll); checkUpdate(true); return; }
        if (!j.running && (j.done || wasDown || newCommit)) {
          renderUpdLog(lastLines.concat(["\u2714 server aktif di " + (j.commit || "?") + " \u2014 halaman dimuat ulang dalam 3 detik\u2026"]), "selesai", "ok");
          clearInterval(updPoll); setTimeout(() => location.reload(), 3000); return;
        }
        renderUpdLog(lastLines, j.running ? "berjalan\u2026" : "menunggu\u2026");
      }
      if (Date.now() - start > 10 * 60 * 1000) { renderUpdLog(lastLines.concat(["\u26a0 melebihi 10 menit \u2014 cek data/update.log"]), "timeout", "err"); clearInterval(updPoll); }
    };
    updPoll = setInterval(tick, 1500); tick();
  }
  { const b = updBtn(); if (b) b.addEventListener("click", () => { if (UPD && UPD.running) { showUpdPanel(); if (!updPoll) startUpdWatch(null); } else runUpdate(); }); }
  // Update yang dimulai dari browser lain: ikut tampilkan panel lognya.
  setTimeout(() => checkUpdate(false).then((s) => { if (s && s.running && !updPoll) startUpdWatch(null); }), 4000);
  updTimer = setInterval(() => checkUpdate(false), 30 * 60 * 1000);
  function showRunnersDlg() {
    const R = RUNNERS || { runners: {}, missing: {} };
    const have = Object.keys(R.runners).sort().map((e) => "." + e + " \u2192 " + R.runners[e].label + " (" + R.runners[e].bin + ")");
    const miss = {}; Object.keys(R.missing || {}).forEach((e) => { const k = R.missing[e].label; (miss[k] = miss[k] || []).push("." + e); });
    const missLines = Object.keys(miss).sort().map((k) => k + ": " + miss[k].join(", "));
    alert("Runner tersedia di server (" + have.length + "):\n" + (have.join("\n") || "(tidak ada)") +
      (missLines.length ? "\n\nBelum terpasang:\n" + missLines.join("\n") : ""));
  }
  function goToFileDlg() { promptDlg("Buka file (path relatif):", "").then((p) => { if (p) openFile(p, basename(p)); }); }

  // ============================================================
  //  CONTEXT MENU (file tree)
  // ============================================================
  const ctx = $("#ctx");
  function hideCtx() { ctx.style.display = "none"; }
  // Satu pembangun item untuk semua menu klik-kanan (editor, tree, terminal, gear).
  // opt: { sep, key, disabled, checked, title }
  function ctxItem(container, label, fn, opt) {
    opt = opt || {};
    if (opt.sep) { const s = document.createElement("div"); s.className = "sep"; container.appendChild(s); }
    const d = document.createElement("div"); d.className = "item" + (opt.disabled ? " disabled" : "") + (opt.checked != null ? " checkable" : "");
    if (opt.checked) { const c = document.createElement("span"); c.className = "chk"; c.textContent = "\u2714"; d.appendChild(c); }
    const l = document.createElement("span"); l.textContent = label; d.appendChild(l);
    if (opt.key) { const k = document.createElement("span"); k.className = "key"; k.textContent = opt.key; d.appendChild(k); }
    if (opt.title) d.title = opt.title;
    if (!opt.disabled) d.addEventListener("click", () => { hideCtx(); hideGear(); fn(); });
    container.appendChild(d);
    return d;
  }
  function ctxSimple(e, items) { ctx.innerHTML = ""; items.forEach(([label, fn]) => ctxItem(ctx, label, fn)); placeCtx(e); }
  // Salin teks ke clipboard (fallback textarea+execCommand di koneksi non-HTTPS).
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* lanjut ke fallback */ }
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove(); return ok;
  }
  function placeCtx(e) { ctx.style.display = "block"; const w = ctx.offsetWidth, h = ctx.offsetHeight; ctx.style.left = Math.min(e.clientX, innerWidth - w - 6) + "px"; ctx.style.top = Math.min(e.clientY, innerHeight - h - 6) + "px"; }
  function showCtx(e, it) {
    ctx.innerHTML = "";
    const items = selectedItems();
    const single = items.length === 1;
    const dirForNew = it.dir ? it.path : parentOf(it.path);
    const rr = single && !it.dir ? runnerFor(it.path) : null;
    const runnable = !!(rr && rr.kind !== "missing");
    const add = (label, fn, opt) => ctxItem(ctx, label, fn, opt);
    if (items.length > 1) add(items.length + " items selected", () => {}, { disabled: true });
    add("Open", () => (it.dir ? expandPath(it.path) : openFile(it.path, it.name)), { disabled: !single });
    add(single ? "Download" : "Download " + items.length + " Items as ZIP",
      () => single ? download(it) : downloadArchive(items, "zip"));
    add("Download as ZIP", () => downloadArchive(items, "zip"), { sep: true });
    add("Download as TAR.GZ", () => downloadArchive(items, "tar.gz"));
    add("Compress to ZIP…", () => makeArchive(items, "zip"), { sep: true });
    add("Compress to TAR.GZ…", () => makeArchive(items, "tar.gz"));
    add("Extract Here", () => extractArchive(it), { disabled: !single || !isArchive(it.name) });
    add("Run", () => runFile(it.path), { disabled: !runnable, title: single && !it.dir ? runnerHint(it.path) : "" });
    add("Preview", () => preview(it), { disabled: !single || it.dir });
    add("Refresh", () => refreshNode(it.dir ? it.path : parentOf(it.path)), { sep: true });
    add("Rename", () => doRename(it), { disabled: !single });
    add("Delete", () => doDeleteMany(items));
    add("Cut", () => (clipboard = { mode: "cut", paths: topLevelItems(items).map((x) => x.path) }), { sep: true, key: "Ctrl-X" });
    add("Copy", () => (clipboard = { mode: "copy", paths: topLevelItems(items).map((x) => x.path) }), { key: "Ctrl-C" });
    add("Paste", () => doPaste(dirForNew), { key: "Ctrl-V", disabled: !clipboard });
    add("Duplicate", () => doDuplicate(it.path), { disabled: !single });
    add("Copy file path", () => copyPath(it, false), { sep: true, disabled: !single });
    add("Copy absolute path", () => copyPath(it, true), { disabled: !single });
    add("Add to Favorites", () => addFav(it), { sep: true, disabled: !single });
    add("Open Terminal Here", () => addTerminal(null, dirForNew), { key: "Alt-L", disabled: !single });
    add("Search In This Folder", () => openSearch(dirForNew), { key: "Ctrl-Shift-F", disabled: !single });
    add("New File", () => newEntry(false, dirForNew), { sep: true });
    add("New Folder", () => newEntry(true, dirForNew));
    placeCtx(e);
  }
  $("#sidebar").addEventListener("contextmenu", (e) => {
    if (e.target.closest("#filetree li") || e.target.closest("#favlist li")) return;
    e.preventDefault(); select(null);
    ctxSimple(e, [
      ["New File", () => newEntry(false, "")], ["New Folder", () => newEntry(true, "")],
      ["Paste", () => (clipboard ? doPaste("") : null)], ["Refresh", refreshTree],
      ["Open Terminal Here", () => addTerminal(null, "")], ["Search In Workspace", () => openSearch("")],
    ]);
  });
  window.addEventListener("click", () => { hideCtx(); hideGear(); });
  window.addEventListener("scroll", hideCtx, true);

  // ============================================================
  //  KEYBOARD
  // ============================================================
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || (a.className && String(a.className).indexOf("ace_") >= 0)); };
  async function goToLineDlg() {
    const ed = activeEditor();
    if (!ed) return setStatus("Ctrl+G: pilih tab file terlebih dahulu");
    const current = ed.getCursorPosition().row + 1;
    const value = await promptDlg("Go To Line (nomor baris):", String(current));
    if (value == null) return;
    const line = parseInt(value, 10);
    if (!Number.isFinite(line) || line < 1) return alert("Nomor baris tidak valid.");
    ed.gotoLine(line, 0, true); ed.focus();
  }
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.key === "F6") { e.preventDefault(); addTerminal(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); saveActive(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === "g") { e.preventDefault(); goToLineDlg(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "g") { e.preventDefault(); setSideView("scm"); return; }
    if (e.altKey && k === "l") { e.preventDefault(); addTerminal(null, curDir()); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "f") { e.preventDefault(); openSearch(""); return; }
    if ((e.ctrlKey || e.metaKey) && !typing() && selNode) {
      const paths = topLevelItems(selectedItems()).map((item) => item.path);
      if (k === "x") { e.preventDefault(); clipboard = { mode: "cut", paths }; }
      else if (k === "c") { e.preventDefault(); clipboard = { mode: "copy", paths }; }
      else if (k === "v") { e.preventDefault(); doPaste(selNode.dir ? selNode.path : parentOf(selNode.path)); }
    }
    if (k === "delete" && !typing() && selNode) doDeleteMany(selectedItems());
  });

  // ============================================================
  //  DRAG & DROP UPLOAD (dari PC)
  // ============================================================
  const sidebar = $("#sidebar");
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  sidebar.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; sidebar.classList.add("dropping"); } });
  sidebar.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  sidebar.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; sidebar.classList.remove("dropping"); } });
  sidebar.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; sidebar.classList.remove("dropping");
    const li = e.target.closest("#filetree li");
    let dest = ""; if (li) dest = li.dataset.dir === "1" ? li.dataset.path : parentOf(li.dataset.path);
    const dt = e.dataTransfer; let files = [];
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      const entries = []; for (const it of dt.items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
      for (const en of entries) files = files.concat(await walkEntry(en, ""));
    } else { for (const f of dt.files) files.push({ file: f, path: f.name }); }
    if (!files.length) return;
    await uploadFiles(dest, files);
  });
  // Unggah daftar [{ path, file }] ke folder tujuan dengan progres di status bar.
  async function uploadFiles(dest, files) {
    let done = 0; setStatus("upload 0/" + files.length + " …");
    for (const f of files) {
      try { await api.upload(dest, f.path, f.file); } catch (err) { setStatus("upload gagal: " + f.path + " (" + err.message + ")"); }
      setStatus("upload " + ++done + "/" + files.length + " …");
    }
    setStatus("upload selesai: " + files.length + " file ke /" + (dest || INFO.name));
    await fsChanged(dest);
  }
  function walkEntry(entry, prefix) {
    return new Promise((resolve) => {
      if (entry.isFile) entry.file((file) => resolve([{ file, path: prefix + entry.name }]), () => resolve([]));
      else if (entry.isDirectory) {
        const reader = entry.createReader(); let all = [];
        const readBatch = () => reader.readEntries(async (batch) => {
          if (!batch.length) { let out = []; for (const en of all) out = out.concat(await walkEntry(en, prefix + entry.name + "/")); resolve(out); }
          else { all = all.concat(batch); readBatch(); }
        }, () => resolve([]));
        readBatch();
      } else resolve([]);
    });
  }
  $("#file-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []); if (!files.length) return;
    e.target.value = "";
    await uploadFiles(curDir(), files.map((f) => ({ file: f, path: f.name })));
  });

  // ============================================================
  //  SEARCH (sidebar ala VS Code): opsi Aa / ab / .*, Replace, include/exclude,
  //  hasil per file dengan highlight, cari-sambil-ketik.
  // ============================================================
  const SRCH_KEY = "c9clone.search";
  const srch = {
    q: $("#srch-q"), r: $("#srch-r"), inc: $("#srch-inc"), exc: $("#srch-exc"),
    results: $("#srch-results"), summary: $("#srch-summary"),
    opts: { case: false, word: false, regex: false }, data: [], collapsed: {}, timer: null, seq: 0,
  };
  try { Object.assign(srch.opts, JSON.parse(localStorage.getItem(SRCH_KEY) || "{}").opts || {}); } catch (e) {}
  function srchSaveOpts() { try { localStorage.setItem(SRCH_KEY, JSON.stringify({ opts: srch.opts })); } catch (e) {} }
  function srchRenderOpts() { document.querySelectorAll("#sidebar-search .srch-opt").forEach((o) => o.classList.toggle("on", !!srch.opts[o.dataset.opt])); }
  srchRenderOpts();
  document.querySelectorAll("#sidebar-search .srch-opt").forEach((o) => o.addEventListener("click", () => { srch.opts[o.dataset.opt] = !srch.opts[o.dataset.opt]; srchSaveOpts(); srchRenderOpts(); srchRun(); }));
  $("#srch-toggle-replace").addEventListener("click", () => {
    const row = $("#sidebar-search .srch-replace"); row.hidden = !row.hidden;
    $("#srch-toggle-replace").innerHTML = row.hidden ? "&#9656;" : "&#9662;";
    if (!row.hidden) srch.r.focus();
  });
  $("#srch-more").addEventListener("click", () => { const adv = $("#sidebar-search .srch-adv"); adv.hidden = !adv.hidden; $("#srch-more").classList.toggle("on", !adv.hidden); });
  [srch.q, srch.inc, srch.exc].forEach((i) => i.addEventListener("input", () => srchSchedule()));
  srch.q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); srchRun(); }
    else if (e.key === "Escape") { srch.q.value = ""; srchClear(); }
    else if (e.altKey && /^[cwr]$/i.test(e.key)) { e.preventDefault(); const m = { c: "case", w: "word", r: "regex" }[e.key.toLowerCase()]; srch.opts[m] = !srch.opts[m]; srchSaveOpts(); srchRenderOpts(); srchRun(); }
  });
  srch.r.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); srchReplaceAll(); } });
  $("#srch-refresh").addEventListener("click", () => srchRun());
  $("#srch-clear").addEventListener("click", () => { srch.q.value = ""; srchClear(); srch.q.focus(); });
  $("#srch-collapse").addEventListener("click", () => { const all = Object.keys(srchGroups()); const anyOpen = all.some((p) => !srch.collapsed[p]); all.forEach((p) => { srch.collapsed[p] = anyOpen; }); srchRender(); });
  $("#srch-replace-all").addEventListener("click", srchReplaceAll);
  function srchClear() { srch.data = []; srch.collapsed = {}; srch.results.innerHTML = ""; srch.summary.textContent = ""; }
  function srchSchedule() { clearTimeout(srch.timer); srch.timer = setTimeout(srchRun, 280); }
  function srchGroups() { const g = {}; srch.data.forEach((r) => { (g[r.path] = g[r.path] || []).push(r); }); return g; }
  function srchRegex(global) {
    let src = srch.opts.regex ? srch.q.value : srch.q.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (srch.opts.word) src = "\\b(?:" + src + ")\\b";
    try { return new RegExp(src, (srch.opts.case ? "" : "i") + (global ? "g" : "")); } catch (e) { return null; }
  }
  async function srchRun() {
    clearTimeout(srch.timer);
    const term = srch.q.value;
    if (!term) { srchClear(); return; }
    const my = ++srch.seq;
    srch.summary.textContent = "mencari\u2026";
    const qs = "q=" + enc(term) + "&regex=" + (srch.opts.regex ? 1 : 0) + "&case=" + (srch.opts.case ? 1 : 0) + "&word=" + (srch.opts.word ? 1 : 0) +
      "&include=" + enc(srch.inc.value.trim()) + "&exclude=" + enc(srch.exc.value.trim());
    let res;
    try { res = await api.get("/api/search?" + qs); }
    catch (e) { if (my !== srch.seq) return; srch.results.innerHTML = ""; srch.summary.textContent = ""; srch.results.appendChild(Object.assign(document.createElement("div"), { className: "srch-empty err", textContent: e.message })); return; }
    if (my !== srch.seq) return; // hasil basi (pengguna sudah mengetik lagi)
    srch.data = Array.isArray(res) ? res : [];
    srch.collapsed = {};
    srchRender();
  }
  function srchHighlight(text, re) {
    const frag = document.createDocumentFragment();
    if (!re) { frag.appendChild(document.createTextNode(text)); return frag; }
    const g = new RegExp(re.source, re.flags.replace("g", "") + "g");
    let last = 0, m, guard = 0;
    while ((m = g.exec(text)) && guard++ < 50) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mk = document.createElement("mark"); mk.textContent = m[0] || ""; frag.appendChild(mk);
      last = m.index + m[0].length;
      if (!m[0]) g.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function srchRender() {
    const box = srch.results; box.innerHTML = "";
    const groups = srchGroups(); const files = Object.keys(groups);
    const total = srch.data.length;
    if (!srch.q.value) { srch.summary.textContent = ""; return; }
    if (!total) { srch.summary.textContent = "Tidak ada hasil."; box.appendChild(Object.assign(document.createElement("div"), { className: "srch-empty", textContent: "Tidak ada hasil ditemukan. Periksa opsi (Aa / ab / .*) dan include/exclude." })); return; }
    srch.summary.textContent = total + " hasil di " + files.length + " file" + (total >= 2000 ? " (dibatasi)" : "");
    const re = srchRegex(false);
    const replacing = !$("#sidebar-search .srch-replace").hidden;
    files.forEach((p) => {
      const hits = groups[p];
      const fh = document.createElement("div"); fh.className = "srch-file" + (srch.collapsed[p] ? " collapsed" : "");
      const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "\u25be"; fh.appendChild(chev);
      const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = "\u25a1"; fh.appendChild(ic);
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = basename(p); fh.appendChild(nm);
      const dir = p.indexOf("/") !== -1 ? p.slice(0, p.lastIndexOf("/")) : "";
      if (dir) { const d = document.createElement("span"); d.className = "dir"; d.textContent = dir; fh.appendChild(d); }
      const acts = document.createElement("span"); acts.className = "acts";
      if (replacing) { const rp = document.createElement("span"); rp.className = "a"; rp.title = "Replace All in file"; rp.textContent = "\u21b4"; rp.addEventListener("click", (e) => { e.stopPropagation(); srchReplace([{ path: p }]); }); acts.appendChild(rp); }
      const dm = document.createElement("span"); dm.className = "a"; dm.title = "Dismiss"; dm.textContent = "\u2715"; dm.addEventListener("click", (e) => { e.stopPropagation(); srch.data = srch.data.filter((r) => r.path !== p); srchRender(); }); acts.appendChild(dm);
      fh.appendChild(acts);
      const cnt = document.createElement("span"); cnt.className = "cnt"; cnt.textContent = hits.length; fh.appendChild(cnt);
      fh.addEventListener("click", () => { srch.collapsed[p] = !srch.collapsed[p]; srchRender(); });
      box.appendChild(fh);
      if (srch.collapsed[p]) return;
      hits.forEach((r) => {
        const row = document.createElement("div"); row.className = "srch-hit"; row.title = p + ":" + r.line;
        const pv = document.createElement("span"); pv.className = "pv";
        // Potong konteks agar match terlihat walau barisnya panjang.
        let text = String(r.text || ""); let mi = -1; if (re) { const mm = re.exec(text); mi = mm ? mm.index : -1; }
        if (mi > 40) text = "\u2026" + text.slice(mi - 30);
        pv.appendChild(srchHighlight(text, re)); row.appendChild(pv);
        const a2 = document.createElement("span"); a2.className = "acts";
        if (replacing) { const rp = document.createElement("span"); rp.className = "a"; rp.title = "Replace"; rp.textContent = "\u21b4"; rp.addEventListener("click", (e) => { e.stopPropagation(); srchReplace([{ path: p, lines: [r.line] }]); }); a2.appendChild(rp); }
        const dm2 = document.createElement("span"); dm2.className = "a"; dm2.title = "Dismiss"; dm2.textContent = "\u2715"; dm2.addEventListener("click", (e) => { e.stopPropagation(); srch.data = srch.data.filter((x) => x !== r); srchRender(); }); a2.appendChild(dm2);
        row.appendChild(a2);
        const ln = document.createElement("span"); ln.className = "ln"; ln.textContent = r.line; row.appendChild(ln);
        row.addEventListener("click", () => { document.querySelectorAll(".srch-hit.sel").forEach((x) => x.classList.remove("sel")); row.classList.add("sel"); openFile(p, basename(p), r.line); });
        box.appendChild(row);
      });
    });
  }
  async function srchReplace(files) {
    if (!srch.q.value || !files.length) return;
    const total = files.reduce((n, f) => n + (f.lines ? f.lines.length : (srchGroups()[f.path] || []).length), 0);
    if (total > 1 && !confirm("Ganti " + total + " kecocokan di " + files.length + " file dengan \u201c" + srch.r.value + "\u201d?")) return;
    try {
      const r = await api.post("/api/replace", { q: srch.q.value, replace: srch.r.value, regex: srch.opts.regex, case: srch.opts.case, word: srch.opts.word, files });
      setStatus("Diganti " + r.replaced + " kecocokan di " + r.files + " file");
      srchRun();
    } catch (e) { alert("Replace gagal: " + e.message); }
  }
  function srchReplaceAll() { const files = Object.keys(srchGroups()).map((p) => ({ path: p })); if (!files.length) return setStatus("Tidak ada hasil untuk diganti"); srchReplace(files); }
  // Buka panel pencarian; scope folder -> diisikan ke "files to include"; seleksi editor -> query.
  function openSearch(scope) {
    setSideView("search");
    Mobile.openFiles();
    if (scope) { srch.inc.value = scope.replace(/\/+$/, "") + "/**"; const adv = $("#sidebar-search .srch-adv"); adv.hidden = false; $("#srch-more").classList.add("on"); }
    const ed = activeEditor(); const sel = ed ? ed.getSelectedText() : "";
    if (sel && sel.indexOf("\n") === -1 && sel.length <= 200) { srch.q.value = sel; srchRun(); }
    setTimeout(() => { srch.q.focus(); srch.q.select(); }, 30);
  }

  // ===== Activity bar =====
  // Workspace / Git / Search mengganti isi sidebar.
  let curSideView = "workspace";
  function setSideView(name, remote) {
    const v = name === "scm" ? "scm" : name === "search" ? "search" : "workspace";
    curSideView = v;
    document.body.classList.toggle("side-scm", v === "scm");
    document.body.classList.toggle("side-search", v === "search");
    document.querySelectorAll("#activitybar .act").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
    if (v === "scm") refreshScm(true);
    if (v === "search" && !remote) setTimeout(() => srch.q.focus(), 30);
    if (!remote) queueViewSync();
  }
  document.querySelectorAll("#activitybar .act").forEach((a) => a.addEventListener("click", () => {
    setSideView(a.dataset.view);
  }));
  // Sinkron tampilan lintas browser: sidebar (Workspace/Git/Search) + panel AI mengikuti browser lain.
  let viewSyncTimer = null, applyingView = false;
  function queueViewSync() {
    if (applyingView || !syncInitialized) return;
    clearTimeout(viewSyncTimer);
    viewSyncTimer = setTimeout(() => {
      const aiOpen = !!(window.VRCloudAI && window.VRCloudAI.isOpen && window.VRCloudAI.isOpen());
      sync.send({ type: "uiview", side: curSideView, ai: aiOpen, desk: desktopOpen() });
    }, 80);
  }
  window.VRCloudViewSync = queueViewSync; // dipanggil panel AI saat dibuka/ditutup
  sync.on("uiview", (m) => {
    if (!m) return;
    applyingView = true;
    try {
      if (m.side && m.side !== curSideView) setSideView(m.side, true);
      if (typeof m.ai === "boolean" && window.VRCloudAI && window.VRCloudAI.setOpen) window.VRCloudAI.setOpen(m.ai, true);
      // Remote Desktop juga ikut terbuka/tertutup di browser lain (tiap browser tetap stream sendiri).
      if (typeof m.desk === "boolean") { if (m.desk && !desktopOpen()) openDesktop(true); else if (!m.desk && desktopOpen()) closeDesktop(true); }
    } finally { applyingView = false; }
  });

  // ===== Source Control (Git) =====
  const scmBody = $("#scm-body");
  let scmData = null, scmBusy = false, scmTimer = null, scmOpen = "";
  function scmBtn(label, title, fn) {
    const b = document.createElement("span"); b.className = "bt"; b.textContent = label; b.title = T(title || label);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function renderScmDiff(box, text) {
    box.innerHTML = "";
    String(text || "(tidak ada perbedaan)").split("\n").forEach((line) => {
      const l = document.createElement("div"); const c = line.charAt(0);
      l.className = "l";
      if (line.indexOf("+++") === 0 || line.indexOf("---") === 0) l.className = "l meta";
      else if (line.indexOf("@@") === 0) l.className = "l hunk";
      else if (c === "+") l.className = "l add";
      else if (c === "-") l.className = "l del";
      l.textContent = line || " ";
      box.appendChild(l);
    });
  }
  function scmAct(url, body) {
    if (scmBusy) return Promise.resolve();
    scmBusy = true;
    return api.post(url, body || {}).then((r) => { scmBusy = false; refreshScm(true); sbRefreshGit(true); return r; },
      (e) => { scmBusy = false; setStatus("Git: " + e.message); throw e; });
  }
  function refreshScm(force) {
    if (!scmBody) return;
    if (document.hidden && !force) return;
    if (!document.body.classList.contains("side-scm") && !force) return;
    api.get("/api/git/status?detail=1").then((g) => {
      scmData = g; paintScm();
    }).catch((e) => {
      scmBody.innerHTML = "";
      const d = document.createElement("div"); d.className = "scm-err"; d.textContent = e.message || "Gagal memuat Git";
      scmBody.appendChild(d);
    });
  }
  function paintScm() {
    if (!scmBody) return;
    const g = scmData || {};
    scmBody.innerHTML = "";
    if (!SERVER_SPEC_GIT() && g.error && !g.repo) {
      const e = document.createElement("div"); e.className = "scm-empty"; e.textContent = T("Git tidak ditemukan di server.");
      scmBody.appendChild(e); return;
    }
    if (!g.repo) {
      const e = document.createElement("div"); e.className = "scm-empty";
      e.appendChild(document.createTextNode(T("Folder kerja ini belum repositori Git.")));
      const b = document.createElement("button"); b.textContent = T("Inisialisasi repositori");
      b.addEventListener("click", () => scmAct("/api/git/init", {}));
      e.appendChild(document.createElement("br")); e.appendChild(b);
      scmBody.appendChild(e); return;
    }
    const br = document.createElement("div"); br.className = "scm-branch";
    const sel = document.createElement("select"); sel.title = T("Ganti branch");
    (g.branches || []).forEach((b) => {
      const o = document.createElement("option"); o.value = b.name; o.textContent = (b.current ? "● " : "") + b.name;
      if (b.current) o.selected = true; sel.appendChild(o);
    });
    if (!(g.branches || []).length) {
      const o = document.createElement("option"); o.textContent = g.branch || "(tanpa commit)"; o.selected = true; sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      const name = sel.value;
      if (!name || name === g.branch) return;
      if (!confirm(T("Pindah ke branch ") + name + "?")) { paintScm(); return; }
      scmAct("/api/git/checkout", { branch: name }).catch(() => paintScm());
    });
    const nb = document.createElement("span"); nb.className = "nb"; nb.textContent = "+"; nb.title = T("Branch baru");
    nb.addEventListener("click", () => {
      const name = prompt(T("Nama branch baru:"), "");
      if (!name) return;
      scmAct("/api/git/checkout", { branch: name, create: true });
    });
    br.appendChild(sel); br.appendChild(nb); scmBody.appendChild(br);

    const staged = (g.files || []).filter((f) => f.staged);
    const rest = (g.files || []).filter((f) => f.unstaged || f.untracked);
    const box = document.createElement("div"); box.className = "scm-commit";
    const ta = document.createElement("textarea"); ta.placeholder = T("Pesan commit"); ta.id = "scm-msg";
    try { ta.value = sessionStorage.getItem("vrcloud_scm_msg") || ""; } catch (e) {}
    ta.addEventListener("input", () => { try { sessionStorage.setItem("vrcloud_scm_msg", ta.value); } catch (e) {} });
    const row = document.createElement("div"); row.className = "row";
    const go = document.createElement("button"); go.textContent = T("Commit") + (staged.length ? " (" + staged.length + ")" : "");
    go.disabled = !staged.length;
    go.addEventListener("click", () => {
      const msg = ta.value.trim(); if (!msg) { setStatus("Git: pesan commit kosong"); return; }
      scmAct("/api/git/commit", { message: msg }).then(() => { ta.value = ""; try { sessionStorage.removeItem("vrcloud_scm_msg"); } catch (e) {} });
    });
    const hint = document.createElement("span"); hint.className = "hint";
    hint.textContent = g.ahead || g.behind
      ? (g.ahead ? "↑" + g.ahead : "") + (g.behind ? " ↓" + g.behind : "")
      : (staged.length ? T("Siap di-commit") : T("Stage file dulu"));
    row.appendChild(go); row.appendChild(hint);
    box.appendChild(ta); box.appendChild(row); scmBody.appendChild(box);

    function section(title, files, kind) {
      const hd = document.createElement("div"); hd.className = "scm-sec-hd";
      hd.appendChild(document.createTextNode(T(title)));
      const n = document.createElement("span"); n.className = "n"; n.textContent = String(files.length); hd.appendChild(n);
      const sp = document.createElement("span"); sp.className = "sp"; hd.appendChild(sp);
      if (kind === "staged" && files.length) hd.appendChild(scmBtn("Unstage all", "Unstage all", () => scmAct("/api/git/unstage", { all: true })));
      if (kind === "changes" && files.length) {
        hd.appendChild(scmBtn("Stage all", "Stage all", () => scmAct("/api/git/stage", { all: true })));
        hd.appendChild(scmBtn("Discard all", "Buang semua perubahan yang belum di-stage", () => {
          if (!confirm(T("Buang semua perubahan yang belum di-stage?"))) return;
          scmAct("/api/git/discard", { paths: files.map((f) => f.path) });
        }));
      }
      scmBody.appendChild(hd);
      if (!files.length) {
        const empty = document.createElement("div"); empty.className = "scm-empty"; empty.style.padding = "4px 12px 8px";
        empty.textContent = kind === "staged" ? T("Tidak ada yang di-stage") : T("Tidak ada perubahan");
        scmBody.appendChild(empty); return;
      }
      files.forEach((f) => {
        const row = document.createElement("div"); row.className = "scm-row" + (scmOpen === kind + ":" + f.path ? " open" : "");
        const sc = document.createElement("span"); sc.className = "sc " + (f.status || "M"); sc.textContent = f.untracked ? "U" : (f.status || "M");
        const p = document.createElement("span"); p.className = "pth"; p.textContent = f.path; p.title = (f.from ? f.from + " → " : "") + f.path;
        const acts = document.createElement("div"); acts.className = "acts";
        if (kind === "staged") acts.appendChild(scmBtn("−", "Unstage", () => scmAct("/api/git/unstage", { paths: [f.path] })));
        else {
          acts.appendChild(scmBtn("+", "Stage", () => scmAct("/api/git/stage", { paths: [f.path] })));
          acts.appendChild(scmBtn("↶", "Buang perubahan file ini", () => {
            if (!confirm(T("Buang perubahan pada ") + f.path + "?")) return;
            scmAct("/api/git/discard", { paths: [f.path] });
          }));
        }
        row.appendChild(sc); row.appendChild(p); row.appendChild(acts);
        const diff = document.createElement("div"); diff.className = "scm-diff" + (scmOpen === kind + ":" + f.path ? " open" : "");
        if (scmOpen === kind + ":" + f.path && !diff.getAttribute("data-loaded")) {
          diff.textContent = T("Memuat diff…");
          api.get("/api/git/diff?path=" + enc(f.path) + (kind === "staged" ? "&staged=1" : "")).then((r) => {
            renderScmDiff(diff, r.diff); diff.setAttribute("data-loaded", "1");
          }).catch((e) => { diff.textContent = e.message; });
        }
        row.addEventListener("click", () => {
          const key = kind + ":" + f.path;
          if (scmOpen === key) { scmOpen = ""; paintScm(); return; }
          scmOpen = key;
          if (f.status !== "D" && !f.untracked) openFile(f.path, basename(f.path));
          else if (f.untracked) openFile(f.path, basename(f.path));
          paintScm();
        });
        scmBody.appendChild(row); scmBody.appendChild(diff);
      });
    }
    section("Staged", staged, "staged");
    section("Changes", rest, "changes");

    if (g.log && g.log.length) {
      const lg = document.createElement("div"); lg.className = "scm-log";
      const hd = document.createElement("div"); hd.className = "hd"; hd.textContent = T("Commit terakhir"); lg.appendChild(hd);
      g.log.slice(0, 8).forEach((it) => {
        const row = document.createElement("div"); row.className = "it";
        const b = document.createElement("b"); b.textContent = it.hash; row.appendChild(b);
        row.appendChild(document.createTextNode((it.subject || "") + (it.when ? " · " + it.when : "")));
        row.title = (it.author || "") + " · " + (it.subject || "");
        lg.appendChild(row);
      });
      scmBody.appendChild(lg);
    }
  }
  function SERVER_SPEC_GIT() { return !!(INFO && INFO.spec && INFO.spec.git); }
  const scmRefreshBtn = $("#scm-refresh");
  if (scmRefreshBtn) scmRefreshBtn.addEventListener("click", () => refreshScm(true));
  function scheduleScm() { clearTimeout(scmTimer); scmTimer = setTimeout(() => refreshScm(false), 600); }

  // ============================================================
  //  VIEW STATE (gutter / wrap / font / dsb)
  // ============================================================
  const UIKEY = "c9clone.uistate";
  const ui = Object.assign(
    { openFiles: true, tabButtons: true, gutter: true, statusBar: true, minimap: true, wrap: false, wrapMargin: false, fontSize: 13 },
    (() => { try { return JSON.parse(localStorage.getItem(UIKEY) || "{}"); } catch (e) { return {}; } })()
  );
  function applyWrapToSession(s) {
    if (ui.wrapMargin) { s.setUseWrapMode(true); s.setWrapLimitRange(80, 80); }
    else { s.setUseWrapMode(!!ui.wrap); s.setWrapLimitRange(null, null); }
  }
  function applyUIState() {
    document.body.classList.toggle("hide-openfiles", !ui.openFiles);
    document.body.classList.toggle("hide-tabs", !ui.tabButtons);
    document.body.classList.toggle("hide-statusbar", !ui.statusBar);
    forEachEditor((ed) => { ed.renderer.setShowGutter(!!ui.gutter); ed.setShowPrintMargin(!!ui.wrapMargin); ed.setFontSize(ui.fontSize + "px"); });
    for (const p in FILES) applyWrapToSession(FILES[p].session);
    localStorage.setItem(UIKEY, JSON.stringify(ui));
    refreshMinimaps();
    setTimeout(() => { forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); refreshMinimaps(); }, 30);
  }
  function toggleUI(k) { ui[k] = !ui[k]; if (k === "wrapMargin" && ui.wrapMargin) ui.wrap = true; applyUIState(); }
  function setFont(n) { ui.fontSize = Math.min(30, Math.max(8, n)); Object.values(TERMS).forEach((t) => { try { t.term.setOption("fontSize", terminalFontSize()); } catch (e) {} }); applyUIState(); }
  function setSyntaxMode(m) { const t = activeFileTab(); if (!t) return; FILES[t.path].session.setMode("ace/mode/" + m); FILES[t.path].mode = m; sbRefreshFile(); }

  // ============================================================
  //  MENU BAR
  // ============================================================
  const openPrefs = () => {
    $("#prefs-modal").classList.add("open"); renderServerSpec();
    const ls = $("#pref-lang"); if (ls && window.I18N) ls.value = window.I18N.lang;
  };
  // Bahasa antarmuka (Indonesia / English): disimpan di browser, halaman dimuat ulang.
  (() => { const ls = $("#pref-lang"); if (!ls) return; if (window.I18N) ls.value = window.I18N.lang; ls.addEventListener("change", () => { if (window.I18N) window.I18N.setLang(ls.value); }); })();

  // ============================================================
  //  MONITOR CPU / RAM / GPU (menubar, dari /api/metrics)
  // ============================================================
  (function sysMetricsMonitor() {
    const box = $("#sys-metrics"); if (!box) return;
    const fmtGb = (n) => (Math.round(n * 10) / 10) + " GB";
    const level = (p) => (p >= 85 ? "hot" : p >= 60 ? "warn" : "ok");
    function metric(label, pct, title) {
      const m = document.createElement("span"); m.className = "m " + level(pct); m.title = title || "";
      const lb = document.createElement("span"); lb.className = "lb"; lb.textContent = label;
      const bar = document.createElement("span"); bar.className = "bar"; const fill = document.createElement("i"); fill.style.width = Math.max(0, Math.min(100, pct)) + "%"; bar.appendChild(fill);
      const pc = document.createElement("span"); pc.className = "pct"; pc.textContent = pct + "%";
      m.appendChild(lb); m.appendChild(bar); m.appendChild(pc);
      return m;
    }
    function render(d) {
      box.innerHTML = "";
      if (!d) return;
      const cpu = d.cpu || {}, mem = d.mem || {};
      box.appendChild(metric("CPU", cpu.percent || 0, (cpu.cores || "?") + " vCPU" + (cpu.load1 != null ? " · load " + cpu.load1 : "")));
      box.appendChild(metric("RAM", mem.percent || 0, fmtGb(mem.usedGb || 0) + " / " + fmtGb(mem.totalGb || 0)));
      (d.gpu || []).forEach((g, i) => {
        const vram = g.memTotalMb ? (g.memUsedMb != null ? Math.round(g.memUsedMb / 1024 * 10) / 10 + " / " : "") + Math.round(g.memTotalMb / 1024 * 10) / 10 + " GB VRAM" : "";
        box.appendChild(metric((d.gpu.length > 1 ? "GPU" + (i + 1) : "GPU"), g.utilPercent || 0, [g.name, vram, g.tempC != null ? g.tempC + " °C" : ""].filter(Boolean).join(" · ")));
      });
      box.title = T("Pemakaian server saat ini — klik untuk spesifikasi lengkap");
    }
    let timer = null, failures = 0;
    async function poll() {
      if (document.hidden) return;
      try { render(await api.get("/api/metrics")); failures = 0; }
      catch (e) { if (++failures > 3) render(null); }
    }
    function start() { if (timer) return; poll(); timer = setInterval(poll, 3000); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else start(); });
    box.addEventListener("click", openPrefs);
    start();
  })();
  // Spesifikasi server (OS, Node, terminal, git, agent) di Preferences — dari /api/info.
  // Logo OS (SVG inline, tanpa file eksternal) untuk kartu di Preferences → Server.
  // Badge OS di menubar: ikon monitor komputer dengan logo OS di layarnya (klik = Remote Desktop).
  const OS_SCREEN_BG = "#0d1219"; // warna layar monitor; dipakai juga untuk "celah" logo Ubuntu
  function osLogoSvg(s) {
    const p = osLogoParts(s);
    return '<svg viewBox="0 0 24 22" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="os-mon">'
      + '<rect x="0.75" y="0.75" width="22.5" height="15.5" rx="2" fill="' + OS_SCREEN_BG + '" stroke="currentColor" stroke-width="1.5"/>'
      + '<path d="M8.5 21h7M12 16.25V21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
      + '<svg x="4" y="2.25" width="16" height="12.5" viewBox="' + p.vb + '" preserveAspectRatio="xMidYMid meet">' + p.inner + '</svg>'
      + '</svg>';
  }
  // Logo OS mentah: { vb: viewBox, inner: markup } — dipakai di dalam layar monitor.
  function osLogoParts(s) {
    const os = String(s.os || "").toLowerCase(), plat = s.platform || "";
    const svg = (vb, inner) => ({ vb: vb, inner: inner });
    if (plat === "win32") {
      if (/windows 11/.test(os)) return svg("0 0 24 24", '<path fill="#0a84ff" d="M0 0h11.38v11.37H0zm12.62 0H24v11.37H12.62zM0 12.63h11.38V24H0zm12.62 0H24V24H12.62z"/>');
      return svg("0 0 24 24", '<path fill="#00adef" d="M0 3.45 9.75 2.1v9.45H0m10.95-9.6L24 0v11.4H10.95M0 12.6h9.75v9.45L0 20.7m10.95-8.1H24V24l-12.9-1.8"/>');
    }
    if (plat === "darwin") return svg("0 0 24 24", '<path fill="#e6e6e6" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>');
    if (plat === "linux") {
      if (/ubuntu/.test(os)) {
        // "Circle of friends": cincin oranye dengan tiga celah + tiga titik.
        const pts = [90, 210, 330].map((a) => { const r = a * Math.PI / 180; return [32 + 19 * Math.cos(r), 32 - 19 * Math.sin(r)]; });
        return svg("0 0 64 64", '<circle cx="32" cy="32" r="19" fill="none" stroke="#e95420" stroke-width="7"/>'
          + pts.map((p) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="8.5" fill="' + OS_SCREEN_BG + '"/>').join("")
          + pts.map((p) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="5.2" fill="#e95420"/>').join(""));
      }
      if (/arch/.test(os)) return svg("0 0 64 64", '<path fill="#1793d1" d="M32 4c-2.3 5.6-3.7 9.3-6.2 14.7 1.6 1.7 3.5 3.6 6.6 5.8-3.3-1.4-5.6-2.7-7.3-4.2C21.9 27.1 16.7 37.1 6 59c8.4-4.8 14.9-7.8 21-9-.3-1.1-.4-2.4-.4-3.7 0-5.7 2.5-10.2 5.5-10 3 .3 5.4 5.1 5.3 10.8 0 1.1-.1 2.1-.3 3 6 1.2 12.4 4.2 20.9 9C54.8 51 51.4 43.8 48 37.3c-2.3 1.9-4.7 3.4-7.9 4.7 3.8-2.7 5.9-5 7.3-6.7C41.9 24.7 38 16.9 32 4z"/>');
      if (/fedora/.test(os)) return svg("0 0 64 64", '<circle cx="32" cy="32" r="28" fill="#294172"/><path fill="#fff" d="M36.5 17.5c-4.6 0-8.3 3.7-8.3 8.3v5.4h-5.1a3 3 0 0 0 0 6h5.1v3.2c0 4.6-3.7 8.3-8.3 8.3-1.2 0-2.3-.2-3.3-.7v6.2c1.1.3 2.2.5 3.3.5 8 0 14.4-6.4 14.4-14.3v-3.2h4.5a3 3 0 0 0 0-6h-4.5v-5.4c0-1.3 1-2.3 2.3-2.3 1 0 1.7.2 2.5.6v-6.1a8.6 8.6 0 0 0-2.6-.5z"/>');
      if (/debian/.test(os)) return svg("0 0 64 64", '<path fill="none" stroke="#a80030" stroke-width="5" stroke-linecap="round" d="M44 22.5c-3-5-9-7.5-15-6-7 1.8-11.5 8.5-10 15.5 1.4 6.4 7.6 10.8 14 9.6 5.8-1.1 9.7-6.6 8.7-12.3-.9-5.2-5.8-8.7-11-7.8-4.6.8-7.7 5.1-6.9 9.7.7 4 4.5 6.7 8.5 6"/>');
      // Linux umum: Tux versi sederhana.
      return svg("0 0 64 64",
        '<ellipse cx="32" cy="39" rx="17" ry="21" fill="#151515"/><ellipse cx="32" cy="43" rx="11.5" ry="14" fill="#f2f2f2"/>'
        + '<circle cx="32" cy="17" r="11.5" fill="#151515"/><ellipse cx="32" cy="21.5" rx="7.5" ry="5.5" fill="#f2f2f2"/>'
        + '<circle cx="28" cy="15.5" r="2.3" fill="#fff"/><circle cx="36" cy="15.5" r="2.3" fill="#fff"/><circle cx="28.6" cy="15.8" r="1.1"/><circle cx="36.6" cy="15.8" r="1.1"/>'
        + '<path d="M27.5 20.5h9l-4.5 4.5z" fill="#f4a020"/>'
        + '<path d="M16 30q-7 9-2 20 3-7 5-13z" fill="#151515"/><path d="M48 30q7 9 2 20-3-7-5-13z" fill="#151515"/>'
        + '<ellipse cx="23.5" cy="59" rx="7" ry="3.3" fill="#f4a020"/><ellipse cx="40.5" cy="59" rx="7" ry="3.3" fill="#f4a020"/>');
    }
    // OS lain: ikon server generik.
    return svg("0 0 24 24", '<g fill="none" stroke="#9fb3c8" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/><path d="M7 6.5h.01M7 17.5h.01"/></g>');
  }
  function renderOsCard(s) {
    const card = $("#prefs-os"); if (!card) return;
    if (!s || !(s.os || s.platform)) { card.hidden = true; return; }
    card.innerHTML = osLogoSvg(s);
    const name = document.createElement("div"); name.className = "os-name";
    name.textContent = String(s.os || s.platform).replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const sub = document.createElement("div"); sub.className = "os-sub";
    const build = /\(([^)]*)\)/.exec(String(s.os || ""));
    sub.textContent = [s.arch, build ? build[1] : "", s.hostname].filter(Boolean).join(" \u00b7 ");
    card.appendChild(name); card.appendChild(sub); card.hidden = false;
  }
  function renderServerSpec() {
    const box = $("#prefs-spec"); if (!box) return;
    api.get("/api/info").then((info) => {
      const s = info.spec || {};
      renderOsCard(s);
      box.innerHTML = "";
      const row = (k, v, ok) => {
        const r = document.createElement("div"); r.className = "row";
        const kk = document.createElement("span"); kk.className = "k"; kk.textContent = k;
        const vv = document.createElement("span"); vv.className = "v" + (ok === true ? " ok" : ok === false ? " bad" : "");
        vv.textContent = (ok === true ? "\u2713 " : ok === false ? "\u2717 " : "") + v;
        r.appendChild(kk); r.appendChild(vv); box.appendChild(r);
      };
      // Nama OS/arsitektur/host sudah ada di kartu OS (kiri): tidak diulang di tabel.
      row("Node.js", (s.node || "?") + (s.nodeOk ? "" : " (minimum " + s.nodeMin + ")"), !!s.nodeOk);
      row("Terminal", s.terminals === "tmux" ? "tmux \u2014 persisten melewati restart" : s.terminals === "conpty" ? "ConPTY \u2014 restart bersama server" : "PTY langsung \u2014 tidak persisten (tmux tidak ada)", s.terminals === "tmux" ? true : undefined);
      row("Shell", s.shell || "-");
      row("Arsip ZIP/TAR", s.archives ? "tersedia" : "tidak tersedia", !!s.archives);
      row("Pencarian", s.rg ? "ripgrep" : "bawaan Node (rg tidak ada)");
      row("git / checkpoint AI", s.git ? (s.checkpoints ? "tersedia" : "git ada, checkpoint nonaktif") : "git tidak ditemukan", !!(s.git && s.checkpoints));
      row("Agent AI", s.aiEnabled ? "aktif" + (s.shellGuard ? " \u00b7 pengaman perintah aktif" : "") : "nonaktif (API key belum diisi)", !!s.aiEnabled);
      const br = s.browser || {};
      row("Browser agent", br.available ? ((br.exe || "").split(/[\\/]/).pop() + (br.version ? " " + br.version : "") + " \u00b7 CDP headless" + (br.downloaded ? " \u00b7 Chrome for Testing" : "") + (br.running ? " \u00b7 berjalan" : "") + (br.tabs && br.tabs.length ? " \u00b7 " + br.tabs.length + " tab" : ""))
        : "tidak ditemukan \u2014 pasang Chrome/Edge/Chromium, set VRCLOUD_BROWSER, atau unduh di bawah", !!br.available);
      // Fallback: unduh Chrome for Testing resmi ke data/browser (progres via hub).
      const inst = br.install || {};
      if (!br.available || !br.downloaded || (inst.stage && inst.stage !== "done")) {
        const r = document.createElement("div"); r.className = "row"; r.id = "prefs-browser-install";
        const kk = document.createElement("span"); kk.className = "k"; kk.textContent = "";
        const vv = document.createElement("span"); vv.className = "v";
        const b = document.createElement("button"); b.className = "btn small"; b.textContent = br.available ? "Unduh Chrome for Testing (cadangan)" : "Unduh Chromium (Chrome for Testing)";
        const st = document.createElement("span"); st.className = "install-status";
        b.onclick = () => { b.disabled = true; st.textContent = "Menyiapkan\u2026"; api.post("/api/ai/browser/install", {}).catch((e) => { st.textContent = "Gagal: " + e.message; b.disabled = false; }); };
        vv.appendChild(b); vv.appendChild(st); r.appendChild(kk); r.appendChild(vv); box.appendChild(r);
        if (inst.stage && inst.stage !== "done") renderBrowserInstall(inst);
      }
      if (s.cpus) row("Perangkat", s.cpus + " vCPU \u00b7 " + s.memoryGb + " GB RAM");
      const gpus = (s.gpu && s.gpu.devices) || [];
      if (gpus.length) gpus.forEach((g, i) => row(gpus.length > 1 ? "GPU " + (i + 1) : "GPU",
        g.name + (g.memoryMb ? " \u00b7 " + (Math.round(g.memoryMb / 1024 * 10) / 10) + " GB VRAM" : "") + (g.driver ? " \u00b7 driver " + g.driver : "")
        + (s.gpu.mode === "nvidia" ? "" : s.gpu.mode === "amd-sysfs" ? " (AMD sysfs)" : s.gpu.mode === "win-counter" ? " (utilisasi via Performance Counter)" : " (tanpa monitor utilisasi)")));
      else row("GPU", "tidak terdeteksi");
      row("Workspace", info.workspace || "-");
      if (info.version) row(T("Versi:").replace(/:$/, ""), (info.product || "VRCloud IDE") + " " + fmtVersion(info.version));
    }).catch(() => { box.textContent = "Gagal memuat info server."; });
  }
  function renderBrowserInstall(p) {
    const r = document.getElementById("prefs-browser-install"); if (!r || !p) return;
    const st = r.querySelector(".install-status"), b = r.querySelector("button");
    const label = p.stage === "metadata" ? "Mencari versi stabil\u2026" : p.stage === "download" ? "Mengunduh " + (p.version || "") + " " + (p.percent != null ? p.percent + "%" : "") : p.stage === "extract" ? "Mengekstrak\u2026" : p.stage === "done" ? "Selesai: Chrome for Testing " + (p.version || "") : p.stage === "error" ? "Gagal: " + (p.error || "") : "";
    if (st) st.textContent = label;
    if (b) b.disabled = !(p.stage === "error" || p.stage === "done");
    if (p.stage === "done") setTimeout(renderServerSpec, 1500);
  }
  sync.on("browser-install", (m) => renderBrowserInstall(m));
  const MODES = ["text", "javascript", "typescript", "python", "html", "css", "json", "markdown", "sh", "yaml", "xml", "sql", "php", "java", "c_cpp", "golang", "ruby"];
  const MENUS = {
    file: () => [
      { label: "New File", act: () => newEntry(false, curDir()) },
      { label: "New Folder", act: () => newEntry(true, curDir()) },
      { sep: 1 },
      { label: "Save", key: "Ctrl-S", act: saveActive },
      { label: "Save All", act: saveAll },
      { sep: 1 },
      { label: "Upload Local Files…", act: () => $("#file-input").click() },
      { label: "Download Project", act: () => download({ path: "", name: "project" }) },
      { sep: 1 },
      { label: "Close Tab", act: () => activeLeaf && activeLeaf.active && closeTab(activeLeaf, activeLeaf.active) },
      { label: "Close All Tabs", act: closeAllTabs },
    ],
    edit: () => [
      { label: "Undo", key: "Ctrl-Z", act: () => activeEditor() && activeEditor().undo() },
      { label: "Redo", key: "Ctrl-Y", act: () => activeEditor() && activeEditor().redo() },
      { sep: 1 },
      { label: "Select All", key: "Ctrl-A", act: () => { const e = activeEditor(); if (e) { e.focus(); e.selectAll(); } } },
      { label: "To Upper Case", act: () => activeEditor() && activeEditor().execCommand("touppercase") },
      { label: "To Lower Case", act: () => activeEditor() && activeEditor().execCommand("tolowercase") },
    ],
    find: () => [
      { label: "Find…", key: "Ctrl-F", act: () => { const e = activeEditor(); if (e) { e.focus(); e.execCommand("find"); } } },
      { label: "Replace…", key: "Ctrl-H", act: () => { const e = activeEditor(); if (e) { e.focus(); e.execCommand("replace"); } } },
      { sep: 1 },
      { label: "Find in Files…", key: "Ctrl-Shift-F", act: () => openSearch("") },
    ],
    // View = tampilan editor; Window = pane/terminal; Tools = alat & preferensi.
    // Tiap aksi hanya ada di satu menu.
    view: () => [
      { label: "Open Files", check: ui.openFiles, act: () => toggleUI("openFiles") },
      { label: "Tab Buttons", check: ui.tabButtons, act: () => toggleUI("tabButtons") },
      { label: "Gutter", check: ui.gutter, act: () => toggleUI("gutter") },
      { label: "Minimap", check: ui.minimap, act: () => toggleUI("minimap") },
      { label: "Status Bar", check: ui.statusBar, act: () => toggleUI("statusBar") },
      { sep: 1 },
      { label: "Font Size", sub: [
        { label: "Increase Font Size", act: () => setFont(ui.fontSize + 1) },
        { label: "Decrease Font Size", act: () => setFont(ui.fontSize - 1) },
        { label: "Reset Font Size", act: () => setFont(13) },
      ] },
      { label: "Syntax", sub: MODES.map((m) => ({ label: MODE_LABELS[m] || m, check: (activeFileTab() ? FILES[activeFileTab().path].mode : "") === m, act: () => setSyntaxMode(m) })) },
      { sep: 1 },
      { label: "Wrap Lines", check: ui.wrap, act: () => toggleUI("wrap") },
      { label: "Wrap To Print Margin", check: ui.wrapMargin, act: () => toggleUI("wrapMargin") },
      { sep: 1 },
      { label: "Source Control", key: "Ctrl-Shift-G", act: () => setSideView("scm") },
    ],
    goto: () => [
      { label: "Go To Line…", key: "Ctrl-G", act: goToLineDlg },
      { label: "Go To File…", key: "Ctrl-P", act: () => openPalette("files") },
      { label: "Go To File (path)…", act: goToFileDlg },
    ],
    run: () => [
      { label: "Run", act: runActive },
      { label: "Run File Terpilih (tree)", act: () => selNode && !selNode.dir && runFile(selNode.path) },
      { sep: true },
      { label: "Runner Tersedia\u2026", act: showRunnersDlg },
      { label: "Deteksi Ulang Runner", act: () => loadRunners(true).then(() => { setStatus("Runner terdeteksi ulang: " + Object.keys((RUNNERS && RUNNERS.runners) || {}).length + " ekstensi"); }) },
    ],
    tools: () => [
      { label: "Command Palette…", key: "Ctrl-Shift-P", act: () => openPalette("commands") },
      { label: "Preferences…", act: openPrefs },
      { sep: true },
      { label: "Cek Update VRCloud", act: () => checkUpdate(true).then((s) => setStatus(!s ? "Cek update gagal" : !s.isGit ? "Bukan instalasi Git \u2014 update otomatis tidak tersedia" : s.updateAvailable ? "Update tersedia: " + s.local.short + " \u2192 " + s.remote.short : (s.remote.error ? "Cek remote gagal: " + s.remote.error : "Sudah versi terbaru (" + s.local.short + ")"))) },
      { label: "Update VRCloud…", act: runUpdate },
    ],
    window: () => [
      { label: "New Terminal", key: "F6", act: () => addTerminal() },
      { label: "New Terminal Here", key: "Alt-L", act: () => addTerminal(null, curDir()) },
      { sep: 1 },
      { label: "Split", sub: [
        { label: "Split Active Pane to 4", act: splitActiveToFour },
        { sep: 1 },
        { label: "Terminal → Right", act: () => splitActiveWithTerminal("right") },
        { label: "Terminal → Left", act: () => splitActiveWithTerminal("left") },
        { label: "Terminal → Down", act: () => splitActiveWithTerminal("bottom") },
        { label: "Terminal → Up", act: () => splitActiveWithTerminal("top") },
      ] },
    ],
  };
  const pop = $("#menu-pop");
  let openMenuName = null;
  function closeMenus() {
    pop.classList.remove("open"); pop.innerHTML = "";
    document.querySelectorAll("#menubar .menu.open").forEach((m) => m.classList.remove("open"));
    openMenuName = null;
    Mobile.closeMenus();
  }
  function buildItems(container, items, topLevel) {
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement("div"); s.className = "sep"; container.appendChild(s); return; }
      const d = document.createElement("div"); d.className = "mi";
      d.innerHTML = (it.check ? '<span class="chk">&#10004;</span>' : "") + '<span class="lbl"></span>' + (it.sub ? '<span class="arrow">&#9654;</span>' : it.key ? '<span class="key">' + it.key + "</span>" : "");
      d.querySelector(".lbl").textContent = it.label;
      if (it.sub) {
        const subEl = document.createElement("div"); subEl.className = "submenu"; buildItems(subEl, it.sub, false); pop.appendChild(subEl);
        const placeSub = () => {
          pop.querySelectorAll(".submenu.open").forEach((x) => { if (x !== subEl) x.classList.remove("open"); });
          subEl.classList.add("open");
          if (isNarrowView()) return;
          const r = d.getBoundingClientRect();
          subEl.style.left = Math.min(r.right, innerWidth - subEl.offsetWidth - 6) + "px";
          subEl.style.top = Math.min(r.top - 4, innerHeight - subEl.offsetHeight - 6) + "px";
        };
        d.addEventListener("mouseenter", placeSub);
        d.addEventListener("click", (e) => { e.stopPropagation(); if (subEl.classList.contains("open") && isNarrowView()) subEl.classList.remove("open"); else placeSub(); });
      } else {
        if (topLevel) d.addEventListener("mouseenter", () => pop.querySelectorAll(".submenu.open").forEach((x) => x.classList.remove("open")));
        d.addEventListener("click", () => { closeMenus(); if (it.act) it.act(); });
      }
      container.appendChild(d);
    });
  }
  function showMenu(btn) {
    closeMenus();
    buildItems(pop, (MENUS[btn.dataset.menu] || (() => []))(), true);
    pop.classList.add("open");
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 6) + "px"; pop.style.top = r.bottom + "px";
    btn.classList.add("open"); openMenuName = btn.dataset.menu;
  }
  document.querySelectorAll("#menubar .menu").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); if (openMenuName === b.dataset.menu) closeMenus(); else showMenu(b); });
    b.addEventListener("mouseenter", () => { if (openMenuName && openMenuName !== b.dataset.menu) showMenu(b); });
  });
  window.addEventListener("click", (e) => {
    if (!e.target.closest("#menu-pop") && !e.target.closest("#menubar .menu") && !e.target.closest("#mb-more")) closeMenus();
  });
  document.querySelector(".mb-run").addEventListener("click", runActive);

  // ============================================================
  //  COMMAND PALETTE (Ctrl+Shift+P) & FUZZY FILE FINDER (Ctrl+P)
  // ============================================================
  const MENU_TITLE = { file: "File", edit: "Edit", find: "Find", view: "View", goto: "Goto", run: "Run", tools: "Tools", window: "Window" };
  // Skor fuzzy: subsequence; bonus untuk karakter berurutan & awal kata; string pendek diutamakan.
  function fuzzyScore(q, s) {
    q = String(q || "").toLowerCase(); s = String(s || "").toLowerCase();
    if (!q) return 1;
    let qi = 0, score = 0, prev = -2;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] !== q[qi]) continue;
      score += (i === prev + 1 ? 3 : 1) + (i === 0 || /[\s/._:\-]/.test(s[i - 1]) ? 2 : 0);
      prev = i; qi++;
    }
    return qi === q.length ? score + Math.max(0, 20 - s.length / 8) : -1;
  }
  function paletteCommands() {
    const out = [];
    const walk = (cat, items) => (items || []).forEach((it) => {
      if (!it || it.sep) return;
      if (it.sub) { walk(cat + " \u203a " + it.label, it.sub); return; }
      if (it.act) out.push({ label: cat + ": " + it.label, key: it.key || "", act: it.act, check: it.check });
    });
    Object.keys(MENUS).forEach((k) => { try { walk(MENU_TITLE[k] || k, MENUS[k]()); } catch (e) {} });
    out.push({ label: "AI: Buka panel Agent", key: "Alt-A", act: () => window.VRCloudAI && window.VRCloudAI.open() });
    out.push({ label: "AI: Tab Browser agent", act: () => window.VRCloud.showBrowserAgent(false) });
    return out;
  }
  let PAL = null;
  function ensurePalette() {
    if (PAL) return PAL;
    const root = document.createElement("div"); root.id = "palette";
    root.innerHTML = '<div class="pal-box"><input class="pal-input" spellcheck="false" autocomplete="off"><div class="pal-list"></div><div class="pal-hint"></div></div>';
    document.body.appendChild(root);
    const p = PAL = { root, input: root.querySelector(".pal-input"), list: root.querySelector(".pal-list"), hint: root.querySelector(".pal-hint"), mode: "files", items: [], sel: 0, timer: null, seq: 0 };
    root.addEventListener("mousedown", (e) => { if (e.target === root) closePalette(); });
    p.input.addEventListener("input", () => onPaletteInput());
    p.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closePalette(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
      else if (e.key === "Enter") { e.preventDefault(); runPaletteItem(p.items[p.sel]); }
      e.stopPropagation();
    });
    return p;
  }
  function openPalette(mode, initial) {
    const p = ensurePalette(); closeMenus();
    p.mode = mode === "commands" ? "commands" : "files";
    p.input.value = p.mode === "commands" ? ">" + (initial || "") : (initial || "");
    p.input.placeholder = p.mode === "commands" ? "Ketik perintah\u2026" : "Ketik nama file\u2026 (awali > untuk perintah)";
    root_show(p); onPaletteInput(); p.input.focus();
    if (p.mode === "commands") p.input.setSelectionRange(p.input.value.length, p.input.value.length);
  }
  function root_show(p) { p.root.classList.add("open"); }
  function closePalette() { if (!PAL) return; PAL.root.classList.remove("open"); PAL.items = []; PAL.list.innerHTML = ""; clearTimeout(PAL.timer); const ed = activeEditor(); if (ed) setTimeout(() => ed.focus(), 0); }
  function movePalette(d) { const p = PAL; if (!p || !p.items.length) return; p.sel = (p.sel + d + p.items.length) % p.items.length; paintPaletteSel(); }
  function paintPaletteSel() {
    const p = PAL; const rows = p.list.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("sel", i === p.sel);
    const cur = rows[p.sel]; if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function onPaletteInput() {
    const p = PAL; if (!p) return;
    let q = p.input.value;
    const cmdMode = q.startsWith(">");
    p.mode = cmdMode ? "commands" : "files";
    p.hint.textContent = T(cmdMode ? "\u2191\u2193 pilih \u00b7 Enter jalankan \u00b7 Esc tutup" : "\u2191\u2193 pilih \u00b7 Enter buka \u00b7 Esc tutup \u00b7 awali > untuk perintah");
    if (cmdMode) {
      q = q.slice(1).trim();
      const items = paletteCommands().map((c) => ({ c, s: fuzzyScore(q, c.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40)
        .map((x) => ({ kind: "cmd", label: x.c.label, key: x.c.key, check: x.c.check, act: x.c.act }));
      renderPalette(items);
      return;
    }
    clearTimeout(p.timer);
    const seq = ++p.seq;
    p.timer = setTimeout(() => {
      api.get("/api/files?q=" + enc(q.trim()) + "&limit=40").then((r) => {
        if (seq !== p.seq) return; // hasil basi
        const files = (r && r.files) || [];
        // Buka tab yang sudah terbuka lebih dulu bila cocok.
        const open = new Set(); walkLeaves(layout, (l) => l.tabs.forEach((t) => { if (t.kind === "file") open.add(t.path); }));
        const items = files.map((f) => ({ kind: "file", path: f, label: basename(f), dir: f.indexOf("/") >= 0 ? f.slice(0, f.lastIndexOf("/")) : "", isOpen: open.has(f) }));
        items.sort((a, b) => (b.isOpen ? 1 : 0) - (a.isOpen ? 1 : 0));
        renderPalette(items);
      }).catch(() => renderPalette([]));
    }, 90);
  }
  function renderPalette(items) {
    const p = PAL; p.items = items; p.sel = 0; p.list.innerHTML = "";
    if (!items.length) { const e = document.createElement("div"); e.className = "pal-empty"; e.textContent = T("Tidak ada yang cocok"); p.list.appendChild(e); return; }
    items.forEach((it, i) => {
      const row = document.createElement("div"); row.className = "pal-row" + (i === 0 ? " sel" : "");
      if (it.kind === "file") {
        row.innerHTML = '<span class="ic">' + fileIcon(it.label) + '</span><span class="nm"></span><span class="dir"></span>' + (it.isOpen ? '<span class="tag">' + T("terbuka") + "</span>" : "");
        row.querySelector(".nm").textContent = it.label; row.querySelector(".dir").textContent = it.dir;
        row.title = it.path;
      } else {
        row.innerHTML = '<span class="ic">' + (it.check ? "&#10004;" : "&#9656;") + '</span><span class="nm"></span>' + (it.key ? '<span class="key"></span>' : "");
        row.querySelector(".nm").textContent = it.label; if (it.key) row.querySelector(".key").textContent = it.key;
      }
      row.addEventListener("mouseenter", () => { p.sel = i; paintPaletteSel(); });
      row.addEventListener("click", () => runPaletteItem(it));
      p.list.appendChild(row);
    });
  }
  function fileIcon(name) { return fileIconSvg(name, false); }
  function runPaletteItem(it) {
    if (!it) return;
    closePalette();
    if (it.kind === "file") openFile(it.path, it.label);
    else if (it.act) { try { it.act(); } catch (e) { setStatus("Gagal: " + e.message); } }
  }
  // Tangkap di fase capture supaya menang atas Ace (Ctrl-P = jump to matching) dan terminal.
  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (!(e.ctrlKey || e.metaKey) || e.altKey || k !== "p") return;
    e.preventDefault(); e.stopPropagation();
    openPalette(e.shiftKey ? "commands" : "files");
  }, true);

  // ============================================================
  //  PREFERENCES
  // ============================================================
  // Tema dikunci (UI_THEME / SYNTAX_THEME); nilai lama di localStorage diabaikan.
  function applyUITheme(name) {
    document.body.dataset.uiTheme = name;
    const th = currentTermTheme(); Object.values(TERMS).forEach((t) => { try { t.term.setOption("theme", th); } catch (e) {} });
    setTimeout(() => { forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); }, 20);
  }
  $("#gear").addEventListener("click", openPrefs);
  $("#prefs-close").addEventListener("click", () => $("#prefs-modal").classList.remove("open"));
  $("#prefs-modal").addEventListener("click", (e) => { if (e.target.id === "prefs-modal") e.currentTarget.classList.remove("open"); });

  // ============================================================
  //  REALTIME SESSION
  // ============================================================
  applyUITheme(UI_THEME);
  const AceRange = ace.require("ace/range").Range;

  // Badge menubar: nama OS server + titik status realtime (warna). Teks
  // "Realtime" diganti nama OS; status koneksi tetap terlihat lewat titik & tooltip.
  let syncState = "offline";
  function osShortName() {
    const o = String((INFO.spec && INFO.spec.os) || "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    return o.length > 28 ? o.slice(0, 27) + "\u2026" : o;
  }
  function updateSyncStatus(value) {
    if (value) syncState = value;
    const el = $("#sync-status"); if (!el) return;
    el.className = "sync-status sb-btn " + syncState; // sb-btn: tetap tampak bisa diklik (pointer + hover)
    const os = osShortName();
    const state = syncState === "online" ? T("tersambung") : syncState === "connecting" ? T("menyambung\u2026") : "offline";
    // Logo OS (bukan titik) + nama OS; titik warna hanya muncul saat belum tersambung.
    const ico = el.querySelector(".os-ico"); if (ico) ico.innerHTML = INFO.spec && (INFO.spec.os || INFO.spec.platform) ? osLogoSvg(INFO.spec) : "";
    const txt = el.querySelector(".txt");
    if (txt) txt.textContent = os ? (syncState === "online" ? os : os + " \u00b7 " + state) : (syncState === "online" ? "Realtime" : state);
    let dot = el.querySelector(".dot");
    if (syncState !== "online") { if (!dot) { dot = document.createElement("i"); dot.className = "dot"; el.appendChild(dot); } }
    else if (dot) dot.remove();
    el.title = "Server: " + ((INFO.spec && INFO.spec.os) || "?") + (INFO.spec && INFO.spec.arch ? " \u00b7 " + INFO.spec.arch : "") + (INFO.spec && INFO.spec.hostname ? " \u00b7 " + INFO.spec.hostname : "")
      + "\nRealtime: " + state + "\n" + T("Klik untuk Remote Desktop");
  }
  $("#sync-status").addEventListener("click", () => openDesktop());

  // ============================================================
  //  REMOTE DESKTOP (mirip VNC): tampilkan & kendalikan desktop server dari IDE.
  //  Frame biner dari /desktop: header 12 byte (sw,sh,fw,fh uint16 + ms uint32) lalu JPEG.
  // ============================================================
  let DESK = null;
  function openDesktop(remote) {
    if (DESK && DESK.f.isOpen()) { DESK.f.front(); if (!remote) queueViewSync(); return; }
    if (!DESK) DESK = buildDesktop();
    DESK.f.open(); DESK.start();
    if (!remote) queueViewSync();
  }
  function closeDesktop(remote) {
    if (DESK && DESK.f.isOpen()) { DESK.stop(); DESK.f.hide(); }
    if (!remote) queueViewSync();
  }
  function desktopOpen() { return !!(DESK && DESK.f.isOpen()); }
  function buildDesktop() {
    const f = createFloat({ id: "desktop", title: "\u{1F5A5} Remote Desktop", w: 900, h: 560, bodyClass: "deskbody", hideOnClose: true, onResize: () => fit(), onClose: () => { stop(); queueViewSync(); } });
    const body = f.body;
    body.innerHTML = '<div class="desk-bar">'
      + '<button type="button" class="db ctl" title="Kendali mouse/keyboard">\u{1F5B1} Kendali: <b>mati</b></button>'
      + '<span class="db-sp"></span>'
      + '<label class="db-q">Kualitas <select class="desk-q"><option value="35">Rendah</option><option value="55" selected>Sedang</option><option value="80">Tinggi</option></select></label>'
      + '<button type="button" class="db cad" title="Kirim Ctrl+Alt+Del">Ctrl+Alt+Del</button>'
      + '<button type="button" class="db ki" title="Papan ketik: fokus di sini lalu ketik">\u2328</button>'
      + '<span class="desk-fps"></span></div>'
      + '<div class="desk-stage"><img class="desk-img" alt="desktop" draggable="false"><div class="desk-msg"></div><textarea class="desk-kb" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></div>';
    const img = body.querySelector(".desk-img"), stage = body.querySelector(".desk-stage"), msg = body.querySelector(".desk-msg");
    const ctlBtn = body.querySelector(".ctl"), fpsEl = body.querySelector(".desk-fps"), qSel = body.querySelector(".desk-q"), kb = body.querySelector(".desk-kb");
    let ws = null, control = false, url = null, lastFrame = 0, frames = 0, fpsTimer = null, screen = { w: 0, h: 0 }, status = null;
    function setMsg(t) { msg.textContent = t || ""; msg.style.display = t ? "" : "none"; }
    function setControl(on) {
      control = on && !!(status && status.ok) && !(status && status.inputBlocked);
      ctlBtn.querySelector("b").textContent = control ? "aktif" : "mati";
      ctlBtn.classList.toggle("on", control);
      stage.classList.toggle("controlling", control);
      if (control) kb.focus();
    }
    function fit() {
      // Gambar menyesuaikan area, mempertahankan rasio; koordinat input dihitung dari rect gambar.
      const bw = stage.clientWidth, bh = stage.clientHeight;
      if (!screen.w || !bw) return;
      const r = Math.min(bw / screen.w, bh / screen.h);
      img.style.width = Math.round(screen.w * r) + "px"; img.style.height = Math.round(screen.h * r) + "px";
    }
    function frac(e) {
      const r = img.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    }
    function send(o) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) {} } }
    const btnMap = (b) => (b === 1 ? 1 : b === 2 ? 2 : 0);
    img.addEventListener("mousedown", (e) => { if (!control) return; e.preventDefault(); const p = frac(e); send({ t: "input", ev: { t: "down", b: btnMap(e.button), x: p.x, y: p.y } }); kb.focus(); });
    window.addEventListener("mouseup", (e) => { if (!control) return; const p = frac(e); send({ t: "input", ev: { t: "up", b: btnMap(e.button), x: p.x, y: p.y } }); });
    img.addEventListener("mousemove", (e) => { if (!control) return; const p = frac(e); send({ t: "input", ev: { t: "move", x: p.x, y: p.y } }); });
    img.addEventListener("contextmenu", (e) => e.preventDefault());
    img.addEventListener("wheel", (e) => { if (!control) return; e.preventDefault(); send({ t: "input", ev: { t: "wheel", dy: e.deltaY, h: e.shiftKey } }); }, { passive: false });
    img.addEventListener("dblclick", (e) => { if (!control) return; const p = frac(e); send({ t: "input", ev: { t: "down", b: 0, x: p.x, y: p.y } }); send({ t: "input", ev: { t: "up", b: 0, x: p.x, y: p.y } }); });
    // Papan ketik: textarea tak terlihat menangkap tombol; kirim key down/up + teks yang diketik.
    const stopKeys = { Tab: 1, " ": 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Backspace: 1, Enter: 1 };
    kb.addEventListener("keydown", (e) => { if (!control) return; if (stopKeys[e.key] || e.ctrlKey || e.altKey || e.metaKey) e.preventDefault(); send({ t: "input", ev: { t: "key", code: e.code, down: true } }); });
    kb.addEventListener("keyup", (e) => { if (!control) return; send({ t: "input", ev: { t: "key", code: e.code, down: false } }); });
    kb.addEventListener("input", (e) => { if (!control) return; if (e.data) send({ t: "input", ev: { t: "text", text: e.data } }); kb.value = ""; });
    ctlBtn.addEventListener("click", () => { if (status && status.inputBlocked) { setMsg((status && status.note) || "Kendali diblokir."); return; } setControl(!control); });
    body.querySelector(".cad").addEventListener("click", () => send({ t: "combo", keys: ["ControlLeft", "AltLeft", "Delete"] }));
    body.querySelector(".ki").addEventListener("click", () => { setControl(true); kb.focus(); });
    qSel.addEventListener("change", () => send({ t: "opts", q: +qSel.value }));
    function start() {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      setMsg("Menghubungkan ke desktop server\u2026");
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      ws = new WebSocket(proto + location.host + "/desktop");
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { send({ t: "start", maxW: 1280, q: +qSel.value }); };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.t === "status") { status = m.status; applyStatus(); }
          else if (m.t === "hello") { screen = m.screen || screen; }
          else if (m.t === "error") { setMsg("Kesalahan: " + m.message); }
          else if (m.t === "note") { setMsg(m.message || ""); } // mis. sesi desktop virtual sedang dijalankan
          return;
        }
        const dv = new DataView(ev.data);
        screen = { w: dv.getUint16(0, true), h: dv.getUint16(2, true) };
        const blob = new Blob([ev.data.slice(12)], { type: "image/jpeg" });
        const u = URL.createObjectURL(blob);
        const prev = url; url = u;
        img.onload = () => { if (prev) URL.revokeObjectURL(prev); fit(); };
        img.src = u;
        setMsg(""); frames++; lastFrame = Date.now();
      };
      ws.onclose = () => { ws = null; if (DESK && DESK.f.isOpen()) setMsg("Koneksi desktop terputus."); };
      ws.onerror = () => {};
      clearInterval(fpsTimer);
      fpsTimer = setInterval(() => { fpsEl.textContent = frames ? frames + " fps" : ""; frames = 0; if (lastFrame && Date.now() - lastFrame > 5000 && ws && ws.readyState === 1) setMsg("Menunggu frame\u2026"); }, 1000);
      refreshStatus();
    }
    function stop() { if (ws) { try { send({ t: "stop" }); ws.close(); } catch (e) {} ws = null; } clearInterval(fpsTimer); if (url) { URL.revokeObjectURL(url); url = null; } }
    function refreshStatus() { api.get("/api/desktop/status").then((s) => { status = s; applyStatus(); }).catch(() => {}); }
    function applyStatus() {
      if (!status) return;
      if (!status.ok) {
        setMsg((status.reason || "Remote desktop tidak tersedia.") + (status.canSetup ? "" : ""));
        if (status.canSetup) offerSetup();
        setControl(false);
      } else {
        if (status.inputBlocked) { setMsg(status.note || "Kendali diblokir antivirus."); setTimeout(() => { if (frames) setMsg(""); }, 4000); }
        ctlBtn.disabled = !!status.inputBlocked;
        ctlBtn.title = status.inputBlocked ? (status.note || "Kendali diblokir") : "Kendali mouse/keyboard";
      }
    }
    function offerSetup() {
      if (body.querySelector(".desk-setup")) return;
      const d = document.createElement("div"); d.className = "desk-setup";
      d.innerHTML = '<div class="ds-t">Server ini belum punya desktop.</div><div class="ds-b">Pasang desktop virtual (Xvfb + XFCE) agar bisa dikontrol dari sini.</div><button type="button" class="ds-go">Pasang desktop virtual</button><pre class="ds-log" hidden></pre>';
      const go = d.querySelector(".ds-go"), logEl = d.querySelector(".ds-log");
      go.addEventListener("click", () => {
        go.disabled = true; go.textContent = "Memasang\u2026"; logEl.hidden = false;
        api.post("/api/desktop/setup", {}).catch(() => {});
        const poll = setInterval(() => {
          api.get("/api/desktop/setup").then((s) => {
            logEl.textContent = (s.log || []).slice(-14).join("\n"); logEl.scrollTop = logEl.scrollHeight;
            if (!s.running) { clearInterval(poll); go.textContent = s.ok ? "Selesai \u2014 menyambung\u2026" : "Gagal, coba lagi"; go.disabled = !s.ok; if (s.ok) { d.remove(); stop(); setTimeout(start, 800); } }
          }).catch(() => {});
        }, 1200);
      });
      stage.appendChild(d);
    }
    const api2 = { f, start, stop };
    return api2;
  }

  function applyRemoteCursor(cursor) {
    const old = REMOTE_CURSORS[cursor.clientId];
    if (old && FILES[old.path]) {
      try { FILES[old.path].session.removeMarker(old.marker); } catch (e) {}
    }
    if (!cursor.path || !FILES[cursor.path]) return;
    const row = Math.max(0, Number(cursor.row) || 0);
    const column = Math.max(0, Number(cursor.column) || 0);
    const marker = FILES[cursor.path].session.addMarker(
      new AceRange(row, column, row, column + 1),
      "remote-cursor",
      "text",
      false
    );
    REMOTE_CURSORS[cursor.clientId] = { path: cursor.path, marker };
  }

  function removeRemoteCursor(clientId) {
    const old = REMOTE_CURSORS[clientId]; if (!old) return;
    if (FILES[old.path]) {
      try { FILES[old.path].session.removeMarker(old.marker); } catch (e) {}
    }
    delete REMOTE_CURSORS[clientId];
  }

  function applyRemoteDoc(doc) {
    const file = installSharedDoc(doc, basename(doc.path));
    const nextContent = String(doc.content == null ? "" : doc.content);
    const local = file.session.getValue();
    // Ketikan yang belum terkirim jangan ditimpa pembaruan yang baru masuk.
    if ((file.inflight || file.queued || file.timer) && local !== nextContent) return;
    if (local !== nextContent) {
      const positions = [];
      const scroll = file.session.getScrollTop();
      walkLeaves(layout, (leaf) => {
        if (leaf._ed && leaf._ed.getSession() === file.session) {
          positions.push({ ed: leaf._ed, pos: leaf._ed.getCursorPosition(), top: leaf._ed.renderer.getScrollTop() });
        }
      });
      file.applying = true;
      file.session.setValue(nextContent);
      file.applying = false;
      try { file.session.setScrollTop(scroll); } catch (e) {}
      positions.forEach((x) => {
        x.ed.moveCursorToPosition(x.pos);
        try { x.ed.renderer.scrollToY(x.top); } catch (e) {}
      });
      scheduleGit();
      scheduleScm();
    }
    file.revision = Number(doc.revision) || 0;
    file.dirty = !!doc.dirty;
    file.inflight = false;
    file.conflictN = 0;
    file.sentContent = nextContent;
    renderAllTabbars(); renderOpenFiles();
  }

  function activateRestoredLeaves(wantedActiveId) {
    let selected = null;
    // Tampilkan tab tiap pane tanpa fokus: focus() di tiap pane akan menggeser
    // activeLeaf ke pane terakhir dan merebut fokus pengguna di browser ini
    // setiap kali browser lain mengklik tab.
    walkLeaves(layout, (leaf) => {
      if (leaf.tabs.length && !leaf.tabs.some((t) => t.id === leaf.active)) leaf.active = leaf.tabs[0].id;
      if (leaf.active != null) setActiveTab(leaf, leaf.active, false);
      if (leaf._id === wantedActiveId) selected = leaf;
    });
    activeLeaf = selected || firstLeaf();
    markActiveLeaf();
  }

  async function applySharedLayout(message) {
    if (!message.layout) return;
    applyingRemote = true;
    try {
      const oldLayout = layout;
      if (oldLayout) disposeLayoutUI(oldLayout);
      layout = hydrateLayout(message.layout);
      tabSeq = Math.max(tabSeq, Number(message.tabSeq) || 0);
      nid = Math.max(nid, Number(message.nodeSeq) || 0);

      const loads = [];
      walkLeaves(layout, (leaf) => {
        leaf.tabs.forEach((tab) => {
          if (tab.kind === "file" && !FILES[tab.path]) loads.push(requestSharedDoc(tab.path, tab.name));
          if (tab.kind === "term") {
            ensureTerminalView(TERMINAL_META[tab.termId] || {
              id: tab.termId,
              title: tab.name,
              cwd: INFO.workspace,
            });
          }
          if (tab.kind === "ashell") ensureAgentShellView(tab.shellId);
        });
      });
      await Promise.all(loads.map((p) => p.catch(() => null)));
      // Layout dari versi lama: tab agent yang menumpang di pane pengguna → pane agent.
      var migrated = migrateAgentTabs();
      renderLayout();
      activateRestoredLeaves(message.activeLeafId);
      renderOpenFiles(); // daftar "File terbuka" mengikuti layout yang baru dimuat (termasuk kosong)
      forEachEditor((ed) => applySyntaxTheme(ed));
      applyUIState();
      restoreFloatTerms(); // terminal Run mengapung yang masih hidup di server
    } finally {
      applyingRemote = false;
    }
    if (migrated) queueLayoutSync(); // idempoten: browser lain yang menerima tidak mengubah apa pun lagi
  }

  async function initializeSession(snapshot) {
    const state = snapshot.state || {};
    Object.keys(state.terminals || {}).forEach((id) => { TERMINAL_META[id] = state.terminals[id]; });
    SB.presence = new Set((snapshot.presence || []).concat(snapshot.clientId ? [snapshot.clientId] : [])); sbRefreshPresence();
    if (syncInitialized) {
      // Snapshot ulang setelah koneksi putus: segarkan kursor remote dan layout
      // terbaru (jangan dibuang begitu saja seperti dulu).
      Object.keys(REMOTE_CURSORS).forEach(removeRemoteCursor);
      Object.keys(state.cursors || {}).forEach((id) => { if (id !== snapshot.clientId) applyRemoteCursor(state.cursors[id]); });
      if (state.layout && JSON.stringify(state.layout) !== JSON.stringify(serializeLayout(layout))) {
        await applySharedLayout({ layout: state.layout, activeLeafId: state.activeLeafId, tabSeq: state.tabSeq, nodeSeq: state.nodeSeq });
      }
      Object.keys(state.docs || {}).forEach((p) => { if (FILES[p]) applyRemoteDoc(state.docs[p]); });
      return;
    }
    Object.keys(state.docs || {}).forEach((p) => installSharedDoc(state.docs[p], basename(p)));
    const clientNumber = parseInt(String(snapshot.clientId || "").replace(/\D/g, ""), 10) || 1;
    tabSeq = Math.max(Number(state.tabSeq) || 0, clientNumber * 1000000);
    nid = Math.max(Number(state.nodeSeq) || 0, clientNumber * 1000000);

    if (state.layout) {
      syncInitialized = true;
      await applySharedLayout({
        layout: state.layout,
        activeLeafId: state.activeLeafId,
        tabSeq: state.tabSeq,
        nodeSeq: state.nodeSeq,
      });
    } else if (snapshot.canInitialize) {
      const topLeaf = newLeaf();
      const botLeaf = newLeaf();
      layout = newSplit("col", [topLeaf, botLeaf], [0.68, 0.32]);
      activeLeaf = topLeaf;
      syncInitialized = true;
      renderLayout();
      setActiveTab(topLeaf, null);
      renderOpenFiles();
      await addTerminalTab(botLeaf);
      activeLeaf = topLeaf; markActiveLeaf(); queueLayoutSync();
    } else {
      // Browser kedua menunggu browser pertama mengirim layout awal.
      layout = newLeaf();
      activeLeaf = layout;
      syncInitialized = true;
      renderLayout();
      setTimeout(() => {
        if (layout && firstLeaf().tabs.length === 0) queueLayoutSync();
      }, 2000);
    }
    Object.keys(state.cursors || {}).forEach((id) => {
      if (id !== snapshot.clientId) applyRemoteCursor(state.cursors[id]);
    });
    hideBoot();
  }
  // Layar muat hilang saat layout siap (atau paling lama 8 detik bila koneksi lambat).
  function hideBoot() {
    const b = document.getElementById("boot"); if (!b || b.classList.contains("gone")) return;
    b.classList.add("gone");
    setTimeout(() => { if (b.parentNode) b.remove(); }, 450);
  }
  setTimeout(hideBoot, 8000);
  sync.on("status", (msg) => { updateSyncStatus(msg.value); if (msg.value === "offline" && !syncInitialized) { const m = document.querySelector("#boot .boot-msg"); if (m) m.textContent = T("Menyambung ke server\u2026"); } });

  sync.on("snapshot", initializeSession);
  sync.on("layout", (msg) => applySharedLayout(msg));
  sync.on("doc", (msg) => {
    if (msg.doc) applyRemoteDoc(msg.doc);
  });
  sync.on("doc-ack", (msg) => {
    const file = FILES[msg.path]; if (!file) return;
    file.revision = Number(msg.revision) || file.revision;
    file.inflight = false;
    file.conflictN = 0;
    const changedAgain = file.session.getValue() !== file.sentContent;
    file.dirty = changedAgain ? true : !!msg.dirty;
    renderAllTabbars(); renderOpenFiles();
    if (changedAgain || file.queued) flushDocChange(msg.path);
    else { scheduleGit(); scheduleScm(); }
  });
  sync.on("doc-conflict", (msg) => {
    const doc = msg.doc;
    const file = doc && FILES[doc.path];
    if (!file) { if (doc) applyRemoteDoc(doc); return; }
    const local = file.session.getValue();
    const remote = String(doc.content == null ? "" : doc.content);
    file.revision = Number(doc.revision) || 0;
    file.inflight = false;
    file.conflictN = (file.conflictN || 0) + 1;
    if (local !== remote && file.conflictN <= 2) {
      flushDocChange(doc.path);
      return;
    }
    file.conflictN = 0;
    applyRemoteDoc(doc);
    setStatus("Perubahan disinkron ulang");
  });
  sync.on("cursor", (msg) => {
    if (msg.cursor && msg.cursor.clientId !== sync.clientId) applyRemoteCursor(msg.cursor);
  });
  sync.on("presence-join", (msg) => { if (msg.clientId) SB.presence.add(msg.clientId); sbRefreshPresence(); });
  sync.on("presence-leave", (msg) => { removeRemoteCursor(msg.clientId); SB.presence.delete(msg.clientId); sbRefreshPresence(); });
  sync.on("terminal-meta", (msg) => {
    if (msg.action === "created" && msg.terminal) TERMINAL_META[msg.terminal.id] = msg.terminal;
    sbRefreshTerm();
    if (msg.action === "closed") {
      disposeTerminalView(msg.id);
      delete TERMINAL_META[msg.id];
    }
  });
  sync.on("fs-change", (m) => refreshNode((m && m.path) || ""));
  sync.on("error", (msg) => {
    setStatus("Realtime error: " + msg.message);
    Object.keys(FILES).forEach((p) => {
      const f = FILES[p];
      if (!f || !f.inflight) return;
      f.inflight = false;
      if (f.queued || f.session.getValue() !== f.sentContent) flushDocChange(p);
    });
  });

  window.addEventListener("resize", () => { forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); });

  // ===== API kecil untuk panel AI (ai-chat.js): konteks dari editor & terminal =====
  function activeTermView() {
    if (activeLeaf) {
      const t = activeLeaf.tabs.find((x) => x.id === activeLeaf.active);
      if (t && t.kind === "term" && TERMS[t.termId]) return TERMS[t.termId];
    }
    let found = null;
    walkLeaves(layout, (leaf) => { if (found) return; const t = leaf.tabs.find((x) => x.id === leaf.active); if (t && t.kind === "term" && TERMS[t.termId]) found = TERMS[t.termId]; });
    if (!found) { const all = Object.values(TERMS).filter((v) => !v.closed); found = all[all.length - 1] || null; }
    return found;
  }
  window.VRCloud = {
    // Teks yang diseleksi di editor aktif + path & rentang baris.
    getSelection() {
      const t = activeFileTab(); const ed = activeEditor();
      if (!t || !ed) return null;
      const text = ed.getSelectedText(); if (!text) return null;
      const r = ed.getSelectionRange();
      const endRow = (r.end.column === 0 && r.end.row > r.start.row) ? r.end.row - 1 : r.end.row;
      return { path: t.path, name: t.name, text, startLine: r.start.row + 1, endLine: endRow + 1 };
    },
    getActiveFile() { const t = activeFileTab(); return t ? { path: t.path, name: t.name } : null; },
    // N baris terakhir dari terminal aktif (buffer xterm).
    getTerminalText(maxLines) {
      const v = activeTermView(); if (!v || !v.term) return null;
      const buf = v.term.buffer.active; const lines = [];
      const start = Math.max(0, buf.length - (maxLines || 200));
      for (let i = start; i < buf.length; i++) { const l = buf.getLine(i); lines.push(l ? l.translateToString(true) : ""); }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return { title: (TERMINAL_META[v.id] && TERMINAL_META[v.id].title) || v.id, text: lines.join("\n") };
    },
    openFile(p, line) { openFile(p, basename(p), line); },
    // Kirim perintah ke terminal aktif (dipakai tombol ▶ di kartu shell agent).
    runInTerminal(cmd) {
      const v = activeTermView();
      if (!v || !v.ws || v.ws.readyState !== 1) return false;
      // Enter = CR, seperti tombol Enter di xterm. LF saja dianggap baris-lanjutan oleh PowerShell/ConPTY (prompt ">>").
      v.ws.send(String(cmd).replace(/\r?\n$/, "") + "\r");
      try { v.term.focus(); } catch (e) {}
      return true;
    },
    // Kanal realtime bersama (hub WebSocket) untuk panel AI: event sesi, draft composer.
    onSync(type, fn) { return sync.on(type, fn); },
    syncSend(msg) { sync.send(msg); },
    clientId() { return sync.clientId; },
    // Tampilkan tab "Agent shell" percakapan ini (dipanggil kartu shell di chat).
    showAgentShell(sessionId) { const hit = ensureAgentShellTab(sessionId, true); if (hit) { activeLeaf = hit.leaf; markActiveLeaf(); } return !!hit; },
    // Buka tab Browser agent (live view); takeover=true langsung masuk mode ambil alih.
    showBrowserAgent(takeover) { const hit = ensureBrowserTab(true); if (hit) { activeLeaf = hit.leaf; markActiveLeaf(); if (takeover) setBrowserTakeover(true); } return !!hit; },
    // Preview server dev: buka URL lokal di tab Browser agent (tab pengguna).
    openPreview(url) { return openPreview(url); },
    openSourceControl() { setSideView("scm"); },
  };
  sync.on("fs-removed", (m) => refreshNode(parentOf((m && m.path) || "")));

  // ============================================================
  //  STATUS BAR: git · file aktif · kursor · agent · token · terminal ·
  //  kolaborator · bahasa · indentasi · EOL · encoding · notifikasi
  // ============================================================
  // 2) posisi kursor + seleksi
  function sbRefreshPos(ed) {
    const el = sbEl("sb-pos"); if (!el) return;
    ed = ed || activeEditor(); if (!ed) { sbShow(el, false); return; }
    const p = ed.getCursorPosition(), r = ed.getSelectionRange(), text = ed.getSelectedText();
    let s = "Ln " + (p.row + 1) + ", Col " + (p.column + 1);
    if (text) {
      const lines = r.end.row - r.start.row + (r.end.column > 0 || r.end.row === r.start.row ? 1 : 0);
      s += "  (" + (lines > 1 ? lines + " baris, " : "") + text.length + " karakter dipilih)";
    }
    el.textContent = s;
  }
  // 2/6/7) file aktif, bahasa, indentasi, EOL, encoding
  function sbRefreshFile() {
    const f = sbEl("sb-file"); if (!f) return;
    const t = activeFileTab(); const ed = activeEditor();
    const dep = ["sb-pos", "sb-lang", "sb-indent", "sb-eol", "sb-enc"].map(sbEl);
    updateRunButton();
    if (!t || !FILES[t.path]) { f.textContent = ""; f.title = ""; dep.forEach((e) => sbShow(e, false)); return; }
    const file = FILES[t.path];
    f.textContent = "/" + t.path;
    if (file.dirty) { const d = document.createElement("span"); d.className = "dirty"; d.textContent = "\u25cf"; f.appendChild(d); }
    f.title = t.path + (file.dirty ? " \u2014 belum tersimpan (Ctrl+S)" : "");
    dep.forEach((e) => sbShow(e, true));
    if (ed) sbRefreshPos(ed);
    const s = file.session;
    sbEl("sb-lang").textContent = MODE_LABELS[file.mode] || file.mode || "Plain Text";
    sbEl("sb-indent").textContent = (s.getUseSoftTabs() ? "Spaces: " : "Tab Size: ") + s.getTabSize();
    sbEl("sb-eol").textContent = s.doc.getNewLineCharacter() === "\r\n" ? "CRLF" : "LF";
  }
  // Deteksi indentasi sederhana dari isi file (tab vs spasi 2/4/8).
  function detectIndent(text) {
    const lines = String(text || "").split(/\r?\n/, 800); let tabs = 0; const widths = {};
    let prev = 0;
    lines.forEach((l) => {
      if (!l.trim()) return;
      if (l[0] === "\t") { tabs++; return; }
      const n = (/^ */.exec(l) || [""])[0].length; const d = Math.abs(n - prev); prev = n;
      if (d >= 2 && d <= 8) widths[d] = (widths[d] || 0) + 1;
    });
    const best = Object.keys(widths).sort((a, b) => widths[b] - widths[a])[0];
    if (tabs && (!best || tabs >= widths[best])) return { soft: false, size: 4 };
    return { soft: true, size: best ? Number(best) : 2 };
  }
  // 9) terminal aktif / terakhir dipakai
  function sbRefreshTerm() {
    const el = sbEl("sb-term"); if (!el) return;
    const v = activeTermView();
    if (!v) { sbShow(el, false); return; }
    const meta = TERMINAL_META[v.id] || {};
    let shell = String((INFO.spec && INFO.spec.shell) || "").replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "");
    const isActive = !!(activeLeaf && activeLeaf.tabs.some((t) => t.id === activeLeaf.active && t.kind === "term" && t.termId === v.id));
    el.textContent = "\u276f " + (meta.title || v.id) + (shell ? " \u00b7 " + shell : "");
    el.title = T(isActive ? "Terminal aktif" : "Terminal terakhir") + " \u2014 " + T("klik untuk fokus");
    el.classList.toggle("active-term", isActive);
    sbShow(el, true);
  }
  // 8) kolaborator (jumlah browser yang terhubung ke sesi ini)
  function sbRefreshPresence() {
    const n = Math.max(1, SB.presence.size);
    sbTxt("sb-presence", String(n), n === 1 ? "Hanya browser ini yang terhubung" : n + " browser terhubung ke workspace ini (termasuk Anda)");
  }
  // 1) git branch + jumlah perubahan
  let gitTimer = null;
  function sbRefreshGit(force) {
    if (document.hidden && !force) return;
    api.get("/api/git/status").then((g) => {
      SB.git = g; const el = sbEl("sb-git"); if (!el) return;
      if (!g || !g.repo) { sbShow(el, false); return; }
      let s = "\u2387 " + (g.branch || "(tanpa commit)");
      if (g.changes) s += " \u25cf" + g.changes;
      if (g.ahead) s += " \u2191" + g.ahead;
      if (g.behind) s += " \u2193" + g.behind;
      el.textContent = s;
      el.title = "Git: " + (g.branch || "-") + "\n" + (g.changes ? (g.staged || 0) + " staged \u00b7 " + (g.unstaged || 0) + " diubah \u00b7 " + (g.untracked || 0) + " baru" : "working tree bersih")
        + (g.ahead || g.behind ? "\n" + (g.ahead || 0) + " commit di depan \u00b7 " + (g.behind || 0) + " di belakang upstream" : "") + "\nKlik: segarkan";
      sbShow(el, true);
    }).catch(() => {});
  }
  function scheduleGit() { clearTimeout(gitTimer); gitTimer = setTimeout(() => sbRefreshGit(false), 800); }
  // 4/5/10) agent, token, notifikasi — dari event ai-chat.js
  function sbRefreshAgent() {
    const a = SB.agent || {}; const el = sbEl("sb-agent"); if (!el) return;
    let txt = "Agent", title = "Agent AI \u2014 klik untuk membuka panel";
    el.classList.remove("busy", "wait");
    if (a.enabled === false) { txt = "Agent nonaktif"; title = "AI belum dikonfigurasi \u2014 klik untuk membuka setelan"; }
    else if (a.pending) { txt = "Agent: menunggu izin" + (a.pending > 1 ? " (" + a.pending + ")" : ""); el.classList.add("wait"); title = "Perintah berisiko menunggu persetujuan Anda \u2014 klik untuk melihat"; }
    else if (a.busy) { txt = "Agent: bekerja\u2026" + (a.plan && a.plan.total ? " " + a.plan.done + "/" + a.plan.total + " langkah" : ""); el.classList.add("busy"); title = "Agent sedang bekerja" + (a.model ? " (" + a.model + ")" : ""); }
    else txt = "Agent siap" + (a.model ? " \u00b7 " + a.model : "");
    sbTxt("sb-agent", txt, title);
    const tk = sbEl("sb-tokens");
    if (a.usage && a.usage.totalTokens) {
      const u = a.usage;
      tk.textContent = "Token usage " + fmtTok(u.totalTokens) + (typeof u.costCents === "number" ? " \u00b7 $" + (u.costCents / 100).toFixed(u.costCents < 100 ? 3 : 2) : "");
      tk.title = T("Pemakaian token percakapan aktif") + "\nInput " + fmtTok(u.inputTokens) + " \u00b7 Output " + fmtTok(u.outputTokens) + (u.cacheReadTokens ? " \u00b7 Cache " + fmtTok(u.cacheReadTokens) : "");
      sbShow(tk, true);
    } else sbShow(tk, false);
  }
  window.addEventListener("vrcloud-ai-status", (e) => { SB.agent = e.detail || {}; sbRefreshAgent(); });
  const openAiPanel = () => { if (window.VRCloudAI && window.VRCloudAI.open) window.VRCloudAI.open(); else { const b = document.querySelector(".mb-ai"); if (b) b.click(); } };

  // ============================================================
  //  PUSAT NOTIFIKASI: daftar di bel status bar, badge belum dibaca, toast, notifikasi browser.
  //  Sumber: agent selesai / minta izin / error, update tersedia, koneksi realtime, browser agent.
  // ============================================================
  const NOTIF_KEY = "c9clone.notifs";
  const NOTIF_MAX = 60;
  const NOTIF = { list: [], actions: {}, pop: null, toasts: null };
  try { NOTIF.list = JSON.parse(localStorage.getItem(NOTIF_KEY) || "[]").slice(0, NOTIF_MAX); } catch (e) { NOTIF.list = []; }
  function notifSave() { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(NOTIF.list.slice(0, NOTIF_MAX).map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, at: n.at, read: n.read, act: n.act })))); } catch (e) {} }
  function notifUnread() { return NOTIF.list.filter((n) => !n.read).length; }
  function notifAgo(t) {
    const d = Math.max(0, Date.now() - t);
    if (d < 60e3) return T("baru saja");
    if (d < 3600e3) return Math.round(d / 60e3) + " " + T("mnt lalu");
    if (d < 86400e3) return Math.round(d / 3600e3) + " " + T("jam lalu");
    return new Date(t).toLocaleDateString();
  }
  // Aksi bernama (tersimpan sebagai string agar bisa dipulihkan setelah reload).
  NOTIF.actions = {
    ai: () => openAiPanel(),
    update: () => { const b = updBtn(); if (b && !b.hidden) b.click(); },
    scm: () => setSideView("scm"),
    file: (arg) => { if (arg) openFile(arg, basename(arg)); },
  };
  function notifBadge() {
    const bell = sbEl("sb-bell"); if (!bell) return;
    const bd = bell.querySelector(".bdg"); const n = notifUnread();
    bell.classList.toggle("has", n > 0);
    if (n) { bd.textContent = n > 99 ? "99+" : String(n); sbShow(bd, true); bell.title = T(n + " notifikasi belum dibaca \u2014 klik untuk melihat"); }
    else { sbShow(bd, false); bell.title = T("Notifikasi (tidak ada yang baru)"); }
  }
  const NOTIF_ICON = { info: "i", ok: "\u2713", warn: "!", err: "\u00d7" };
  function notifRender() {
    const p = NOTIF.pop; if (!p || !p.classList.contains("open")) return;
    const list = p.querySelector(".nl"); list.innerHTML = "";
    if (!NOTIF.list.length) { const e = document.createElement("div"); e.className = "ne"; e.textContent = T("Belum ada notifikasi."); list.appendChild(e); }
    NOTIF.list.forEach((n) => {
      const it = document.createElement("div"); it.className = "ni" + (n.read ? "" : " unread") + (n.act ? " act" : "");
      it.innerHTML = '<span class="ic ' + (n.kind || "info") + '">' + (NOTIF_ICON[n.kind] || "i") + '</span><div class="bd"><div class="t"></div>' + (n.body ? '<div class="b"></div>' : "") + '<div class="tm"></div></div><span class="x" title="Hapus">&times;</span>';
      it.querySelector(".t").textContent = n.title; if (n.body) it.querySelector(".b").textContent = n.body;
      it.querySelector(".tm").textContent = notifAgo(n.at);
      it.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); NOTIF.list = NOTIF.list.filter((x) => x !== n); notifSave(); notifBadge(); notifRender(); });
      it.addEventListener("click", () => { n.read = true; notifSave(); notifBadge(); notifRun(n); notifRender(); });
      list.appendChild(it);
    });
    const perm = p.querySelector(".nf");
    const canAsk = "Notification" in window && Notification.permission === "default";
    perm.style.display = canAsk ? "" : "none";
  }
  function notifRun(n) {
    if (!n.act) return;
    const [name, arg] = String(n.act).split(":");
    const fn = NOTIF.actions[name]; if (fn) { try { fn(arg ? decodeURIComponent(arg) : undefined); } catch (e) {} }
    if (name !== "update") notifClose();
  }
  function notifPop() {
    if (NOTIF.pop) return NOTIF.pop;
    const p = document.createElement("div"); p.id = "notif-pop";
    p.innerHTML = '<div class="nh"><span>' + T("Notifikasi") + '</span><span class="sp"></span><span class="act" data-a="read">' + T("Tandai dibaca") + '</span><span class="act" data-a="clear">' + T("Bersihkan") + '</span></div>'
      + '<div class="nl"></div><div class="nf"><span>' + T("Izinkan notifikasi browser saat tab tidak aktif") + '</span><button type="button">' + T("Izinkan") + "</button></div>";
    p.querySelector('[data-a="read"]').addEventListener("click", () => { NOTIF.list.forEach((n) => { n.read = true; }); notifSave(); notifBadge(); notifRender(); });
    p.querySelector('[data-a="clear"]').addEventListener("click", () => { NOTIF.list = []; notifSave(); notifBadge(); notifRender(); });
    p.querySelector(".nf button").addEventListener("click", () => {
      Notification.requestPermission().then((r) => { if (r === "granted") { localStorage.setItem("vrcloud_ai_notify", "1"); notify({ kind: "ok", title: T("Notifikasi browser diizinkan"), body: T("Anda akan diberi tahu saat agent selesai walau tab tidak aktif.") }); } notifRender(); });
    });
    document.body.appendChild(p);
    document.addEventListener("pointerdown", (e) => { if (p.classList.contains("open") && !p.contains(e.target) && !e.target.closest("#sb-bell")) notifClose(); }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && p.classList.contains("open")) notifClose(); });
    return NOTIF.pop = p;
  }
  function notifOpen() { const p = notifPop(); p.classList.add("open"); notifRender(); }
  function notifClose() { if (NOTIF.pop) NOTIF.pop.classList.remove("open"); }
  function notifToggle() { if (NOTIF.pop && NOTIF.pop.classList.contains("open")) notifClose(); else notifOpen(); }
  function toast(n) {
    if (!NOTIF.toasts) { NOTIF.toasts = document.createElement("div"); NOTIF.toasts.id = "toasts"; document.body.appendChild(NOTIF.toasts); }
    const t = document.createElement("div"); t.className = "toast " + (n.kind || "info");
    t.innerHTML = '<div class="bd"><div class="t"></div>' + (n.body ? '<div class="b"></div>' : "") + '</div><span class="x">&times;</span>';
    t.querySelector(".t").textContent = n.title; if (n.body) t.querySelector(".b").textContent = n.body;
    const close = () => { if (!t.parentNode) return; t.classList.add("out"); setTimeout(() => t.remove(), 180); };
    t.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); close(); });
    t.addEventListener("click", () => { n.read = true; notifSave(); notifBadge(); notifRun(n); close(); });
    NOTIF.toasts.appendChild(t);
    while (NOTIF.toasts.children.length > 4) NOTIF.toasts.firstChild.remove();
    setTimeout(close, n.kind === "err" || n.kind === "warn" ? 9000 : 6000);
  }
  // notify({ kind: info|ok|warn|err, title, body, act: "ai" | "update" | "scm" | "file:<path>", toast: true, system: true, dedupe: key })
  function notify(o) {
    o = o || {};
    if (o.dedupe && NOTIF.list.some((n) => n.dedupe === o.dedupe && Date.now() - n.at < 6 * 3600e3)) return null;
    const n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: o.kind || "info", title: String(o.title || ""), body: o.body ? String(o.body).slice(0, 400) : "", at: Date.now(), read: false, act: o.act || "", dedupe: o.dedupe || "" };
    NOTIF.list.unshift(n); if (NOTIF.list.length > NOTIF_MAX) NOTIF.list.length = NOTIF_MAX;
    notifSave(); notifBadge(); notifRender();
    if (o.toast !== false) toast(n);
    // Notifikasi sistem hanya saat tab tidak aktif dan pengguna sudah mengizinkan.
    if (o.system !== false && document.hidden && "Notification" in window && Notification.permission === "granted" && localStorage.getItem("vrcloud_ai_notify") === "1") {
      try { const sn = new Notification(n.title, { body: n.body, tag: "vrcloud-" + (n.dedupe || n.id) }); sn.onclick = () => { window.focus(); n.read = true; notifSave(); notifBadge(); notifRun(n); }; } catch (e) {}
    }
    return n;
  }
  function notifyAgent(title, body) { notify({ kind: "warn", title, body, act: "ai" }); }
  window.VRCloud = window.VRCloud || {};
  window.VRCloud.notify = notify;
  // Koneksi realtime: beri tahu saat terputus lama & saat tersambung kembali.
  let rtLostAt = 0;
  sync.on("status", (m) => {
    if (m.value === "offline") { if (!rtLostAt) rtLostAt = Date.now(); setTimeout(() => { if (rtLostAt && syncState !== "online") notify({ kind: "warn", title: T("Koneksi realtime terputus"), body: T("Mencoba menyambung ulang\u2026"), dedupe: "rt-off" }); }, 4000); }
    else if (m.value === "online" && rtLostAt) { if (Date.now() - rtLostAt > 4000) notify({ kind: "ok", title: T("Tersambung kembali"), body: T("Sesi realtime aktif lagi."), dedupe: "rt-on-" + Math.floor(Date.now() / 60000) }); rtLostAt = 0; }
  });
  notifBadge();

  // ---- interaksi ----
  sbEl("sb-agent").addEventListener("click", openAiPanel);
  sbEl("sb-bell").addEventListener("click", (e) => { e.stopPropagation(); notifToggle(); });
  sbEl("sb-pos").addEventListener("click", () => goToLineDlg());
  sbEl("sb-git").addEventListener("click", () => {
    setSideView("scm");
    Mobile.openFiles();
    sbRefreshGit(true);
  });
  sbEl("sb-term").addEventListener("click", () => {
    const v = activeTermView(); if (!v) return;
    let hit = null; walkLeaves(layout, (leaf) => { if (hit) return; const t = leaf.tabs.find((x) => x.kind === "term" && x.termId === v.id); if (t) hit = { leaf, t }; });
    if (hit) setActiveTab(hit.leaf, hit.t.id); else { try { v.term.focus(); } catch (e) {} }
  });
  sbEl("sb-lang").addEventListener("click", (e) => {
    e.stopPropagation(); if (!activeFileTab()) return;
    ctxSimple(e, MODES.map((m) => [MODE_LABELS[m] || m, () => setSyntaxMode(m)]));
  });
  sbEl("sb-indent").addEventListener("click", (e) => {
    e.stopPropagation(); const t = activeFileTab(); if (!t) return; const s = FILES[t.path].session;
    const set = (soft, size) => () => { s.setUseSoftTabs(soft); s.setTabSize(size); sbRefreshFile(); setStatus("Indentasi: " + (soft ? "Spaces " + size : "Tab " + size)); };
    ctxSimple(e, [["Spaces: 2", set(true, 2)], ["Spaces: 4", set(true, 4)], ["Spaces: 8", set(true, 8)], ["Tab (lebar 4)", set(false, 4)], ["Tab (lebar 8)", set(false, 8)],
      ["Deteksi dari isi file", () => { const d = detectIndent(s.getValue()); s.setUseSoftTabs(d.soft); s.setTabSize(d.size); sbRefreshFile(); setStatus("Indentasi terdeteksi: " + (d.soft ? "Spaces " + d.size : "Tab")); }]]);
  });
  sbEl("sb-eol").addEventListener("click", (e) => {
    e.stopPropagation(); const t = activeFileTab(); if (!t) return; const f = FILES[t.path];
    const set = (mode) => () => { f.session.doc.setNewLineMode(mode); f.dirty = true; renderAllTabbars(); renderOpenFiles(); setStatus("Akhir baris " + (mode === "windows" ? "CRLF" : "LF") + " \u2014 berlaku saat disimpan (Ctrl+S)"); };
    ctxSimple(e, [["LF (Unix / Linux / macOS)", set("unix")], ["CRLF (Windows)", set("windows")]]);
  });

  // ---- pemicu pembaruan ----
  sbRefreshGit(true);
  setInterval(() => sbRefreshGit(false), 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sbRefreshGit(true); });
  sync.on("fs-change", () => { scheduleGit(); scheduleScm(); });
  sync.on("fs-removed", () => { scheduleGit(); scheduleScm(); });
  sbRefreshPresence(); sbRefreshAgent(); sbRefreshFile();

  // ===== Dragbar sidebar =====
  function dragify(bar, cb) { bar.addEventListener("mousedown", (e) => { e.preventDefault(); let lx = e.clientX; const mv = (ev) => { cb(ev.clientX - lx); lx = ev.clientX; }; const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }; document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up); }); }
  dragify($("#drag-x"), (dx) => { const sb = $("#sidebar"); sb.style.width = Math.min(600, Math.max(140, sb.offsetWidth + dx)) + "px"; forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); });

  // ===== Navigasi layar sempit: drawer file + bilah bawah Files/Terminal/Agent =====
  // The Ace/text editor is not a mobile pane. body.mob-term reveals #workarea
  // for the terminal only; otherwise the workarea (and Ace) stay hidden.
  function setMobTerm(on) {
    document.body.classList.toggle("mob-term", !!(on && isNarrowView()));
  }
  function refitWorkarea() {
    setTimeout(() => {
      lockMobileViewport();
      try { forEachEditor((ed) => ed.resize()); } catch (e) {}
      try { Object.values(TERMS).forEach(fitVisibleTerminal); } catch (e) {}
    }, 60);
  }
  function closeAiPanel() {
    if (window.VRCloudAI && window.VRCloudAI.setOpen) window.VRCloudAI.setOpen(false);
  }
  function setDrawer(open) {
    document.body.classList.toggle("drawer-open", !!open);
    const burger = $("#mb-burger");
    if (burger) burger.setAttribute("aria-expanded", open ? "true" : "false");
    const back = $("#drawer-backdrop");
    if (back) back.hidden = !open;
    Mobile.syncNav();
  }
  function setMenusOpen(open) {
    document.body.classList.toggle("menus-open", !!open);
    const more = $("#mb-more");
    if (more) more.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function focusExistingTerminal() {
    if (!layout) return;
    let hit = null;
    walkLeaves(layout, (leaf) => {
      if (hit || (leaf && leaf.agent)) return;
      const t = leaf.tabs.find((x) => x.kind === "term");
      if (t) hit = { leaf, t };
    });
    if (hit) setActiveTab(hit.leaf, hit.t.id);
    else addTerminal();
    refitWorkarea();
  }
  Mobile.afterOpenFile = function () {
    if (!isNarrowView()) return;
    // Stay on Files / Agent / Terminal. Opening a file must not reveal Ace.
    setMenusOpen(false);
    lockMobileViewport();
    Mobile.syncNav();
  };
  Mobile.openFiles = function () {
    if (!isNarrowView()) return;
    closeAiPanel();
    setMobTerm(false);
    setDrawer(true);
    Mobile.syncNav();
  };
  Mobile.showEditor = function () {
    // Editor nav is hidden on phones; if anything still calls this, fill with Agent.
    if (!isNarrowView()) return;
    setDrawer(false);
    setMobTerm(false);
    setMenusOpen(false);
    if (window.VRCloudAI && window.VRCloudAI.open) window.VRCloudAI.open();
    Mobile.syncNav();
  };
  Mobile.closeMenus = function () { setMenusOpen(false); };
  Mobile.onAiToggle = function () { Mobile.syncNav(); };
  Mobile.syncNav = function () {
    const nav = $("#mob-nav"); if (!nav) return;
    const aiOpen = !!(window.VRCloudAI && window.VRCloudAI.isOpen && window.VRCloudAI.isOpen());
    const drawer = document.body.classList.contains("drawer-open");
    let mode = "agent";
    if (aiOpen) mode = "agent";
    else if (drawer) mode = "files";
    else if (document.body.classList.contains("mob-term") || (activeLeaf && (function () {
      const t = activeLeaf.tabs.find((x) => x.id === activeLeaf.active);
      return t && (t.kind === "term" || t.kind === "ashell");
    })())) mode = "term";
    nav.querySelectorAll("[data-nav]").forEach((b) => b.classList.toggle("on", b.dataset.nav === mode));
  };

  const burger = $("#mb-burger");
  if (burger) burger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isNarrowView()) return;
    const open = !document.body.classList.contains("drawer-open");
    if (open) { closeAiPanel(); setSideView(curSideView || "workspace"); }
    setDrawer(open);
    setMenusOpen(false);
    if (!open && !document.body.classList.contains("mob-term") && window.VRCloudAI && window.VRCloudAI.open) {
      window.VRCloudAI.open();
    }
  });
  const more = $("#mb-more");
  if (more) more.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isNarrowView()) return;
    const open = !document.body.classList.contains("menus-open");
    if (open) closeMenus();
    setMenusOpen(open);
  });
  const backdrop = $("#drawer-backdrop");
  if (backdrop) backdrop.addEventListener("click", () => {
    setDrawer(false);
    setMenusOpen(false);
    if (isNarrowView() && !document.body.classList.contains("mob-term") && window.VRCloudAI && window.VRCloudAI.open) {
      window.VRCloudAI.open();
    }
  });
  const mobNav = $("#mob-nav");
  if (mobNav) mobNav.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nav]"); if (!btn) return;
    const dest = btn.dataset.nav;
    if (dest === "files") {
      if (document.body.classList.contains("drawer-open")) {
        setDrawer(false);
        if (!document.body.classList.contains("mob-term") && window.VRCloudAI && window.VRCloudAI.open) {
          window.VRCloudAI.open();
        }
      } else { setSideView("workspace"); Mobile.openFiles(); }
    } else if (dest === "editor") {
      Mobile.showEditor();
    } else if (dest === "term") {
      setDrawer(false);
      closeAiPanel();
      setMenusOpen(false);
      setMobTerm(true);
      focusExistingTerminal();
      Mobile.syncNav();
    } else if (dest === "agent") {
      setDrawer(false);
      setMobTerm(false);
      setMenusOpen(false);
      if (window.VRCloudAI && window.VRCloudAI.open) window.VRCloudAI.open();
      Mobile.syncNav();
    }
  });

  document.addEventListener("focusin", () => {
    if (!isNarrowView()) return;
    lockMobileViewport();
    setTimeout(lockMobileViewport, 0);
  });
  if (window.visualViewport) {
    const pinVV = () => { if (isNarrowView()) lockMobileViewport(); };
    try { window.visualViewport.addEventListener("scroll", pinVV); } catch (e) {}
    try { window.visualViewport.addEventListener("resize", pinVV); } catch (e) {}
  }
  function onViewportChange() {
    applyNarrowClass();
    if (!isNarrowView()) {
      setDrawer(false);
      setMenusOpen(false);
      setMobTerm(false);
      const sb = $("#sidebar");
      if (sb) sb.style.width = "";
      // File tabs that skipped Ace on a phone need a real editor now.
      if (layout) walkLeaves(layout, (l) => {
        const t = l.tabs.find((x) => x.id === l.active);
        if (t && t.kind === "file") setActiveTab(l, t.id, false);
      });
    } else {
      lockMobileViewport();
      if (layout) walkLeaves(layout, (l) => {
        if (l._edEl) { l._edEl.style.display = "none"; l._edEl.classList.add("no-minimap"); }
      });
    }
    Mobile.syncNav();
    refitWorkarea();
  }
  let _narrowT = null;
  window.addEventListener("resize", () => { clearTimeout(_narrowT); _narrowT = setTimeout(onViewportChange, 160); });
  window.addEventListener("orientationchange", onViewportChange);
  if (MQ_NARROW && MQ_NARROW.addEventListener) MQ_NARROW.addEventListener("change", onViewportChange);
  else if (MQ_NARROW && MQ_NARROW.addListener) MQ_NARROW.addListener(onViewportChange);
  Mobile.syncNav();
  // First paint on a phone: Agent fills the space the editor used to occupy.
  setTimeout(() => {
    if (!isNarrowView()) return;
    if (document.body.classList.contains("drawer-open") || document.body.classList.contains("mob-term")) return;
    if (window.VRCloudAI && window.VRCloudAI.open) window.VRCloudAI.open();
  }, 0);
})();
