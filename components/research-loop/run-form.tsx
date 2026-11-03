"use client";

import { useState, type FormEvent } from "react";
import { newKey, postJson, type ChangeRequest, type Dataset, type Entrypoint, type ParamSpec, type TaskBudget } from "./api";
import { shortSha } from "./labels";
import { Blocked, ErrorNote } from "./ui";
import styles from "./research-loop.module.css";

function initialParams(schema: Record<string, ParamSpec>) {
  return Object.fromEntries(Object.entries(schema).map(([name, spec]) => [name, spec.default === undefined ? "" : String(spec.default)]));
}

function convert(spec: ParamSpec, raw: string): string | number | boolean | undefined {
  if (raw === "") return undefined;
  if (spec.type === "boolean") return raw === "true";
  if (spec.type === "integer" || spec.type === "number") return Number(raw);
  return raw;
}

/** Creates a run (awaiting approval). Options come from GET /api/runs?studentId=. */
export function RunForm({ taskId, budget, changeRequests, entrypoints, datasets, onCreated, onCancel }: {
  taskId: string;
  budget: TaskBudget;
  changeRequests: ChangeRequest[];
  entrypoints: Entrypoint[];
  datasets: Dataset[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const published = changeRequests.filter((item) => ["open", "merged"].includes(item.status) && item.headCommitSha);
  const [key] = useState(newKey);
  const [source, setSource] = useState(published[0]?.id ?? "sha");
  const [sha, setSha] = useState("");
  const [entrypointId, setEntrypointId] = useState(entrypoints[0]?.id ?? "");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [params, setParams] = useState<Record<string, string>>(() => initialParams(entrypoints[0]?.paramsSchema ?? {}));
  const [resources, setResources] = useState({
    gpuCount: String(Math.min(1, budget.maxGpuCount ?? 1)),
    walltimeMinutes: String(Math.min(60, budget.maxWalltimeMinutes ?? 60)),
    memoryGb: "16",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const entrypoint = entrypoints.find((item) => item.id === entrypointId);

  if (!entrypoints.length || !datasets.length) {
    return <Blocked>{!entrypoints.length ? "管理员尚未为该学生的仓库登记运行入口。" : "该学生没有有效的数据集计算授权。"}请联系超级管理员在“系统管理 · 实验室”中配置。</Blocked>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !entrypoint) return;
    setBusy(true);
    setError(null);
    const typed: Record<string, string | number | boolean> = {};
    for (const [name, spec] of Object.entries(entrypoint.paramsSchema)) {
      const value = convert(spec, params[name] ?? "");
      if (value !== undefined) typed[name] = value;
    }
    try {
      await postJson("/api/runs", {
        action: "create", taskId, idempotencyKey: key, entrypointId, datasetVersionId: datasetId, params: typed,
        resources: { gpuCount: Number(resources.gpuCount), walltimeMinutes: Number(resources.walltimeMinutes), memoryGb: Number(resources.memoryGb) },
        ...(source === "sha" ? { executedCommitSha: sha.trim().toLowerCase() } : { changeRequestId: source }),
      }, "运行创建失败，请重试");
      onCreated();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  return <form className={styles.form} onSubmit={submit}>
    <h4>登记运行</h4>
    <p className={styles.muted}>登记后生成不可变的运行规范，需导师批准才会派发到实验室；作业禁止联网，数据只读挂载。</p>
    <div className={styles.grid2}>
      <label>代码版本<select value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}>
        {published.map((item) => <option key={item.id} value={item.id}>变更请求 PR #{item.prNumber} · {shortSha(item.headCommitSha, 8)}</option>)}
        <option value="sha">直接填写提交 SHA</option>
      </select></label>
      {source === "sha" ? <label>提交 SHA（40 位）<input required pattern="[0-9a-fA-F]{40}" value={sha} disabled={busy} spellCheck={false} autoComplete="off" onChange={(event) => setSha(event.target.value)} /></label> : null}
      <label>运行入口<select value={entrypointId} disabled={busy} onChange={(event) => { setEntrypointId(event.target.value); setParams(initialParams(entrypoints.find((item) => item.id === event.target.value)?.paramsSchema ?? {})); }}>
        {entrypoints.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>数据集版本<select value={datasetId} disabled={busy} onChange={(event) => setDatasetId(event.target.value)}>
        {datasets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {entrypoint ? Object.entries(entrypoint.paramsSchema).map(([name, spec]) => <label key={name}>参数 {name}{spec.required ? "" : "（可选）"}
        {spec.type === "boolean" ? <select value={params[name] ?? ""} disabled={busy} onChange={(event) => setParams({ ...params, [name]: event.target.value })}><option value="">默认</option><option value="true">是</option><option value="false">否</option></select>
          : spec.enum ? <select value={params[name] ?? ""} required={spec.required} disabled={busy} onChange={(event) => setParams({ ...params, [name]: event.target.value })}><option value="">请选择</option>{spec.enum.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select>
          : <input type={spec.type === "string" ? "text" : "number"} step={spec.type === "number" ? "any" : undefined} min={spec.minimum} max={spec.maximum} maxLength={spec.maxLength} required={spec.required} value={params[name] ?? ""} disabled={busy} onChange={(event) => setParams({ ...params, [name]: event.target.value })} />}
      </label>) : null}
      <label>GPU 数量<input type="number" min={0} max={budget.maxGpuCount ?? 8} required value={resources.gpuCount} disabled={busy} onChange={(event) => setResources({ ...resources, gpuCount: event.target.value })} /></label>
      <label>运行时长（分钟）<input type="number" min={1} max={budget.maxWalltimeMinutes ?? 10080} required value={resources.walltimeMinutes} disabled={busy} onChange={(event) => setResources({ ...resources, walltimeMinutes: event.target.value })} /></label>
      <label>内存（GB）<input type="number" min={1} max={2048} required value={resources.memoryGb} disabled={busy} onChange={(event) => setResources({ ...resources, memoryGb: event.target.value })} /></label>
    </div>
    {entrypoint ? <p className={styles.muted}>入口命令：<code>{entrypoint.argv.join(" ")}</code></p> : null}
    <ErrorNote error={error} />
    <div className={styles.actions}>
      <button type="submit" className={styles.primary} disabled={busy}>{busy ? "正在登记…" : "登记运行（待批准）"}</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>;
}
