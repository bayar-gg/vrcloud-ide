"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const evalAssertions = require("../eval/assertions");
const createStructuralTools = require("../lib/structural-tools");
const VerificationEngine = require("../lib/verification-engine");

async function expectRejected(promise, pattern) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected structural edit to reject");
  assert.match(String(caught.message || caught), pattern);
}

async function applyRejectionFixture(definition, workspace) {
  const rejection = definition.rejection;
  const tools = createStructuralTools({ workspace });
  const searched = await tools.ast_search.execute({
    path: rejection.path,
    kind: rejection.kind,
    name: rejection.name,
  });
  const matches = searched.structuredContent.matches;
  assert.ok(matches.length > 0, definition.id + " has no structural match");
  if (rejection.type === "stale") {
    fs.appendFileSync(path.join(workspace, rejection.path), rejection.mutationText, "utf8");
  }
  const match = matches[0];
  await expectRejected(tools.ast_edit.execute({
    path: match.path,
    match_id: match.id,
    file_hash: match.file_hash,
    operation: rejection.operation,
    text: rejection.text,
  }), new RegExp(rejection.error, "i"));
}

async function fixtureSuite() {
  const casesDirectory = path.join(__dirname, "..", "eval", "cases");
  const cases = evalAssertions.loadCases(casesDirectory);
  assert.ok(cases.length >= 8, "expected the complete Smart Agent fixture matrix");

  for (const definition of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vrcloud-eval-unit-"));
    const workspace = path.join(root, "workspace");
    try {
      evalAssertions.copyFixture(definition, workspace);
      const beforeSnapshot = evalAssertions.snapshotWorkspace(workspace);
      const beforeSyntax = await evalAssertions.syntaxSnapshot(workspace);
      if (definition.rejection) await applyRejectionFixture(definition, workspace);
      else evalAssertions.materializeExpected(definition, workspace);

      const verification = await VerificationEngine.runCommand(definition.verifyCommand, {
        workspace,
        timeoutMs: 5000,
        maxOutput: 16 * 1024,
      });
      assert.strictEqual(verification.passed, true,
        definition.id + " verifier failed:\n" + verification.stderr + verification.stdout);

      const result = await evalAssertions.assertCase(definition, {
        workspace,
        beforeSnapshot,
        beforeSyntax,
        verification,
      });
      assert.strictEqual(result.syntaxRegressions, 0, definition.id);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function cacheBustCoherence() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const values = Array.from(html.matchAll(/[?&]v=([^"'&\s>]+)/g), (match) => match[1]);
  assert.ok(values.length >= 5, "expected cache-busted frontend assets");
  assert.deepStrictEqual(Array.from(new Set(values)), [values[0]],
    "frontend cache-bust values must move together");
}

(async () => {
  cacheBustCoherence();
  await fixtureSuite();
  console.log("eval-assertions: ok");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
