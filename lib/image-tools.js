"use strict";

/**
 * Tool `generate_image`: membuat atau mengedit gambar lewat Grok Imagine (API xAI yang
 * kompatibel OpenAI: POST /v1/images/generations dan /v1/images/edits) lalu menyimpannya
 * ke workspace, supaya agent bisa langsung memakainya (aset UI, ikon, ilustrasi, mockup).
 *
 * Hanya didaftarkan saat model aktif memang bisa membuat gambar (lihat AiChat.imageSupport):
 * provider Grok memakai sesi loginnya, provider lain hanya bila XAI_API_KEY diisi. Provider
 * Cursor tidak memakai tool ini — SDK-nya sudah punya generateImage bawaan.
 *
 * getAuth() -> { token, bases: [baseUrl...], headers?: (base, token) => {} } | null
 */

const fs = require("fs");
const path = require("path");
const Instructions = require("./agent-instructions");

const DEFAULT_MODELS = ["grok-imagine-image-2.0", "grok-imagine-image", "grok-2-image-1212", "grok-2-image"];
const MODEL_TTL_MS = 30 * 60 * 1000;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const SOURCE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function sniffExt(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "gif";
  return "";
}

function slug(text) {
  const s = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "image";
}

function toPosix(p) { return String(p || "").replace(/\\/g, "/"); }

function previewUrl(rel) {
  return "/preview/" + toPosix(rel).split("/").map(encodeURIComponent).join("/");
}

class ImageGenerator {
  constructor(options) {
    options = options || {};
    this.workspace = path.resolve(options.workspace || process.cwd());
    this.getAuth = typeof options.getAuth === "function" ? options.getAuth : async () => null;
    this.fetch = options.fetch || ((url, init) => fetch(url, init));
    this.defaultDir = toPosix(options.defaultDir || "generated/images");
    this.timeoutMs = Math.max(5000, Number(options.timeoutMs) || 120000);
    this.models = null;
    this.modelsAt = 0;
    this.modelsBase = "";
  }

  // Path relatif workspace -> absolut, menolak apa pun di luar workspace (termasuk lewat symlink).
  resolveInside(rel) {
    const clean = toPosix(rel).replace(/^\.\/+/, "");
    if (!clean || path.isAbsolute(clean) || clean.split("/").includes("..")) throw new Error("path must be a workspace-relative path without '..': " + rel);
    const abs = path.resolve(this.workspace, clean);
    if (abs !== this.workspace && !abs.startsWith(this.workspace + path.sep)) throw new Error("path is outside the workspace: " + rel);
    let probe = path.dirname(abs);
    while (probe.startsWith(this.workspace) && !fs.existsSync(probe)) probe = path.dirname(probe);
    try {
      const real = fs.realpathSync(probe), root = fs.realpathSync(this.workspace);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error("path resolves outside the workspace: " + rel);
    } catch (e) { if (/outside/.test(e.message)) throw e; }
    return abs;
  }

  headers(auth, base) {
    const h = typeof auth.headers === "function" ? auth.headers(base, auth.token) : null;
    return Object.assign({ authorization: "Bearer " + auth.token, "content-type": "application/json", accept: "application/json" }, h || {});
  }

