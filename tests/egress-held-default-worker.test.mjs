import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// R03 / batch 7 exit condition 2: the platform's egress re-check holds every
// output by default. A runner's `published` claim stands only for a
// `metrics.json` that passes the trusted-metrics check, or for a path the data
// steward listed in `autoPublishPaths`. Synthetic data only; outbound network is
// blocked; the lab runner is simulated (and may lie) through direct protocol calls.
const EVAL = "e".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.lab/train@${IMAGE_DIGEST}`;
const SHA_A = "1".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const RAW = Buffer.from("id,age,diagnosis\n1,54,synthetic-condition-A\n2,61,synthetic-condition-B\n".repeat(4));

test("R03 egress: held by default, metrics only, steward opt-in, forged claims downgraded", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "egress-held-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const cookie = (actor) => `tanyan_session=egress-${actor}; tanyan_persona=${actor === "student" ? "student" : "management"}`;
  const call = (path, { actor, method = "GET", body } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    return JSON.parse(text);
  };
  const admin = (body, actor = "root", status = 200) => call("/api/admin/lab", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const runs = (body, actor = "student", status = 200) => call("/api/runs", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const detail = (runId) => call(`/api/runs?runId=${runId}`, { actor: "mentor" }).then((r) => expectJson(r));
  let keyCounter = 0;
  const key = (label = "k") => `${label}-${String(++keyCounter).padStart(6, "0")}`;

  try {
    const db = await applyD1Migrations(mf);
    const bucket = await mf.getR2Bucket("FILES");
    await db.prepare("INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES ('eg-a', '外发测试', '博士', 2025, '实验', 1)").run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (3101, 'eg-student', '外发测试', 'student', 'eg-a'), (3103, 'eg-mentor', '审核导师', 'mentor', NULL), (3106, 'eg-root', '数据持有方', 'superadmin', NULL)`).run();
    await db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (3103, 'eg-a', 1, 1)").run();
    for (const [id, actor] of [[3101, "student"], [3103, "mentor"], [3106, "root"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").bind(digest(`egress-${actor}`), id).run();
    }
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (99, 'synthetic-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('eg-a', 7001, 99, 'synthetic-lab/eg-research', 'main')`).run();
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agenteg', '代理', 'agent', ?)").bind("f".repeat(64)).run();
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_eg', 3101, 'codex', 'rnr_agenteg')").run();
    await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
      VALUES ('task_eg', 'eg-a', '合成任务', 'confirmed', 1, 1, 3101, 'seed-task_eg', 'seed-task_eg')`).run();
    await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
      budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
      VALUES ('task_eg', 1, '合成任务', '合成问题', '合成说明', '合成标准', '{"maxGpuCount":1,"maxWalltimeMinutes":600}', ?, 3101, 3101, CURRENT_TIMESTAMP)`).bind("d".repeat(64)).run();
    await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
      base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
      VALUES ('att_eg', 'task_eg', 1, 'eg-a', 'codex', 'cred_eg', 7001, ?, ?, 'change_ready', 'seed-attempt-eg', 3101)`).bind("0".repeat(40), "d".repeat(64)).run();
    await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, status)
      VALUES ('cr_eg', 'task_eg', 'att_eg', 'eg-a', 7001, ?, 'tanyan/eg/seed', ?, 'open')`).bind("0".repeat(40), SHA_A).run();

    const registered = await admin({ action: "register_runner", label: "GPU 服务器", kind: "compute" });
    const runner = registered.runner.id;
    const runnerToken = registered.token;
    const entrypoint = (await admin({ action: "register_entrypoint", studentId: "eg-a", name: "train", argv: ["python", "train.py"], imageRef: IMAGE, paramsSchema: {}, evaluationProtocolSha256: EVAL })).entrypoint;
    const policy = { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".csv", ".log", ".txt"], maxFileBytes: 100_000, maxTotalBytes: 500_000, allowImages: false, blockDatasetHashMatches: true };
    const base = { action: "register_dataset", runnerId: runner, manifestSha256: "a".repeat(64), splitManifestSha256: "b".repeat(64) };

    const lab = (body, status = 200) => mf.dispatchFetch(origin + "/api/lab/runs", {
      method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => expectJson(r, status));
    const dispatch = async (dataset) => {
      const run = await runs({ action: "create", taskId: "task_eg", changeRequestId: "cr_eg", entrypointId: entrypoint.id, params: {}, datasetVersionId: dataset.id,
        resources: { gpuCount: 0, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key("create") });
      await runs({ action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, "mentor");
      const { work } = await lab({ action: "claim" });
      assert.equal(work?.runId, run.runId);
      return work;
    };
    /** A runner artifact; `decision` is what the (possibly lying) runner claims. */
    const file = (relativePath, content, { kind = "other", decision = "published", reason = "runner says ok" } = {}) => ({
      artifact: { relativePath, sha256: sha256(content), sizeBytes: Buffer.byteLength(content), kind, egressDecision: decision, egressReason: reason, labLocator: `lab://out/${relativePath}` },
      published: { relativePath, contentBase64: Buffer.from(content).toString("base64") },
    });
    const metrics = (extra = {}) => JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: EVAL, split: "test", values: { accuracy: 0.9 }, ...extra });
    const complete = async (work, items, { metricsArtifactPath = "metrics.json", publish = items } = {}) => {
      const manifest = {
        schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
        repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
        inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
          splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
        environment: { imageDigest: IMAGE_DIGEST, driverVersion: "", gpuModel: "" },
        execution: { runnerId: runner, schedulerJobId: "4242", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
          startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
        metricsArtifactPath, artifacts: items.map((item) => item.artifact),
      };
      const done = await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0,
        manifest, publishedFiles: publish.map((item) => item.published) });
      assert.equal(done.status, "completed");
      const view = await detail(work.runId);
      const stored = (await bucket.list({ prefix: `runs/${work.runId}/` })).objects.map((object) => object.key.slice(`runs/${work.runId}/`.length)).sort();
      return { view, stored, byPath: Object.fromEntries(view.artifacts.map((item) => [item.relativePath, item])) };
    };

    let defaultDataset, optInDataset;
    await t.test("autoPublishPaths: optional, validated, steward-only, stored in tanyan.egress/v1 and bound into the spec", async () => {
      defaultDataset = (await admin({ ...base, label: "默认扣留", egressPolicy: policy })).dataset;
      assert.ok(!("autoPublishPaths" in defaultDataset.egressPolicy), "no opt-in: the stored policy is unchanged (backward compatible)");
      for (const bad of [["*.csv"], ["**/*.log"], ["logs/*"], ["*/job.log"], ["../x.csv"], "predictions.csv", Array.from({ length: 21 }, (_, index) => `f${index}.csv`)]) {
        await admin({ ...base, label: "过宽", egressPolicy: { ...policy, autoPublishPaths: bad } }, "root", 400);
      }
      await admin({ ...base, label: "导师不可", egressPolicy: { ...policy, autoPublishPaths: ["predictions.csv"] } }, "mentor", 403);
      optInDataset = (await admin({ ...base, label: "授权外发", egressPolicy: { ...policy, autoPublishPaths: ["predictions.csv", "logs/*.log", "predictions.csv"] } })).dataset;
      assert.deepEqual(optInDataset.egressPolicy.autoPublishPaths, ["logs/*.log", "predictions.csv"]);
      const stored = await db.prepare("SELECT egress_policy_json FROM dataset_versions WHERE id = ?").bind(optInDataset.id).first();
      assert.equal(JSON.parse(stored.egress_policy_json).schema, "tanyan.egress/v1");
      const registry = await expectJson(await call("/api/admin/lab", { actor: "root" }));
      assert.deepEqual(registry.datasets.find((item) => item.id === optInDataset.id).egressPolicy.autoPublishPaths, ["logs/*.log", "predictions.csv"]);
      for (const dataset of [defaultDataset, optInDataset]) await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "eg-a" });
    });

    await t.test("a valid metrics.json publishes; forged published claims for copies are downgraded to held", async () => {
      const work = await dispatch(defaultDataset);
      const third = Math.ceil(RAW.length / 3);
      const items = [
        file("metrics.json", metrics(), { kind: "metrics" }),
        file("predictions.csv", "id,prediction\n1,0\n", { kind: "table" }),
        file("encoded.txt", RAW.toString("base64")),
        file("encoded-hex.json", JSON.stringify({ blob: RAW.toString("hex") })),
        file("parts/p0.csv", RAW.subarray(0, third).toString("utf8"), { kind: "table" }),
        file("parts/p1.csv", RAW.subarray(third, 2 * third).toString("utf8"), { kind: "table" }),
        file("weights.json", Buffer.from([0, 1, 2, 255, ...RAW.subarray(0, 32)]).toString("latin1")),
        file("logs/job.log", `epoch 1 loss 0.4\n${RAW.toString("utf8")}epoch 2 loss 0.3\n`, { kind: "log" }),
        file("sub/metrics.json", metrics(), { kind: "other" }),
      ];
      const { view, stored, byPath } = await complete(work, items);
      assert.equal(byPath["metrics.json"].egressDecision, "published");
      assert.equal(byPath["metrics.json"].egressReason, "平台复核：可信指标 metrics.json", "the platform records its own basis, not the runner's");
      for (const item of items.slice(1)) {
        const path = item.artifact.relativePath;
        assert.equal(byPath[path].egressDecision, "held", path);
        assert.equal(byPath[path].egressReason, "平台复核：需数据持有方授权后外发（默认只自动外发校验通过的 metrics.json）", path);
        assert.equal(byPath[path].downloadable, false, path);
      }
      assert.deepEqual(stored, ["metrics.json"], "nothing but the trusted metrics reached R2");
      assert.equal(view.result.technicalValidity, "valid");
      assert.deepEqual(view.result.metrics.values, { accuracy: 0.9 });
    });

    await t.test("a metrics.json with smuggled content is downgraded and the result is invalid (T19 kept)", async () => {
      const smuggled = {
        "extra nested blob": metrics({ extra: { rows: [RAW.toString("hex")] } }),
        // Passes validateMetricsFile (≤ 64 chars) but is free text, not an identifier.
        "free-text split": JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: EVAL, split: "id 1 age 54 diagnosis A", values: { accuracy: 0.9 } }),
        "duplicate key": `{"values":${JSON.stringify(RAW.toString("base64"))},${metrics().slice(1)}`,
        "padding": metrics() + " ".repeat(4000),
      };
      for (const [label, content] of Object.entries(smuggled)) {
        const work = await dispatch(defaultDataset);
        const { view, stored, byPath } = await complete(work, [file("metrics.json", content, { kind: "metrics" })]);
        assert.equal(byPath["metrics.json"].egressDecision, "held", label);
        assert.match(byPath["metrics.json"].egressReason, /平台复核：metrics\.json 未通过可信指标校验/, label);
        assert.deepEqual(stored, [], label);
        assert.equal(view.result.technicalValidity, "invalid", label);
        assert.equal(view.result.metrics, null, label);
        assert.match(view.result.validityNotes, /metrics 产物未外发/, label);
      }
    });

    await t.test("a metrics.json the runner held is still reported and recorded invalid, not unknown (T19)", async () => {
      const work = await dispatch(defaultDataset);
      const held = file("metrics.json", JSON.stringify({ schema: "tanyan.metrics/v1" }), { kind: "metrics", decision: "held", reason: "metrics.json 未通过可信指标校验，按默认策略扣留：缺少评价协议 sha256" });
      const { view, stored } = await complete(work, [held], { publish: [] });
      assert.equal(view.result.technicalValidity, "invalid");
      assert.match(view.result.validityNotes, /metrics 产物未外发（metrics\.json 未通过可信指标校验/);
      assert.deepEqual(stored, []);
      const none = await dispatch(defaultDataset);
      assert.equal((await complete(none, [], { metricsArtifactPath: null })).view.result.technicalValidity, "unknown");
    });

    await t.test("an opt-in path publishes and records the policy basis; size/extension checks still apply", async () => {
      const work = await dispatch(optInDataset);
      assert.deepEqual(work.spec.egress.autoPublishPaths, ["logs/*.log", "predictions.csv"], "the approved spec binds the opt-in");
      const items = [
        file("metrics.json", metrics(), { kind: "metrics" }),
        file("predictions.csv", "id,prediction\n1,0\n", { kind: "table" }),
        file("logs/job.log", "epoch 1 loss 0.4\n", { kind: "log" }),
        file("logs/huge.log", "x".repeat(100_001), { kind: "log" }),
        file("other.csv", "a\n1\n", { kind: "table" }),
      ];
      const { stored, byPath } = await complete(work, items);
      assert.equal(byPath["predictions.csv"].egressDecision, "published");
      assert.equal(byPath["predictions.csv"].egressReason, "平台复核：数据持有方授权外发（autoPublishPaths 命中 \"predictions.csv\"）");
      assert.equal(byPath["logs/job.log"].egressDecision, "published");
      assert.match(byPath["logs/job.log"].egressReason, /autoPublishPaths 命中 "logs\/\*\.log"/);
      assert.equal(byPath["logs/huge.log"].egressDecision, "held");
      assert.match(byPath["logs/huge.log"].egressReason, /超过单文件上限/);
      assert.equal(byPath["other.csv"].egressDecision, "held");
      assert.deepEqual(stored, ["logs/job.log", "metrics.json", "predictions.csv"]);
      assert.equal(outbound, 0, "no external requests");
    });
  } finally {
    await mf.dispose();
  }
});
