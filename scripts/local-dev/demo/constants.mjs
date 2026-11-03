// Fixed identities for the local demo loop. Everything is SYNTHETIC and local:
// the "GitHub" below is a double on 127.0.0.1, the App id/key are throwaway.
//
// The repository identity deliberately matches what seed-research-loop.mjs
// stores for synthetic-loop-01 (repository_links: synthetic-lab-org/loop-demo,
// id 880001, installation 90000001), so the seeded student's existing link
// resolves against the double without rewriting seed rows.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** Gitignored (`/.wrangler/`): repo, dataset, runner work dirs, runner tokens. */
export const STATE_DIR = path.join(ROOT, ".wrangler", "demo-loop");
export const SECRETS_FILE = path.join(STATE_DIR, "secrets.json");
/** Fake GitHub PR list and counter (non-secret). */
export const GITHUB_STATE_FILE = path.join(STATE_DIR, "github-state.json");
/** Gitignored by `.env*`; read by the Cloudflare Vite plugin when no .dev.vars exists. */
export const ENV_FILE = path.join(ROOT, ".env.local");
export const DEV_VARS_FILE = path.join(ROOT, ".dev.vars");
export const CREDENTIAL_FILE = path.join(ROOT, ".local-dev-admin.txt");

export const DEFAULT_PLATFORM_URL = "http://localhost:3000";
export const DEFAULT_GITHUB_PORT = 4610;

export const APP_ID = "900001";
export const APP_SLUG = "tanyan-demo-local";
export const ORG = "synthetic-lab-org";
export const REPO_NAME = "loop-demo";
export const FULL_NAME = `${ORG}/${REPO_NAME}`;
export const REPO_ID = 880001;
export const INSTALLATION_ID = 90000001;
/** PR numbers start here so they never look like the seed's fake PRs (#8, #15 …). */
export const FIRST_PR_NUMBER = 1001;

export const STUDENT_ID = "synthetic-loop-01";
export const LOGINS = {
  admin: { usernameKey: "username", passwordKey: "password" },
  student: { usernameKey: "synthetic_student_username", passwordKey: "synthetic_student_password" },
  mentor: { usernameKey: "synthetic_mentor_username", passwordKey: "synthetic_mentor_password" },
};

/** Not a real image: the no-isolation shim never pulls or opens it. */
export const IMAGE_REF = `registry.lab.invalid/tanyan-demo/train@sha256:${"d".repeat(64)}`;
export const AGENT_RUNNER_LABEL = "演示代理工作进程（本地合成）";
export const COMPUTE_RUNNER_LABEL = "演示计算执行器（本地合成，无隔离）";
export const ENTRYPOINT_NAME = "demo_train_eval";
export const DATASET_LABEL = "演示合成数据 v1（本地，只读意图）";
export const TASK_TITLE_PREFIX = "【演示闭环】";
