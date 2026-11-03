"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson, type ChangeRequest, type ChangeRequestDetail } from "./api";
import { changeRequestStatusLabels, dateLabel, label, providerLabels, shortSha } from "./labels";
import { Blocked, ConfirmButton, ErrorNote, Notice, Pill } from "./ui";
import styles from "./research-loop.module.css";

/** Counts added/removed lines in a unified diff (headers excluded). */
export function diffStats(diff: string) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

const actionLabels: Record<string, string> = { add: "新增", modify: "修改", delete: "删除" };

export function ChangeRequestCard({ item, onChanged }: { item: ChangeRequest; onChanged: () => void }) {
  const [open, setOpen] = useState(item.status === "pending_review");
  const [detail, setDetail] = useState<ChangeRequestDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal?: AbortSignal) => getJson<ChangeRequestDetail>(
    `/api/change-requests?changeRequestId=${encodeURIComponent(item.id)}`, "变更请求读取失败", signal,
  ).then((payload) => { if (!signal?.aborted) setDetail(payload); }, (failure: unknown) => { if (!signal?.aborted) setError(failure); }), [item.id]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load, item.version]);

  const current = detail?.changeRequest ?? item;
  const permissions = detail?.permissions ?? item.permissions;

  async function act(action: "publish" | "approve_extra_review" | "reject") {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await postJson<ChangeRequestDetail>("/api/change-requests", { action, changeRequestId: item.id, expectedVersion: current.version }, "操作失败，请重试");
      setNotice(action === "publish" ? "已发布为 GitHub Draft PR。" : action === "approve_extra_review" ? "额外审查已通过，现在可以发布。" : "变更请求已驳回。");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      await load();
      onChanged();
    }
  }

  const [text, tone] = label(changeRequestStatusLabels, current.status);
  const stats = detail?.change ? diffStats(detail.change.unifiedDiff) : null;
  const reviewPending = current.requiresExtraReview && !current.extraReviewApprovedAt;
  const actionable = ["pending_review", "failed", "publishing"].includes(current.status);
  return <article className={styles.item}>
    <button type="button" className={styles.itemHead} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={styles.itemTitle}>变更请求 · {current.branchName}</span>
      <span className={styles.itemMeta}>{current.requiresExtraReview ? <Pill tone={reviewPending ? "bad" : "good"}>{reviewPending ? "受保护路径待审查" : "额外审查已通过"}</Pill> : null}<Pill tone={tone}>{text}</Pill></span>
    </button>
    {open ? <div className={styles.itemBody}>
      {current.requiresExtraReview ? <p className={reviewPending ? styles.warning : styles.notice}>
        {reviewPending ? "本次修改触及受保护路径（如评价协议、数据划分、依赖或 CI 配置），必须由导师或超级管理员完成额外审查后才能发布。" : `受保护路径的额外审查已于 ${dateLabel(current.extraReviewApprovedAt)} 通过。`}
      </p> : null}
      <dl className={styles.fields}>
        <div className={styles.field}><dt>代理</dt><dd>{providerLabels[current.provider] ?? current.provider}{current.modelId ? ` · ${current.modelId}` : ""}</dd></div>
        <div className={styles.field}><dt>基准提交</dt><dd className={styles.mono}>{shortSha(current.baseCommitSha, 12)}</dd></div>
        <div className={styles.field}><dt>发布后提交</dt><dd className={styles.mono}>{shortSha(current.headCommitSha, 12)}</dd></div>
        <div className={styles.field}><dt>Pull Request</dt><dd>{current.prUrl ? <a href={current.prUrl} target="_blank" rel="noopener noreferrer">#{current.prNumber} 在 GitHub 打开 ↗</a> : "尚未发布"}</dd></div>
      </dl>
      {detail ? detail.change ? <>
        <p className={styles.diffStats}><strong>{detail.change.paths.length}</strong> 个文件 · <span className={styles.added}>+{stats?.added ?? 0}</span> <span className={styles.removed}>−{stats?.removed ?? 0}</span></p>
        <ul className={styles.pathList}>{detail.change.paths.map((file) => <li key={file.path}><span className={styles.eventKind}>{actionLabels[file.action] ?? file.action}</span>{file.path}</li>)}</ul>
        <details className={styles.subtle}><summary>查看 diff{detail.change.diffTruncated ? "（已截断，完整内容见 PR）" : ""}</summary><pre className={styles.diff}>{detail.change.unifiedDiff || "（空）"}</pre></details>
      </> : <p className={styles.muted}>修改内容暂时无法读取（存储未配置或文件缺失）。</p> : <p className={styles.muted} role="status">正在读取修改内容…</p>}
      <ErrorNote error={error} />
      <Notice>{notice}</Notice>
      {actionable ? <div className={styles.actions}>
        {permissions.canApproveExtraReview ? <ConfirmButton label="通过额外审查" confirmLabel="确认通过" prompt="确认已审阅受保护路径的改动？" busy={busy} onConfirm={() => void act("approve_extra_review")} /> : null}
        {permissions.canPublish ? <button type="button" className={styles.primary} disabled={busy} onClick={() => void act("publish")}>{busy ? "处理中…" : current.status === "failed" ? "重新发布为 Draft PR" : "发布为 Draft PR"}</button> : null}
        {permissions.canReject ? <ConfirmButton label="驳回" confirmLabel="确认驳回" prompt="驳回后不能再发布。" busy={busy} danger onConfirm={() => void act("reject")} /> : null}
      </div> : null}
      {actionable && !permissions.canPublish ? <Blocked>{reviewPending
        ? permissions.canApproveExtraReview ? "通过额外审查后才能发布。" : "需由有审核权限的导师或超级管理员先完成额外审查（发起代理的人不能审查自己的修改）。"
        : "只有学生本人或有审核权限的导师可以发布。"}</Blocked> : null}
    </div> : null}
  </article>;
}
