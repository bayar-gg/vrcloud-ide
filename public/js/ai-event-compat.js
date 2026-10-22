(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VRCloudAiEventCompat = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var LABELS = {
    role: {
      planner: ["Perencana", "Planner"],
      explorer: ["Penjelajah", "Explorer"],
      implementer: ["Pelaksana", "Implementer"],
      repairer: ["Perbaikan", "Repairer"],
      finalizer: ["Penyelesai", "Finalizer"],
      verifier: ["Verifikator", "Verifier"],
      worker: ["Worker", "Worker"],
    },
    phase: {
      planner: ["Perencanaan", "Planning"],
      planning: ["Perencanaan", "Planning"],
      exploration: ["Eksplorasi", "Exploration"],
      implementation: ["Implementasi", "Implementation"],
      repair: ["Perbaikan", "Repair"],
      verification: ["Verifikasi", "Verification"],
      verifier: ["Verifikasi", "Verification"],
      finalization: ["Finalisasi", "Finalization"],
    },
    status: {
      running: ["Berjalan", "Running"],
      finished: ["Selesai", "Finished"],
      completed: ["Selesai", "Completed"],
      passed: ["Lulus", "Passed"],
      failed: ["Gagal", "Failed"],
      error: ["Gagal", "Error"],
      skipped: ["Dilewati", "Skipped"],
      cancelled: ["Dibatalkan", "Cancelled"],
      "verification-failed": ["Verifikasi gagal", "Verification failed"],
      unknown: ["Tidak diketahui", "Unknown"],
    },
    activity: {
      "planning the work": ["Menyusun rencana kerja", "Planning the work"],
      "inspecting the codebase": ["Memeriksa basis kode", "Inspecting the codebase"],
      "implementing changes": ["Menerapkan perubahan", "Implementing changes"],
      "repairing verification failures": ["Memperbaiki kegagalan verifikasi", "Repairing verification failures"],
      "running verification": ["Menjalankan verifikasi", "Running verification"],
      "composing the final response": ["Menyusun jawaban akhir", "Composing the final response"],
      "updating the work plan": ["Memperbarui rencana kerja", "Updating the work plan"],
      "searching the workspace": ["Mencari di workspace", "Searching the workspace"],
      "checking diagnostics": ["Memeriksa diagnostik", "Checking diagnostics"],
      "running a command": ["Menjalankan perintah", "Running a command"],
      "inspecting web resources": ["Memeriksa sumber web", "Inspecting web resources"],
      working: ["Bekerja", "Working"],
    },
  };

  function canonicalType(value) {
    var type = String(value || "");
    if (type === "orchestration-worker") return "worker";
    if (type === "verify" || type === "verifier") return "verification";
    if (type === "orchestration-result") return "result";
    return type;
  }

  function humanize(value) {
    var text = String(value == null ? "" : value).replace(/[_-]+/g, " ").trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  function orchestrationLabel(kind, value, lang) {
    kind = String(kind || "");
    var key = String(value == null ? "" : value).toLowerCase();
    var pair = LABELS[kind] && LABELS[kind][key];
    return pair ? pair[lang === "en" ? 1 : 0] : humanize(value);
  }

  function normalizeWorkerEvent(value) {
    value = value && typeof value === "object" ? value : {};
    var nested = value.value && typeof value.value === "object" ? value.value : {};
    var out = Object.assign({}, nested, value);
    delete out.value;
    if (!out.eventKind) out.eventKind = "end";
    if ((out.eventKind === "start" || out.eventKind === "progress") && !out.status) out.status = "running";
    if (out.durationMs == null && out.eventKind === "end" && out.elapsedMs != null) out.durationMs = out.elapsedMs;
    if (!Array.isArray(out.touchedFiles)) out.touchedFiles = [];
    return out;
  }

  function workerStatus(value) {
    var event = normalizeWorkerEvent(value);
    if (event.eventKind === "start" || event.eventKind === "progress") return "running";
    return String(event.status || "finished").toLowerCase();
  }

  function workerActivity(value, lang) {
    var event = normalizeWorkerEvent(value);
    var activity = String(event.activity || "");
    var key = activity.toLowerCase();
    var pair = LABELS.activity[key];
    if (pair) return pair[lang === "en" ? 1 : 0];
    var prefixed = [
      ["Reading ", "Membaca ", "Reading "],
      ["Editing ", "Mengedit ", "Editing "],
      ["Removing ", "Menghapus ", "Removing "],
      ["Using ", "Menggunakan ", "Using "],
    ];
    for (var i = 0; i < prefixed.length; i++) {
      if (activity.indexOf(prefixed[i][0]) === 0) return (lang === "en" ? prefixed[i][2] : prefixed[i][1]) + activity.slice(prefixed[i][0].length);
    }
    return activity || orchestrationLabel("phase", event.phase || event.role || "worker", lang);
  }

  function workerMetrics(value, lang) {
    var event = normalizeWorkerEvent(value);
    var tools = Math.max(0, Number(event.toolCount) || 0);
    var elapsed = Math.max(0, Number(event.durationMs != null ? event.durationMs : event.elapsedMs) || 0);
    var seconds = Math.max(0, Math.floor(elapsed / 1000));
    return {
      tools: tools,
      elapsedMs: elapsed,
      elapsedText: seconds + "s",
      toolsText: tools + " " + (lang === "en" ? (tools === 1 ? "tool" : "tools") : "alat"),
    };
  }

  function shouldUseNarrowLayout(panelWidth, viewportWidth, threshold) {
    var panel = Number(panelWidth);
    var viewport = Number(viewportWidth);
    var width = panel > 0 && viewport > 0 ? Math.min(panel, viewport) : (panel > 0 ? panel : viewport);
    return width > 0 && width < (Number(threshold) || 600);
  }

  function lspSummary(lsp, lang) {
    var counts = { active: 0, retrying: 0, unavailable: 0, failed: 0, starting: 0, idle: 0 };
    var servers = lsp && lsp.servers || {};
    Object.keys(servers).forEach(function (key) {
      var status = String(servers[key] && servers[key].status || "idle").toLowerCase();
      if (status === "running") counts.active++;
      else if (status === "backoff") counts.retrying++;
      else if (status === "unavailable") counts.unavailable++;
      else if (status === "failed" || status === "error") counts.failed++;
      else if (status === "starting" || status === "detecting") counts.starting++;
      else counts.idle++;
    });
    var labels = lang === "en"
      ? { active: "active", retrying: "retrying", unavailable: "unavailable", failed: "failed", starting: "starting", idle: "idle", none: "not configured" }
      : { active: "aktif", retrying: "jeda ulang", unavailable: "tidak tersedia", failed: "gagal", starting: "memulai", idle: "menunggu", none: "belum dikonfigurasi" };
    var parts = [];
    ["active", "retrying", "unavailable", "failed", "starting", "idle"].forEach(function (key) {
      if (counts[key]) parts.push(counts[key] + " " + labels[key]);
    });
    return { counts: counts, text: parts.join(" \u00b7 ") || labels.none };
  }

  function structuredMemoryReviewCount(status) {
    var counts = status && status.counts || {};
    // The settings list requests active + stale records. Invalid/superseded
    // records stay hidden, so they must not inflate the visible review count.
    return Math.max(0, Number(counts.stale) || 0);
  }

  function structuredMemorySummary(status, lang) {
    var counts = status && status.counts;
    if (!counts) return "\u2014";
    var active = Math.max(0, Number(counts.active) || 0);
    var review = structuredMemoryReviewCount(status);
    return lang === "en"
      ? active + " active \u00b7 " + review + " need review"
      : active + " aktif \u00b7 " + review + " perlu tinjau";
  }

  function normalizeBlock(block) {
    if (!block || typeof block !== "object") return null;
    var type = canonicalType(block.type || block.kind || block.t);
    if (!type) return block;
    var normalized = Object.assign({}, block, { type: type });
    if (!Object.prototype.hasOwnProperty.call(normalized, "value")) {
      if (Object.prototype.hasOwnProperty.call(block, "v")) normalized.value = block.v;
      else if (Object.prototype.hasOwnProperty.call(block, "val")) normalized.value = block.val;
      else if (type === "worker" || type === "verification" || type === "result") normalized.value = block;
    }
    if (type === "worker") normalized.value = normalizeWorkerEvent(normalized.value);
    return normalized;
  }

  function blocksOf(message) {
    var m = message || {};
    if (Array.isArray(m.blocks) && m.blocks.length) return m.blocks.map(normalizeBlock).filter(Boolean);
    var out = [];
    if (m.think) out.push({ type: "think", text: m.think });
    if (Array.isArray(m.plan) && m.plan.length) out.push({ type: "plan", todos: m.plan });
    (m.tools || []).forEach(function (tool) { out.push({ type: "tool", tool: tool }); });
    if (m.orchestration) {
      (m.orchestration.workers || []).forEach(function (worker) {
        out.push({ type: "worker", value: Object.assign({ eventKind: "end" }, worker) });
      });
      if (m.orchestration.verification) out.push({ type: "verification", value: m.orchestration.verification });
      out.push({ type: "result", value: {
        runId: m.orchestration.runId,
        status: m.orchestration.status,
        verification: m.orchestration.verification,
      } });
    }
    if (m.text) out.push({ type: "text", text: m.text });
    return out;
  }

  function normalizeFrame(frame) {
    if (!frame || typeof frame !== "object") return null;
    var type = canonicalType(frame.t || frame.type || frame.kind);
    var value = Object.prototype.hasOwnProperty.call(frame, "v") ? frame.v
      : Object.prototype.hasOwnProperty.call(frame, "value") ? frame.value : frame.val;
    if (!type) return null;
    if (type === "worker") value = normalizeWorkerEvent(value);
    return { type: type, value: value };
  }

  return {
    blocksOf: blocksOf,
    normalizeFrame: normalizeFrame,
    orchestrationLabel: orchestrationLabel,
    normalizeWorkerEvent: normalizeWorkerEvent,
    workerStatus: workerStatus,
    workerActivity: workerActivity,
    workerMetrics: workerMetrics,
    shouldUseNarrowLayout: shouldUseNarrowLayout,
    lspSummary: lspSummary,
    structuredMemoryReviewCount: structuredMemoryReviewCount,
    structuredMemorySummary: structuredMemorySummary,
  };
});
