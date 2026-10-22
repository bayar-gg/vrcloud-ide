"use strict";

/**
 * Tool `diagnostics` untuk agent: error dan peringatan dari language server untuk satu file.
 *
 * Sebelum ini LspManager hanya mengisi konteks prompt; agent tidak punya cara menanyakan
 * "apakah file yang baru kuedit masih valid?" selain menjalankan tsc/pyright sendiri lewat
 * shell. Tool ini membuat pemeriksaan itu murah (sub-detik, tanpa proses baru), sehingga
 * lebih sering dilakukan — dan hasilnya dihitung sebagai bukti oleh penegak todo.
 *
 * Jujur saat tidak bisa: tanpa server untuk bahasa itu, jawabannya "tidak tersedia, pakai
 * compiler/linter lewat shell", bukan "tidak ada error".
 */

const fs = require("fs");
const Instructions = require("./agent-instructions");

const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function text(t, structured) {
  const out = { content: [{ type: "text", text: t }] };
  if (structured) out.structuredContent = structured;
  return out;
}

function formatDiagnostic(d) {
  const r = d && d.range && d.range.start ? d.range.start : null;
  const where = r ? ":" + ((r.line | 0) + 1) + ":" + ((r.character | 0) + 1) : "";
  const sev = SEVERITY[d && d.severity] || "info";
  const code = d && d.code != null ? " [" + d.code + "]" : "";
  return where + " " + sev + code + ": " + String((d && d.message) || "").replace(/\s+/g, " ").trim();
}

function createLspTools(lsp, options) {
  if (!lsp) return {};
  options = options || {};
  const waitMs = Math.max(500, Number(options.waitMs) || 4000);
  return {
    diagnostics: {
      description: Instructions.tool("diagnostics"),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path of the file to check" },
          max: { type: "integer", minimum: 1, maximum: 200, description: "Maximum diagnostics to return (default 50)" },
        },
        required: ["path"],
      },
      annotations: { title: "Diagnostics", readOnlyHint: true },
      execute: async (args) => {
        args = args || {};
        const rel = lsp.normalize(args.path);
        if (!rel) throw new Error("path must be a file inside the workspace");
        const key = lsp.profileKey(rel);
        if (!key) {
          return text("No language server is configured for " + rel + " (supported: JavaScript/TypeScript, Python, Go, Rust). " +
            "Run the language's compiler, linter, or test via shell to check this file.", { path: rel, available: false, diagnostics: [] });
        }
        const abs = lsp.absolute(rel);
        let content;
        try { content = fs.readFileSync(abs, "utf8"); }
        catch (e) { throw new Error("Cannot read " + rel + ": " + (e && e.message)); }
        const startedAt = Date.now();
        // didOpen mengirim didChange bila dokumen sudah terbuka: server selalu melihat isi
        // terbaru dari disk, bukan versi yang diingat dari pembukaan sebelumnya.
        let ok = false;
        try { ok = await lsp.didOpen(rel, content); } catch (e) { ok = false; }
        if (!ok) {
          const st = (lsp.status().servers || {})[key] || {};
          const why = st.error || (st.status === "failed" ? "the server failed to start" : "the server is not installed or not running");
          return text("The " + key + " language server is unavailable (" + why + "). " +
            "Run the compiler, linter, or test via shell to check " + rel + " instead.", { path: rel, available: false, diagnostics: [] });
        }
        // Tunggu publishDiagnostics yang lebih baru dari permintaan ini. Server mengirim
        // daftar kosong saat file bersih, jadi "tidak ada entri baru" berarti server lambat.
        let entry = null;
        const deadline = startedAt + waitMs;
        while (Date.now() < deadline) {
          entry = lsp.diagnosticsCache.get(rel) || null;
          if (entry && entry.updatedAt >= startedAt) break;
          await sleep(80);
        }
        const fresh = !!(entry && entry.updatedAt >= startedAt);
        const list = entry && Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
        const max = Math.max(1, Math.min(200, parseInt(args.max, 10) || 50));
        const errors = list.filter((d) => d && d.severity === 1).length;
        const warnings = list.filter((d) => d && d.severity === 2).length;
        const head = rel + ": " + (list.length ? errors + " error(s), " + warnings + " warning(s)" + (list.length - errors - warnings ? ", " + (list.length - errors - warnings) + " other" : "") : "no diagnostics") +
          (fresh ? "" : (entry ? " (cached result; the server did not respond within " + Math.round(waitMs / 1000) + "s)" : " (no result from the server within " + Math.round(waitMs / 1000) + "s)"));
        const lines = list.slice(0, max).map((d) => "  " + rel + formatDiagnostic(d));
        if (list.length > max) lines.push("  \u2026 " + (list.length - max) + " more");
        return text([head].concat(lines).join("\n"), {
          path: rel, available: true, fresh, errors, warnings,
          diagnostics: list.slice(0, max).map((d) => ({
            severity: SEVERITY[d && d.severity] || "info", message: d && d.message, code: d && d.code,
            line: d && d.range && d.range.start ? (d.range.start.line | 0) + 1 : null,
            character: d && d.range && d.range.start ? (d.range.start.character | 0) + 1 : null,
          })),
        });
      },
    },
  };
}

module.exports = createLspTools;
