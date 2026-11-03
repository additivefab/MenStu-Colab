// Acceptance matrix (design pack 05, T01–T26) and the mapping from automated
// tests to acceptance IDs.
//
// Two sources of evidence:
//   1. A test whose own title names an ID such as "(T09/T10)" or "T04:" is
//      mapped automatically (see extractIds).
//   2. EXPLICIT_EVIDENCE below maps tests whose titles carry no ID. It was
//      derived by reading those tests; an entry matches a test in `file` whose
//      own title starts with `title`. Entries that match nothing are reported.
//
// `mode`:
//   automatable — the behavior can be checked locally with simulated external
//                 systems; real-environment checks may still remain.
//   real-only   — the acceptance criterion is about a real external system or a
//                 real isolation boundary; simulated tests are supporting evidence
//                 only and never make the item pass.

export const ACCEPTANCE = [
  {
    id: "T01", mode: "automatable",
    scenario: "项目 A 学生请求项目 B 的任务、运行、产物、代理日志",
    simulated: "无外部系统；D1 / R2 为 Miniflare 本地模拟",
    realCheck: "部署后用两名真实学生账号抽查接口与 R2 下载地址",
  },
  {
    id: "T02", mode: "real-only",
    scenario: "合法成员读取授权仓库的固定 SHA",
    simulated: "GitHub App 与仓库为测试替身（模拟 REST 与 git smart HTTP）",
    realCheck: "真实 GitHub App 安装到试点仓库，留存只读集成日志（仓库稳定 ID、授权范围）",
  },
  {
    id: "T03", mode: "automatable",
    scenario: "前端把仓库 ID 换为未授权仓库",
    simulated: "GitHub App 为测试替身",
    realCheck: "真实 GitHub App 下重做越权回归：组织级安装不能绕过个人仓库范围",
  },
  {
    id: "T04", mode: "automatable",
    scenario: "AI 执行经确认的修改任务，形成分支 / PR，不直推 main",
    simulated: "GitHub、Codex / Claude 均为测试替身（假 SDK / 假 CLI）",
    realCheck: "真实代理 + 真实 GitHub App 产生的 diff 与 Draft PR 链接",
  },
  {
    id: "T05", mode: "automatable",
    scenario: "AI 提议改 CI、安全策略或环境依赖",
    simulated: "GitHub、代理均为测试替身",
    realCheck: "真实仓库中受保护路径改动的额外审查与审批记录",
  },
  {
    id: "T06", mode: "automatable",
    scenario: "重复投递同一 GitHub Webhook",
    simulated: "Webhook 由测试按 GitHub 格式签名构造",
    realCheck: "真实 GitHub 的重投（Redeliver）只产生一次副作用",
  },
  {
    id: "T07", mode: "automatable",
    scenario: "伪造 Webhook 签名、安装 ID 或仓库 ID",
    simulated: "Webhook 由测试构造",
    realCheck: "真实 Webhook secret 配置后抽查拒绝与审计记录",
  },
  {
    id: "T08", mode: "automatable",
    scenario: "平台回写 GitHub 后收到自身事件",
    simulated: "GitHub 为测试替身",
    realCheck: "真实 GitHub App 回写后不形成评论 / 任务循环",
  },
  {
    id: "T09", mode: "automatable",
    scenario: "批准 SHA A 后分支更新为 SHA B",
    simulated: "Git 仓库为本地临时仓库；执行器使用 Apptainer 替身",
    realCheck: "真实执行器检出记录与批准的 SHA 一致",
  },
  {
    id: "T10", mode: "automatable",
    scenario: "批准后修改数据、环境、参数或资源规范",
    simulated: "纯平台逻辑；数据集为临时目录",
    realCheck: "无额外外部依赖；试点中抽查批准哈希与运行规范版本",
  },
  {
    id: "T11", mode: "automatable",
    scenario: "执行器提交作业后响应丢失并重连",
    simulated: "Slurm 为假 sbatch / squeue / sacct；本地调度器为 Node 进程",
    realCheck: "真实 Slurm 上模拟提交后断线，核对调度器作业列表与提交键",
  },
  {
    id: "T12", mode: "automatable",
    scenario: "排队或运行中撤销用户权限",
    simulated: "纯平台逻辑（Miniflare）",
    realCheck: "试点中撤权后核对在途代理与运行被取消并有审计",
  },
  {
    id: "T13", mode: "automatable",
    scenario: "取消任务后执行器断线重连",
    simulated: "Slurm 为假命令；执行器进程在测试内重启",
    realCheck: "真实 Slurm 上取消后断线重连，核对 scancel 的作业 ID 与部分记录",
  },
  {
    id: "T14", mode: "real-only",
    scenario: "恶意 README / 日志要求读密钥或发送数据",
    simulated: "代理为假 CLI / 假 SDK；只验证策略与提示不被仓库文本改变",
    realCheck: "真实代理在专用低权限用户与出站白名单下运行，验证工具、文件、网络权限无法扩大",
  },
  {
    id: "T15", mode: "real-only",
    scenario: "作业读其他学生目录、写原始数据、访问 Docker socket",
    simulated: "Apptainer 为替身（不提供隔离）；只验证生成的容器参数",
    realCheck: "GPU 服务器上确认 Apptainer --network none、user namespace、只读绑定与目录权限实际生效",
  },
  {
    id: "T16", mode: "automatable",
    scenario: "超时、超内存、超 GPU 配额或超模型预算",
    simulated: "墙钟超时用本地进程；代理用量为假代理上报",
    realCheck: "真实 Slurm / GPU 的内存与配额限制；真实模型用量计费",
  },
  {
    id: "T17", mode: "automatable",
    scenario: "产物含符号链接、越界路径或敏感内容",
    simulated: "本地文件系统；R2 为 Miniflare",
    realCheck: "真实执行器输出目录上复查外发闸门",
  },
  {
    id: "T18", mode: "automatable",
    scenario: "正常运行输出完整 manifest、指标与日志",
    simulated: "Apptainer 替身执行本地脚本；无 GPU",
    realCheck: "GPU 服务器上用小数据集跑通，核对 manifest、metrics、日志",
  },
  {
    id: "T19", mode: "automatable",
    scenario: "训练成功但无评测结果，或指标 JSON 不合法",
    simulated: "本地脚本产生指标文件",
    realCheck: "真实作业中复查",
  },
  {
    id: "T20", mode: "automatable",
    scenario: "模型自然语言声称提升但 metrics 无记录",
    simulated: "纯平台逻辑",
    realCheck: "真实代理输出下复查界面“证据缺失”提示",
  },
  {
    id: "T21", mode: "automatable",
    scenario: "AI 改动评价器、标签或划分后报告提升",
    simulated: "纯平台逻辑",
    realCheck: "试点中抽查协议变化提示",
  },
  {
    id: "T22", mode: "real-only",
    scenario: "在干净环境复现获准任务",
    simulated: "平台侧复现对比（同一规范多次执行、容差判断）为纯平台逻辑；执行环境为替身",
    realCheck: "干净环境（真实执行器 + 容器）独立复现获准任务，提交复现报告；平台侧复现对比与容差判断已有自动化测试（第 6 批 G3），只作支撑证据",
  },
  {
    id: "T23", mode: "automatable",
    scenario: "失败后重新运行",
    simulated: "纯平台逻辑",
    realCheck: "真实执行器失败后重跑，核对历史完整",
  },
  {
    id: "T24", mode: "automatable",
    scenario: "第二代理提供商执行相同契约",
    simulated: "Codex SDK 与 Claude CLI 均为替身",
    realCheck: "真实 Codex / Claude 订阅下的事件流、用量与取消；DeepSeek 未实现",
  },
  {
    id: "T25", mode: "automatable",
    scenario: "一轮闭环并提出后续任务",
    simulated: "GitHub、代理、容器均为替身；平台、代理工作进程、执行器为真实代码",
    realCheck: "按设计包做人工端到端验收：1 名导师、2 名学生、1 个仓库完成两轮闭环",
  },
  {
    id: "T26", mode: "automatable",
    scenario: "数据库 / 存储备份恢复",
    simulated: "D1 / R2 为 Miniflare 本地模拟；生产 wrangler --remote 导出与 R2 同步未演练",
    realCheck: "在托管环境做一次真实演练：wrangler d1 export --remote + R2 同步，恢复到全新库并留存记录（见 docs/ops/备份与恢复.md）",
  },
];

