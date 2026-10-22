"use strict";

/**
 * Tool `web_search`: pencarian web untuk agent, lintas provider (Cursor, Anthropic, Grok).
 *
 * Backend dipilih dari kunci yang tersedia saat dipanggil (getKey()):
 *   - "tvly-…"  -> Tavily (dibuat untuk LLM: cuplikan isi halaman + ringkasan jawaban)
 *   - lainnya  -> Brave Search API (X-Subscription-Token)
 *   - kosong   -> DuckDuckGo HTML (tanpa kunci; fallback ke versi lite)
 *
 * Hasil: daftar bernomor judul/URL/cuplikan (+ tanggal bila ada); dengan fetch_top=N isi
 * N halaman teratas ikut dibaca dan dilampirkan (teks, dipangkas), sehingga jawaban agent
 * bersandar pada sumber, bukan ingatan model. Query identik di-cache 10 menit.
 */

const DDG_HTML = "https://html.duckduckgo.com/html/";
const DDG_LITE = "https://lite.duckduckgo.com/lite/";
const TAVILY = "https://api.tavily.com/search";
const BRAVE = "https://api.search.brave.com/res/v1/web/search";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CACHE_TTL_MS = 10 * 60 * 1000;
const RECENCY = { day: 1, week: 1, month: 1, year: 1 };

const NAMED = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", middot: "\u00b7", laquo: "\u00ab", raquo: "\u00bb" };
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; } })
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ""; } })
    .replace(/&([a-z]+);/gi, (m, name) => (Object.prototype.hasOwnProperty.call(NAMED, name.toLowerCase()) ? NAMED[name.toLowerCase()] : m));
}
function stripTags(s) { return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }

/** HTML -> teks polos yang cukup bersih untuk dibaca model (skrip/gaya/nav dibuang). */
function htmlToText(html) {
  let t = String(html || "");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return decodeEntities(t).replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** Tautan hasil DuckDuckGo adalah redirect //duckduckgo.com/l/?uddg=<url>; kembalikan URL aslinya. */
function unwrapDdg(href) {
  let h = decodeEntities(href || "");
  if (/^\/\//.test(h)) h = "https:" + h;
  const m = /[?&]uddg=([^&]+)/.exec(h);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  return h;
}

function parseDuckDuckGoHtml(html) {
  const out = [];
  // Satu blok per hasil: judul (result__a) lalu cuplikan (result__snippet) di blok yang sama.
  const blocks = String(html || "").split(/<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const a = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = unwrapDdg(a[1]);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const s = /<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block);
    out.push({ title: stripTags(a[2]), url, snippet: stripTags(s ? s[1] : "") });
    if (out.length >= 30) break;
  }
  return out;
}

function parseDuckDuckGoLite(html) {
  const out = [];
  const links = [];
  const re = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) links.push({ url: unwrapDdg(m[1]), title: stripTags(m[2]), at: m.index });
  const snips = [];
  const sre = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = sre.exec(html))) snips.push({ text: stripTags(m[1]), at: m.index });
  links.forEach((l, i) => {
    if (!/^https?:\/\//i.test(l.url)) return;
    const next = links[i + 1] ? links[i + 1].at : Infinity;
    const s = snips.find((x) => x.at > l.at && x.at < next);
    out.push({ title: l.title, url: l.url, snippet: s ? s.text : "" });
  });
  return out.slice(0, 30);
}

