"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_PROTECTED_PATHS, evaluatePathPolicy } from "../../lib/research-loop/contracts";
import { getJson, postJson, type AttemptDetail, type ChangeRequest, type ChangeRequestDetail, type TaskDetail } from "./api";
import { DiffView, splitUnifiedDiff, type DiffFile } from "./diff-view";
import { changeRequestStatusLabels, dateLabel, label, providerLabels, shortSha } from "./labels";
import { anchorId, useFocusedCard, useLoopNavigation } from "./navigation";
import { Blocked, ConfirmButton, ErrorNote, Notice, Pill } from "./ui";
import review from "./change-review.module.css";
import styles from "./research-loop.module.css";

const actionLabels: Record<string, string> = { add: "新增", modify: "修改", delete: "删除" };
const PROTECTED = "受保护路径";
const OUTSIDE = "超出允许范围";
/** Largest afterSequence the attempt endpoint accepts: returns no events. */
const SKIP_EVENTS = "999999999999999";

type PathMark = { protectedTouched: boolean; outsideAllowed: boolean; invalid: boolean };

/** Display-only recomputation of the server's path policy (publisher unions the
 * version's protected paths with the defaults). `allowed` null = not loaded. */
function pathMarks(paths: string[], allowed: readonly string[] | null, protectedPatterns: readonly string[]) {
  const marks = new Map<string, PathMark>();
  for (const path of paths) {
    try {
      const result = evaluatePathPolicy([path], allowed ?? [], protectedPatterns);
      marks.set(path, { protectedTouched: result.protectedTouched.length > 0, outsideAllowed: result.outsideAllowed.length > 0, invalid: false });
    } catch {
      marks.set(path, { protectedTouched: false, outsideAllowed: false, invalid: true });
    }
  }
  return marks;
}

function exitBadge(exitCode: number | undefined) {
  if (typeof exitCode !== "number") return <span className={review.exitUnknown}>退出码未上报</span>;
  return <span className={exitCode === 0 ? review.exitOk : review.exitBad}>退出码 {exitCode}</span>;
}

