#!/usr/bin/env -S node --experimental-strip-types
// One-command LOCAL demo of the whole research loop against `npm run dev`:
// confirm task → agent edits code → change request → publish PR (GitHub
// double) → approve run → lab runner executes → result → review.
// No real GitHub, model or GPU is used; every identity and value is synthetic.
//
//   node --experimental-strip-types scripts/local-dev/demo-loop.mjs [--auto [--exit]]
//
// Options:
//   --platform-url <url>  dev server (default http://localhost:3000)
//   --github-port <port>  port of the GitHub double on 127.0.0.1 (default 4610)
//   --auto                also drive the whole loop through the HTTP APIs once
//   --exit                with --auto: stop after the automatic loop (exit code = result)
//   --skip-db             do not inspect/migrate/seed the local D1 (dev server elsewhere)
//   --remove-env          remove the demo block from .env.local and exit
// Guide: scripts/local-dev/README-demo-loop.md
import { mkdirSync } from "node:fs";

import {
  DEFAULT_GITHUB_PORT, DEFAULT_PLATFORM_URL, ENTRYPOINT_NAME, DATASET_LABEL, FULL_NAME, STATE_DIR, STUDENT_ID,
} from "./demo/constants.mjs";
import { ensureDataset, ensureRepository } from "./demo/demo-repo.mjs";
import { conflictingUserKeys, devVarsConflict, ensureDemoEnv, removeDemoEnv } from "./demo/env-file.mjs";
import { startFakeGithub } from "./demo/fake-github.mjs";
import { ensureDraftDemoTask, runAutoFlow } from "./demo/flow.mjs";
import { labPaths, startLabProcesses } from "./demo/lab-processes.mjs";
import { ensureLocalDatabase } from "./demo/local-db.mjs";
import { createPlatformApi, probeDevServer } from "./demo/platform-api.mjs";
import { GithubWiringError, registerLabSide, verifyGithubWiring } from "./demo/register.mjs";

function parseArgs(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const known = new Set(["--platform-url", "--github-port", "--auto", "--exit", "--skip-db", "--remove-env", "--help"]);
  for (const arg of argv) if (arg.startsWith("--") && !known.has(arg)) throw new Error(`unknown option ${arg}`);
  const platformUrl = new URL(value("--platform-url", DEFAULT_PLATFORM_URL));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(platformUrl.hostname)) throw new Error("--platform-url must be a local dev server");
  const githubPort = Number(value("--github-port", DEFAULT_GITHUB_PORT));
  if (!Number.isInteger(githubPort) || githubPort < 1024 || githubPort > 65535) throw new Error("--github-port must be 1024-65535");
  return {
    platformUrl: platformUrl.origin, githubPort,
    auto: argv.includes("--auto"), exitAfter: argv.includes("--exit"), skipDb: argv.includes("--skip-db"),
    removeEnv: argv.includes("--remove-env"), help: argv.includes("--help"),
  };
}

