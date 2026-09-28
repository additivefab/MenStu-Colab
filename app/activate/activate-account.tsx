"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PasswordField } from "../../components/password-field";
import styles from "../../components/local-login.module.css";

export default function ActivateAccount() {
  const token = useRef("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (value) {
      token.current = value;
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (!token.current) setError("请从管理员提供的完整链接进入；刷新后需重新打开原链接。");
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirmation")) { setError("两次输入的密码不一致"); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/local/activate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current, password: form.get("password") }),
      });
      const result = await response.json() as { error?: string; username: string };
      if (!response.ok) throw new Error(result.error || "密码设置失败");
      token.current = ""; setUsername(result.username);
    } catch (error) { setError(error instanceof Error ? error.message : "密码设置失败"); }
    finally { setBusy(false); }
  }
  return <main className="access-shell"><section className={`access-card ${styles.card}`}>
    <div className="access-brand"><div className="brand-mark">探</div><strong>探研</strong></div>
    <h1>{username ? "密码已设置" : "设置独立登录密码"}</h1>
    {username ? <><p>你的账号：<strong>{username}</strong></p><p>登录后即可继续使用原学生档案。</p><button type="button" onClick={() => window.location.assign("/")}>返回登录</button></> : <>
      <p>密码须为 8–128 个字符。</p>
      <form className={styles.form} onSubmit={submit}>
        <PasswordField label="新密码" name="password" autoComplete="new-password" required minLength={8} maxLength={128} />
        <PasswordField label="再次输入密码" name="confirmation" autoComplete="new-password" required minLength={8} maxLength={128} />
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <button className="primary" disabled={busy}>{busy ? "正在设置…" : "保存密码"}</button>
      </form>
    </>}
  </section></main>;
}
