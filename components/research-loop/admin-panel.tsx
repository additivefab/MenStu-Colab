"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getJson, postJson, type Dataset, type Entrypoint } from "./api";
import { bytesLabel, dateLabel, providerLabels, shortSha } from "./labels";
import { Blocked, ConfirmButton, CopyButton, ErrorNote, Notice, Pill } from "./ui";
import { PilotMetricsSection } from "./pilot-metrics";
import styles from "./research-loop.module.css";

type StudentOption = { id: string; name: string };

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

type GithubState = {
  configured: { app: boolean; webhook: boolean };
  installations: { installationId: number; accountLogin: string; accountType: string; repositorySelection: string; status: string; updatedAt: string }[];
  students: {
    studentId: string;
    displayName: string;
    boundFullName: string | null;
    link: { repositoryId: number; installationId: number; fullName: string; defaultBranch: string; status: string; verifiedAt: string } | null;
  }[];
};

function useLoader<T>(url: string, fallback: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback((signal?: AbortSignal) => getJson<T>(url, fallback, signal).then(
    (payload) => { if (!signal?.aborted) { setData(payload); setError(null); } },
    (failure: unknown) => { if (!signal?.aborted) setError(failure); },
  ), [url, fallback]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  return { data, setData, error, setError, load };
}

function GithubSection() {
  const { data, setData, error, setError } = useLoader<GithubState>("/api/admin/github", "GitHub 状态读取失败");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  async function act(body: Record<string, unknown>, tag: string, success: (result: Record<string, unknown>) => string) {
    setBusy(tag); setError(null); setNotice("");
    try {
      const payload = await postJson<GithubState & { result: Record<string, unknown> }>("/api/admin/github", body, "GitHub 操作失败");
      setData(payload);
      setNotice(success(payload.result ?? {}));
    } catch (failure) { setError(failure); } finally { setBusy(null); }
  }

  const appReady = Boolean(data?.configured.app);
  return <section className={styles.adminSection} aria-labelledby="loop-admin-github">
    <header className={styles.blockHead}>
      <h4 id="loop-admin-github">GitHub 仓库授权</h4>
      {data ? <span className={styles.itemMeta}><Pill tone={appReady ? "good" : "warn"}>{appReady ? "GitHub App 已配置" : "GitHub App 未配置"}</Pill><Pill tone={data.configured.webhook ? "good" : "warn"}>{data.configured.webhook ? "Webhook 已配置" : "Webhook 未配置"}</Pill></span> : null}
    </header>
    {data && !appReady ? <Blocked>需在 Worker secrets 中配置 GITHUB_APP_ID 与 GITHUB_APP_PRIVATE_KEY 后，才能同步安装、关联仓库和发布 PR。</Blocked> : null}
    <p className={styles.muted}>平台只按学生档案里已绑定的仓库名，在 App 安装范围内解析稳定仓库 ID；不接受手填仓库标识。</p>
    {!data && !error ? <p className={styles.muted} role="status">正在读取…</p> : null}
    {data ? <>
      <div className={styles.actions}>
        <button type="button" disabled={!appReady || busy !== null} onClick={() => void act({ action: "sync_installations" }, "sync", (result) => `已同步 ${String(result.synced ?? 0)} 个安装。`)}>{busy === "sync" ? "正在同步…" : "同步 App 安装"}</button>
        <small>{data.installations.length ? data.installations.map((item) => `${item.accountLogin}（${item.status === "active" ? "有效" : item.status}）`).join("、") : "尚无安装记录"}</small>
      </div>
      <div className={styles.tableWrap}><table className={`${styles.table} ${styles.wideTable}`}>
        <thead><tr><th scope="col">学生</th><th scope="col">档案绑定</th><th scope="col">授权链接</th><th scope="col">操作</th></tr></thead>
        <tbody>{data.students.map((row) => {
          const active = row.link?.status === "active";
          return <tr key={row.studentId}>
            <td>{row.displayName}</td>
            <td className={styles.mono}>{row.boundFullName ?? "未绑定"}</td>
            <td>{row.link ? <><Pill tone={active ? "good" : "neutral"}>{active ? "有效" : "已撤销"}</Pill><small className={styles.mono}>{row.link.fullName} · {row.link.defaultBranch}</small></> : <Pill tone="warn">未链接</Pill>}</td>
            <td><span className={styles.rowActions}>
              {!active ? <button type="button" disabled={!appReady || !row.boundFullName || busy !== null} title={!row.boundFullName ? "学生尚未在档案中绑定仓库" : undefined} onClick={() => void act({ action: "link_repository", studentId: row.studentId }, `link-${row.studentId}`, (result) => `已链接 ${String(result.fullName ?? "")}。`)}>{busy === `link-${row.studentId}` ? "链接中…" : "链接仓库"}</button> : null}
              {active ? <button type="button" disabled={!appReady || busy !== null} onClick={() => void act({ action: "check_access", studentId: row.studentId }, `check-${row.studentId}`, (result) => `读取正常：${String(result.ref ?? "")} → ${shortSha(String(result.commitSha ?? ""), 12)}`)}>{busy === `check-${row.studentId}` ? "检查中…" : "检查读取"}</button> : null}
              {active ? <ConfirmButton label="撤销链接" confirmLabel="确认撤销" prompt="撤销后代理与运行不再能访问该仓库。" busy={busy !== null} danger onConfirm={() => void act({ action: "revoke_link", studentId: row.studentId }, `revoke-${row.studentId}`, () => "已撤销仓库链接。")} /> : null}
            </span></td>
          </tr>;
        })}</tbody>
      </table></div>
      {!data.students.length ? <p className={styles.muted}>还没有学生在档案中绑定科研仓库。</p> : null}
    </> : null}
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
  </section>;
}

// ---------------------------------------------------------------------------
// Lab registry
// ---------------------------------------------------------------------------

type LabState = {
  runners: { id: string; label: string; kind: "compute" | "agent"; status: string; lastSeenAt: string | null }[];
  entrypoints: Entrypoint[];
  datasets: Dataset[];
  grants: { datasetVersionId: string; studentId: string; grantedAt: string; active: boolean }[];
};

const DEFAULT_PARAMS = "{\n  \"epochs\": { \"type\": \"integer\", \"default\": 10, \"minimum\": 1, \"maximum\": 500 }\n}";

function LabSection({ students }: { students: StudentOption[] }) {
  const { data, error, setError, load } = useLoader<LabState>("/api/admin/lab", "实验室登记读取失败");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [form, setForm] = useState<"runner" | "entrypoint" | "dataset" | "grant" | null>(null);
  const names = new Map(students.map((item) => [item.id, item.name]));

  async function act(body: Record<string, unknown>, tag: string, success: string) {
    setBusy(tag); setError(null); setNotice("");
    try {
      const payload = await postJson<Record<string, unknown>>("/api/admin/lab", body, "实验室登记操作失败");
      if (typeof payload.token === "string") {
        const runner = payload.runner as { label?: string } | undefined;
        setIssued({ label: runner?.label ?? "", token: payload.token });
      }
      setNotice(success);
      setForm(null);
      await load();
      return true;
    } catch (failure) { setError(failure); return false; } finally { setBusy(null); }
  }

  function submitRunner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void act({ action: "register_runner", label: values.get("label"), kind: values.get("kind") }, "runner", "执行器已登记。");
  }

  function submitEntrypoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    let paramsSchema: unknown;
    try { paramsSchema = JSON.parse(String(values.get("paramsSchema") || "{}")); }
    catch { setError(new Error("参数定义不是有效的 JSON")); return; }
    void act({
      action: "register_entrypoint", studentId: values.get("studentId"), name: values.get("name"),
      argv: String(values.get("argv") ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      paramsSchema, imageRef: String(values.get("imageRef") ?? "").trim(), evaluationProtocolSha256: String(values.get("evaluationProtocolSha256") ?? "").trim().toLowerCase(),
    }, "entrypoint", "运行入口已登记。");
  }

  function submitDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void act({
      action: "register_dataset", label: values.get("label"), runnerId: values.get("runnerId"),
      manifestSha256: String(values.get("manifestSha256") ?? "").trim().toLowerCase(),
      splitManifestSha256: String(values.get("splitManifestSha256") ?? "").trim().toLowerCase(),
      egressPolicy: {
        schema: "tanyan.egress/v1",
        allowedExtensions: String(values.get("allowedExtensions") ?? "").split(/[\s,，]+/).map((item) => item.trim().toLowerCase()).filter(Boolean),
        maxFileBytes: Math.round(Number(values.get("maxFileMb")) * 1024 * 1024),
        maxTotalBytes: Math.round(Number(values.get("maxTotalMb")) * 1024 * 1024),
        allowImages: values.get("allowImages") === "on",
        blockDatasetHashMatches: true,
        autoPublishPaths: String(values.get("autoPublishPaths") ?? "").split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean),
      },
    }, "dataset", "数据集版本已登记。");
  }

  function submitGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void act({ action: "grant_dataset", datasetVersionId: values.get("datasetVersionId"), studentId: values.get("studentId") }, "grant", "已授予计算授权（只读挂载，不可下载）。");
  }

  const computeRunners = data?.runners.filter((item) => item.kind === "compute" && item.status === "active") ?? [];
  const datasetLabels = new Map((data?.datasets ?? []).map((item) => [item.id, item.label]));
  return <section className={styles.adminSection} aria-labelledby="loop-admin-lab">
    <header className={styles.blockHead}><h4 id="loop-admin-lab">实验室：执行器、入口与数据</h4></header>
    {issued ? <div className={styles.tokenBox} role="alert">
      <strong>执行器“{issued.label}”的凭据只显示这一次</strong>
      <p>请立即复制并保存到实验室服务器的配置文件或环境变量中。平台只保存哈希，关闭后无法再次查看；丢失请停用后重新登记。</p>
      <code className={styles.hash}>{issued.token}</code>
      <div className={styles.actions}><CopyButton text={issued.token} label="复制凭据" /><button type="button" onClick={() => setIssued(null)}>我已保存，关闭</button></div>
    </div> : null}
    {!data && !error ? <p className={styles.muted} role="status">正在读取…</p> : null}
    {data ? <>
      <h5>执行器</h5>
      <ul className={styles.adminList}>{data.runners.map((runner) => <li key={runner.id}>
        <span><strong>{runner.label}</strong><small>{runner.kind === "compute" ? "计算执行器" : "代理工作进程"} · 最近在线 {dateLabel(runner.lastSeenAt)}</small></span>
        <span className={styles.rowActions}><Pill tone={runner.status === "active" ? "good" : "neutral"}>{runner.status === "active" ? "有效" : "已停用"}</Pill>
          {runner.status === "active" ? <ConfirmButton label="停用" confirmLabel="确认停用" prompt="停用后不再领取新工作。" busy={busy !== null} danger onConfirm={() => void act({ action: "disable_runner", runnerId: runner.id }, `runner-${runner.id}`, "执行器已停用。")} /> : null}</span>
      </li>)}{!data.runners.length ? <li className={styles.muted}>尚未登记执行器。</li> : null}</ul>
      {form === "runner" ? <form className={styles.form} onSubmit={submitRunner}>
        <div className={styles.grid2}>
          <label>名称<input name="label" required maxLength={80} placeholder="例如：实验室 GPU 服务器 A" /></label>
          <label>类型<select name="kind" defaultValue="compute"><option value="compute">计算执行器（运行作业）</option><option value="agent">代理工作进程（运行 Codex / Claude）</option></select></label>
        </div>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy !== null}>{busy === "runner" ? "正在登记…" : "登记并生成凭据"}</button><button type="button" onClick={() => setForm(null)}>取消</button></div>
      </form> : <div className={styles.actions}><button type="button" onClick={() => setForm("runner")}>登记执行器</button></div>}

      <h5>运行入口</h5>
      <ul className={styles.adminList}>{data.entrypoints.map((item) => <li key={item.id}>
        <span><strong>{item.name}</strong><small>{item.studentId ? names.get(item.studentId) ?? item.studentId : "仓库未链接"} · <code>{item.argv.join(" ")}</code> · 评价协议 {shortSha(item.evaluationProtocolSha256)}</small></span>
        <span className={styles.rowActions}><Pill tone={item.active ? "good" : "neutral"}>{item.active ? "有效" : "已停用"}</Pill>
          {item.active ? <ConfirmButton label="停用" confirmLabel="确认停用" prompt="停用后不能再用于新运行。" busy={busy !== null} danger onConfirm={() => void act({ action: "disable_entrypoint", entrypointId: item.id }, `ep-${item.id}`, "入口已停用。")} /> : null}</span>
      </li>)}{!data.entrypoints.length ? <li className={styles.muted}>尚未登记运行入口。</li> : null}</ul>
      {form === "entrypoint" ? <form className={styles.form} onSubmit={submitEntrypoint}>
        <div className={styles.grid2}>
          <label>学生（需已链接仓库）<select name="studentId" required>{students.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>入口名称<input name="name" required maxLength={80} placeholder="例如：train_eval" /></label>
          <label>argv（每行一项，不经 shell）<textarea name="argv" required rows={3} spellCheck={false} placeholder={"python\nscripts/train.py"} /></label>
          <label>参数定义（JSON）<textarea name="paramsSchema" rows={3} spellCheck={false} defaultValue={DEFAULT_PARAMS} /></label>
          <label>镜像引用（必须带 @sha256: 摘要）<input name="imageRef" required spellCheck={false} placeholder="registry.lab/train@sha256:…" /></label>
          <label>评价协议 sha256<input name="evaluationProtocolSha256" required pattern="[0-9a-fA-F]{64}" spellCheck={false} /></label>
        </div>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy !== null}>{busy === "entrypoint" ? "正在登记…" : "登记入口"}</button><button type="button" onClick={() => setForm(null)}>取消</button></div>
      </form> : <div className={styles.actions}><button type="button" onClick={() => setForm("entrypoint")}>登记运行入口</button></div>}

      <h5>数据集版本</h5>
      <ul className={styles.adminList}>{data.datasets.map((item) => <li key={item.id}>
        <span><strong>{item.label}</strong><small>清单 {shortSha(item.manifestSha256)} · 外发 {item.egressPolicy ? `${item.egressPolicy.allowedExtensions.join(" ")}，单文件 ≤ ${bytesLabel(item.egressPolicy.maxFileBytes)}，图片${item.egressPolicy.allowImages ? "可" : "不"}外发；自动外发 metrics.json${item.egressPolicy.autoPublishPaths?.length ? `、${item.egressPolicy.autoPublishPaths.join(" ")}（数据持有方授权）` : "，其余产物默认扣留"}` : "策略损坏"}</small></span>
        <span className={styles.rowActions}><Pill tone={item.active ? "good" : "neutral"}>{item.active ? "有效" : "已停用"}</Pill>
          {item.active ? <ConfirmButton label="停用" confirmLabel="确认停用" prompt="停用后不能再用于新运行。" busy={busy !== null} danger onConfirm={() => void act({ action: "disable_dataset", datasetVersionId: item.id }, `ds-${item.id}`, "数据集版本已停用。")} /> : null}</span>
      </li>)}{!data.datasets.length ? <li className={styles.muted}>尚未登记数据集版本。</li> : null}</ul>
      {form === "dataset" && computeRunners.length ? <form className={styles.form} onSubmit={submitDataset}>
        <div className={styles.grid2}>
          <label>名称<input name="label" required maxLength={120} /></label>
          <label>托管执行器<select name="runnerId" required>{computeRunners.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>数据清单 sha256<input name="manifestSha256" required pattern="[0-9a-fA-F]{64}" spellCheck={false} /></label>
          <label>划分清单 sha256（可选）<input name="splitManifestSha256" pattern="[0-9a-fA-F]{64}" spellCheck={false} /></label>
          <label>可外发扩展名<input name="allowedExtensions" required defaultValue=".json .csv .txt .md" spellCheck={false} /></label>
          <label>单文件上限（MB）<input name="maxFileMb" type="number" min={0.001} max={10} step="any" required defaultValue={5} /></label>
          <label>总量上限（MB）<input name="maxTotalMb" type="number" min={0.001} max={1000} step="any" required defaultValue={20} /></label>
          <label className={styles.check}><input name="allowImages" type="checkbox" />允许外发图片（图片可能含原始数据，默认不外发）</label>
          <label>自动外发路径（数据持有方授权，可选）<input name="autoPublishPaths" placeholder="例如 predictions.csv logs/*.log" spellCheck={false} /></label>
        </div>
        <p className={styles.muted}>默认只自动外发校验通过的 metrics.json，其余产物扣留在实验室，需数据持有方授权后外发。填写自动外发路径即代表数据持有方授权：只接受精确路径或子目录下的窄通配（如 logs/*.log），仍受扩展名和大小限制。与数据集清单哈希相同的输出始终禁止外发。</p>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy !== null}>{busy === "dataset" ? "正在登记…" : "登记数据集版本"}</button><button type="button" onClick={() => setForm(null)}>取消</button></div>
      </form> : computeRunners.length ? <div className={styles.actions}><button type="button" onClick={() => setForm("dataset")}>登记数据集版本</button></div> : <Blocked>登记数据集前，需要先登记一个有效的计算执行器来托管数据。</Blocked>}

      <h5>数据授权（只读计算，不可下载）</h5>
      <ul className={styles.adminList}>{data.grants.map((grant) => <li key={`${grant.datasetVersionId}-${grant.studentId}`}>
        <span><strong>{names.get(grant.studentId) ?? grant.studentId}</strong><small>{datasetLabels.get(grant.datasetVersionId) ?? grant.datasetVersionId} · 授权于 {dateLabel(grant.grantedAt)}</small></span>
        <span className={styles.rowActions}><Pill tone={grant.active ? "good" : "neutral"}>{grant.active ? "有效" : "已撤销"}</Pill>
          {grant.active ? <ConfirmButton label="撤销" confirmLabel="确认撤销" prompt="进行中的运行会在下次心跳时被取消。" busy={busy !== null} danger onConfirm={() => void act({ action: "revoke_dataset", datasetVersionId: grant.datasetVersionId, studentId: grant.studentId }, `grant-${grant.studentId}`, "数据授权已撤销。")} /> : null}</span>
      </li>)}{!data.grants.length ? <li className={styles.muted}>尚无数据授权。</li> : null}</ul>
      {form === "grant" && data.datasets.some((item) => item.active) ? <form className={styles.form} onSubmit={submitGrant}>
        <div className={styles.grid2}>
          <label>数据集版本<select name="datasetVersionId" required>{data.datasets.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>学生<select name="studentId" required>{students.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy !== null}>{busy === "grant" ? "正在授权…" : "授予计算授权"}</button><button type="button" onClick={() => setForm(null)}>取消</button></div>
      </form> : data.datasets.some((item) => item.active) ? <div className={styles.actions}><button type="button" onClick={() => setForm("grant")}>授予数据授权</button></div> : <Blocked>授予数据授权前，需要先登记有效的数据集版本。</Blocked>}
    </> : null}
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
  </section>;
}

// ---------------------------------------------------------------------------
// Agent credential profiles
// ---------------------------------------------------------------------------

type ProfileState = {
  profiles: { id: string; userId: number; userDisplayName: string; provider: string; workerId: string; workerLabel: string; workerStatus: string; active: boolean; createdAt: string }[];
  workers: { id: string; label: string; status: string; lastSeenAt: string | null }[];
};
type UserOption = { id: number; display_name: string; role: string };

function ProfileSection() {
  const { data, setData, error, setError } = useLoader<ProfileState>("/api/admin/agent-credential-profiles", "代理凭据档案读取失败");
  const users = useLoader<{ users: UserOption[] }>("/api/users", "账号列表读取失败");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);

  async function act(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(null); setNotice("");
    try {
      setData(await postJson<ProfileState>("/api/admin/agent-credential-profiles", body, "凭据档案操作失败"));
      setNotice(success);
      setOpen(false);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void act({ action: "create", userId: Number(values.get("userId")), provider: values.get("provider"), workerId: values.get("workerId") }, "凭据档案映射已登记。");
  }

  const activeWorkers = data?.workers.filter((item) => item.status === "active") ?? [];
  const eligible = (users.data?.users ?? []).filter((item) => item.role !== "pending");
  const roleLabel: Record<string, string> = { superadmin: "超级管理员", admin: "导师", student: "学生" };
  return <section className={styles.adminSection} aria-labelledby="loop-admin-profiles">
    <header className={styles.blockHead}><h4 id="loop-admin-profiles">代理凭据档案</h4></header>
    <p className={styles.notice}>平台只记录“用户 ↔ 提供商 ↔ 代理工作进程”的对应关系，不接收、不保存任何凭据。Codex 登录缓存和 Claude OAuth token 只存放在对应工作进程所在的实验室机器上，由本人在该机器上登录配置。</p>
    {!data && !error ? <p className={styles.muted} role="status">正在读取…</p> : null}
    {data ? <>
      <ul className={styles.adminList}>{data.profiles.map((profile) => <li key={profile.id}>
        <span><strong>{profile.userDisplayName}</strong><small>{providerLabels[profile.provider] ?? profile.provider} · 工作进程 {profile.workerLabel}{profile.workerStatus !== "active" ? "（已停用）" : ""}</small></span>
        <span className={styles.rowActions}><Pill tone={profile.active ? "good" : "neutral"}>{profile.active ? "有效" : "已停用"}</Pill>
          {profile.active ? <ConfirmButton label="停用" confirmLabel="确认停用" prompt="该用户将不能再用此提供商启动代理。" busy={busy} danger onConfirm={() => void act({ action: "deactivate", id: profile.id }, "凭据档案已停用。")} /> : null}</span>
      </li>)}{!data.profiles.length ? <li className={styles.muted}>尚无凭据档案。</li> : null}</ul>
      {open && activeWorkers.length ? <form className={styles.form} onSubmit={submit}>
        <div className={styles.grid2}>
          <label>用户<select name="userId" required>{eligible.map((item) => <option key={item.id} value={item.id}>{item.display_name}（{roleLabel[item.role] ?? item.role}）</option>)}</select></label>
          <label>提供商<select name="provider" required defaultValue="codex"><option value="codex">Codex（ChatGPT 登录缓存）</option><option value="claude">Claude（本人 OAuth token）</option></select></label>
          <label>代理工作进程<select name="workerId" required>{activeWorkers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </div>
        <ErrorNote error={users.error} />
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || !eligible.length}>{busy ? "正在登记…" : "登记映射"}</button><button type="button" onClick={() => setOpen(false)}>取消</button></div>
      </form> : activeWorkers.length ? <div className={styles.actions}><button type="button" onClick={() => setOpen(true)}>登记凭据档案映射</button></div> : <Blocked>登记映射前，需要先在“实验室”中登记一个有效的代理工作进程。</Blocked>}
    </> : null}
    <ErrorNote error={error} />
    <Notice>{notice}</Notice>
  </section>;
}

/** Superadmin settings for the research loop: GitHub, lab registry, agent profiles. */
export function ResearchLoopAdmin({ students }: { students: StudentOption[] }) {
  return <section className={styles.admin} aria-labelledby="loop-admin-title">
    <header className={styles.panelHead}>
      <div><h2 id="loop-admin-title">代码与实验配置</h2><p>GitHub 仓库授权、实验室执行器与数据、代理凭据档案</p></div>
    </header>
    <GithubSection />
    <LabSection students={students} />
    <ProfileSection />
    <section className={styles.adminSection} aria-label="试点流程指标"><PilotMetricsSection /></section>
  </section>;
}
