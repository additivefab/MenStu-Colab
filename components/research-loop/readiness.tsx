"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  readinessModel, type ReadinessCapability, type ReadinessItem, type ReadinessMode, type ReadinessOwner, type ReadinessPayload,
} from "../../lib/research-loop-readiness";
import { errorText, getJson } from "./api";
import styles from "./readiness.module.css";

// Readiness checklist at the top of the research-loop panel (frontend plan
// F6). Read-only: it only says what is missing and who can fix it.

const capabilityLabels: Record<ReadinessCapability, string> = { agent: "启动代理", run: "登记运行" };

function ownerText(owners: ReadinessOwner[], mode: ReadinessMode) {
  return owners.map((owner) => mode === "student" && owner === "学生" ? "你" : owner).join(" / ");
}

function Place({ item }: { item: ReadinessItem }) {
  return item.href ? <a href={item.href}>{item.place}</a> : <span>{item.place}</span>;
}

function MissingItem({ item, mode }: { item: ReadinessItem; mode: ReadinessMode }) {
  return <li className={styles.item} data-done="false">
    <span className={styles.mark} aria-hidden="true">!</span>
    <div className={styles.body}>
      <p className={styles.label}><strong>{item.label}</strong><span className={styles.srOnly}>（未满足）</span>
        {item.needs.map((need) => <span key={need} className={styles.blocks}>影响{capabilityLabels[need]}</span>)}</p>
      {item.detail ? <p className={styles.detail}>{item.detail}</p> : null}
      <dl className={styles.meta}>
        <div><dt>负责</dt><dd>{ownerText(item.owners, mode)}</dd></div>
        <div><dt>在哪里</dt><dd><Place item={item} /></dd></div>
      </dl>
    </div>
  </li>;
}

function DoneItem({ item }: { item: ReadinessItem }) {
  return <li className={styles.item} data-done="true">
    <span className={styles.mark} aria-hidden="true">✓</span>
    <div className={styles.body}><p className={styles.label}><strong>{item.label}</strong><span className={styles.srOnly}>（已满足）</span></p></div>
  </li>;
}

function Ability({ label, ok, mode }: { label: string; ok: boolean; mode: ReadinessMode }) {
  const no = mode === "student" ? "你暂时还不能" : "暂时还不能";
  return <span className={styles.ability} data-ok={ok ? "true" : "false"}>{ok ? `可以${label}` : `${no}${label}`}</span>;
}

export function Readiness({ studentId, mode }: { studentId: string; mode: ReadinessMode }) {
  const titleId = useId();
  const [payload, setPayload] = useState<ReadinessPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    getJson<ReadinessPayload>(`/api/research-loop/readiness?studentId=${encodeURIComponent(studentId)}`, "闭环条件读取失败", controller.signal)
      .then((data) => { if (!controller.signal.aborted) { setPayload(data); setError(""); } },
        (failure: unknown) => { if (!controller.signal.aborted) setError(errorText(failure, "闭环条件读取失败")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [studentId]);

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => { window.clearTimeout(timer); request.current?.abort(); };
  }, [load]);

  if (!payload) {
    if (!error) return null;
    return <section className={styles.readiness} aria-label="闭环条件"><p className={styles.failed} role="status">
      闭环条件暂时无法读取：{error}<button type="button" onClick={load} disabled={loading}>重试</button></p></section>;
  }

  const model = readinessModel(payload, mode);
  const done = model.items.filter((item) => item.done);
  const recheck = <button type="button" className={styles.recheck} onClick={load} disabled={loading}>{loading ? "检查中…" : "重新检查"}</button>;

  if (model.ready) {
    return <section className={styles.readiness} aria-label="闭环条件">
      <details className={styles.collapsed}>
        <summary><span className={styles.okMark} aria-hidden="true">✓</span>闭环条件已就绪</summary>
        <ul className={styles.list}>{model.items.map((item) => <DoneItem key={item.key} item={item} />)}</ul>
        <div className={styles.footer}>{recheck}</div>
      </details>
    </section>;
  }

  return <section className={styles.readiness} aria-labelledby={titleId}>
    <div className={styles.head}>
      <h3 id={titleId}>闭环条件还差 {model.missing.length} 项</h3>
      <div className={styles.abilities}>
        <Ability label="启动代理" ok={model.canStartAgents} mode={mode} />
        <Ability label="登记运行" ok={model.canRegisterRuns} mode={mode} />
      </div>
      {recheck}
    </div>
    <p className={styles.lead}>{mode === "student"
      ? "以下条件需要相应负责人处理；标为超级管理员的项目，请联系超级管理员。"
      : "以下条件需要相应负责人处理。代理凭据档案按发起人计：这里显示的是当前账号。"}</p>
    {error ? <p className={styles.failed} role="status">刷新失败：{error}</p> : null}
    <ul className={styles.list}>{model.missing.map((item) => <MissingItem key={item.key} item={item} mode={mode} />)}</ul>
    {done.length ? <details className={styles.doneGroup}>
      <summary>已满足 {done.length} 项</summary>
      <ul className={styles.list}>{done.map((item) => <DoneItem key={item.key} item={item} />)}</ul>
    </details> : null}
  </section>;
}