  async request(auth, route, init, signal) {
    let lastErr = null;
    for (const base of auth.bases) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      const onAbort = () => ac.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await this.fetch(base + route, Object.assign({}, init, { headers: this.headers(auth, base), signal: ac.signal }));
        if (res.ok) return { res, base };
        let text = "";
        try { text = await res.text(); } catch (e) {}
        let msg = text;
        try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type || j.error)) || j.message || text; } catch (e) {}
        lastErr = Object.assign(new Error("xAI image API " + res.status + ": " + String(msg || res.statusText).slice(0, 500)), { status: res.status });
        // 403/404 pada satu base (mis. token login tidak berlaku di api.x.ai) -> coba base berikutnya.
        if (res.status !== 403 && res.status !== 404) throw lastErr;
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error(signal && signal.aborted ? "cancelled" : "image request timed out after " + Math.round(this.timeoutMs / 1000) + "s");
        if (e && e.status && e.status !== 403 && e.status !== 404) throw e;
        lastErr = e;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
    throw lastErr || new Error("no image API endpoint reachable");
  }

  // Model gambar yang tersedia untuk akun ini (GET /image-generation-models), di-cache.
  async listModels(auth, signal) {
    if (this.models && Date.now() - this.modelsAt < MODEL_TTL_MS) return this.models;
    let ids = [];
    try {
      const { res } = await this.request(auth, "/image-generation-models", { method: "GET" }, signal);
      const j = await res.json();
      const arr = Array.isArray(j.models) ? j.models : (Array.isArray(j.data) ? j.data : []);
      ids = arr.map((m) => String((m && (m.id || m.name)) || "")).filter(Boolean);
    } catch (e) { ids = []; }
    const ranked = ids.length
      ? ids.slice().sort((a, b) => rank(a) - rank(b))
      : DEFAULT_MODELS.slice();
    this.models = ranked;
    this.modelsAt = Date.now();
    return ranked;
    function rank(id) { const i = DEFAULT_MODELS.indexOf(id); return i === -1 ? (/imagine/i.test(id) ? 10 : 50) : i; }
  }

  async fetchImage(url, signal) {
    const res = await this.fetch(url, { signal });
    if (!res.ok) throw new Error("could not download the generated image (HTTP " + res.status + ")");
    return Buffer.from(await res.arrayBuffer());
  }

  sourceImage(rel) {
    const abs = this.resolveInside(rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error("not a file: " + rel);
    if (st.size > MAX_SOURCE_BYTES) throw new Error("source image is larger than 10 MB: " + rel);
    const buf = fs.readFileSync(abs);
    const ext = sniffExt(buf);
    const mime = ext ? SOURCE_MIME["." + (ext === "jpg" ? "jpeg" : ext)] : SOURCE_MIME[path.extname(abs).toLowerCase()];
    if (!mime) throw new Error("unsupported source image type (use PNG, JPEG, WebP or GIF): " + rel);
    return "data:" + mime + ";base64," + buf.toString("base64");
  }

  outputPaths(args, count, ext) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    let base;
    if (args.path) {
      const p = toPosix(args.path).replace(/^\.\/+/, "");
      base = /\.[a-z0-9]{2,5}$/i.test(p) ? p.replace(/\.[a-z0-9]{2,5}$/i, "") : p;
    } else base = this.defaultDir + "/" + slug(args.prompt) + "-" + stamp;
    const out = [];
    for (let i = 0; i < count; i++) out.push(base + (count > 1 ? "-" + (i + 1) : "") + "." + ext);
    return out;
  }

  async generate(args, signal) {
    args = args || {};
    const prompt = String(args.prompt || "").trim();
    if (!prompt) throw new Error("prompt is empty");
    if (prompt.length > 4000) throw new Error("prompt is too long (max 4000 characters)");
    const auth = await this.getAuth();
    if (!auth || !auth.token || !Array.isArray(auth.bases) || !auth.bases.length) {
      throw new Error("Image generation is not available: sign in with Grok in the AI settings, or set XAI_API_KEY on the server.");
    }
    const n = Math.max(1, Math.min(4, parseInt(args.n, 10) || 1));
    const sources = (Array.isArray(args.source_images) ? args.source_images : (args.source_image ? [args.source_image] : []))
      .map(String).filter(Boolean).slice(0, 5);
    const sourceData = sources.map((rel) => this.sourceImage(rel));
    const models = args.model ? [String(args.model)] : await this.listModels(auth, signal);
    const route = sourceData.length ? "/images/edits" : "/images/generations";
    let body = { prompt, n, response_format: "b64_json" };
    if (args.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio);
    if (sourceData.length === 1) body.image = { url: sourceData[0], type: "image_url" };
    else if (sourceData.length > 1) body.image = sourceData.map((u) => ({ url: u, type: "image_url" }));

    let payload = null, usedModel = "", lastErr = null;
    for (const model of models.slice(0, 4)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { res } = await this.request(auth, route, { method: "POST", body: JSON.stringify(Object.assign({ model }, body)) }, signal);
          payload = await res.json();
          usedModel = model;
          break;
        } catch (e) {
          lastErr = e;
          const msg = String(e && e.message || "");
          // Parameter opsional ditolak oleh model ini: kirim ulang tanpa parameter itu.
          if (e.status === 400 && body.aspect_ratio && /aspect/i.test(msg)) { body = Object.assign({}, body); delete body.aspect_ratio; continue; }
          if (e.status === 400 && body.response_format && /response_format/i.test(msg)) { body = Object.assign({}, body); delete body.response_format; continue; }
          break;
        }
      }
      if (payload) break;
      const st = lastErr && lastErr.status;
      // Model tidak ada / tidak diizinkan -> coba model berikutnya; selain itu berhenti.
      if (!(st === 404 || (st === 400 && /model/i.test(String(lastErr.message))) || st === 403)) break;
    }
    if (!payload) throw lastErr || new Error("image generation failed");

    const items = Array.isArray(payload.data) ? payload.data : [];
    if (!items.length) throw new Error("the image API returned no images");
    const buffers = [];
    for (const it of items.slice(0, n)) {
      if (it && it.b64_json) buffers.push({ buf: Buffer.from(it.b64_json, "base64"), revised: it.revised_prompt || "" });
      else if (it && it.url) buffers.push({ buf: await this.fetchImage(it.url, signal), revised: it.revised_prompt || "" });
    }
    if (!buffers.length) throw new Error("the image API response had no image data");
    const ext = sniffExt(buffers[0].buf) || "png";
    const rels = this.outputPaths(Object.assign({}, args, { prompt }), buffers.length, ext);
    const images = buffers.map((b, i) => {
      const rel = rels[i];
      const abs = this.resolveInside(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, b.buf);
      return { path: rel, url: previewUrl(rel), bytes: b.buf.length, revisedPrompt: b.revised || undefined };
    });
    return { model: usedModel, mode: sourceData.length ? "edit" : "generate", sources, images };
  }
}

