/* VRCloud IDE — frontend realtime dengan tiling panes */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const enc = encodeURIComponent;
  const api = {
    async get(u) { const r = await fetch(u); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); },
    async post(u, b) { const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); },
    async upload(destDir, relName, blob) {
      const r = await fetch("/api/upload?path=" + enc(destDir), { method: "POST", headers: { "X-Filename": relName }, body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json();
    },
  };
  const basename = (p) => p.split("/").pop();
  const parentOf = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const setStatus = (l, r) => { if (l != null) $("#status-file").textContent = l; if (r != null) $("#status-right").textContent = r; };
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  let INFO = { workspace: "", name: "" };

  // ===== Ace helper =====
  ace.require("ace/ext/language_tools");
  const modelist = ace.require("ace/ext/modelist");

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

  const newLeaf = (tabs) => ({ type: "leaf", _id: ++nid, tabs: tabs || [], active: tabs && tabs[0] ? tabs[0].id : null });
  const newSplit = (dir, children, sizes) => ({ type: "split", _id: ++nid, dir, children, sizes });
  function walkLeaves(n, cb) { if (n.type === "leaf") cb(n); else n.children.forEach((c) => walkLeaves(c, cb)); }
  function firstLeaf() { let f = null; walkLeaves(layout, (l) => { if (!f) f = l; }); return f; }
  function findParent(n, id, par) { if (n._id === id) return { parent: par, node: n }; if (n.type === "split") { for (const c of n.children) { const r = findParent(c, id, n); if (r) return r; } } return null; }
  function forEachEditor(cb) { walkLeaves(layout, (l) => { if (l._ed) cb(l._ed); }); }
  function ensureActiveLeaf() { if (!activeLeaf || !findParent(layout, activeLeaf._id, null)) activeLeaf = firstLeaf(); }
  const activeFileTab = () => { if (!activeLeaf) return null; const t = activeLeaf.tabs.find((x) => x.id === activeLeaf.active); return t && t.kind === "file" ? t : null; };
  const activeEditor = () => (activeFileTab() ? activeLeaf._ed : null);

  function serializeLayout(node) {
    if (!node) return null;
    if (node.type === "leaf") {
      return {
        type: "leaf",
        _id: node._id,
        active: node.active,
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
      const leaf = newLeaf((node && node.tabs || []).map((t) => Object.assign({}, t)));
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

  function disposeLayoutUI(node) {
    if (!node) return;
    walkLeaves(node, (leaf) => {
      if (leaf._ed) { try { leaf._ed.destroy(); } catch (e) {} }
      leaf._ed = null; leaf._root = null; leaf._bar = null; leaf._body = null;
      leaf._edEl = null; leaf._termHost = null; leaf._empty = null; leaf._drop = null;
    });
  }

  api.get("/api/info").then((i) => { INFO = i; $("#ws-name").textContent = i.workspace; document.title = i.name + " — " + (i.product || "VRCloud IDE"); });

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
      const t = l.tabs.find((x) => x.id === l.active);
      if (t && t.kind === "term") { const tt = TERMS[t.termId]; if (tt) setTimeout(() => fitVisibleTerminal(tt), 0); }
    });
    markActiveLeaf();
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
      const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); queueLayoutSync(); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    return r;
  }
  function resizeSubtree(el) {
    el.querySelectorAll(".leaf").forEach((lf) => {
      const id = lf.__leaf; if (!id) return;
      if (id._ed) id._ed.resize();
      const t = id.tabs && id.tabs.find((x) => x.id === id.active);
      if (t && t.kind === "term") { const tt = TERMS[t.termId]; if (tt) fitVisibleTerminal(tt); }
    });
  }

  function getLeafEl(leaf) {
    if (leaf._root) { renderLeafTabs(leaf); return leaf._root; }
    const root = document.createElement("div"); root.className = "leaf"; root.__leaf = leaf;
    const bar = document.createElement("div"); bar.className = "pane-tabs";
    const body = document.createElement("div"); body.className = "pane-body";
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", "Pane " + leaf._id + " drop area");
    const edEl = document.createElement("div"); edEl.className = "pane-editor";
    const host = document.createElement("div"); host.className = "pane-term-host";
    const empty = document.createElement("div"); empty.className = "pane-empty";
    empty.innerHTML = "<div>&#9729; VRCloud IDE<br><span>Geser tab file / terminal ke tepi panel ini untuk split.</span></div>";
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
    ed.selection.on("changeCursor", publish);
    ed.selection.on("changeSelection", publish);
    leaf._edEl.addEventListener("keyup", publish);
    leaf._edEl.addEventListener("mouseup", publish);
  }
  function ensureLeafEditor(leaf) {
    if (leaf._ed) return leaf._ed;
    const ed = ace.edit(leaf._edEl);
    ed.setOptions({ fontSize: ui.fontSize + "px", enableBasicAutocompletion: true, enableLiveAutocompletion: true, enableSnippets: true, showPrintMargin: !!ui.wrapMargin, useSoftTabs: true, tabSize: 2 });
    ed.renderer.setShowGutter(!!ui.gutter);
    ed.setTheme("ace/theme/" + (localStorage.getItem("c9clone.syntax") || "tomorrow_night_blue"));
    ed.on("focus", () => { activeLeaf = leaf; markActiveLeaf(); });
    leaf._ed = ed;
    bindCursorSync(ed, leaf);
    return ed;
  }

  function renderLeafTabs(leaf) {
    const bar = leaf._bar; if (!bar) return; bar.innerHTML = "";
    leaf.tabs.forEach((t) => {
      const el = document.createElement("div"); el.className = "pane-tab" + (t.id === leaf.active ? " active" : "");
      el.dataset.tabId = String(t.id);
      el.setAttribute("role", "tab");
      el.setAttribute("aria-label", t.name);
      el.setAttribute("aria-selected", t.id === leaf.active ? "true" : "false");
      el.draggable = true;
      const dirty = t.kind === "file" && FILES[t.path] && FILES[t.path].dirty;
      el.innerHTML = '<span class="pt-ic">' + (t.kind === "term" ? "&#9002;" : "") + '</span><span class="pt-name"></span>' + (dirty ? '<span class="pt-dot">&#9679;</span>' : "") + '<span class="pt-x">&times;</span>';
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
      el.addEventListener("dragstart", (e) => { DRAG = { leaf, tabId: t.id }; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", "tab"); } catch (x) {} });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); clearDropUI(); DRAG = null; });
      bar.appendChild(el);
    });
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

  function setActiveTab(leaf, id) {
    leaf.active = id; activeLeaf = leaf;
    const tab = leaf.tabs.find((t) => t.id === id);
    const edEl = leaf._edEl, host = leaf._termHost, empty = leaf._empty;
    if (!tab) { edEl.style.display = "none"; host.style.display = "none"; empty.style.display = "flex"; updateTabSelection(); renderOpenFiles(); markActiveLeaf(); setStatus("siap", ""); queueLayoutSync(); return; }
    empty.style.display = "none";
    if (tab.kind === "file") {
      ensureLeafEditor(leaf);
      bindCursorSync(leaf._ed, leaf);
      leaf._ed.setSession(FILES[tab.path].session);
      edEl.style.display = "block"; host.style.display = "none";
      setTimeout(() => { leaf._ed.resize(); leaf._ed.focus(); }, 0);
      setStatus("/" + tab.path, FILES[tab.path].mode);
    } else {
      const t = TERMS[tab.termId];
      if (t) host.appendChild(t.el);
      host.style.display = "block"; edEl.style.display = "none";
      setTimeout(() => { if (t) { fitVisibleTerminal(t); t.term.focus(); } }, 0);
      setStatus("terminal bash " + tab.termId, "");
    }
    // Jangan buat ulang DOM tab saat klik. Ini penting agar tombol close yang
    // sedang menerima event tidak hilang sebelum event click selesai.
    updateTabSelection(); renderOpenFiles(); markActiveLeaf(); queueLayoutSync();
  }

  // ---- drop zones (split) ----
  function clearDropUI() {
    document.querySelectorAll(".pane-drop").forEach((d) => (d.className = "pane-drop"));
    document.querySelectorAll(".pane-tabs.bar-drop").forEach((b) => b.classList.remove("bar-drop"));
    document.querySelectorAll(".pane-tab.dragging").forEach((b) => b.classList.remove("dragging"));
  }
  function wireLeafDrop(leaf) {
    const body = leaf._body, drop = leaf._drop, bar = leaf._bar;
    const zoneFrom = (e) => {
      const r = body.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height, T = 0.28;
      if (x < T) return "left"; if (x > 1 - T) return "right"; if (y < T) return "top"; if (y > 1 - T) return "bottom"; return "center";
    };
    body.addEventListener("dragover", (e) => { if (!DRAG) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; drop.className = "pane-drop show zone-" + zoneFrom(e); });
    body.addEventListener("dragleave", (e) => { if (!body.contains(e.relatedTarget)) drop.className = "pane-drop"; });
    body.addEventListener("drop", (e) => {
      if (!DRAG) return; e.preventDefault(); const z = zoneFrom(e); const src = DRAG.leaf, id = DRAG.tabId; DRAG = null; clearDropUI();
      if (z === "center") moveTabToLeaf(src, id, leaf); else splitWith(leaf, z, src, id);
    });
    bar.addEventListener("dragover", (e) => { if (!DRAG) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; bar.classList.add("bar-drop"); });
    bar.addEventListener("dragleave", () => bar.classList.remove("bar-drop"));
    bar.addEventListener("drop", (e) => { if (!DRAG) return; e.preventDefault(); bar.classList.remove("bar-drop"); const src = DRAG.leaf, id = DRAG.tabId; DRAG = null; clearDropUI(); moveTabToLeaf(src, id, leaf); });
  }

  // ---- operasi pohon ----
  function removeLeaf(leaf) {
    const info = findParent(layout, leaf._id, null); if (!info) return;
    if (leaf._ed) { try { leaf._ed.destroy(); } catch (e) {} leaf._ed = null; }
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
  function wrapLeafInSplit(target, side, newLf) {
    const info = findParent(layout, target._id, null);
    const dir = side === "left" || side === "right" ? "row" : "col";
    const children = side === "left" || side === "top" ? [newLf, target] : [target, newLf];
    const split = newSplit(dir, children, [0.5, 0.5]);
    if (!info.parent) layout = split;
    else { const idx = info.parent.children.indexOf(target); info.parent.children[idx] = split; }
  }
  function moveTabToLeaf(src, tabId, dst) {
    const ti = src.tabs.findIndex((t) => t.id === tabId); if (ti < 0) return; const tab = src.tabs[ti];
    if (src === dst) { src.tabs.splice(ti, 1); src.tabs.push(tab); renderLayout(); setActiveTab(dst, tab.id); return; }
    src.tabs.splice(ti, 1); dst.tabs.push(tab);
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
    return true;
  }
  function installSharedDoc(doc, name) {
    const p = doc.path;
    let file = FILES[p];
    if (!file) {
      const m = modelist.getModeForPath(name || basename(p));
      const session = ace.createEditSession(doc.content || "", "ace/mode/" + (doc.mode || m.name || "text"));
      session.setUseSoftTabs(true);
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
        file.timer = setTimeout(() => flushDocChange(p), 100);
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
  async function openFile(p, name, gotoLine) {
    // Satu path hanya boleh punya satu tab di seluruh layout, bukan per-pane.
    const existing = findFileTab(p);
    if (focusFileTab(existing, gotoLine)) return;
    ensureActiveLeaf();
    const requestedLeaf = activeLeaf;
    if (!FILES[p]) {
      if (!OPENING[p]) OPENING[p] = requestSharedDoc(p, name);
      try { await OPENING[p]; }
      catch (e) { delete OPENING[p]; return alert("Gagal buka: " + e.message); }
      delete OPENING[p];
    }
    // Permintaan kedua mungkin selesai ketika permintaan pertama sudah membuat tab.
    const openedWhileLoading = findFileTab(p);
    if (focusFileTab(openedWhileLoading, gotoLine)) return;
    const leaf = findParent(layout, requestedLeaf._id, null) ? requestedLeaf : firstLeaf();
    const tab = { id: ++tabSeq, kind: "file", path: p, name };
    leaf.tabs.push(tab); renderLayout(); setActiveTab(leaf, tab.id);
    if (gotoLine && leaf._ed) leaf._ed.gotoLine(gotoLine, 0, true);
  }
  function pathOpenElsewhere(p, exceptTabId) {
    let n = 0; walkLeaves(layout, (l) => l.tabs.forEach((t) => { if (t.kind === "file" && t.path === p && t.id !== exceptTabId) n++; })); return n;
  }
  function closeTab(leaf, tabId) {
    const ti = leaf.tabs.findIndex((t) => t.id === tabId); if (ti < 0) return; const tab = leaf.tabs[ti];
    if (tab.kind === "file") {
      const f = FILES[tab.path];
      if (f && f.dirty && pathOpenElsewhere(tab.path, tabId) === 0 && !confirm("Perubahan belum disimpan. Tutup saja?")) return;
    } else {
      disposeTerminalView(tab.termId);
      if (!applyingRemote) sync.send({ type: "terminal-close", id: tab.termId });
    }
    leaf.tabs.splice(ti, 1);
    if (leaf.active === tabId) leaf.active = leaf.tabs.length ? leaf.tabs[Math.max(0, ti - 1)].id : null;
    const info = findParent(layout, leaf._id, null);
    if (leaf.tabs.length === 0 && info && info.parent) { removeLeaf(leaf); activeLeaf = firstLeaf(); }
    renderLayout();
    if (activeLeaf) setActiveTab(activeLeaf, activeLeaf.active);
  }
  async function saveActive() {
    const t = activeFileTab(); if (!t) return;
    const file = FILES[t.path];
    try {
      const ack = await sync.request("doc-save", { path: t.path, content: file.session.getValue() });
      file.revision = Number(ack.revision) || file.revision;
      file.dirty = false;
      file.inflight = false;
      renderAllTabbars(); renderOpenFiles(); setStatus("tersimpan: " + t.path);
    } catch (e) { alert("Gagal simpan: " + e.message); }
  }
  async function saveAll() {
    for (const p in FILES) {
      if (!FILES[p].dirty) continue;
      try {
        const ack = await sync.request("doc-save", { path: p, content: FILES[p].session.getValue() });
        FILES[p].revision = Number(ack.revision) || FILES[p].revision;
        FILES[p].dirty = false;
        FILES[p].inflight = false;
      } catch (e) { alert("Gagal simpan " + p + ": " + e.message); }
    }
    renderAllTabbars(); renderOpenFiles(); setStatus("semua tersimpan");
  }
  function closeAllTabs() { walkLeaves(layout, (l) => l.tabs.slice().forEach((t) => closeTab(l, t.id))); }

  // ===== OPEN FILES (sidebar) =====
  function focusPath(p) {
    const found = findFileTab(p);
    if (found) setActiveTab(found.leaf, found.tab.id); else openFile(p, basename(p));
  }
  function closePathEverywhere(p) { walkLeaves(layout, (l) => l.tabs.slice().forEach((t) => { if (t.kind === "file" && t.path === p) closeTab(l, t.id); })); }
  function renderOpenFiles() {
    const wrap = $("#openfiles-wrap"), ul = $("#openlist"); ul.innerHTML = "";
    const paths = []; walkLeaves(layout, (l) => l.tabs.forEach((t) => { if (t.kind === "file" && !paths.includes(t.path)) paths.push(t.path); }));
    wrap.classList.toggle("empty", paths.length === 0);
    const af = activeFileTab();
    paths.forEach((p) => {
      const li = document.createElement("li"); if (af && af.path === p) li.className = "active";
      li.innerHTML = '<span class="ox">&times;</span><span class="oname"></span><span class="opath"></span>';
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
  const TERM_THEMES = {
    "flat-dark": {
      background: "#0b0b0b", foreground: "#e8e8e8", cursor: "#00d7ff", selection: "#264f62",
      black: "#1c1c1c", red: "#ff5f5f", green: "#5fff87", yellow: "#ffd75f",
      blue: "#5fafff", magenta: "#d787ff", cyan: "#00d7d7", white: "#d0d0d0",
      brightBlack: "#808080", brightRed: "#ff8787", brightGreen: "#87ffaf",
      brightYellow: "#ffff87", brightBlue: "#87afff", brightMagenta: "#ff87ff",
      brightCyan: "#5fffff", brightWhite: "#ffffff"
    },
    "flat-light": { background: "#ffffff", foreground: "#1e2b36", cursor: "#3d7fb3", selection: "#cfe0ee" },
    "classic-dark": { background: "#141414", foreground: "#d4d4d4", cursor: "#6a9bd5", selection: "#2d4a63" },
    "classic-gray": { background: "#232323", foreground: "#dcdcdc", cursor: "#7fb3e6", selection: "#3a5163" },
  };
  const terminalFontSize = () => Math.max(9, Number(ui.fontSize || 13) - 2);
  const currentTermTheme = () => TERM_THEMES[document.body.dataset.uiTheme || "flat-dark"] || TERM_THEMES["flat-dark"];
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
  function terminalProtocolReply(data) {
    return /^\x1b\[[?>]?[0-9;]*[cR]$/.test(data) ||
      /^\x1b\][0-9]+;.*(?:\x07|\x1b\\)$/.test(data) ||
      /^\x1bP.*\x1b\\$/.test(data);
  }
  async function copyTerminal(term) {
    const text = term.getSelection();
    if (!text) return setStatus("Pilih teks terminal terlebih dahulu");
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement("textarea");
        input.value = text; input.style.position = "fixed"; input.style.opacity = "0";
        document.body.appendChild(input); input.select();
        document.execCommand("copy"); input.remove();
      }
      setStatus("Teks terminal disalin");
    } catch (e) { setStatus("Copy terminal gagal: " + e.message); }
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
      if (paste) { pasteTerminal(view); return false; }
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
      ws.onopen = () => {
        setTimeout(() => fitVisibleTerminal(view), 80);
        if (runCmd && !view.ran) { view.ran = true; ws.send(runCmd + "\n"); }
      };
      ws.onmessage = (ev) => term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
      ws.onclose = () => {
        if (!view.closed) {
          term.write("\r\n\x1b[33m[terminal reconnecting…]\x1b[0m\r\n");
          setTimeout(connect, 1000);
        }
      };
    }
    term.onData((d) => {
      if (terminalProtocolReply(d)) return;
      if (view.ws && view.ws.readyState === 1) view.ws.send(d);
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
  async function addTerminalTab(leaf, runCmd, cwd) {
    ensureActiveLeaf(); leaf = leaf || activeLeaf;
    let response;
    try { response = await sync.request("terminal-create", { cwd: cwd || "" }); }
    catch (e) { return alert("Gagal membuat terminal: " + e.message); }
    const meta = response.terminal;
    ensureTerminalView(meta, runCmd);
    const tab = { id: ++tabSeq, kind: "term", termId: meta.id, name: meta.title };
    leaf.tabs.push(tab); renderLayout(); setActiveTab(leaf, tab.id);
  }
  function addTerminal(runCmd, cwd) { ensureActiveLeaf(); addTerminalTab(activeLeaf, runCmd, cwd); }
  // split aktif dgn terminal baru (dipakai menu)
  async function splitActiveWithTerminal(side) {
    ensureActiveLeaf(); const dst = activeLeaf;
    let response;
    try { response = await sync.request("terminal-create", {}); }
    catch (e) { return alert("Gagal membuat terminal: " + e.message); }
    const meta = response.terminal;
    ensureTerminalView(meta);
    const tab = { id: ++tabSeq, kind: "term", termId: meta.id, name: meta.title };
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
  //  FILE TREE
  // ============================================================
  const treeRoot = $("#filetree");
  let showHidden = localStorage.getItem("c9clone.hidden") !== "0";
  async function loadDir(ulEl, pathStr) {
    ulEl.innerHTML = "";
    let items; try { items = await api.get("/api/list?path=" + enc(pathStr)); } catch (e) { return; }
    if (!showHidden) items = items.filter((it) => !it.name.startsWith("."));
    for (const it of items) ulEl.appendChild(makeNode(it));
  }
  function makeNode(it) {
    const li = document.createElement("li");
    li.dataset.path = it.path; li.dataset.dir = it.dir ? "1" : ""; li.dataset.name = it.name;
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<span class="twist">' + (it.dir ? "&#9656;" : "") + '</span><span class="ic ' + (it.dir ? "ic-dir" : "ic-file") + '">' + (it.dir ? "&#128193;" : "&#128196;") + '</span><span class="nm"></span>';
    row.querySelector(".nm").textContent = it.name;
    li.appendChild(row);
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
    if (sub) { sub.remove(); tw.innerHTML = "&#9656;"; return; }
    sub = document.createElement("ul"); li.appendChild(sub); tw.innerHTML = "&#9662;";
    await loadDir(sub, li.dataset.path);
  }
  function refreshTree() { loadDir(treeRoot, ""); }
  async function refreshNode(pathStr) {
    if (!pathStr) return refreshTree();
    const li = document.querySelector('#filetree li[data-path="' + CSS.escape(pathStr) + '"]');
    if (li && li.dataset.dir === "1" && li.querySelector(":scope > ul")) await loadDir(li.querySelector(":scope > ul"), pathStr);
    else refreshTree();
  }
  async function expandPath(p) { const li = document.querySelector('#filetree li[data-path="' + CSS.escape(p) + '"]'); if (li && !li.querySelector(":scope > ul")) toggleDir(li); }
  const curDir = () => (selNode ? (selNode.dir ? selNode.path : parentOf(selNode.path)) : "");
  $("#tree-refresh").addEventListener("click", refreshTree);
  refreshTree();

  // gear menu file tree
  const gearMenu = $("#tree-gear-menu");
  function hideGear() { gearMenu.style.display = "none"; }
  $("#tree-gear").addEventListener("click", (e) => {
    e.stopPropagation(); gearMenu.innerHTML = "";
    const add = (label, fn, checked) => { const d = document.createElement("div"); d.className = "item"; d.innerHTML = (checked ? '<span class="chk">&#10004;</span>' : "") + "<span>" + label + "</span>"; d.addEventListener("click", () => { hideGear(); fn(); }); gearMenu.appendChild(d); };
    add("Refresh File Tree", refreshTree);
    add("Collapse All Folders", () => document.querySelectorAll("#filetree li > ul").forEach((u) => { const tw = u.parentElement.querySelector(".twist"); if (tw) tw.innerHTML = "&#9656;"; u.remove(); }));
    add("Show Open Files", () => toggleUI("openFiles"), ui.openFiles);
    add("Show Hidden Files", () => { showHidden = !showHidden; localStorage.setItem("c9clone.hidden", showHidden ? "1" : "0"); refreshTree(); }, showHidden);
    const r = e.target.getBoundingClientRect();
    gearMenu.style.display = "block"; gearMenu.style.left = Math.min(r.left, innerWidth - gearMenu.offsetWidth - 6) + "px"; gearMenu.style.top = r.bottom + 4 + "px";
  });

  // ============================================================
  //  CLIPBOARD & FILE OPS
  // ============================================================
  async function newEntry(dir, inDir) {
    const name = await promptDlg(dir ? "Nama folder baru:" : "Nama file baru:", "");
    if (!name) return;
    const full = (inDir ? inDir + "/" : "") + name;
    try { await api.post("/api/create", { path: full, dir }); sync.send({ type: "fs-change", path: inDir }); await refreshNode(inDir); if (!dir) openFile(full, basename(full)); } catch (e) { alert("Gagal: " + e.message); }
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
      if (clipboard.mode === "cut") clipboard = null;
      sync.send({ type: "fs-change", path: destDir });
      refreshNode(destDir); refreshTree();
    } catch (e) { alert("Paste gagal: " + e.message); }
  }
  async function doDuplicate(p) { try { const r = await api.post("/api/duplicate", { path: p }); sync.send({ type: "fs-change", path: parentOf(p) }); refreshNode(parentOf(p)); setStatus("digandakan: " + r.path); } catch (e) { alert("Gagal: " + e.message); } }
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
      sync.send({ type: "fs-change", path: refreshAt });
      refreshNode(refreshAt); refreshTree();
    } catch (e) { alert("Gagal: " + e.message); }
  }
  async function doDelete(it) { return doDeleteMany([it]); }
  async function doRename(it) { const n = await promptDlg("Nama baru:", it.name); if (!n) return; try { const to = (parentOf(it.path) ? parentOf(it.path) + "/" : "") + n; await api.post("/api/rename", { from: it.path, to }); sync.send({ type: "fs-change", path: parentOf(it.path) }); refreshNode(parentOf(it.path)); } catch (e) { alert("Gagal: " + e.message); } }
  function copyPath(it, absolute) { const p = absolute ? INFO.workspace + "/" + it.path : it.path; navigator.clipboard.writeText(p).then(() => setStatus("path disalin: " + p), () => setStatus("path: " + p)); }
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
      sync.send({ type: "fs-change", path: dest });
      await refreshNode(dest); refreshTree();
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
      sync.send({ type: "fs-change", path: parentOf(it.path) });
      await refreshNode(parentOf(it.path)); refreshTree();
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
      row.innerHTML = '<span class="twist"></span><span class="ic ' + (it.dir ? "ic-dir" : "ic-file") + '">&#9733;</span><span class="nm"></span>';
      row.querySelector(".nm").textContent = it.name; li.appendChild(row);
      row.addEventListener("click", () => { if (it.dir) addTerminal(null, it.path); else openFile(it.path, it.name); });
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ctxSimple(e, [["Buka", () => (it.dir ? addTerminal(null, it.path) : openFile(it.path, it.name))], ["Hapus dari Favorites", () => removeFav(it.path)]]); });
      ul.appendChild(li);
    });
  }
  renderFavs();

  // ===== Run =====
  function runActive() { const t = activeFileTab(); if (!t) return alert("Buka & pilih file dulu untuk di-Run."); saveActive().then(() => runFile(t.path)); }
  function runFile(p) {
    const ext = p.split(".").pop().toLowerCase();
    let cmd; if (ext === "py") cmd = "python3 " + q(p); else if (ext === "js") cmd = "node " + q(p); else if (ext === "sh") cmd = "bash " + q(p);
    else return alert("Belum ada runner untuk .*" + ext + " (dukung: py, js, sh)");
    addTerminal(cmd);
  }

  // ============================================================
  //  CONTEXT MENU (file tree)
  // ============================================================
  const ctx = $("#ctx");
  function hideCtx() { ctx.style.display = "none"; }
  function ctxSimple(e, items) { ctx.innerHTML = ""; items.forEach(([label, fn]) => { const d = document.createElement("div"); d.className = "item"; d.textContent = label; d.addEventListener("click", () => { hideCtx(); fn(); }); ctx.appendChild(d); }); placeCtx(e); }
  function placeCtx(e) { ctx.style.display = "block"; const w = ctx.offsetWidth, h = ctx.offsetHeight; ctx.style.left = Math.min(e.clientX, innerWidth - w - 6) + "px"; ctx.style.top = Math.min(e.clientY, innerHeight - h - 6) + "px"; }
  function showCtx(e, it) {
    ctx.innerHTML = "";
    const items = selectedItems();
    const single = items.length === 1;
    const dirForNew = it.dir ? it.path : parentOf(it.path);
    const runnable = single && !it.dir && ["py", "js", "sh"].includes(it.name.split(".").pop().toLowerCase());
    const add = (label, fn, opt) => {
      opt = opt || {};
      if (opt.sep) { const s = document.createElement("div"); s.className = "sep"; ctx.appendChild(s); }
      const d = document.createElement("div"); d.className = "item" + (opt.disabled ? " disabled" : "");
      d.innerHTML = "<span>" + label + "</span>" + (opt.key ? '<span class="key">' + opt.key + "</span>" : "");
      if (!opt.disabled) d.addEventListener("click", () => { hideCtx(); fn(); });
      ctx.appendChild(d);
    };
    if (items.length > 1) add(items.length + " items selected", () => {}, { disabled: true });
    add("Open", () => (it.dir ? expandPath(it.path) : openFile(it.path, it.name)), { disabled: !single });
    add(single ? "Download" : "Download " + items.length + " Items as ZIP",
      () => single ? download(it) : downloadArchive(items, "zip"));
    add("Download as ZIP", () => downloadArchive(items, "zip"), { sep: true });
    add("Download as TAR.GZ", () => downloadArchive(items, "tar.gz"));
    add("Compress to ZIP…", () => makeArchive(items, "zip"), { sep: true });
    add("Compress to TAR.GZ…", () => makeArchive(items, "tar.gz"));
    add("Extract Here", () => extractArchive(it), { disabled: !single || !isArchive(it.name) });
    add("Run", () => runFile(it.path), { disabled: !runnable });
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
    if (e.altKey && k === "l") { e.preventDefault(); addTerminal(null, curDir()); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "f") { e.preventDefault(); openSearch(curDir()); return; }
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
    let done = 0; setStatus("upload 0/" + files.length + " …");
    for (const f of files) { try { await api.upload(dest, f.path, f.file); } catch (err) { setStatus("upload gagal: " + f.path + " (" + err.message + ")"); } setStatus("upload " + ++done + "/" + files.length + " …"); }
    setStatus("upload selesai: " + files.length + " file ke /" + (dest || INFO.name));
    sync.send({ type: "fs-change", path: dest });
    refreshNode(dest); refreshTree();
  });
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
    const dest = curDir(); let done = 0; setStatus("upload 0/" + files.length + " …");
    for (const f of files) { try { await api.upload(dest, f.name, f); } catch (err) { setStatus("upload gagal: " + f.name); } setStatus("upload " + ++done + "/" + files.length + " …"); }
    setStatus("upload selesai: " + files.length + " file"); e.target.value = ""; sync.send({ type: "fs-change", path: dest }); refreshNode(dest); refreshTree();
  });

  // ============================================================
  //  SEARCH MODAL
  // ============================================================
  const sm = $("#search-modal");
  let searchScope = "";
  function openSearch(scope) { searchScope = scope || ""; $("#search-scope").textContent = "Cari di /" + (searchScope || INFO.name || "workspace"); $("#search-results").innerHTML = ""; sm.classList.add("open"); const i = $("#search-input"); i.value = ""; i.focus(); }
  function closeSearch() { sm.classList.remove("open"); }
  $("#search-close").addEventListener("click", closeSearch);
  sm.addEventListener("click", (e) => { if (e.target === sm) closeSearch(); });
  $("#search-go").addEventListener("click", runSearch);
  $("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); else if (e.key === "Escape") closeSearch(); });
  async function runSearch() {
    const term = $("#search-input").value.trim(); const box = $("#search-results");
    if (!term) return; box.innerHTML = '<div class="sr-empty">mencari…</div>';
    let res; try { res = await api.get("/api/search?path=" + enc(searchScope) + "&q=" + enc(term)); } catch (e) { box.innerHTML = '<div class="sr-empty">error: ' + e.message + "</div>"; return; }
    if (!res.length) { box.innerHTML = '<div class="sr-empty">tidak ada hasil</div>'; return; }
    box.innerHTML = ""; let cur = null;
    res.forEach((r) => {
      if (r.path !== cur) { cur = r.path; const h = document.createElement("div"); h.className = "sr-file"; h.textContent = r.path; box.appendChild(h); }
      const hit = document.createElement("div"); hit.className = "sr-hit";
      hit.innerHTML = '<span class="ln">' + r.line + "</span>"; hit.appendChild(document.createTextNode(r.text));
      hit.addEventListener("click", () => { closeSearch(); openFile(r.path, basename(r.path), r.line); });
      box.appendChild(hit);
    });
  }

  // ===== Activity bar =====
  document.querySelectorAll("#activitybar .act").forEach((a) => a.addEventListener("click", () => {
    document.querySelectorAll("#activitybar .act").forEach((x) => x.classList.remove("active")); a.classList.add("active");
    const v = a.dataset.view;
    if (v === "search") openSearch(curDir());
    else if (v === "navigate") promptDlg("Buka file (path relatif):", "").then((p) => { if (p) openFile(p, basename(p)); });
  }));

  // ============================================================
  //  VIEW STATE (gutter / wrap / font / dsb)
  // ============================================================
  const UIKEY = "c9clone.uistate";
  const ui = Object.assign(
    { openFiles: true, tabButtons: true, gutter: true, statusBar: true, wrap: false, wrapMargin: false, fontSize: 13 },
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
    setTimeout(() => { forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); }, 30);
  }
  function toggleUI(k) { ui[k] = !ui[k]; if (k === "wrapMargin" && ui.wrapMargin) ui.wrap = true; applyUIState(); }
  function setFont(n) { ui.fontSize = Math.min(30, Math.max(8, n)); Object.values(TERMS).forEach((t) => { try { t.term.setOption("fontSize", terminalFontSize()); } catch (e) {} }); applyUIState(); }
  function setSyntaxMode(m) { const t = activeFileTab(); if (!t) return; FILES[t.path].session.setMode("ace/mode/" + m); FILES[t.path].mode = m; setStatus(null, m); }

  // ============================================================
  //  MENU BAR
  // ============================================================
  const openPrefs = () => $("#prefs-modal").classList.add("open");
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
      { label: "Find in Files…", key: "Ctrl-Shift-F", act: () => openSearch(curDir()) },
    ],
    view: () => [
      { label: "Open Files", check: ui.openFiles, act: () => toggleUI("openFiles") },
      { label: "New Terminal", key: "F6", act: () => addTerminal() },
      { sep: 1 },
      { label: "Tab Buttons", check: ui.tabButtons, act: () => toggleUI("tabButtons") },
      { label: "Gutter", check: ui.gutter, act: () => toggleUI("gutter") },
      { label: "Status Bar", check: ui.statusBar, act: () => toggleUI("statusBar") },
      { sep: 1 },
      { label: "Split", sub: [
        { label: "Split Active Pane to 4", act: splitActiveToFour },
        { sep: 1 },
        { label: "Split Right (Terminal)", act: () => splitActiveWithTerminal("right") },
        { label: "Split Left (Terminal)", act: () => splitActiveWithTerminal("left") },
        { label: "Split Down (Terminal)", act: () => splitActiveWithTerminal("bottom") },
        { label: "Split Up (Terminal)", act: () => splitActiveWithTerminal("top") },
      ] },
      { label: "Font Size", sub: [
        { label: "Increase Font Size", act: () => setFont(ui.fontSize + 1) },
        { label: "Decrease Font Size", act: () => setFont(ui.fontSize - 1) },
        { label: "Reset Font Size", act: () => setFont(13) },
      ] },
      { label: "Syntax", sub: MODES.map((m) => ({ label: m, check: (activeFileTab() ? FILES[activeFileTab().path].mode : "") === m, act: () => setSyntaxMode(m) })) },
      { label: "Themes", sub: [
        { label: "Flat Dark", check: document.body.dataset.uiTheme === "flat-dark", act: () => applyUITheme("flat-dark") },
        { label: "Flat Light", check: document.body.dataset.uiTheme === "flat-light", act: () => applyUITheme("flat-light") },
        { label: "Classic Dark", check: document.body.dataset.uiTheme === "classic-dark", act: () => applyUITheme("classic-dark") },
        { label: "Classic Gray", check: document.body.dataset.uiTheme === "classic-gray", act: () => applyUITheme("classic-gray") },
        { sep: 1 },
        { label: "Syntax Theme…", act: openPrefs },
      ] },
      { sep: 1 },
      { label: "Wrap Lines", check: ui.wrap, act: () => toggleUI("wrap") },
      { label: "Wrap To Print Margin", check: ui.wrapMargin, act: () => toggleUI("wrapMargin") },
    ],
    goto: () => [
      { label: "Go To Line…", key: "Ctrl-G", act: goToLineDlg },
      { label: "Go To File…", act: () => promptDlg("Buka file (path relatif):", "").then((p) => { if (p) openFile(p, basename(p)); }) },
    ],
    run: () => [
      { label: "Run", act: runActive },
      { label: "Run File Terpilih (tree)", act: () => selNode && !selNode.dir && runFile(selNode.path) },
    ],
    tools: () => [
      { label: "New Terminal Here", key: "Alt-L", act: () => addTerminal(null, curDir()) },
      { label: "Preferences…", act: openPrefs },
    ],
    window: () => [
      { label: "New Terminal", act: () => addTerminal() },
      { label: "Split", sub: [
        { label: "Split Active Pane to 4", act: splitActiveToFour },
        { sep: 1 },
        { label: "Terminal → Right", act: () => splitActiveWithTerminal("right") },
        { label: "Terminal → Left", act: () => splitActiveWithTerminal("left") },
        { label: "Terminal → Down", act: () => splitActiveWithTerminal("bottom") },
        { label: "Terminal → Up", act: () => splitActiveWithTerminal("top") },
      ] },
      { sep: 1 },
      { label: "Preferences…", act: openPrefs },
    ],
  };
  const pop = $("#menu-pop");
  let openMenuName = null;
  function closeMenus() { pop.classList.remove("open"); pop.innerHTML = ""; document.querySelectorAll("#menubar .menu.open").forEach((m) => m.classList.remove("open")); openMenuName = null; }
  function buildItems(container, items, topLevel) {
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement("div"); s.className = "sep"; container.appendChild(s); return; }
      const d = document.createElement("div"); d.className = "mi";
      d.innerHTML = (it.check ? '<span class="chk">&#10004;</span>' : "") + '<span class="lbl"></span>' + (it.sub ? '<span class="arrow">&#9654;</span>' : it.key ? '<span class="key">' + it.key + "</span>" : "");
      d.querySelector(".lbl").textContent = it.label;
      if (it.sub) {
        const subEl = document.createElement("div"); subEl.className = "submenu"; buildItems(subEl, it.sub, false); pop.appendChild(subEl);
        d.addEventListener("mouseenter", () => {
          pop.querySelectorAll(".submenu.open").forEach((x) => x.classList.remove("open")); subEl.classList.add("open");
          const r = d.getBoundingClientRect();
          subEl.style.left = Math.min(r.right, innerWidth - subEl.offsetWidth - 6) + "px";
          subEl.style.top = Math.min(r.top - 4, innerHeight - subEl.offsetHeight - 6) + "px";
        });
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
  window.addEventListener("click", (e) => { if (!e.target.closest("#menu-pop") && !e.target.closest("#menubar .menu")) closeMenus(); });
  document.querySelector(".mb-run").addEventListener("click", runActive);

  // ============================================================
  //  PREFERENCES
  // ============================================================
  const ACE_THEMES = ["ambiance", "chaos", "chrome", "clouds", "clouds_midnight", "cobalt", "dawn", "dracula", "dreamweaver", "eclipse", "github", "gob", "gruvbox", "idle_fingers", "kr_theme", "kuroir", "merbivore", "merbivore_soft", "monokai", "nord_dark", "pastel_on_dark", "solarized_dark", "solarized_light", "sqlserver", "terminal", "textmate", "tomorrow", "tomorrow_night", "tomorrow_night_blue", "tomorrow_night_bright", "tomorrow_night_eighties", "twilight", "vibrant_ink", "xcode"];
  (function fillSyntax() { const s = $("#syntax-theme"); ACE_THEMES.forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); s.appendChild(o); }); })();
  function applyUITheme(name) {
    document.body.dataset.uiTheme = name; localStorage.setItem("c9clone.ui", name);
    document.querySelectorAll(".sw").forEach((sw) => sw.classList.toggle("active", sw.dataset.theme === name));
    const th = currentTermTheme(); Object.values(TERMS).forEach((t) => { try { t.term.setOption("theme", th); } catch (e) {} });
    setTimeout(() => { forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); }, 20);
  }
  function applySyntaxTheme(name) { forEachEditor((ed) => ed.setTheme("ace/theme/" + name)); localStorage.setItem("c9clone.syntax", name); const s = $("#syntax-theme"); if (s) s.value = name; }
  $("#gear").addEventListener("click", openPrefs);
  $("#prefs-close").addEventListener("click", () => $("#prefs-modal").classList.remove("open"));
  $("#prefs-modal").addEventListener("click", (e) => { if (e.target.id === "prefs-modal") e.currentTarget.classList.remove("open"); });
  document.querySelectorAll(".sw").forEach((sw) => sw.addEventListener("click", () => applyUITheme(sw.dataset.theme)));
  $("#syntax-theme").addEventListener("change", (e) => applySyntaxTheme(e.target.value));

  // ============================================================
  //  REALTIME SESSION
  // ============================================================
  applyUITheme(localStorage.getItem("c9clone.ui") || "flat-dark");
  const savedSyntax = localStorage.getItem("c9clone.syntax") || "tomorrow_night_blue";
  const AceRange = ace.require("ace/range").Range;

  function updateSyncStatus(value) {
    const el = $("#sync-status"); if (!el) return;
    el.className = "sync-status " + value;
    el.textContent = value === "online" ? "Realtime" : value === "connecting" ? "Connecting…" : "Offline";
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
    if (file.session.getValue() !== nextContent) {
      const positions = [];
      walkLeaves(layout, (leaf) => {
        if (leaf._ed && leaf._ed.getSession() === file.session) {
          positions.push({ ed: leaf._ed, pos: leaf._ed.getCursorPosition() });
        }
      });
      file.applying = true;
      file.session.setValue(nextContent);
      file.applying = false;
      positions.forEach((x) => x.ed.moveCursorToPosition(x.pos));
    }
    file.revision = Number(doc.revision) || 0;
    file.dirty = !!doc.dirty;
    file.inflight = false;
    file.sentContent = nextContent;
    renderAllTabbars(); renderOpenFiles();
  }

  function activateRestoredLeaves(wantedActiveId) {
    let selected = null;
    walkLeaves(layout, (leaf) => {
      if (leaf.tabs.length && !leaf.tabs.some((t) => t.id === leaf.active)) leaf.active = leaf.tabs[0].id;
      if (leaf.active != null) setActiveTab(leaf, leaf.active);
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
        });
      });
      await Promise.all(loads.map((p) => p.catch(() => null)));
      renderLayout();
      activateRestoredLeaves(message.activeLeafId);
      applySyntaxTheme(savedSyntax);
      applyUIState();
    } finally {
      applyingRemote = false;
    }
  }

  async function initializeSession(snapshot) {
    if (syncInitialized) return;
    const state = snapshot.state || {};
    Object.keys(state.terminals || {}).forEach((id) => { TERMINAL_META[id] = state.terminals[id]; });
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
  }

  sync.on("status", (msg) => updateSyncStatus(msg.value));
  sync.on("snapshot", initializeSession);
  sync.on("layout", (msg) => applySharedLayout(msg));
  sync.on("doc", (msg) => {
    if (msg.doc) applyRemoteDoc(msg.doc);
  });
  sync.on("doc-ack", (msg) => {
    const file = FILES[msg.path]; if (!file) return;
    file.revision = Number(msg.revision) || file.revision;
    file.inflight = false;
    file.dirty = !!msg.dirty;
    const changedAgain = file.session.getValue() !== file.sentContent;
    renderAllTabbars(); renderOpenFiles();
    if (changedAgain || file.queued) flushDocChange(msg.path);
  });
  sync.on("doc-conflict", (msg) => {
    if (msg.doc) applyRemoteDoc(msg.doc);
    setStatus("Perubahan disinkron ulang karena revision conflict");
  });
  sync.on("cursor", (msg) => {
    if (msg.cursor && msg.cursor.clientId !== sync.clientId) applyRemoteCursor(msg.cursor);
  });
  sync.on("presence-leave", (msg) => removeRemoteCursor(msg.clientId));
  sync.on("terminal-meta", (msg) => {
    if (msg.action === "created" && msg.terminal) TERMINAL_META[msg.terminal.id] = msg.terminal;
    if (msg.action === "closed") {
      disposeTerminalView(msg.id);
      delete TERMINAL_META[msg.id];
    }
  });
  sync.on("fs-change", () => refreshTree());
  sync.on("error", (msg) => setStatus("Realtime error: " + msg.message));

  window.addEventListener("resize", () => { forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); });

  // ===== Dragbar sidebar =====
  function dragify(bar, cb) { bar.addEventListener("mousedown", (e) => { e.preventDefault(); let lx = e.clientX; const mv = (ev) => { cb(ev.clientX - lx); lx = ev.clientX; }; const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }; document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up); }); }
  dragify($("#drag-x"), (dx) => { const sb = $("#sidebar"); sb.style.width = Math.min(600, Math.max(140, sb.offsetWidth + dx)) + "px"; forEachEditor((ed) => ed.resize()); Object.values(TERMS).forEach(fitVisibleTerminal); });
})();
