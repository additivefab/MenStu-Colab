// Step 5: the lab side, run in this process with the REAL infra code:
//   - infra/agent-worker (platform client, runWorker/runAttempt, workspace/git,
//     path policy) with the FakeAdapter playing the coding agent: a scripted,
//     deterministic edit of the demo repo. No model, no subscription.
//   - infra/lab-runner (claim, exact-SHA checkout, dataset manifest check, local
//     scheduler, job launcher, egress gate, manifest) with the test
//     "apptainer" shim, which provides NO isolation: it runs the entrypoint
//     directly on this machine. Read-only data is intended (the runner binds
//     /data with :ro) but only the dataset's file modes enforce it here.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FakeAdapter } from "../../../infra/agent-worker/adapters/fake.mjs";
import { createPlatformClient } from "../../../infra/agent-worker/platform-client.mjs";
import { runWorker } from "../../../infra/agent-worker/worker.mjs";
import { validateConfig as validateRunnerConfig } from "../../../infra/lab-runner/lib/config.mjs";
import { createLogger as createRunnerLogger } from "../../../infra/lab-runner/lib/log.mjs";
import { createRunner } from "../../../infra/lab-runner/runner.mjs";
import { installShim } from "../../../infra/lab-runner/test-support/fixtures.mjs";

import { IMAGE_REF, STATE_DIR } from "./constants.mjs";
import { MODEL_AFTER } from "./demo-repo.mjs";

const PLAN_TEXT = `修改计划（合成演示代理）：
1. src/model.mjs：predict(x) 漏了系数 2，改为 return 2 * x。
2. 运行 node --test 确认 test/model.test.mjs 通过。
3. 不改动 evaluation/ 与 train.mjs，评价协议保持不变。`;

function summarizeNodeTest(output) {
  const pass = /ℹ pass (\d+)/.exec(output)?.[1];
  const fail = /ℹ fail (\d+)/.exec(output)?.[1];
  return pass !== undefined ? `${pass} passed, ${fail ?? 0} failed` : output.trim().split("\n").slice(-3).join(" ").slice(0, 200);
}

/** The scripted "agent". Same edit for any demo task; real `node --test` run. */
async function demoAgentScript(ctx) {
  const say = (text) => ctx.emit("message", { role: "assistant", text });
  if (ctx.input.policy?.mode === "plan") {
    say("（合成演示代理，不是真实模型）只读模式：阅读任务与仓库，给出修改计划。");
    await ctx.sleep(1200);
    say(PLAN_TEXT);
    return undefined;
  }
  say("（合成演示代理，不是真实模型）读取任务说明与仓库结构……");
  await ctx.sleep(1500);
  const file = path.join(ctx.workspaceDir, "src", "model.mjs");
  const current = readFileSync(file, "utf8");
  if (current.includes("2 * x")) {
    writeFileSync(file, `${current.trimEnd()}\n// 演示代理复核：predict 已满足 y = 2x。\n`);
    say("predict 已经返回 2 * x，只补充一行复核注释。");
  } else {
    writeFileSync(file, MODEL_AFTER);
    say("发现 src/model.mjs 的 predict 漏了系数 2，已改为 return 2 * x。");
  }
  await ctx.sleep(800);
  const result = spawnSync(process.execPath, ["--test"], {
    cwd: ctx.workspaceDir, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
  });
  const exitCode = result.status ?? 1;
  ctx.test("node --test", exitCode, summarizeNodeTest(`${result.stdout ?? ""}${result.stderr ?? ""}`));
  say(exitCode === 0 ? "单元测试通过，改动已就绪，等待学生审阅并发布 PR。" : "单元测试未通过，请查看测试输出。");
  ctx.setUsage({ inputTokens: 0, outputTokens: 0 });
  return undefined;
}

function prefixedWriter(prefix) {
  return (line) => {
    for (const part of String(line).split("\n")) if (part.trim()) process.stdout.write(`${prefix} ${part}\n`);
  };
}