function createImageTools(options) {
  const gen = options instanceof ImageGenerator ? options : new ImageGenerator(options);
  return {
    generate_image: {
      description: Instructions.tool("generate_image"),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What the image should show: subject, style, composition, colours, text to render. Be specific." },
          path: { type: "string", description: "Workspace-relative output path, e.g. public/img/hero.png (extension is set from the actual format). Default: generated/images/<prompt-slug>-<time>." },
          n: { type: "integer", minimum: 1, maximum: 4, description: "Number of variations (default 1)" },
          aspect_ratio: { type: "string", description: "Optional, e.g. 1:1, 16:9, 9:16, 4:3" },
          source_images: { type: "array", items: { type: "string" }, description: "Optional workspace image paths to EDIT or combine (up to 5); the prompt describes the change" },
        },
        required: ["prompt"],
      },
      annotations: { title: "Generate image", readOnlyHint: false, openWorldHint: true },
      execute: async (args, ctx) => {
        const r = await gen.generate(args, ctx && ctx.signal);
        const lines = r.images.map((im) => "- " + im.path + " (" + Math.round(im.bytes / 1024) + " KB)" + (im.revisedPrompt ? " \u2014 revised prompt: " + String(im.revisedPrompt).slice(0, 200) : ""));
        const head = (r.mode === "edit" ? "Edited " + r.sources.join(", ") + " into " : "Generated ") + r.images.length + " image(s) with " + r.model + ", saved in the workspace:";
        return {
          content: [{ type: "text", text: head + "\n" + lines.join("\n") + "\nReference these paths from code or docs as needed; the user sees the images in the chat." }],
          structuredContent: { model: r.model, mode: r.mode, sources: r.sources, images: r.images, path: r.images[0].path, paths: r.images.map((im) => im.path) },
        };
      },
    },
  };
}

createImageTools.ImageGenerator = ImageGenerator;
createImageTools.DEFAULT_MODELS = DEFAULT_MODELS;
createImageTools.previewUrl = previewUrl;
module.exports = createImageTools;
