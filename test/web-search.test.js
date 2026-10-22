"use strict";

// Tool web_search: pemilihan backend dari kunci, parser DuckDuckGo (html + lite), fallback,
// cache, pembacaan halaman teratas, dan bentuk teks yang diterima model. Tanpa jaringan.

const assert = require("assert");
const { WebSearch, createWebSearchTools, parseDuckDuckGoHtml, parseDuckDuckGoLite, htmlToText } = require("../lib/web-search");
const ProviderFactory = require("../lib/provider-factory");

const DDG_HTML = [
  '<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">',
  '<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fblog%2Frelease%2Fv24.0.0&amp;rut=abc">Node.js &mdash; Node.js <b>24.0.0</b> (Current)</a></h2>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fblog%2Frelease%2Fv24.0.0">Released <b>2025-05-06</b> with V8 13.6.</a></div></div>',
  '<div class="result results_links"><div class="links_main"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nodejs.org%2Fen%2Fblog%2Frelease%2Fv24.0.0%2F">Duplicate</a></div></div>',
  '<div class="result results_links"><div class="links_main"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Second</a><div class="result__snippet">Snippet two</div></div></div>',
  '<div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>',
].join("\n");

const DDG_LITE = [
  '<table><tr><td><a rel="nofollow" href="https://lite.example/one" class="result-link">Lite one</a></td></tr>',
  '<tr><td class="result-snippet">Lite snippet one</td></tr>',
  '<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2Ftwo" class="result-link">Lite two</a></td></tr>',
  '<tr><td class="result-snippet">Lite snippet two</td></tr></table>',
].join("\n");

function response(status, text, type) {
  return { status, text: async () => text, headers: { get: (k) => (k === "content-type" ? (type || "text/html") : "") } };
}

