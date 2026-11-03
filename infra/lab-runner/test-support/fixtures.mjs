// Test fixtures: temp dirs, a local git repository holding a tiny entrypoint,
// a dataset with a manifest, the apptainer shim wrapper, specs and configs.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateConfig } from "../lib/config.mjs";

const SHIM_URL = pathToFileURL(fileURLToPath(new URL("./apptainer-shim.mjs", import.meta.url))).href;
export const IMAGE_REF = `registry.example/lab/train@sha256:${"a".repeat(64)}`;
export const PROTOCOL_SHA = "e".repeat(64);

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function tempRoot(t) {
  // Short base path: Unix socket paths in egress tests must stay < 104 bytes on macOS.
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "lr-"));
  t?.after?.(() => execFileSync("rm", ["-rf", root]));
  return root;
}

// The entrypoint the "container" runs. It receives params as --key=value.
const ENTRY = `
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const params = Object.fromEntries(process.argv.slice(2).map((arg) => { const i = arg.indexOf("="); return [arg.slice(2, i), arg.slice(i + 1)]; }));
const out = process.env.TANYAN_OUT_DIR;
const data = process.env.TANYAN_DATA_DIR;
writeFileSync(join(out, "argv.json"), JSON.stringify(process.argv.slice(2)));
console.log("entry start", params.mode);
if (params.mode === "ok") {
  writeFileSync(join(out, "metrics.json"), JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: "${PROTOCOL_SHA}", split: "val", values: { accuracy: 0.91, loss: 0.25 } }));
  writeFileSync(join(out, "figure.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  writeFileSync(join(out, "table.csv"), "epoch,acc\\n1,0.91\\n");
  copyFileSync(join(data, readdirSync(data).sort()[0]), join(out, "copied-sample.json"));
  symlinkSync(data, join(out, "data-link"));
} else if (params.mode === "badmetrics") {
  writeFileSync(join(out, "metrics.json"), JSON.stringify({ schema: "tanyan.metrics/v1", split: "val", values: { accuracy: "high" } }));
} else if (params.mode === "sleep") {
  mkdirSync(join(out, "partial"), { recursive: true });
  writeFileSync(join(out, "partial", "progress.csv"), "step,loss\\n1,0.9\\n");
  setTimeout(() => {}, 600000);
} else if (params.mode === "fail") {
  process.exit(3);
}
`;

export function createRepo(root) {
  const base = join(root, "git");
  const repo = join(base, "owner", "repo.git");
  mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git(["init", "-q", "."]);
  writeFileSync(join(repo, "entry.mjs"), ENTRY);
  git(["add", "entry.mjs"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "entry"]);
  const sha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "later.txt"), "moved on");
  git(["add", "later.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "later"]);
  return { base, repo, sha };
}

export function createDataset(root) {
  const dataPath = join(root, "dataset");
  mkdirSync(dataPath, { recursive: true });
  const files = [];
  for (const name of ["a-sample.json", "b-sample.json"]) {
    const content = JSON.stringify({ secret: randomBytes(8).toString("hex"), name });
    writeFileSync(join(dataPath, name), content);
    files.push({ path: name, sha256: sha256(content), bytes: content.length });
  }
  const manifestPath = join(root, "dataset-manifest.json");
  const manifest = JSON.stringify({ schema: "lab.dataset/v1", files });
  writeFileSync(manifestPath, manifest);
  return { dataPath, manifestPath, manifestSha256: sha256(manifest), files };
}

export function installShim(root) {
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  const record = join(root, "shim-calls.jsonl");
  const path = join(dir, "apptainer");
  writeFileSync(path, `#!${process.execPath}\nimport(${JSON.stringify(SHIM_URL)}).then((m) => m.main(${JSON.stringify(record)}));\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls() {
      try {
        return readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

export function makeSpec({ sha, dataset, params = { mode: "ok", seed: 7 }, resources = { gpuCount: 0, walltimeMinutes: 5, memoryGb: 4 }, egress = {} }) {
  return {
    schema: "tanyan.runspec/v1",
    taskId: "task_1",
    taskVersion: 1,
    taskSnapshotSha256: "b".repeat(64),
    studentId: "student_1",
    repository: { provider: "github", repositoryId: 4242, fullName: "owner/repo" },
    executedCommitSha: sha,
    changeRequestId: null,
    entrypoint: { id: "ep_1", argv: [process.execPath, "entry.mjs"], imageRef: IMAGE_REF, params },
    dataset: { versionId: "ds_1", manifestSha256: dataset.manifestSha256, splitManifestSha256: "", mount: "read_only" },
    evaluationProtocolSha256: PROTOCOL_SHA,
    resources,
    network: "deny",
    egress: {
      schema: "tanyan.egress/v1",
      allowedExtensions: [".json", ".csv", ".log", ".png"],
      maxFileBytes: 1_000_000,
      maxTotalBytes: 5_000_000,
      allowImages: false,
      blockDatasetHashMatches: true,
      ...egress,
    },
  };
}

let runCounter = 0;
export function makeWork({ spec, mode = "execute", repository = null, runId }) {
  runCounter += 1;
  const id = runId ?? `run_${randomBytes(16).toString("hex")}`;
  return {
    mode,
    runId: id,
    attempt: 1,
    submitTag: `tanyan-${id}`,
    approvalId: `apr_${runCounter}`,
    runSpecSha256: "c".repeat(64),
    spec,
    repository,
    schedulerJobId: null,
  };
}

export function makeConfig({ root, platformUrl, dataset, shimPath, scheduler = { type: "local" }, gitReadFallback, git, githubBaseUrl, limits = {} }) {
  return validateConfig({
    platformUrl,
    runnerId: "rnr_test",
    workRoot: join(root, "work"),
    scheduler,
    nvidiaSmi: null,
    git,
    githubBaseUrl,
    apptainer: { binary: shimPath, images: { [IMAGE_REF]: join(root, "image.sif") } },
    datasets: [{ versionId: "ds_1", dataPath: dataset.dataPath, manifestPath: dataset.manifestPath }],
    gitReadFallback,
    limits: { heartbeatSeconds: 0.05, pollSeconds: 0.05, claimIntervalSeconds: 0.05, killGraceSeconds: 1, ...limits },
  });
}

/** Every regular file under `dir` (no symlink following) whose bytes contain `needle`. */
export function filesContaining(dir, needle) {
  const hits = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile() && readFileSync(path).includes(needle)) hits.push(path);
    }
  };
  walk(dir);
  return hits;
}

export function captureLogger(createLogger) {
  const lines = [];
  return { logger: createLogger({ write: (line) => lines.push(line) }), lines };
}

export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
