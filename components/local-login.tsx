"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "./local-login.module.css";

export function LocalLogin({ onAuthenticated, onFeishu }: { onAuthenticated: () => Promise<void>; onFeishu: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("passwordChanged") !== "1") return;
    const timer = window.setTimeout(() => setNotice("密码已修改，请使用新密码重新登录"), 0);
    return () => window.clearTimeout(timer);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/local/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "登录失败");
      await onAuthenticated();
    } catch (error) { setError(error instanceof Error ? error.message : "登录失败，请稍后重试"); }
    finally { setBusy(false); }
  }
  return <main className="access-shell"><section className={`access-card ${styles.card}`}>
    <div className="access-brand"><div className="brand-mark">探</div><div><strong>探研</strong><span>科研进展管理</span></div></div>
    <h1>登录学生工作台</h1><p>使用管理员开通的账号，继续查看和提交原有科研进展。</p>
    {notice ? <p role="status">{notice}</p> : null}
    <form className={styles.form} onSubmit={submit}>
      <label>账号<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} placeholder="姓名拼音缩写，例如 why" /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className="primary" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
    </form>
    <p className={styles.help}>首次登录后请修改初始密码；忘记密码请联系超级管理员。</p>
    <button type="button" onClick={onFeishu} disabled={busy}>使用飞书登录</button>
  </section></main>;
}
