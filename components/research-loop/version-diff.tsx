"use client";

import { useMemo } from "react";
import { DEFAULT_PROTECTED_PATHS } from "../../lib/research-loop/contracts";
import type { TaskVersion } from "./api";
import { diffTaskVersions, splitProtectedPaths, type BudgetItemChange, type ListChange, type TextChange } from "./version-diff-model";
import styles from "./version-diff.module.css";

export { comparisonBaseVersion, diffTaskVersions, splitProtectedPaths } from "./version-diff-model";
export type { VersionChange } from "./version-diff-model";

function Chips({ paths, tone }: { paths: string[]; tone: "added" | "removed" | "plain" }) {
  if (!paths.length) return null;
  const sign = tone === "added" ? "+" : tone === "removed" ? "−" : "";
  const word = tone === "added" ? "新增" : tone === "removed" ? "移除" : "";
  return <ul className={styles.chips}>
    {paths.map((path) => <li key={path} className={`${styles.chip} ${styles[`chip_${tone}`]}`}>
      {sign ? <span aria-hidden="true">{sign}</span> : null}
      {word ? <span className={styles.srOnly}>{word}</span> : null}
      <code>{path}</code>
    </li>)}
  </ul>;
}

function TextChangeView({ change }: { change: TextChange }) {
  return <div className={styles.pair}>
    <div className={styles.before}><span className={styles.tag}>原</span><p>{change.before || <em>（空）</em>}</p></div>
    <div className={styles.after}><span className={styles.tag}>新</span><p>{change.after || <em>（空）</em>}</p></div>
  </div>;
}

function ListChangeView({ change }: { change: ListChange }) {
  const wholeRepo = change.field === "allowedPaths";
  return <div className={styles.listChange}>
    {wholeRepo && !change.before.length ? <p className={styles.note}>原为：除受保护路径外的整个仓库</p> : null}
    <Chips paths={change.added} tone="added" />
    <Chips paths={change.removed} tone="removed" />
    {wholeRepo && !change.after.length ? <p className={styles.note}>现为：除受保护路径外的整个仓库</p> : null}
  </div>;
}

const budgetValue = (item: BudgetItemChange, value: number | undefined) => value === undefined ? "未设" : `${value}${item.unit ? ` ${item.unit}` : ""}`;

/** Changed fields between two task versions; unchanged fields are omitted. */
export function VersionDiff({ previous, current, heading }: { previous: TaskVersion; current: TaskVersion; heading?: string }) {
  const changes = useMemo(() => diffTaskVersions(previous, current), [previous, current]);
  const title = heading ?? `第 ${current.version} 版与第 ${previous.version} 版相比`;
  return <section className={styles.diff} aria-label={title}>
    <header className={styles.head}>
      <h5>{title}</h5>
      <small>{changes.length ? `改动 ${changes.length} 项，未列出的内容不变` : "内容没有变化"}</small>
    </header>
    {changes.length ? <ul className={styles.changes}>
      {changes.map((change) => <li key={change.field} className={styles.change}>
        <h6>{change.label}</h6>
        {change.kind === "text" ? <TextChangeView change={change} /> : null}
        {change.kind === "list" ? <ListChangeView change={change} /> : null}
        {change.kind === "budget" ? <ul className={styles.budget}>
          {change.items.map((item) => <li key={item.key}>
            <span>{item.label}</span>
            <span><s>{budgetValue(item, item.before)}</s> → <strong>{budgetValue(item, item.after)}</strong></span>
          </li>)}
        </ul> : null}
      </li>)}
    </ul> : null}
  </section>;
}

/** Protected paths: the task's own additions first, the platform defaults collapsed. */
export function ProtectedPathList({ paths }: { paths: string[] }) {
  const { defaults, extra } = useMemo(() => splitProtectedPaths(paths, DEFAULT_PROTECTED_PATHS), [paths]);
  return <div className={styles.protected}>
    {extra.length ? <>
      <p className={styles.note}>本任务另加 {extra.length} 项：</p>
      <Chips paths={extra} tone="plain" />
    </> : <p className={styles.note}>没有另加受保护路径。</p>}
    {defaults.length ? <details className={styles.defaults}>
      <summary>默认 {defaults.length} 项</summary>
      <Chips paths={defaults} tone="plain" />
    </details> : null}
  </div>;
}