export function ChangeRequestCard({ item, onChanged }: { item: ChangeRequest; onChanged: () => void }) {
  const [open, setOpen] = useState(item.status === "pending_review");
  const [detail, setDetail] = useState<ChangeRequestDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<AttemptDetail["attempt"] | null>(null);
  const [attemptError, setAttemptError] = useState<unknown>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskError, setTaskError] = useState<unknown>(null);
  const rootRef = useFocusedCard<HTMLElement>("changeRequest", item.id, setOpen);
  const { registerChangeRequest, changeRequestRef } = useLoopNavigation();

  const load = useCallback((signal?: AbortSignal) => getJson<ChangeRequestDetail>(
    `/api/change-requests?changeRequestId=${encodeURIComponent(item.id)}`, "变更请求读取失败", signal,
  ).then((payload) => { if (!signal?.aborted) setDetail(payload); }, (failure: unknown) => { if (!signal?.aborted) setError(failure); }), [item.id]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load, item.version]);

  // Review context: the agent's own test report and the task version's path scope.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    void getJson<AttemptDetail>(`/api/agent-attempts?attemptId=${encodeURIComponent(item.attemptId)}&afterSequence=${SKIP_EVENTS}`, "代理尝试读取失败", signal)
      .then((payload) => { if (!signal.aborted) { setAttempt(payload.attempt); setAttemptError(null); } },
        (failure: unknown) => { if (!signal.aborted) setAttemptError(failure); });
    void getJson<TaskDetail>(`/api/research-tasks?taskId=${encodeURIComponent(item.taskId)}`, "任务读取失败", signal)
      .then((payload) => { if (!signal.aborted) { setTaskDetail(payload); setTaskError(null); } },
        (failure: unknown) => { if (!signal.aborted) setTaskError(failure); });
    return () => controller.abort();
  }, [open, item.attemptId, item.taskId]);

  const current = detail?.changeRequest ?? item;
  const permissions = detail?.permissions ?? item.permissions;
  const prNumber = current.prNumber ?? null;

  // Let lineage chains and titles elsewhere in the panel name this change.
  useEffect(() => {
    registerChangeRequest?.({ id: item.id, taskId: item.taskId, createdAt: item.createdAt, prNumber });
  }, [registerChangeRequest, item.id, item.taskId, item.createdAt, prNumber]);
  const changeNumber = changeRequestRef?.(item.id)?.number ?? null;
  const provider = providerLabels[current.provider] ?? current.provider;
  const title = prNumber ? `PR #${prNumber} · ${provider}` : `${changeNumber ? `变更 #${changeNumber}` : "变更请求"} · ${provider} 修改 · ${dateLabel(current.createdAt)}`;

  const taskVersion = attempt?.taskVersion ?? taskDetail?.attempts.find((entry) => entry.id === item.attemptId)?.taskVersion ?? null;
  const version = taskVersion === null ? null : taskDetail?.versions.find((entry) => entry.version === taskVersion) ?? null;
  const change = detail?.change ?? null;
  const diffFiles = useMemo<DiffFile[]>(() => (change ? splitUnifiedDiff(change.unifiedDiff) : []), [change]);
  const protectedPatterns = useMemo(() => [...new Set([...(version?.protectedPaths ?? []), ...DEFAULT_PROTECTED_PATHS])], [version]);
  const marks = useMemo(() => pathMarks(change?.paths.map((file) => file.path) ?? [], version ? version.allowedPaths : null, protectedPatterns),
    [change, version, protectedPatterns]);
  const flags = useMemo(() => {
    const result = new Map<string, string>();
    for (const [path, mark] of marks) {
      const text = [mark.protectedTouched ? PROTECTED : "", mark.outsideAllowed ? OUTSIDE : ""].filter(Boolean).join(" · ");
      if (text) result.set(path, text);
    }
    return result;
  }, [marks]);
  const fileRows = useMemo(() => {
    const byPath = new Map(diffFiles.map((file) => [file.path, file]));
    const rows = (change?.paths ?? []).map((file) => ({ ...file, diff: byPath.get(file.path) ?? null, mark: marks.get(file.path) }));
    // Flagged files first; otherwise keep the server's (sorted) order.
    return rows.sort((a, b) => Number(flags.has(b.path)) - Number(flags.has(a.path)));
  }, [change, diffFiles, marks, flags]);

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
  const totals = diffFiles.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const protectedCount = [...marks.values()].filter((mark) => mark.protectedTouched).length;
  const outsideCount = [...marks.values()].filter((mark) => mark.outsideAllowed).length;
  const reviewPending = current.requiresExtraReview && !current.extraReviewApprovedAt;
  const actionable = ["pending_review", "failed", "publishing"].includes(current.status);
  const tests = attempt?.tests ?? [];
  return <article className={styles.item} id={anchorId.changeRequest(item.id)} ref={rootRef}>
    <div className={review.headRow}>
      <button type="button" className={styles.itemHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={styles.itemTitle}>{title}</span>
        <span className={styles.itemMeta}>{current.requiresExtraReview ? <Pill tone={reviewPending ? "bad" : "good"}>{reviewPending ? "受保护路径待审查" : "额外审查已通过"}</Pill> : null}<Pill tone={tone}>{text}</Pill></span>
      </button>
      {current.prUrl ? <a className={review.prLink} href={current.prUrl} target="_blank" rel="noopener noreferrer" aria-label={`在 GitHub 打开 PR #${prNumber ?? ""}`}>GitHub ↗</a> : null}
    </div>
    {open ? <div className={styles.itemBody}>
      {current.requiresExtraReview ? <p className={reviewPending ? styles.warning : styles.notice}>
        {reviewPending ? "本次修改触及受保护路径（如评价协议、数据划分、依赖或 CI 配置），必须由导师或超级管理员完成额外审查后才能发布。" : `受保护路径的额外审查已于 ${dateLabel(current.extraReviewApprovedAt)} 通过。`}
      </p> : null}
      <dl className={styles.fields}>
        <div className={styles.field}><dt>分支</dt><dd className={styles.mono}>{current.branchName}</dd></div>
        <div className={styles.field}><dt>Pull Request</dt><dd>{current.prUrl ? <a href={current.prUrl} target="_blank" rel="noopener noreferrer">PR #{current.prNumber} 在 GitHub 打开 ↗</a> : "尚未发布"}</dd></div>
        <div className={styles.field}><dt>代理</dt><dd>{provider}{current.modelId ? ` · ${current.modelId}` : ""}{taskVersion !== null ? ` · 第 ${taskVersion} 版任务` : ""}</dd></div>
        <div className={styles.field}><dt>基准提交</dt><dd className={styles.mono}>{shortSha(current.baseCommitSha, 12)}</dd></div>
        <div className={styles.field}><dt>发布后提交</dt><dd className={styles.mono}>{shortSha(current.headCommitSha, 12)}</dd></div>
      </dl>

      {detail ? change ? <>
        <section className={review.section} aria-label="改动文件">
          <div className={review.sectionHead}>
            <h4>改动文件 {change.paths.length} 个</h4>
            <small>
              <span className={review.plus}>+{totals.added}</span> <span className={review.minus}>−{totals.removed}</span>
              {protectedCount ? ` · ${protectedCount} 个受保护` : ""}{outsideCount ? ` · ${outsideCount} 个越界` : ""}
              {change.diffTruncated ? "（diff 已截断，统计不完整）" : ""}
            </small>
          </div>
          <ul className={review.fileList}>{fileRows.map((file) => {
            const flagged = flags.has(file.path);
            return <li key={file.path} className={`${review.fileRow} ${flagged ? review.flaggedRow : ""}`}>
              <span className={`${review.badge} ${review[`badge_${file.action}`] ?? ""}`}>{actionLabels[file.action] ?? file.action}</span>
              <span className={review.filePath}>{file.path}</span>
              <span className={review.fileMarks}>
                {file.mark?.protectedTouched ? <span className={review.flag}>{PROTECTED}</span> : null}
                {file.mark?.outsideAllowed ? <span className={review.flagWarn}>{OUTSIDE}</span> : null}
                {file.mark?.invalid ? <span className={review.flag}>路径无效</span> : null}
                {file.diff ? file.diff.binary ? <span className={review.badge}>二进制</span>
                  : <><span className={review.plus}>+{file.diff.added}</span><span className={review.minus}>−{file.diff.removed}</span></>
                  : <span className={review.badge}>{change.diffTruncated ? "diff 已截断" : "diff 中无此文件"}</span>}
              </span>
            </li>;
          })}</ul>
          {version ? <p className={review.note}>
            按第 {version.version} 版任务核对：允许修改 {version.allowedPaths.length ? <code>{version.allowedPaths.join("、")}</code> : "整个仓库（受保护路径除外）"}；受保护路径含默认规则{version.protectedPaths.some((path) => !(DEFAULT_PROTECTED_PATHS as readonly string[]).includes(path)) ? "和任务追加的路径" : ""}。标记只用于展示，发布时服务器会再次检查。
          </p> : taskError || attemptError ? <p className={review.noteWarn}>未能读取任务的修改范围，“{OUTSIDE}”暂无法标记；“{PROTECTED}”按默认规则标记。发布时服务器会再次检查。</p>
            : taskVersion !== null && taskDetail ? <p className={review.noteWarn}>找不到第 {taskVersion} 版任务，“{OUTSIDE}”暂无法标记。</p>
              : <p className={review.note} role="status">正在读取任务的修改范围…</p>}
        </section>

        <section className={review.section} aria-label="代理实际执行的测试">
          <div className={review.sectionHead}>
            <h4>代理实际执行的测试</h4>
            <small>代理自己上报的结果，平台未复核</small>
          </div>
          {attempt ? tests.length ? <ul className={review.tests}>{tests.map((entry, index) => <li key={index} className={review.test}>
            {exitBadge(entry.exitCode)}
            <code>{entry.command || "（未上报命令）"}</code>
            {entry.summary ? <p>{entry.summary}</p> : null}
          </li>)}</ul> : <p className={review.noteWarn}>代理未执行测试。</p>
            : attemptError ? <ErrorNote error={attemptError} /> : <p className={review.note} role="status">正在读取代理的测试记录…</p>}
        </section>

        <section className={review.section} aria-label="按文件查看 diff">
          <div className={review.sectionHead}>
            <h4>diff</h4>
            <small>{flags.size ? "受保护或越界的文件已默认展开" : "点击文件名展开"}</small>
          </div>
          {change.diffTruncated ? <p className={review.noteWarn}>diff 已截断，只显示前一部分，完整内容请在 PR 中查看。</p> : null}
          <DiffView files={diffFiles} truncated={change.diffTruncated} flags={flags} />
        </section>
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
