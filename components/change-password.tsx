"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "./local-login.module.css";

export function ChangePassword() {
  const [account, setAccount] = useState<{ username: string | null; enabled: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/local/password", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { username: string | null; enabled: boolean; error?: string };
        if (!response.ok) throw new Error(result.error || "无法读取独立账号");
        if (!controller.signal.aborted) setAccount(result);
      }).catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("newPassword") !== form.get("confirmation")) { setError("两次输入的新密码不一致"); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/local/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "密码修改失败");
      window.location.assign("/?passwordChanged=1");
    } catch (error) { setError(error instanceof Error ? error.message : "密码修改失败，请重试"); }
    finally { setBusy(false); }
  }

  return <details className={styles.changePassword}>
    <summary>修改登录密码</summary>
    {account?.enabled ? <form className={styles.form} onSubmit={submit}>
      <label>独立登录名<input name="username" autoComplete="username" value={account.username ?? ""} readOnly /></label>
      <label>原密码<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <label>新密码<input name="newPassword" type="password" autoComplete="new-password" required minLength={15} maxLength={128} /></label>
      <label>再次输入新密码<input name="confirmation" type="password" autoComplete="new-password" required minLength={15} maxLength={128} /></label>
      <p className={styles.help}>新密码须为 15–128 个字符。修改成功后，所有设备都需要重新登录。</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className="primary" disabled={busy}>{busy ? "正在修改…" : "保存新密码并重新登录"}</button>
    </form> : <p className={styles.help} role="status">{error || (account ? "独立登录尚未开通，请联系管理员获取密码设置链接。" : "正在读取独立账号…")}</p>}
  </details>;
}