const log = (line = "") => process.stdout.write(`${line}\n`);
const section = (title) => log(`\n== ${title} ==`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevServer(platformUrl, { exitAfter }) {
  let announced = false;
  for (;;) {
    const probe = await probeDevServer(platformUrl);
    if (probe.up) return;
    if (exitAfter) throw new Error(`no dev server answering at ${platformUrl} (${probe.error}); start \`npm run dev\` first`);
    if (!announced) {
      log(`  ⏳ ${platformUrl} 上没有开发服务器。请在另一个终端运行 \`npm run dev\`，本脚本会等待它启动……`);
      announced = true;
    }
    await sleep(3000);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log("usage: node --experimental-strip-types scripts/local-dev/demo-loop.mjs [--auto [--exit]] [--platform-url URL] [--github-port N] [--skip-db] [--remove-env]");
    return 0;
  }
  if (options.removeEnv) {
    log(removeDemoEnv() ? "已从 .env.local 删除演示环境变量块。请重启 `npm run dev` 使其生效。" : ".env.local 中没有演示环境变量块。");
    return 0;
  }
  log("科研闭环本地演示（全部为合成数据；GitHub、编码代理、容器均为本机替身，不访问任何外部服务）");
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

  section("1/6 本地数据库");
  if (options.skipDb) log("  跳过（--skip-db）");
  else {
    await ensureLocalDatabase();
    log("  ✔ 已迁移，存在 local-admin 与合成种子（synthetic-loop-01 / synthetic-student / synthetic-mentor）");
  }

  section("2/6 本地 GitHub 替身与演示仓库");
  const repo = ensureRepository();
  const dataset = ensureDataset();
  const githubUrl = `http://127.0.0.1:${options.githubPort}`;
  log(`  ✔ 仓库 ${FULL_NAME}（main ${repo.mainSha.slice(0, 12)}），位于 .wrangler/demo-loop/github`);
  log(`  ✔ 合成数据集 ${dataset.dataPath}（文件 0444、目录 0555：只读意图；替身容器无法强制只读挂载）`);

  section("3/6 开发服务器环境（.env.local，已被 .gitignore 忽略）");
  const env = ensureDemoEnv(githubUrl);
  log(env.changed
    ? "  ✔ 已写入 GITHUB_APP_ID、GITHUB_APP_SLUG、GITHUB_APP_PRIVATE_KEY（一次性生成的本地密钥）、GITHUB_WEBHOOK_SECRET、GITHUB_API_BASE_URL"
    : "  ✔ 演示环境变量已存在且未变化（无需重启开发服务器）");
  if (devVarsConflict()) log("  ⚠ 发现 .dev.vars：存在它时 wrangler 不读取 .env.local。请把演示块中的变量复制进 .dev.vars，或临时移走 .dev.vars。");
  const conflicts = conflictingUserKeys();
  if (conflicts.length) log(`  ⚠ 这些变量在演示块之外也有设置，可能覆盖演示值：${conflicts.join(", ")}`);
  const github = await startFakeGithub({
    port: options.githubPort, publicKey: env.publicKey, bare: repo.bare, githubRoot: repo.githubRoot,
    platformUrl: options.platformUrl, webhookSecret: env.webhookSecret, log: (line) => log(`[fake-github] ${line}`),
  });
  log(`  ✔ GitHub 替身已监听 ${github.url}（REST + git smart HTTP + PR 查看页）`);

  let lab = null;
  let stopping = false;
  const cleanup = async (code) => {
    if (stopping) return;
    stopping = true;
    log("\n正在停止演示进程……");
    await lab?.stop();
    await github.close();
    log("已停止。开发服务器未被改动；.env.local 中的演示块与 .wrangler/demo-loop 保留，便于下次直接启动。");
    log("彻底清理：node --experimental-strip-types scripts/local-dev/demo-loop.mjs --remove-env，然后重启 npm run dev；删除 .wrangler/demo-loop 目录（先 chmod -R u+w）。");
    process.exit(code);
  };
  process.on("SIGINT", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));

  section("4/6 开发服务器与登记");
  await waitForDevServer(options.platformUrl, options);
  const api = createPlatformApi(options.platformUrl);
  if (env.changed) log("  ℹ 演示环境变量刚刚写入：若开发服务器在此之前已启动，需要重启一次 `npm run dev`。");
  let announced = false;
  for (;;) {
    try {
      const link = await verifyGithubWiring(api, github);
      log(`  ✔ 开发服务器经本地替身完成安装同步，并验证 ${STUDENT_ID} 的仓库链接（repo id ${link.repositoryId}）`);
      break;
    } catch (error) {
      if (!(error instanceof GithubWiringError) || options.exitAfter) throw error;
      if (!announced) log(`  ⏳ ${error.message}\n     （每 5 秒重试一次；Ctrl-C 退出）`);
      announced = true;
      await sleep(5000);
    }
  }
  const { profilesDir } = labPaths();
  const registered = await registerLabSide(api, { dataset, profilesDir });
  log(`  ✔ 代理工作进程 ${registered.agent.id}、计算执行器 ${registered.compute.id}（${registered.agent.reused && registered.compute.reused ? "沿用" : "新登记"}；令牌只保存在 .wrangler/demo-loop/secrets.json，0600）`);
  log(`  ✔ 凭据档案 ${registered.profiles.map((profile) => `${profile.provider}:${profile.id}`).join(", ")}（平台只记对应关系，替身代理不需要订阅文件）`);
  log(`  ✔ 入口 ${ENTRYPOINT_NAME}（${registered.entrypoint.id}）、数据集「${DATASET_LABEL}」（${registered.datasetVersion.id}）已授权给 ${STUDENT_ID}`);

  section("5/6 实验室进程");
  lab = startLabProcesses({
    platformUrl: options.platformUrl, githubUrl: github.url, agent: registered.agent, compute: registered.compute,
    datasetVersionId: registered.datasetVersion.id, dataset,
  });
  log("  ✔ infra/agent-worker 已启动（FakeAdapter：脚本化修改 src/model.mjs 并真实运行 node --test）");
  log("  ✔ infra/lab-runner 已启动（local 调度器 + 无隔离的 apptainer 替身；数据只读意图见上）");

  if (options.auto) {
    section("自动跑一遍闭环（--auto，经 HTTP API，学生 / 导师账号）");
    try {
      const summary = await runAutoFlow(api, { entrypoint: registered.entrypoint, datasetVersion: registered.datasetVersion, fakeGithub: github, log });
      log(`  ✅ 闭环完成：任务 ${summary.taskId} → PR #${summary.prNumber} → 运行 ${summary.runId}，accuracy = ${summary.metrics.accuracy}`);
    } catch (error) {
      log(`  ✖ 自动闭环失败：${error.message}`);
      if (options.exitAfter) return cleanup(1);
    }
    if (options.exitAfter) return cleanup(0);
  }

  const { task, created } = await ensureDraftDemoTask(api);
  section("6/6 在浏览器里走一遍");
  log(`演示任务：「${task.title}」（${task.id}，${created ? "刚创建的" : "已有的"}草稿）`);
  log(`
 1. 打开 ${options.platformUrl}，选择独立账号登录：用户名 synthetic-student，密码见 .local-dev-admin.txt 的 synthetic_student_password。
 2. 在科研闭环的研究任务里展开上面的演示任务，点「确认第 1 版」。
 3. 提供商选 Codex（这里是脚本化的合成代理，不调用任何模型），点「用第 1 版启动代理」。
    几秒后尝试变为「已产出修改」，可查看改动（src/model.mjs）与测试结果（node --test）。
 4. 在变更请求里审阅改动，点「发布为 Draft PR」。PR 会出现在本地替身：${github.url}/ （页面里也能「模拟合并」）。
    平台里的「在 GitHub 打开」链接指向 github.com（平台只接受该格式），本地演示时请用替身页面查看。
 5. 点「登记运行」：代码版本选刚发布的变更请求，运行入口 ${ENTRYPOINT_NAME}，数据集版本「${DATASET_LABEL}」，
    参数用默认值、GPU 数量 0，提交「登记运行（待批准）」。
 6. 退出，改用 synthetic-mentor 登录（密码 synthetic_mentor_password），在待办或 /students/${STUDENT_ID} 中找到该运行，
    核对规范后点「批准此规范」。
 7. 本终端会看到实验室执行器领取、检出 PR 的 head、运行 train.mjs；完成后结果显示 accuracy = 1 与 metrics.json 等产物。
 8. 导师填写评审并「保存评审」（采纳 / 需跟进；也可「转为下一轮任务」）。

本终端保持运行即可；按 Ctrl-C 停止 GitHub 替身、代理工作进程和执行器（开发服务器不受影响）。
GitHub 替身 PR 列表：${github.url}/ · 状态目录：.wrangler/demo-loop`);
  return new Promise(() => {});
}

main().then((code) => { if (typeof code === "number") process.exit(code); }).catch((error) => {
  process.stderr.write(`demo-loop: ${error.message}\n`);
  process.exit(1);
});
