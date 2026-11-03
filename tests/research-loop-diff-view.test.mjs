import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Node strips types from .ts but cannot load .tsx: transpile it here and stub
// CSS modules so the pure helper can be imported without a bundler.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
    }
    if (url.endsWith(".tsx")) {
      const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      });
      return { format: "module", shortCircuit: true, source: outputText };
    }
    return nextLoad(url, context);
  },
});

const { splitUnifiedDiff } = await import("../components/research-loop/diff-view.tsx");
const summary = (files) => files.map(({ path, status, binary, added, removed }) => ({ path, status, binary, added, removed }));

test("splitUnifiedDiff handles bare ---/+++ diffs (seed format)", () => {
  const diff = "--- a/src/requirements.txt\n+++ b/src/requirements.txt\n@@ -1 +1 @@\n-numpy==1.26.4\n+numpy==2.1.0\n"
    + "--- a/src/train.py\n+++ b/src/train.py\n@@ -5 +5 @@\n-LR = 0.01\n+LR = 0.003\n";
  const files = splitUnifiedDiff(diff);
  assert.deepEqual(summary(files), [
    { path: "src/requirements.txt", status: "modify", binary: false, added: 1, removed: 1 },
    { path: "src/train.py", status: "modify", binary: false, added: 1, removed: 1 },
  ]);
  assert.equal(files[1].text, "--- a/src/train.py\n+++ b/src/train.py\n@@ -5 +5 @@\n-LR = 0.01\n+LR = 0.003");
});

test("splitUnifiedDiff handles git diff output with new, deleted and binary files", () => {
  const diff = [
    "diff --git a/scripts/plot.py b/scripts/plot.py",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/scripts/plot.py",
    "@@ -0,0 +1,2 @@",
    "+import json",
    "+print(1)",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "index 2222222..0000000",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-a",
    "-b",
    "-c",
    "diff --git a/docs/fig one.png b/docs/fig one.png",
    "index 3333333..4444444 100644",
    "GIT binary patch",
    "literal 3",
    "KcmZ>A00001",
    "",
    "diff --git a/src/train.py b/src/train.py",
    "index 5555555..6666666 100644",
    "--- a/src/train.py",
    "+++ b/src/train.py",
    "@@ -1,4 +1,4 @@ def main():",
    " import torch",
    "-LR = 0.01",
    "+LR = 0.003",
    " ",
    "",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(summary(splitUnifiedDiff(diff)), [
    { path: "scripts/plot.py", status: "add", binary: false, added: 2, removed: 0 },
    { path: "old.txt", status: "delete", binary: false, added: 0, removed: 3 },
    { path: "docs/fig one.png", status: "modify", binary: true, added: 0, removed: 0 },
    { path: "src/train.py", status: "modify", binary: false, added: 1, removed: 1 },
  ]);
});

test("splitUnifiedDiff does not mistake removed '--' content for a file header", () => {
  const diff = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n select 1;\n"
    + "--- a/r.sql\n+++ b/r.sql\n@@ -1 +1 @@\n-x\n+y\n";
  assert.deepEqual(summary(splitUnifiedDiff(diff)), [
    { path: "q.sql", status: "modify", binary: false, added: 1, removed: 1 },
    { path: "r.sql", status: "modify", binary: false, added: 1, removed: 1 },
  ]);
});

test("splitUnifiedDiff tolerates empty, CRLF and truncated input", () => {
  assert.deepEqual(splitUnifiedDiff(""), []);
  assert.deepEqual(summary(splitUnifiedDiff("--- a/a.py\r\n+++ b/a.py\r\n@@ -1,3 +1,3 @@\r\n-x\r\n+y\r\n")), [
    { path: "a.py", status: "modify", binary: false, added: 1, removed: 1 },
  ]);
  // Cut off in the middle of the second file's hunk.
  const truncated = splitUnifiedDiff("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-1\n+2\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1,5 +1,6 @@\n+new");
  assert.deepEqual(truncated.map((file) => [file.path, file.added, file.removed]), [["a", 1, 1], ["b", 1, 0]]);
});