const E2E = "tests/research-loop-e2e.test.mjs";

export const EXPLICIT_EVIDENCE = [
  // T01: scope isolation across students
  { ids: ["T01"], file: "tests/access-policy.test.mjs", title: "student data access defaults to deny outside the explicit role scope" },
  { ids: ["T01"], file: "tests/student-scoped-reads-worker.test.mjs", title: "student and dual-persona sessions cannot expand their scope" },
  { ids: ["T01"], file: "tests/student-scoped-reads-worker.test.mjs", title: "invalid filters and inactive students never trigger an unfiltered fallback" },
  { ids: ["T01"], file: "tests/research-loop-readiness-worker.test.mjs", title: "unauthenticated, pending and out-of-scope callers are refused" },
  { ids: ["T01"], file: "tests/research-loop-inbox-worker.test.mjs", title: "scope isolation: unassigned, read-only, inactive assignment and inactive student" },
  { ids: ["T01"], file: "tests/research-loop-inbox-rules-worker.test.mjs", title: "leakage: a mentor's loopTasks never mention out-of-scope students" },
  { ids: ["T01"], file: "tests/research-loop-evidence-worker.test.mjs", title: "scope isolation" },
  { ids: ["T01"], file: "tests/research-loop-results-rules-worker.test.mjs", title: "baseline: outsiders, other students, view-only and unassigned mentors are rejected" },
  { ids: ["T01"], file: "tests/runs-results-batch4-worker.test.mjs", title: "scope isolation for student B's own run" },
  { ids: ["T01"], file: "tests/review-delegation-worker.test.mjs", title: "no access to runs, results, progress or other students" },

  // T02: stable repository ID and fixed SHA (simulated GitHub only)
  { ids: ["T02"], file: "tests/github-worker.test.mjs", title: "link_repository resolves the bound full name to a stable ID through the installation" },
  { ids: ["T02"], file: E2E, title: "6. lab runner: claim → exact SHA" },

  // T03: repository IDs never come from the client
  { ids: ["T03"], file: "tests/repository-link-revocation.test.mjs", title: "binding changes revoke the verified repository link" },
  { ids: ["T03"], file: "tests/github-worker.test.mjs", title: "removing the repository from the installation revokes the link and blocks publishing" },
  { ids: ["T03"], file: "tests/agent-attempts-worker.test.mjs", title: "start checks confirmation, repository link, credential profile and GitHub availability" },
  { ids: ["T03"], file: "infra/lab-runner/runner.test.mjs", title: "no repository access (claim repository=null, no fallback) fails clearly" },

  // T04: allowed scope, branch/PR, never main
  { ids: ["T04", "T05"], file: "tests/research-loop-contract.test.mjs", title: "path policy normalizes paths and flags protected or out-of-scope changes" },
  { ids: ["T04"], file: "tests/github-worker.test.mjs", title: "a branch that already points elsewhere is a conflict and is never overwritten" },
  { ids: ["T04"], file: "tests/github-worker.test.mjs", title: "a publish interrupted mid-way resumes without a second ref or PR" },
  { ids: ["T04"], file: E2E, title: "3. agent worker claims, edits at the base SHA" },
  { ids: ["T04"], file: E2E, title: "4. publish: the simulated GitHub receives the exact tree/commit/ref/PR" },

  // T05: protected paths need extra review
  { ids: ["T05"], file: "tests/research-loop-contract.test.mjs", title: "task content always keeps default protected paths" },
  { ids: ["T05"], file: "tests/review-delegation-worker.test.mjs", title: "protected changes and extra review stay with the mentor" },
  { ids: ["T05"], file: E2E, title: "3b/4b. protected-path variant" },

  // T06–T08: webhooks
  { ids: ["T06"], file: "tests/github-worker.test.mjs", title: "pull_request synchronize and merge update the change request exactly once" },
  { ids: ["T07"], file: "tests/github-worker.test.mjs", title: "installation events from another App are isolated" },

  // T09 / T10: approval bound to the exact spec
  { ids: ["T09", "T10"], file: "tests/runs-worker.test.mjs", title: "manifest fields must match the approved spec exactly" },
  { ids: ["T09", "T10"], file: E2E, title: "5. student creates a run from the change request; mentor approves the echoed spec hash" },
  { ids: ["T10"], file: "infra/lab-runner/runner.test.mjs", title: "dataset manifest hash mismatch fails before anything is submitted" },
  { ids: ["T10"], file: "infra/lab-runner/units.test.mjs", title: "dataset binding: manifest and split manifest hashes must match" },

  // T11: reconcile before resubmitting
  { ids: ["T11"], file: "infra/lab-runner/runner.test.mjs", title: "reconcile mode sends no heartbeat before reconcile and honors the reconcile response" },
  { ids: ["T11"], file: "infra/lab-runner/runner.test.mjs", title: "LEASE_LOST: local actions abandoned, job not killed, next lease adopts it" },
  { ids: ["T11"], file: "tests/runs-worker.test.mjs", title: "concurrent approvals, claims and cancels apply exactly once" },
  { ids: ["T11"], file: "tests/agent-attempts-worker.test.mjs", title: "expired leases fail with LEASE_EXPIRED on heartbeat, GET or claim and are never re-dispatched" },

  // T12: revocation
  { ids: ["T12"], file: "tests/review-delegation-worker.test.mjs", title: "revocation takes effect on the next request and keeps the audit row" },

  // T13: cancellation is never revived
  { ids: ["T13"], file: "tests/agent-attempts-worker.test.mjs", title: "cancel: queued attempts end immediately, running ones are cancel_requested until the worker reports" },
  { ids: ["T13"], file: "infra/agent-worker/worker.test.mjs", title: "cancel requested by the platform mid-run stops the adapter and reports canceled" },

  // T14: hostile repository content cannot widen permissions (supporting evidence only)
  { ids: ["T14"], file: "infra/agent-worker/adapters.test.mjs", title: "claude adapter aborts with POLICY_VIOLATION when the CLI reports MCP servers or web tools" },
  { ids: ["T14"], file: "infra/agent-worker/worker.test.mjs", title: "tokens never reach events, logs, results or the workspace" },
  { ids: ["T14"], file: "infra/agent-worker/worker.test.mjs", title: "planted git filters and hooks do not run during change collection" },
  { ids: ["T14"], file: "infra/agent-worker/worker.test.mjs", title: "a worker credential written into the change set blocks the result" },
  { ids: ["T14"], file: "infra/lab-runner/runner.test.mjs", title: "token handling: repository token reaches git only via env and never disk/logs/argv" },
  { ids: ["T14"], file: "infra/lab-runner/runner.test.mjs", title: "scheduler passEnv refuses to forward credential variables" },
  { ids: ["T14"], file: "infra/lab-runner/runner.test.mjs", title: "argv never goes through a shell: metacharacters arrive verbatim" },

  // T15: container isolation as generated argv (supporting evidence only)
  { ids: ["T15"], file: "infra/lab-runner/units.test.mjs", title: "container command: isolation, read-only binds, GPU flag, memory opt-in" },
  { ids: ["T15"], file: "infra/lab-runner/units.test.mjs", title: "container command refuses ambiguous bind paths, unpinned images, network != deny" },

  // T17: egress gate
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "symlinks (file and directory, inside or escaping) are rejected and never followed" },
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "special files (named pipe, socket) are rejected" },
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "non-normalized names (backslash traversal, control chars, .git) are rejected" },
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "images are held unless allowImages=true" },
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "extension not allowlisted, oversize file and total cap are held" },
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "a copy of a dataset file is rejected even with an allowlisted extension" },
  { ids: ["T17"], file: "infra/lab-runner/egress.test.mjs", title: "hard links are held" },
  { ids: ["T17"], file: "tests/research-loop-contract.test.mjs", title: "one image extension list for the egress gate and the platform re-check" },

  // T18: complete provenance
  { ids: ["T18"], file: E2E, title: "6. lab runner: claim → exact SHA → dataset manifest → run → egress gate → complete" },

  // T19: missing metrics is never acceptable
  { ids: ["T19"], file: "infra/lab-runner/runner.test.mjs", title: "no metrics.json: metricsArtifactPath stays null" },

  // T20: claims without metrics are never formal results
  { ids: ["T20"], file: "tests/research-loop-results-rules-worker.test.mjs", title: "progress draft: writes nothing, cites the metrics source and PR, never claims a pending acceptance" },
  { ids: ["T20"], file: "tests/research-loop-results-rules-worker.test.mjs", title: "progress draft: no PR is never invented" },
  { ids: ["T20"], file: "tests/runs-results-batch4-worker.test.mjs", title: "progress draft: factual content, metric source, PR, missing interpretation; nothing saved" },

  // T21: protocol change is shown
  { ids: ["T21"], file: "tests/research-loop-result-insights.test.mjs", title: "baseline wording: protocol mismatch is never hidden" },

  // T24: second provider, explicit capabilities, honest cancel
  { ids: ["T24"], file: "infra/agent-worker/adapters.test.mjs", title: "codex adapter cancel aborts the SDK turn; turn.failed is reported as failed" },
  { ids: ["T24"], file: "infra/agent-worker/adapters.test.mjs", title: "claude adapter cancel sends SIGINT and reports canceled" },
  { ids: ["T24"], file: "infra/agent-worker/adapters.test.mjs", title: "claude message mapping never invents an exit code" },
  { ids: ["T24"], file: "infra/agent-worker/adapters.test.mjs", title: "codex event mapping covers errors and unknown events" },
  { ids: ["T24"], file: "infra/agent-worker/worker.test.mjs", title: "unknown provider, missing profile and missing read access fail cleanly" },

  // T25: follow-up tasks link back to the discussion
  { ids: ["T25"], file: E2E, title: "2. student turns a mentor guidance note into a confirmed task" },
  { ids: ["T25"], file: "tests/research-tasks-worker.test.mjs", title: "create validates scope, origin, content and guidance-note ownership" },
  // T22 (platform side, batch 6 G3/G8): repeated executions of one spec compared within tolerance.
  { ids: ["T22"], file: "tests/runs-evaluation-budget-worker.test.mjs", title: "reproduction: compares with the latest earlier completed execution within the task tolerance" },
  { ids: ["T22"], file: "tests/runs-evaluation-budget-worker.test.mjs", title: "reproduction: default tolerance is 0.01 absolute" },
  { ids: ["T22"], file: "tests/research-loop-batch6-rules-worker.test.mjs", title: "reproduction compares with the previous completed execution of the same spec" },
  { ids: ["T22"], file: "tests/research-loop-batch6-rules-worker.test.mjs", title: "reproduction uses the task's reproTolerance when set" },
  // T23 (batch 6 G2): failures and lost runners are recovered by compensating reconciliation.
  { ids: ["T23"], file: "tests/loop-maintenance-worker.test.mjs", title: "cron run applies each sweep at its threshold and writes audit rows" },
  { ids: ["T23"], file: "tests/research-loop-batch6-rules-worker.test.mjs", title: "run finalizes stale cancel requests and expired agent leases with system audit rows only" },
];

const ID_PATTERN = /(?<![A-Za-z0-9])T(\d{2})(?![0-9])/g;
const KNOWN_IDS = new Set(ACCEPTANCE.map((item) => item.id));

/** Acceptance IDs named in a test's own title, e.g. "(T09/T10)" → ["T09", "T10"]. */
export function extractIds(title) {
  const ids = new Set();
  for (const match of String(title).matchAll(ID_PATTERN)) {
    const id = `T${match[1]}`;
    if (KNOWN_IDS.has(id)) ids.add(id);
  }
  return [...ids];
}
