// Research-loop readiness (frontend plan F6). The reader returns booleans and
// counts only — never repository names, token data, worker labels or other
// users' credential profiles. The checklist model is pure and has no server
// imports, so the client component can use it directly.
//
// The conditions mirror the server's own preconditions:
// - agent start (lib/agent-attempts-service.ts): active repository_links on an
//   active installation (REPOSITORY_NOT_LINKED), an active credential profile
//   of the requester on an active agent worker (CREDENTIAL_PROFILE_MISSING),
//   and a configured GitHub App (GITHUB_NOT_CONFIGURED);
// - run registration (lib/run-registry-service.ts / run-results-service.ts):
//   an active entrypoint on the student's linked repository and an active
//   dataset grant; execution needs an active compute runner.

export type ReadinessPayload = {
  studentId: string;
  /** An active student_repository_bindings row exists (the repository URL is on file). */
  repositoryBound: boolean;
  /** An active repository_links row on an active GitHub App installation. */
  repositoryLinked: boolean;
  githubAppConfigured: boolean;
  /** The current viewer's own active profiles on an active agent worker; provider names only. */
  viewerCredentialProviders: string[];
  activeAgentWorkers: number;
  activeComputeRunners: number;
  /** Active, non-revoked dataset grants for this student. */
  grantedDatasets: number;
  /** Active entrypoints registered on this student's linked repository. */
  entrypoints: number;
  /** Whether the viewer can open the configuration page (superadmin settings). */
  viewerCanConfigure: boolean;
};

type CountRow = { count: number | string | null };
const count = (row: CountRow | null) => Number(row?.count ?? 0) || 0;

export async function readResearchLoopReadiness(d1: D1Database, input: {
  studentId: string;
  viewerUserId: number;
  githubAppConfigured: boolean;
  viewerCanConfigure: boolean;
}): Promise<ReadinessPayload> {
  const { studentId, viewerUserId } = input;
  const [binding, link, providers, workers, entrypoints, datasets] = await Promise.all([
    d1.prepare("SELECT 1 AS ok FROM student_repository_bindings WHERE student_id = ? AND active = 1").bind(studentId).first(),
    d1.prepare(`SELECT 1 AS ok FROM repository_links l JOIN github_installations i ON i.installation_id = l.installation_id
      WHERE l.student_id = ? AND l.status = 'active' AND i.status = 'active'`).bind(studentId).first(),
    d1.prepare(`SELECT DISTINCT p.provider FROM agent_credential_profiles p JOIN lab_runners r ON r.id = p.worker_id
      WHERE p.user_id = ? AND p.active = 1 AND r.status = 'active' AND r.kind = 'agent' ORDER BY p.provider`)
      .bind(viewerUserId).all<{ provider: string }>(),
    d1.prepare(`SELECT SUM(CASE WHEN kind = 'agent' THEN 1 ELSE 0 END) AS agent,
      SUM(CASE WHEN kind = 'compute' THEN 1 ELSE 0 END) AS compute FROM lab_runners WHERE status = 'active'`)
      .first<{ agent: number | null; compute: number | null }>(),
    d1.prepare(`SELECT COUNT(*) AS count FROM registered_entrypoints e
      JOIN repository_links l ON l.github_repository_id = e.github_repository_id AND l.status = 'active'
      WHERE l.student_id = ? AND e.active = 1`).bind(studentId).first<CountRow>(),
    d1.prepare(`SELECT COUNT(*) AS count FROM dataset_grants g JOIN dataset_versions d ON d.id = g.dataset_version_id
      WHERE g.student_id = ? AND g.revoked_at IS NULL AND d.active = 1`).bind(studentId).first<CountRow>(),
  ]);
  return {
    studentId,
    repositoryBound: Boolean(binding),
    repositoryLinked: Boolean(link),
    githubAppConfigured: input.githubAppConfigured,
    viewerCredentialProviders: providers.results.map((row) => row.provider),
    activeAgentWorkers: Number(workers?.agent ?? 0) || 0,
    activeComputeRunners: Number(workers?.compute ?? 0) || 0,
    grantedDatasets: count(datasets),
    entrypoints: count(entrypoints),
    viewerCanConfigure: input.viewerCanConfigure,
  };
}

// ---------------------------------------------------------------------------
// Checklist model (pure)
// ---------------------------------------------------------------------------

export type ReadinessOwner = "学生" | "导师" | "超级管理员";
export type ReadinessCapability = "agent" | "run";
export type ReadinessMode = "student" | "staff";

export type ReadinessItem = {
  key: "repository_bound" | "repository_linked" | "github_app" | "agent_worker" | "credential_profile"
    | "entrypoint" | "dataset" | "compute_runner";
  done: boolean;
  label: string;
  /** Extra context for a missing item (empty when done). */
  detail: string;
  owners: ReadinessOwner[];
  /** Where to act, e.g. "超级管理员设置 → 代码与实验配置 → GitHub 仓库授权". */
  place: string;
  /** Link to the place, only when the viewer can open it. */
  href: string | null;
  /** Which abilities this condition blocks while missing. */
  needs: ReadinessCapability[];
};