export function labPaths() {
  return {
    agentRoot: path.join(STATE_DIR, "agent-worker"),
    profilesDir: path.join(STATE_DIR, "agent-worker", "profiles"),
    runnerRoot: path.join(STATE_DIR, "lab-runner"),
    shimRoot: path.join(STATE_DIR, "shim"),
  };
}

/**
 * @param {{ platformUrl: string, githubUrl: string, agent: {id: string, token: string}, compute: {id: string, token: string},
 *   datasetVersionId: string, dataset: {dataPath: string, manifestPath: string, splitManifestPath: string} }} options
 */
export function startLabProcesses({ platformUrl, githubUrl, agent, compute, datasetVersionId, dataset }) {
  const paths = labPaths();
  mkdirSync(paths.profilesDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.runnerRoot, { recursive: true, mode: 0o700 });

  // Agent worker -----------------------------------------------------------
  const workerConfig = {
    platformUrl, workerId: "demo-agent-worker", workRoot: path.join(paths.agentRoot, "work"), profilesDir: paths.profilesDir,
    githubBaseUrl: githubUrl, gitReadFallback: null, pollSeconds: 2, heartbeatSeconds: 10, eventFlushMs: 500,
    maxConcurrentAttempts: 2, keepWorkspaces: false,
    limits: { defaultAgentMinutes: 10, maxAgentMinutes: 30, maxEventsPerAttempt: 500, cancelGraceSeconds: 5 },
    agent: { maxTurns: 10 },
  };
  const agentLog = prefixedWriter("[agent-worker]");
  const adapters = Object.fromEntries(["codex", "claude"].map((provider) => [provider, new FakeAdapter({ provider, script: demoAgentScript })]));
  const workerAbort = new AbortController();
  const workerDone = runWorker({
    config: workerConfig,
    client: createPlatformClient({ platformUrl, workerToken: agent.token }),
    adapters,
    baseSecrets: [agent.token],
    logWrite: agentLog,
  }, { signal: workerAbort.signal }).catch((error) => agentLog(`stopped with error: ${error.message}`));

  // Lab runner -------------------------------------------------------------
  const shim = installShim(paths.shimRoot);
  const imagePath = path.join(paths.shimRoot, "demo-image.sif.placeholder");
  writeFileSync(imagePath, "synthetic placeholder: the no-isolation shim never opens images\n");
  const nodeDir = path.dirname(process.execPath);
  const runnerConfig = validateRunnerConfig({
    platformUrl, runnerId: compute.id, workRoot: paths.runnerRoot, nodePath: process.execPath,
    githubBaseUrl: githubUrl, nvidiaSmi: null,
    scheduler: { type: "local", passEnv: ["PATH", "HOME", "LANG"] },
    apptainer: { binary: shim.path, images: { [IMAGE_REF]: imagePath } },
    datasets: [{ versionId: datasetVersionId, dataPath: dataset.dataPath, manifestPath: dataset.manifestPath, splitManifestPath: dataset.splitManifestPath }],
    gitReadFallback: null,
    limits: { heartbeatSeconds: 5, pollSeconds: 1, claimIntervalSeconds: 2, killGraceSeconds: 5 },
  });
  // The entrypoint is ["node", "train.mjs"]; make sure this Node is the one found.
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(nodeDir)) process.env.PATH = `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const runner = createRunner({ config: runnerConfig, token: compute.token, logger: createRunnerLogger() });
  const runnerDone = runner.start().catch((error) => process.stdout.write(`[lab-runner] stopped with error: ${error.message}\n`));

  return {
    shimCalls: () => shim.calls(),
    async stop() {
      workerAbort.abort();
      runner.stop();
      await Promise.race([Promise.allSettled([workerDone, runnerDone]), new Promise((resolve) => setTimeout(resolve, 8000))]);
    },
  };
}
