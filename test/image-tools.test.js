"use strict";

// Pembuatan gambar: tool generate_image (Grok Imagine), deteksi dukungan per provider,
// sakelar Off, dan metadata kartu chat. Hermetik: fetch palsu, workspace sementara.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createImageTools = require("../lib/image-tools");
const AiChat = require("../lib/ai-chat");
const ProviderFactory = require("../lib/provider-factory");
const I = require("../lib/agent-instructions");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b50000000049454e44ae426082", "hex");

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: (init && init.method) || "GET", body, headers: (init && init.headers) || {} });
    const r = await handler(url, body, calls.length);
    const status = r.status || 200;
    return {
      ok: status >= 200 && status < 300, status, statusText: "",
      json: async () => r.json, text: async () => JSON.stringify(r.json || { error: { message: r.error || "" } }),
      arrayBuffer: async () => r.bytes,
    };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-img-"));
  try {
    const auth = { token: "t", bases: ["https://api.example/v1"] };

    // Generate: model dari discovery, b64 disimpan, path default, ekstensi dari isi berkas.
    {
      const f = fakeFetch((url, body) => {
        if (/image-generation-models$/.test(url)) return { json: { models: [{ id: "grok-2-image" }, { id: "grok-imagine-image-2.0" }] } };
        assert.strictEqual(body.model, "grok-imagine-image-2.0", "best-ranked model is used first");
        assert.strictEqual(body.response_format, "b64_json");
        return { json: { data: [{ b64_json: PNG.toString("base64"), revised_prompt: "a red fox" }] } };
      });
      const tools = createImageTools({ workspace: root, getAuth: async () => auth, fetch: f });
      const r = await tools.generate_image.execute({ prompt: "A red fox, flat illustration", aspect_ratio: "16:9" });
      const im = r.structuredContent.images[0];
      assert.ok(/^generated\/images\/a-red-fox-flat-illustration-\d{8}-\d{6}\.png$/.test(im.path), im.path);
      assert.ok(fs.readFileSync(path.join(root, im.path)).equals(PNG));
      assert.strictEqual(im.url, "/preview/" + im.path);
      assert.strictEqual(r.structuredContent.path, im.path);
      assert.deepStrictEqual(r.structuredContent.paths, [im.path]);
      assert.ok(/Generated 1 image\(s\) with grok-imagine-image-2\.0/.test(r.content[0].text));
      assert.strictEqual(f.calls.find((c) => /generations$/.test(c.url)).body.aspect_ratio, "16:9");
    }

    // Path eksplisit (ekstensi diganti sesuai format), n variasi, URL yang diunduh.
    {
      const f = fakeFetch((url, body) => {
        if (/image-generation-models$/.test(url)) return { status: 404, error: "nope" };
        if (/generations$/.test(url)) return { json: { data: [{ url: "https://cdn/1" }, { url: "https://cdn/2" }] } };
        return { bytes: PNG };
      });
      const tools = createImageTools({ workspace: root, getAuth: async () => auth, fetch: f });
      const r = await tools.generate_image.execute({ prompt: "logo", path: "public/img/logo.jpg", n: 2 });
      assert.deepStrictEqual(r.structuredContent.paths, ["public/img/logo-1.png", "public/img/logo-2.png"]);
      assert.strictEqual(f.calls.find((c) => /generations$/.test(c.url)).body.model, createImageTools.DEFAULT_MODELS[0], "fallback model list when discovery fails");
    }

    // aspect_ratio ditolak -> kirim ulang tanpa; model tidak ada -> model berikutnya.
    {
      const f = fakeFetch((url, body) => {
        if (/image-generation-models$/.test(url)) return { json: { models: [{ id: "grok-imagine-image-2.0" }, { id: "grok-2-image" }] } };
        if (body.model === "grok-imagine-image-2.0") return { status: 400, error: "model not available for this team" };
        if (body.aspect_ratio) return { status: 400, error: "Unknown field aspect_ratio" };
        return { json: { data: [{ b64_json: PNG.toString("base64") }] } };
      });
      const tools = createImageTools({ workspace: root, getAuth: async () => auth, fetch: f });
      const r = await tools.generate_image.execute({ prompt: "x", aspect_ratio: "1:1", path: "a/b.png" });
      assert.strictEqual(r.structuredContent.model, "grok-2-image");
    }

    // Edit: gambar sumber dikirim sebagai data URI ke /images/edits.
    {
      fs.writeFileSync(path.join(root, "src.png"), PNG);
      const f = fakeFetch((url, body) => {
        if (/image-generation-models$/.test(url)) return { json: { models: [{ id: "grok-imagine-image-2.0" }] } };
        assert.ok(/\/images\/edits$/.test(url), "edit endpoint");
        assert.ok(/^data:image\/png;base64,/.test(body.image.url));
        return { json: { data: [{ b64_json: PNG.toString("base64") }] } };
      });
      const tools = createImageTools({ workspace: root, getAuth: async () => auth, fetch: f });
      const r = await tools.generate_image.execute({ prompt: "make it blue", source_images: ["src.png"], path: "out/blue.png" });
      assert.strictEqual(r.structuredContent.mode, "edit");
    }

    // Path di luar workspace ditolak; tanpa kredensial = pesan yang jelas; 401 tidak dicoba ulang ke base lain.
    {
      const f = fakeFetch(() => ({ json: { data: [{ b64_json: PNG.toString("base64") }] } }));
      const tools = createImageTools({ workspace: root, getAuth: async () => auth, fetch: f });
      for (const bad of ["../escape.png", "/etc/x.png", "a/../../x.png"]) {
        await assert.rejects(tools.generate_image.execute({ prompt: "x", path: bad, model: "m" }), /workspace/);
      }
      await assert.rejects(tools.generate_image.execute({ prompt: "x", source_images: ["../../secret.png"], model: "m" }), /workspace/);
      const none = createImageTools({ workspace: root, getAuth: async () => null, fetch: f });
      await assert.rejects(none.generate_image.execute({ prompt: "x" }), /sign in with Grok|XAI_API_KEY/);
      const f401 = fakeFetch(() => ({ status: 401, error: "bad token" }));
      const two = createImageTools({ workspace: root, getAuth: async () => ({ token: "t", bases: ["https://a/v1", "https://b/v1"] }), fetch: f401 });
      await assert.rejects(two.generate_image.execute({ prompt: "x", model: "m" }), /401/);
      assert.strictEqual(f401.calls.length, 1, "401 is final, not retried on the next base");
      const f403 = fakeFetch((url) => (/^https:\/\/a\//.test(url) ? { status: 403, error: "forbidden" } : { json: { data: [{ b64_json: PNG.toString("base64") }] } }));
      const fb = createImageTools({ workspace: root, getAuth: async () => ({ token: "t", bases: ["https://a/v1", "https://b/v1"] }), fetch: f403 });
      const ok = await fb.generate_image.execute({ prompt: "x", model: "m", path: "fb.png" });
      assert.strictEqual(ok.structuredContent.path, "fb.png", "403 falls through to the next base");
    }

    // Dukungan per provider + penyaringan tool + sakelar Off.
    {
      const chat = new AiChat({
        workspace: root, storeFile: path.join(root, "s.json"), configFile: path.join(root, "c.json"),
        providerFactory: { cursorStatus: () => ({ available: true, error: "" }), create: async () => { throw new Error("unused"); } },
        orchestration: "off",
        grokAuth: { status: () => ({ connected: true }), getAccessToken: async () => "tok", pending: null, connected: () => true },
        customTools: () => Object.assign({ read_only_x: { annotations: { readOnlyHint: true } } }, createImageTools({ workspace: root })),
      });
      const prevKey = process.env.XAI_API_KEY;
      delete process.env.XAI_API_KEY;
      try {
        chat.provider = "cursor";
        assert.deepStrictEqual(chat.imageSupport().via, "native");
        assert.ok(!chat.customToolSet().generate_image, "Cursor uses its native generateImage, not ours");
        chat.provider = "grok";
        assert.strictEqual(chat.imageSupport().supported, true);
        assert.ok(chat.customToolSet().generate_image, "Grok gets generate_image");
        const a = await chat.imageAuth();
        assert.strictEqual(a.token, "tok");
        assert.ok(a.bases.length >= 1 && typeof a.headers === "function");
        chat.provider = "anthropic";
        assert.strictEqual(chat.imageSupport().supported, false);
        assert.ok(/Claude/.test(chat.imageSupport().reason));
        assert.ok(!chat.customToolSet().generate_image, "Claude without XAI_API_KEY: no tool");
        process.env.XAI_API_KEY = "xai-test";
        assert.strictEqual(chat.imageSupport().via, "xai-key");
        assert.ok(chat.customToolSet().generate_image);
        assert.strictEqual((await chat.imageAuth()).token, "xai-test");
        delete process.env.XAI_API_KEY;

        chat.provider = "grok";
        await chat.setConfig({ imageTools: "off" });
        assert.strictEqual(chat.status().imageTools, "off");
        assert.ok(!chat.customToolSet().generate_image, "Off removes the tool");
        assert.deepStrictEqual(chat.imageRestrictions(), { noImage: true });
        await chat.setConfig({ imageTools: "auto" });
        assert.deepStrictEqual(chat.imageRestrictions(), {});
        await assert.rejects(chat.setConfig({ imageTools: "sometimes" }), /imageTools/);
        assert.ok(AiChat.isEvidenceTool("generate_image") && AiChat.isEvidenceTool("generateimage"));
      } finally {
        if (prevKey == null) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prevKey;
        await chat.close();
      }
    }

    // Off juga melarang generateImage bawaan Cursor di setiap anak tangga fallback.
    {
      const ladder = ProviderFactory.disallowedCandidates("agent", { noImage: true });
      assert.ok(ladder.every((rung) => rung.indexOf("generateImage") !== -1));
      const both = ProviderFactory.disallowedCandidates("agent", { noImage: true, noNativeTask: true });
      assert.ok(both.every((rung) => rung.indexOf("generateImage") !== -1 && rung.indexOf("task") !== -1));
      assert.ok(!ProviderFactory.filterCustomTools({ generate_image: {} }, { noImage: true }).generate_image);
      assert.ok(!ProviderFactory.filterCustomTools({ generate_image: {} }, { readOnly: true }).generate_image, "Ask mode cannot write images");
    }

    // Prompt: tiga keadaan.
    {
      const base = { workspace: root, mode: "agent", platform: "linux", userText: "x" };
      assert.ok(/Image generation is available \(generate_image tool, Grok Imagine\)/.test(I.agentPrompt(Object.assign({ images: { on: true, via: "xai" } }, base))));
      assert.ok(/generateImage tool/.test(I.agentPrompt(Object.assign({ images: { on: true, via: "native" } }, base))));
      assert.ok(/NOT available with the current model \(Claude/.test(I.agentPrompt(Object.assign({ images: { on: false, mode: "auto", reason: "Claude models cannot generate images" } }, base))));
      assert.ok(/turned OFF by the user/.test(I.agentPrompt(Object.assign({ images: { on: false, mode: "off" } }, base))));
      assert.ok(/Grok Imagine/.test(I.tool("generate_image")));
    }

    // Metadata kartu chat: generate_image (xAI) dan generateImage bawaan Cursor.
    {
      const chat = new AiChat({ workspace: root, storeFile: path.join(root, "s2.json"), configFile: path.join(root, "c2.json"),
        providerFactory: { cursorStatus: () => ({ available: true, error: "" }), create: async () => { throw new Error("unused"); } }, orchestration: "off" });
      const frames = [];
      const emit = (kind, val) => frames.push({ kind, val });
      chat.emitFromEvent({ type: "tool_call", call_id: "g1", name: "mcp", status: "completed",
        args: { toolName: "generate_image", args: { prompt: "fox" } },
        result: { status: "success", value: { structuredContent: { model: "m", mode: "generate", images: [{ path: "generated/images/fox.png", url: "/preview/generated/images/fox.png" }], path: "generated/images/fox.png", paths: ["generated/images/fox.png"] } } } }, emit, null);
      const t1 = frames.find((f) => f.kind === "tool").val;
      assert.deepStrictEqual(t1.meta.images, [{ url: "/preview/generated/images/fox.png", path: "generated/images/fox.png" }]);
      frames.length = 0;
      chat.emitFromEvent({ type: "tool_call", call_id: "g2", name: "generateImage", status: "completed",
        args: { prompt: "logo" }, result: { status: "success", value: { filePath: path.join(root, "assets", "my logo.png") } } }, emit, null);
      const t2 = frames.find((f) => f.kind === "tool").val;
      assert.deepStrictEqual(t2.meta.images, [{ url: "/preview/assets/my%20logo.png", path: "assets/my logo.png" }]);
      await chat.close();
    }

    console.log("image-tools: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