export type ReadinessModel = {
  items: ReadinessItem[];
  missing: ReadinessItem[];
  canStartAgents: boolean;
  canRegisterRuns: boolean;
  ready: boolean;
};

const SETTINGS = "超级管理员设置 → 代码与实验配置";
const settingsHref = (anchor: string) => `/?mentorView=settings#${anchor}`;

export function readinessModel(payload: ReadinessPayload, mode: ReadinessMode): ReadinessModel {
  const you = mode === "student" ? "你" : "当前账号";
  const link = (anchor: string) => payload.viewerCanConfigure ? settingsHref(anchor) : null;
  const providers = payload.viewerCredentialProviders;
  const items: ReadinessItem[] = [
    {
      key: "repository_bound",
      done: payload.repositoryBound,
      label: payload.repositoryBound ? "已填写科研仓库" : "还没有填写科研仓库",
      detail: mode === "student" ? "先在“科研仓库”卡片里填写你的 GitHub 仓库地址。" : "学生或导师先在“科研仓库”卡片里填写仓库地址。",
      owners: ["学生", "导师"],
      place: "档案中的“科研仓库”卡片",
      href: null,
      needs: ["agent", "run"],
    },
    {
      key: "repository_linked",
      done: payload.repositoryLinked,
      label: payload.repositoryLinked ? "仓库已完成 GitHub 授权链接" : "仓库还没有完成 GitHub 授权链接",
      detail: payload.repositoryBound ? "需要超级管理员按已填写的仓库完成授权链接。" : "填写科研仓库后，由超级管理员完成授权链接。",
      owners: ["超级管理员"],
      place: `${SETTINGS} → GitHub 仓库授权`,
      href: link("loop-admin-github"),
      needs: ["agent", "run"],
    },
    {
      key: "github_app",
      done: payload.githubAppConfigured,
      label: payload.githubAppConfigured ? "GitHub App 已配置" : "GitHub App 还没有配置",
      detail: "需要在 Worker secrets 中配置 GITHUB_APP_ID 和 GITHUB_APP_PRIVATE_KEY。",
      owners: ["超级管理员"],
      place: "Worker 部署配置（secrets）",
      href: null,
      needs: ["agent", "run"],
    },
    {
      key: "agent_worker",
      done: payload.activeAgentWorkers > 0,
      label: payload.activeAgentWorkers > 0 ? `代理工作进程可用（${payload.activeAgentWorkers} 个）` : "没有可用的代理工作进程",
      detail: "需要登记并启用一个代理类执行器（实验室代理工作进程）。",
      owners: ["超级管理员"],
      place: `${SETTINGS} → 实验室：执行器、入口与数据`,
      href: link("loop-admin-lab"),
      needs: ["agent"],
    },
    {
      key: "credential_profile",
      done: providers.length > 0,
      label: providers.length > 0 ? `${you}有代理凭据档案（${providers.join("、")}）` : `${you}还没有代理凭据档案`,
      detail: mode === "student"
        ? "发起代理用的是你自己账号的档案，需要超级管理员为你登记。"
        : "由你发起代理时需要你账号的档案；学生本人发起时用学生自己的档案。",
      owners: ["超级管理员"],
      place: `${SETTINGS} → 代理凭据档案`,
      href: link("loop-admin-profiles"),
      needs: ["agent"],
    },
    {
      key: "entrypoint",
      done: payload.entrypoints > 0,
      label: payload.entrypoints > 0 ? `已登记运行入口（${payload.entrypoints} 个）` : "还没有登记运行入口",
      detail: payload.repositoryLinked ? "需要为该学生的仓库登记至少一个运行入口。" : "仓库完成授权链接后，才能为它登记运行入口。",
      owners: ["超级管理员"],
      place: `${SETTINGS} → 实验室：执行器、入口与数据`,
      href: link("loop-admin-lab"),
      needs: ["run"],
    },
    {
      key: "dataset",
      done: payload.grantedDatasets > 0,
      label: payload.grantedDatasets > 0 ? `已授权数据集（${payload.grantedDatasets} 个）` : "还没有已授权的数据集",
      detail: mode === "student" ? "需要超级管理员把数据集授权给你（只授予计算权限）。" : "需要超级管理员把数据集授权给该学生（只授予计算权限）。",
      owners: ["超级管理员"],
      place: `${SETTINGS} → 实验室：执行器、入口与数据`,
      href: link("loop-admin-lab"),
      needs: ["run"],
    },
    {
      key: "compute_runner",
      done: payload.activeComputeRunners > 0,
      label: payload.activeComputeRunners > 0 ? `计算执行器可用（${payload.activeComputeRunners} 个）` : "没有可用的计算执行器",
      detail: "批准后的运行由计算执行器领取；没有执行器时运行会一直排队。",
      owners: ["超级管理员"],
      place: `${SETTINGS} → 实验室：执行器、入口与数据`,
      href: link("loop-admin-lab"),
      needs: ["run"],
    },
  ];
  const missing = items.filter((item) => !item.done);
  const canStartAgents = !missing.some((item) => item.needs.includes("agent"));
  const canRegisterRuns = !missing.some((item) => item.needs.includes("run"));
  return { items, missing, canStartAgents, canRegisterRuns, ready: missing.length === 0 };
}
