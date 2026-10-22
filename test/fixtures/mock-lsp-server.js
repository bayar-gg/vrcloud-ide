"use strict";

const { fileURLToPath, pathToFileURL } = require("url");
const path = require("path");

let buffer = Buffer.alloc(0);
let rootUri = "";
const documents = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([
    Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"),
    body,
  ]));
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function diagnostics(uri, version, text) {
  const line = String(text || "").split(/\r?\n/).findIndex((value) => value.indexOf("BROKEN") !== -1);
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      version,
      diagnostics: line < 0 ? [] : [{
        range: { start: { line, character: 0 }, end: { line, character: 6 } },
        severity: 1,
        source: "mock-lsp",
        message: "BROKEN marker at version " + version,
      }],
    },
  });
}

function onMessage(message) {
  const params = message.params || {};
  if (message.method === "initialize") {
    rootUri = params.rootUri || "";
    result(message.id, {
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        workspaceSymbolProvider: true,
      },
    });
  } else if (message.method === "shutdown") {
    result(message.id, null);
  } else if (message.method === "exit") {
    process.exit(0);
  } else if (message.method === "textDocument/didOpen") {
    const doc = params.textDocument;
    documents.set(doc.uri, { text: doc.text, version: doc.version });
    diagnostics(doc.uri, doc.version, doc.text);
  } else if (message.method === "textDocument/didChange") {
    const doc = params.textDocument;
    const text = params.contentChanges && params.contentChanges[0] ? params.contentChanges[0].text : "";
    documents.set(doc.uri, { text, version: doc.version });
    diagnostics(doc.uri, doc.version, text);
  } else if (message.method === "textDocument/didClose") {
    documents.delete(params.textDocument.uri);
  } else if (message.method === "workspace/symbol") {
    const root = rootUri ? fileURLToPath(rootUri) : process.cwd();
    result(message.id, [{
      name: "AppSymbol",
      kind: 12,
      location: {
        uri: pathToFileURL(path.join(root, "src", "app.ts")).href,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } },
      },
    }]);
  } else if (message.method === "textDocument/definition") {
    result(message.id, {
      uri: params.textDocument.uri,
      range: { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } },
    });
  } else if (message.method === "textDocument/references") {
    result(message.id, [{
      uri: params.textDocument.uri,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
    }]);
  } else if (Object.prototype.hasOwnProperty.call(message, "id")) {
    result(message.id, null);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const at = buffer.indexOf("\r\n\r\n");
    if (at < 0) return;
    const header = buffer.slice(0, at).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(at + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < at + 4 + length) return;
    const body = buffer.slice(at + 4, at + 4 + length);
    buffer = buffer.slice(at + 4 + length);
    onMessage(JSON.parse(body.toString("utf8")));
  }
});