function dedupe(items, max) {
  const seen = new Set(); const out = [];
  for (const it of items) {
    if (!it || !it.url) continue;
    const key = it.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

class WebSearch {
  constructor(options) {
    options = options || {};
    this.getKey = typeof options.getKey === "function" ? options.getKey : () => "";
    this.fetch = options.fetch || ((url, init) => fetch(url, init));
    this.timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);
    this.cache = new Map();
    this.now = options.now || (() => Date.now());
  }

  backend() {
    const key = String(this.getKey() || "").trim();
    if (!key) return { name: "duckduckgo", key: "" };
    if (/^tvly-/i.test(key)) return { name: "tavily", key };
    return { name: "brave", key };
  }

  async _get(url, headers, init) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, Object.assign({ signal: ac.signal, redirect: "follow", headers: Object.assign({ "user-agent": UA, accept: "text/html,application/json,*/*", "accept-language": "en-US,en;q=0.8,id;q=0.6" }, headers || {}) }, init || {}));
      const text = await res.text();
      return { status: res.status, text, type: String(res.headers && res.headers.get ? res.headers.get("content-type") || "" : "") };
    } finally { clearTimeout(t); }
  }

  async _tavily(key, q, opts) {
    const body = { api_key: key, query: q, max_results: opts.max, search_depth: "advanced", include_answer: true };
    if (opts.recency) body.time_range = opts.recency;
    if (opts.site) body.include_domains = [opts.site];
    const r = await this._get(TAVILY, { "content-type": "application/json" }, { method: "POST", body: JSON.stringify(body) });
    if (r.status >= 400) throw new Error("Tavily HTTP " + r.status + ": " + r.text.slice(0, 200));
    const data = JSON.parse(r.text || "{}");
    return {
      answer: data.answer ? String(data.answer) : "",
      results: (data.results || []).map((x) => ({ title: x.title || "", url: x.url || "", snippet: String(x.content || "").slice(0, 600), date: x.published_date || "" })),
    };
  }

  async _brave(key, q, opts) {
    const p = new URLSearchParams({ q: opts.site ? q + " site:" + opts.site : q, count: String(opts.max), text_decorations: "0" });
    if (opts.recency) p.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[opts.recency]);
    const r = await this._get(BRAVE + "?" + p.toString(), { "X-Subscription-Token": key, accept: "application/json" });
    if (r.status >= 400) throw new Error("Brave Search HTTP " + r.status + ": " + r.text.slice(0, 200));
    const data = JSON.parse(r.text || "{}");
    const web = (data.web && data.web.results) || [];
    return { answer: "", results: web.map((x) => ({ title: x.title || "", url: x.url || "", snippet: stripTags(x.description || ""), date: x.page_age || x.age || "" })) };
  }

  async _duckduckgo(q, opts) {
    const query = opts.site ? q + " site:" + opts.site : q;
    const df = opts.recency ? { day: "d", week: "w", month: "m", year: "y" }[opts.recency] : "";
    const errors = [];
    const tries = [
      { url: DDG_HTML + "?" + new URLSearchParams(Object.assign({ q: query, kl: "wt-wt" }, df ? { df } : {})).toString(), parse: parseDuckDuckGoHtml },
      { url: DDG_LITE + "?" + new URLSearchParams(Object.assign({ q: query, kl: "wt-wt" }, df ? { df } : {})).toString(), parse: parseDuckDuckGoLite },
    ];
    for (const t of tries) {
      try {
        const r = await this._get(t.url);
        if (r.status >= 400) { errors.push("HTTP " + r.status); continue; }
        if (/anomaly|bots|captcha/i.test(r.text) && !/result__a|result-link/.test(r.text)) { errors.push("bot check"); continue; }
        const results = t.parse(r.text);
        if (results.length) return { answer: "", results };
        errors.push("no results parsed");
      } catch (e) { errors.push(String((e && e.message) || e)); }
    }
    throw new Error("DuckDuckGo unavailable (" + errors.join("; ") + "). Set a Tavily or Brave Search API key in the AI settings for a reliable backend.");
  }

  /** Cari; hasil { backend, answer, results[{title,url,snippet,date}] }. */
  async search(query, opts) {
    opts = opts || {};
    const q = String(query || "").replace(/\s+/g, " ").trim();
    if (!q) throw new Error("query is required");
    const max = Math.min(10, Math.max(1, parseInt(opts.max, 10) || 6));
    const recency = RECENCY[String(opts.recency || "").toLowerCase()] ? String(opts.recency).toLowerCase() : "";
    const site = String(opts.site || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();
    const b = this.backend();
    const cacheKey = [b.name, q.toLowerCase(), max, recency, site].join("|");
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const o = { max, recency, site };
    const raw = b.name === "tavily" ? await this._tavily(b.key, q, o) : b.name === "brave" ? await this._brave(b.key, q, o) : await this._duckduckgo(q, o);
    const value = { backend: b.name, query: q, answer: raw.answer || "", results: dedupe(raw.results, max) };
    this.cache.set(cacheKey, { at: this.now(), value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /** Baca satu halaman sebagai teks (dipangkas). Gagal -> string kosong, bukan error. */
  async readPage(url, maxChars) {
    try {
      const r = await this._get(url);
      if (r.status >= 400) return "";
      const text = /json/i.test(r.type) ? r.text : htmlToText(r.text);
      const cap = Math.max(500, maxChars || 3500);
      return text.length > cap ? text.slice(0, cap) + "\u2026" : text;
    } catch (e) { return ""; }
  }

  /** Teks hasil untuk model: daftar bernomor + (opsional) isi halaman teratas. */
  async run(args) {
    args = args || {};
    const res = await this.search(args.query, { max: args.max_results, recency: args.recency, site: args.site });
    const fetchTop = Math.min(3, Math.max(0, parseInt(args.fetch_top, 10) || 0));
    const pages = fetchTop ? await Promise.all(res.results.slice(0, fetchTop).map((r) => this.readPage(r.url))) : [];
    const L = ["Web search (" + res.backend + "): " + res.query + (res.results.length ? "" : " \u2014 no results")];
    if (res.answer) L.push("", "Summary from the search engine (verify against the sources below): " + res.answer);
    res.results.forEach((r, i) => {
      L.push("", (i + 1) + ". " + (r.title || r.url) + " \u2014 " + r.url + (r.date ? " (" + r.date + ")" : ""));
      if (r.snippet) L.push("   " + r.snippet);
      if (pages[i]) L.push("   --- page text ---", pages[i].split("\n").map((l) => "   " + l).join("\n"), "   --- end ---");
    });
    if (res.results.length) L.push("", "Read the most relevant pages in full with WebFetch (or fetch_top) before relying on a snippet; cite the URLs you used.");
    return { text: L.join("\n"), data: res };
  }
}

function createWebSearchTools(options) {
  const ws = options instanceof WebSearch ? options : new WebSearch(options);
  const Instructions = require("./agent-instructions");
  return {
    web_search: {
      description: Instructions.tool("web_search"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query. Be specific: include names, versions, error text in quotes, and the year for time-sensitive topics." },
          max_results: { type: "integer", minimum: 1, maximum: 10, description: "Default 6" },
          recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from this period (news, releases, prices)" },
          site: { type: "string", description: "Restrict to one domain, e.g. docs.python.org" },
          fetch_top: { type: "integer", minimum: 0, maximum: 3, description: "Also read the full text of the top N results (0-3). Use 2-3 when you need facts, not just links." },
        },
        required: ["query"],
      },
      annotations: { title: "Search the web", readOnlyHint: true, openWorldHint: true },
      execute: async (args) => {
        const out = await ws.run(args);
        return { content: [{ type: "text", text: out.text }], structuredContent: { backend: out.data.backend, query: out.data.query, results: out.data.results } };
      },
    },
  };
}

module.exports = { WebSearch, createWebSearchTools, parseDuckDuckGoHtml, parseDuckDuckGoLite, htmlToText, unwrapDdg };
