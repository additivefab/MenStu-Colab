"use client";

import { useState, type ReactNode } from "react";
import { LoopRequestError } from "./api";
import { errorHints, type Tone } from "./labels";
import styles from "./research-loop.module.css";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${styles.pill} ${styles[`tone_${tone}`]}`}>{children}</span>;
}

/** Server message plus a short hint for well-known error codes. */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof LoopRequestError ? errorHints[error.code] : undefined;
  return <p className={styles.error} role="alert">{message}{hint && !message.includes(hint) ? <span> {hint}</span> : null}</p>;
}

export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className={styles.notice} role="status">{children}</p>;
}

/** A disabled action that says why it is unavailable. */
export function Blocked({ children }: { children: ReactNode }) {
  return <p className={styles.blocked}>{children}</p>;
}

export function Field({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return <div className={styles.field}><dt>{label}</dt><dd className={mono ? styles.mono : undefined}>{value}</dd></div>;
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }, () => setCopied(false));
  }}>{copied ? "已复制" : label}</button>;
}

/** Two-step confirmation for irreversible actions. */
export function ConfirmButton({ label, confirmLabel, prompt, busy, disabled, onConfirm, danger = false }: {
  label: string;
  confirmLabel: string;
  prompt: string;
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className={danger ? styles.danger : undefined} disabled={busy || disabled} onClick={() => setOpen(true)}>{label}</button>;
  return <span className={styles.confirm}>
    <span>{prompt}</span>
    <button type="button" className={danger ? styles.dangerSolid : styles.primary} disabled={busy} onClick={() => { onConfirm(); setOpen(false); }}>{busy ? "处理中…" : confirmLabel}</button>
    <button type="button" disabled={busy} onClick={() => setOpen(false)}>返回</button>
  </span>;
}
