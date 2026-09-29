"use client";

import { studentLoginName } from "../lib/student-login-names";
import { useState } from "react";
import styles from "./local-login.module.css";

type LocalAccount = { username: string; status: "active" | "pending" | "disabled"; activationExpiresAt: string | null };
export function LocalAccountActions({ userId, studentId, studentName, account, onChanged }: {
  userId: number; studentId: string | null; studentName: string; account: LocalAccount | null; onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [issued, setIssued] = useState<{ username: string; activationUrl: string; expiresAt: string } | null>(null);
  async function change(action: "initialize" | "issue" | "disable") {
    if (!window.confirm(action === "disable"
      ? `停用 ${studentName} 的独立登录？该账号现有会话将退出，原档案和飞书绑定保留。`
      : action === "initialize" ? `为 ${studentName}（${studentId}，原账号 #${userId}）开通独立登录？初始密码为 123456789，首次登录必须修改。`
      : `为 ${studentName}（原账号 #${userId}）生成密码设置链接？请先核对本人身份。旧密码、旧链接及现有会话将失效。`)) return;
    setBusy(true); setMessage(""); setIssued(null);
    try {
      const response = await fetch("/api/admin/local-accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId, studentId }),
      });
      const result = await response.json() as { error?: string; message?: string; username: string; activationUrl: string; expiresAt: string };
      if (!response.ok) throw new Error(result.error || "操作失败");
      if (action === "issue") setIssued(result);
      else setMessage(result.message || "操作成功");
      await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <div className={styles.controls}>
    <small>独立账号：{account?.username ?? (studentId ? studentLoginName(studentId) : "未开通")} · {account?.status === "active" ? "已启用" : account?.status === "pending" ? "待设置密码" : account ? "已停用" : "未开通"}</small>
    <button type="button" disabled={busy} onClick={() => void change(account ? "issue" : "initialize")}>{account ? "重新生成密码设置链接" : "开通独立登录"}</button>
    {account && account.status !== "disabled" ? <button type="button" disabled={busy} onClick={() => void change("disable")}>停用独立登录</button> : null}
    {issued ? <div className={styles.result}>
      <strong>{studentName} · 账号 {issued.username}</strong>
      <p>请将链接单独交给已核对身份的账号本人。24 小时内有效，只能使用一次；关闭后不能再次查看。</p>
      <label>密码设置链接<textarea className={styles.link} readOnly value={issued.activationUrl} onFocus={(event) => event.currentTarget.select()} /></label>
      <button type="button" onClick={() => void navigator.clipboard.writeText(`探研账号：${issued.username}\n设置密码：${issued.activationUrl}`).then(() => setMessage("已复制，请单独交给账号本人")).catch(() => setMessage("复制失败，请选中上方链接手动复制"))}>复制账号与链接</button>
      <button type="button" onClick={() => setIssued(null)}>关闭链接</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
