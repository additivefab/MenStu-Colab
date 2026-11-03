// The demo repository (a tiny train/eval script with a deliberate bug) and the
// small synthetic dataset the lab runner mounts. Both live under
// .wrangler/demo-loop and are created once; later starts reuse them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FULL_NAME, ORG, REPO_NAME, STATE_DIR } from "./constants.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const GIT_ENV = {
  PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Synthetic Demo", GIT_AUTHOR_EMAIL: "demo@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Demo", GIT_COMMITTER_EMAIL: "demo@example.invalid",
};

export function git(cwd, args, { input, env = {} } = {}) {
  return execFileSync("git", args, {
    cwd, env: { ...GIT_ENV, ...env }, input, encoding: input instanceof Buffer ? undefined : "utf8",
    maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  }).toString().trim();
}

export const PROTOCOL_MD = `# 评价协议 v1（合成演示）

accuracy = 测试划分中 predict(x) === y 的样本比例。
数据只读挂载于 TANYAN_DATA_DIR；指标写入 TANYAN_OUT_DIR/metrics.json（tanyan.metrics/v1）。
`;
export const EVALUATION_PROTOCOL_SHA256 = sha256(PROTOCOL_MD);

export const MODEL_BEFORE = `// 合成演示模型：真实关系是 y = 2x，这里故意漏了系数 2。
export function predict(x) {
  return x;
}
`;
export const MODEL_AFTER = `// 合成演示模型：真实关系是 y = 2x。
export function predict(x) {
  return 2 * x;
}
`;

const TRAIN_MJS = `// Tiny synthetic "train + eval" entrypoint. The lab runner passes params as
// --key=value, mounts the dataset read-only at TANYAN_DATA_DIR and collects
// TANYAN_OUT_DIR (defaults to ./out when run by hand).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { predict } from "./src/model.mjs";

const params = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf("=");
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
const data = process.env.TANYAN_DATA_DIR ?? "data";
const out = process.env.TANYAN_OUT_DIR ?? "out";
mkdirSync(out, { recursive: true });

const names = readdirSync(join(data, "samples")).sort();
const samples = names.map((name) => JSON.parse(readFileSync(join(data, "samples", name), "utf8")));
const epochs = Number(params.epochs ?? 1);
for (let epoch = 1; epoch <= epochs; epoch += 1) console.log("epoch", epoch, "/", epochs, "(synthetic: nothing to learn)");
const predictions = samples.map((sample) => ({ ...sample, prediction: predict(sample.x) }));
const accuracy = predictions.filter((row) => row.prediction === row.y).length / predictions.length;
const meanAbsError = predictions.reduce((sum, row) => sum + Math.abs(row.prediction - row.y), 0) / predictions.length;
console.log("evaluated", samples.length, "samples; accuracy", accuracy, "seed", params.seed);

const protocol = createHash("sha256").update(readFileSync("evaluation/protocol.md")).digest("hex");
writeFileSync(join(out, "metrics.json"), JSON.stringify({
  schema: "tanyan.metrics/v1",
  evaluationProtocolSha256: protocol,
  split: "test",
  values: { accuracy, mean_abs_error: meanAbsError, samples: samples.length },
}, null, 2));
writeFileSync(join(out, "predictions.csv"), "id,x,y,prediction\\n" + predictions.map((row) => [row.id, row.x, row.y, row.prediction].join(",")).join("\\n") + "\\n");
`;

const MODEL_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { predict } from "../src/model.mjs";

test("predict follows y = 2x", () => {
  assert.equal(predict(3), 6);
  assert.equal(predict(0), 0);
});
`;

const README = `# loop-demo（合成演示仓库）

本仓库只存在于本机 \`.wrangler/demo-loop\`，由 \`scripts/local-dev/demo-loop.mjs\` 生成，
通过本地 GitHub 替身（127.0.0.1）提供。内容全部是合成的。

- \`train.mjs\`：读取只读数据集，评测 \`src/model.mjs\`，写出 \`out/metrics.json\`（tanyan.metrics/v1）。
- \`src/model.mjs\`：故意少了系数 2，演示代理会修正它。
- \`node --test\`：单元测试。
`;

export const REPOSITORY_FILES = {
  "README.md": README,
  "train.mjs": TRAIN_MJS,
  "src/model.mjs": MODEL_BEFORE,
  "test/model.test.mjs": MODEL_TEST,
  "evaluation/protocol.md": PROTOCOL_MD,
};

export function repositoryPaths() {
  const githubRoot = path.join(STATE_DIR, "github");
  return { githubRoot, bare: path.join(githubRoot, ORG, `${REPO_NAME}.git`) };
}

/** Creates the bare repository once (an existing one keeps its PR branches). */
export function ensureRepository() {
  const { githubRoot, bare } = repositoryPaths();
  if (!existsSync(path.join(bare, "HEAD"))) {
    const seed = path.join(STATE_DIR, "repo-seed");
    rmSync(seed, { recursive: true, force: true });
    for (const [file, content] of Object.entries(REPOSITORY_FILES)) {
      mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      writeFileSync(path.join(seed, file), content);
    }
    git(STATE_DIR, ["init", "-q", "--initial-branch=main", seed]);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "Synthetic demo repository"]);
    mkdirSync(path.dirname(bare), { recursive: true });
    git(STATE_DIR, ["clone", "-q", "--bare", seed, bare]);
    rmSync(seed, { recursive: true, force: true });
  }
  git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(bare, ["config", "http.receivepack", "false"]);
  return { githubRoot, bare, fullName: FULL_NAME, mainSha: git(bare, ["rev-parse", "refs/heads/main"]) };
}

/**
 * Synthetic dataset: y = 2x for a handful of x. Files and directories are made
 * read-only (0444/0555). The lab runner binds the folder with `:ro`, but the
 * demo's container shim has NO isolation and cannot enforce mounts, so the
 * file modes are what keeps a job from writing it here.
 */
export function ensureDataset() {
  const root = path.join(STATE_DIR, "dataset");
  const dataPath = path.join(root, "v1");
  const manifestPath = path.join(root, "v1.manifest.json");
  const splitManifestPath = path.join(root, "v1.splits.json");
  const xs = [1, 2, 3, 5, 8, 13];
  const files = xs.map((x, index) => {
    const name = `samples/s${String(index + 1).padStart(2, "0")}.json`;
    const content = JSON.stringify({ id: `s${index + 1}`, x, y: 2 * x, note: "synthetic" });
    return { name, content };
  });
  // Regenerate state written before the tanyan.datamanifest/v1 format (R02).
  if (!existsSync(manifestPath) || !readFileSync(manifestPath, "utf8").includes('"tanyan.datamanifest/v1"')) {
    if (existsSync(root)) execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(path.join(dataPath, "samples"), { recursive: true });
    for (const file of files) writeFileSync(path.join(dataPath, file.name), file.content);
    writeFileSync(splitManifestPath, JSON.stringify({ schema: "lab.splits/v1", test: files.map((file) => file.name) }));
    const manifest = JSON.stringify({ schema: "tanyan.datamanifest/v1", files: files.map((file) => ({ path: file.name, size: Buffer.byteLength(file.content), sha256: sha256(file.content) })) });
    writeFileSync(manifestPath, manifest);
    for (const file of files) chmodSync(path.join(dataPath, file.name), 0o444);
    chmodSync(path.join(dataPath, "samples"), 0o555);
    chmodSync(dataPath, 0o555);
  }
  return {
    dataPath, manifestPath, splitManifestPath,
    manifestSha256: sha256(readFileSync(manifestPath)),
    splitManifestSha256: sha256(readFileSync(splitManifestPath)),
  };
}
