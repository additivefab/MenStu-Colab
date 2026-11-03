// node:test custom reporter: one JSON object per finished test, with the full
// title path (parent › subtest) reconstructed per file. Used by report.mjs via
// --test-reporter=./scripts/acceptance/jsonl-reporter.mjs.
//
// node:test reports a test only after all of its subtests, in definition order,
// so the children waiting at nesting n+1 belong to the next test reported at
// nesting n of the same file. This does not depend on test:start ordering.

export default async function* jsonlReporter(source) {
  const pendingByFile = new Map();

  for await (const event of source) {
    if (event.type === "test:summary" && event.data?.file === undefined) {
      yield `${JSON.stringify({ kind: "summary", counts: event.data.counts ?? null, success: event.data.success ?? null })}\n`;
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    const file = data.file ?? "(unknown)";
    const nesting = Number(data.nesting ?? 0);
    if (!pendingByFile.has(file)) pendingByFile.set(file, new Map());
    const pending = pendingByFile.get(file);
    const children = pending.get(nesting + 1) ?? [];
    pending.delete(nesting + 1);
    const error = data.details?.error;
    const node = {
      name: String(data.name),
      nesting,
      file,
      type: data.details?.type ?? "test",
      passed: event.type === "test:pass",
      skipped: Boolean(data.skip),
      todo: Boolean(data.todo),
      durationMs: Number(data.details?.duration_ms ?? 0),
      error: error ? String(error.cause?.message ?? error.message ?? error).slice(0, 500) : null,
      children,
    };
    if (!pending.has(nesting)) pending.set(nesting, []);
    pending.get(nesting).push(node);
    if (nesting === 0) {
      // A top-level test closes a subtree: emit every node in it with its path.
      const stack = [[node, [node.name]]];
      while (stack.length > 0) {
        const [current, path] = stack.pop();
        yield `${JSON.stringify({
          kind: "test",
          file: current.file,
          path,
          name: current.name,
          nesting: current.nesting,
          type: current.type,
          passed: current.passed,
          skipped: current.skipped,
          todo: current.todo,
          durationMs: current.durationMs,
          error: current.error,
          hasChildren: current.children.length > 0,
        })}\n`;
        for (const child of [...current.children].reverse()) stack.push([child, [...path, child.name]]);
      }
      pending.delete(0);
    }
  }
}
