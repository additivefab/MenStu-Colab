// Stand-in for the `claude` CLI in tests (launched via a sh wrapper named `claude`). Records how it was invoked next to
// itself (it receives no extra env vars from the test), then plays a short
// stream-json session. Mode is selected by a marker in the prompt (stdin).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
  fs.writeFileSync(path.join(here, "invocation.json"), JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
    env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
    tokenSha256: crypto.createHash("sha256").update(token).digest("hex"),
    prompt,
  }));
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const argv = process.argv.slice(2);
  // Like the real CLI, the init message lists the tools granted by --tools.
  const granted = argv.includes("--tools") ? argv[argv.indexOf("--tools") + 1].split(",") : ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
  // Without write tools the session can only read: play a planner.
  const mode = /FAKE_MODE=(\w+)/.exec(prompt)?.[1] ?? (granted.includes("Write") ? "normal" : "plan");
  out({ type: "system", subtype: "init", model: "claude-test", permissionMode: "dontAsk", claude_code_version: "9.9.9-fake",
    // widen: a CLI that ignores --tools and still offers Write.
    tools: mode === "mcp" ? ["Read", "Edit", "mcp__exfil__send"] : mode === "widen" ? [...granted, "Write"] : granted,
    mcp_servers: mode === "mcp" ? [{ name: "exfil", status: "connected" }] : [] });
  if (mode === "plan") {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tp1", name: "Read", input: { file_path: "src/model.py" } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tp1", content: "def f(x):\n    return x\n" }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Reading done; drafting the plan." }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 321, usage: { input_tokens: 20, output_tokens: 9 },
      result: "1. Files to touch: src/model.py, tests/test_model.py\n2. Approach: add scale parameter\n3. Tests to run: pytest -q\n4. Risks: none" });
    process.exit(0);
  }
  if (mode === "hang") {
    process.on("SIGINT", () => {
      out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {} });
      process.exit(130);
    });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "mcp" || mode === "widen") {
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  fs.writeFileSync(path.join(process.cwd(), "src", "model.py"), "def f(x, scale=1):\n    return x * scale\n");
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "src/model.py", content: "..." } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "pytest -q" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", is_error: false, content: "1 passed" }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu3", name: "Bash", input: { command: "python -m pytest tests/test_x.py" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu3", is_error: true, content: "Exit code 1\n1 failed" }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu4", name: "Bash", input: { command: "ls" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu4", content: "src" }] } });
  // Simulated leak: the agent prints its own credential.
  out({ type: "assistant", message: { content: [{ type: "text", text: `my token is ${token}` }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 5, duration_ms: 1234, total_cost_usd: 0.01,
    usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 3 }, result: "Done. Tests: pytest -q passed." });
  process.exit(0);
});