(async () => {
  // Parser DuckDuckGo: redirect dibuka, entitas didekode, iklan dibuang, cuplikan ikut.
  {
    const r = parseDuckDuckGoHtml(DDG_HTML);
    assert.strictEqual(r.length, 3, "three organic results, no ad");
    assert.strictEqual(r[0].url, "https://nodejs.org/en/blog/release/v24.0.0");
    assert.strictEqual(r[0].title, "Node.js — Node.js 24.0.0 (Current)");
    assert.strictEqual(r[0].snippet, "Released 2025-05-06 with V8 13.6.");
    assert.strictEqual(r[2].snippet, "Snippet two", "div-style snippet is read too");
    const l = parseDuckDuckGoLite(DDG_LITE);
    assert.deepStrictEqual(l, [
      { title: "Lite one", url: "https://lite.example/one", snippet: "Lite snippet one" },
      { title: "Lite two", url: "https://lite.example/two", snippet: "Lite snippet two" },
    ]);
    assert.strictEqual(htmlToText("<html><head><style>x{}</style></head><body><nav>menu</nav><h1>Hi</h1><p>a &amp; b</p><script>1</script></body></html>"), "Hi\na & b", "nav/style/script dropped, entities decoded");
  }

  // Tanpa kunci: DuckDuckGo html; duplikat (www, trailing slash) dibuang; cache per query.
  {
    const calls = [];
    const ws = new WebSearch({ getKey: () => "", fetch: async (url) => { calls.push(url); return response(200, DDG_HTML); } });
    assert.strictEqual(ws.backend().name, "duckduckgo");
    const r = await ws.search("node 24 release", { max: 5 });
    assert.strictEqual(r.backend, "duckduckgo");
    assert.deepStrictEqual(r.results.map((x) => x.url), ["https://nodejs.org/en/blog/release/v24.0.0", "https://example.com/b"], "www/trailing-slash duplicate removed");
    assert.ok(/html\.duckduckgo\.com\/html\/\?q=node\+24\+release/.test(calls[0]));
    await ws.search("node 24 release", { max: 5 });
    assert.strictEqual(calls.length, 1, "identical query served from cache");
    await ws.search("node 24 release", { max: 5, recency: "week", site: "https://nodejs.org/en" });
    assert.ok(/df=w/.test(calls[1]) && /site%3Anodejs\.org/.test(calls[1]), "recency and site reach the engine: " + calls[1]);
  }

  // DuckDuckGo html diblokir -> fallback lite; keduanya gagal -> error yang menyarankan kunci.
  {
    const ws = new WebSearch({ getKey: () => "", fetch: async (url) => (/html\.duckduckgo/.test(url) ? response(403, "bots anomaly") : response(200, DDG_LITE)) });
    const r = await ws.search("x");
    assert.strictEqual(r.results[0].url, "https://lite.example/one", "lite fallback used");
    const dead = new WebSearch({ getKey: () => "", fetch: async () => response(503, "") });
    await assert.rejects(dead.search("x"), /DuckDuckGo unavailable[\s\S]*Tavily or Brave/);
  }

  // Kunci Tavily -> POST JSON dengan time_range/include_domains; jawaban ringkas ikut dibawa.
  {
    let sent = null;
    const ws = new WebSearch({ getKey: () => "tvly-abc", fetch: async (url, init) => {
      sent = { url, body: JSON.parse(init.body), method: init.method };
      return response(200, JSON.stringify({ answer: "Node 24 came out on 2025-05-06.", results: [{ title: "T", url: "https://nodejs.org/x", content: "c".repeat(700), published_date: "2025-05-06" }] }), "application/json");
    } });
    assert.strictEqual(ws.backend().name, "tavily");
    const r = await ws.search("node 24", { recency: "year", site: "nodejs.org", max: 3 });
    assert.strictEqual(sent.method, "POST");
    assert.ok(/api\.tavily\.com/.test(sent.url));
    assert.strictEqual(sent.body.api_key, "tvly-abc");
    assert.strictEqual(sent.body.time_range, "year");
    assert.deepStrictEqual(sent.body.include_domains, ["nodejs.org"]);
    assert.strictEqual(sent.body.max_results, 3);
    assert.strictEqual(r.answer, "Node 24 came out on 2025-05-06.");
    assert.strictEqual(r.results[0].snippet.length, 600, "content capped");
    assert.strictEqual(r.results[0].date, "2025-05-06");
  }

  // Kunci lain -> Brave dengan header token dan freshness.
  {
    let sent = null;
    const ws = new WebSearch({ getKey: () => "BSAxyz", fetch: async (url, init) => {
      sent = { url, headers: init.headers };
      return response(200, JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example/", description: "<strong>bold</strong> desc", age: "2 days ago" }] } }), "application/json");
    } });
    assert.strictEqual(ws.backend().name, "brave");
    const r = await ws.search("q", { recency: "month" });
    assert.strictEqual(sent.headers["X-Subscription-Token"], "BSAxyz");
    assert.ok(/freshness=pm/.test(sent.url) && /q=q/.test(sent.url));
    assert.strictEqual(r.results[0].snippet, "bold desc");
    assert.strictEqual(r.results[0].date, "2 days ago");
  }

  // run(): teks bernomor, fetch_top membaca halaman (teks polos, dipangkas), halaman gagal tidak menggagalkan pencarian.
  {
    const ws = new WebSearch({ getKey: () => "", fetch: async (url) => {
      if (/duckduckgo/.test(url)) return response(200, DDG_HTML);
      if (/nodejs\.org/.test(url)) return response(200, "<html><body><h1>Node.js 24</h1><p>" + "Long text. ".repeat(600) + "</p></body></html>");
      return response(500, "");
    } });
    const out = await ws.run({ query: "node 24", fetch_top: 2, max_results: 2 });
    assert.ok(/^Web search \(duckduckgo\): node 24/.test(out.text));
    assert.ok(/1\. Node\.js — Node\.js 24\.0\.0 \(Current\) — https:\/\/nodejs\.org/.test(out.text));
    assert.ok(/--- page text ---[\s\S]*Node\.js 24[\s\S]*--- end ---/.test(out.text), "top page text attached");
    assert.ok(out.text.indexOf("\u2026") !== -1, "long page is truncated");
    assert.ok(/2\. Second — https:\/\/example\.com\/b/.test(out.text) && !/2\. Second[\s\S]*--- page text/.test(out.text), "failed page simply has no text");
    assert.ok(/cite the URLs you used/.test(out.text));
    assert.strictEqual(out.data.results.length, 2);
  }

  // Tool yang didaftarkan: baca-saja (tetap ada di Ask dan Chat), skema dan structuredContent untuk kartu UI.
  {
    const tools = createWebSearchTools(new WebSearch({ getKey: () => "", fetch: async () => response(200, DDG_HTML) }));
    assert.deepStrictEqual(Object.keys(tools), ["web_search"], "only the tool itself is registered");
    const t = tools.web_search;
    assert.strictEqual(t.annotations.readOnlyHint, true);
    assert.deepStrictEqual(t.inputSchema.required, ["query"]);
    assert.ok(/current, factual, or outside the workspace/.test(t.description));
    const res = await t.execute({ query: "node", max_results: 2 });
    assert.strictEqual(res.structuredContent.backend, "duckduckgo");
    assert.strictEqual(res.structuredContent.results.length, 2);
    assert.ok(/Web search/.test(res.content[0].text));
    const ask = ProviderFactory.filterCustomTools(tools, { readOnly: true, noBrowser: true });
    assert.ok(ask.web_search, "ask mode keeps web_search");
    await assert.rejects(t.execute({ query: "   " }), /query is required/);
  }

  console.log("web-search: ok");
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
