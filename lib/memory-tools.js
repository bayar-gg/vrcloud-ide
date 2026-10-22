"use strict";

function result(value, text) {
  return {
    content: [{ type: "text", text: text || JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function createMemoryTools(store) {
  if (!store) return {};
  return {
    memory_search: {
      description: "Search structured project memory. Returns active evidence-backed facts by default; can include stale records for review.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Terms to find in statements, scope, provenance, and evidence paths" },
          kind: { type: "string", description: "Optional exact memory kind" },
          scope: { description: "Optional exact scope value" },
          status: { type: "array", items: { type: "string", enum: ["active", "stale", "invalid", "superseded"] } },
          include_stale: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      annotations: { title: "Search project memory", readOnlyHint: true },
      execute: async (args) => {
        args = args || {};
        const items = await store.search(args.query || "", {
          kind: args.kind, scope: args.scope, status: args.status,
          includeStale: !!args.include_stale, limit: args.limit,
        });
        return result({ items, count: items.length, revision: store.revision },
          items.length ? JSON.stringify(items, null, 2) : "No matching structured memories.");
      },
    },
    memory_upsert: {
      description: "Create or update one structured project memory with scope, evidence, provenance, confidence, and optional TTL.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing record ID to update; omit to create or deduplicate" },
          kind: { type: "string" },
          statement: { type: "string" },
          scope: { description: "Workspace, component, path, or other JSON scope" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                range: { type: "object" },
                hash: { type: "string" },
              },
              required: ["path"],
            },
          },
          provenance: { description: "Source metadata, such as agent/run/user/tool" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          ttl_seconds: { type: "number", minimum: 0 },
          supersedes: { type: "string" },
        },
        required: ["statement"],
      },
      annotations: { title: "Update project memory", readOnlyHint: false, idempotentHint: true },
      execute: async (args) => {
        args = args || {};
        const item = await store.upsert({
          id: args.id, kind: args.kind, statement: args.statement, scope: args.scope,
          evidence: args.evidence, provenance: args.provenance, confidence: args.confidence,
          ttlSeconds: args.ttl_seconds, supersedes: args.supersedes,
        });
        return result({ item, revision: store.revision }, JSON.stringify(item, null, 2));
      },
    },
    memory_forget: {
      description: "Forget one structured project memory by marking its record invalid while retaining provenance history.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory record ID" } },
        required: ["id"],
      },
      annotations: { title: "Forget project memory", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      execute: async (args) => {
        const item = await store.forget(args && args.id);
        if (!item) throw new Error("Memory record not found");
        return result({ item, revision: store.revision }, "Forgot memory " + item.id + ".");
      },
    },
    memory_revalidate: {
      description: "Revalidate a stale memory against current evidence, refreshing evidence hashes and optional statement/confidence.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          statement: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, range: { type: "object" }, hash: { type: "string" } },
              required: ["path"],
            },
          },
        },
        required: ["id"],
      },
      annotations: { title: "Revalidate project memory", readOnlyHint: false, idempotentHint: true },
      execute: async (args) => {
        args = args || {};
        const item = await store.revalidate(args.id, {
          statement: args.statement, confidence: args.confidence, evidence: args.evidence,
        });
        if (!item) throw new Error("Memory record not found");
        return result({ item, revision: store.revision }, JSON.stringify(item, null, 2));
      },
    },
  };
}

module.exports = createMemoryTools;
