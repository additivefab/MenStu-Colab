// Submit-outcome vocabulary shared by the scheduler adapters and the runner (R05).
//
// A scheduler submit has exactly three outcomes:
//   accepted  → submit() resolves with {jobId};
//   rejected  → submit() throws SubmitRejectedError: the scheduler definitively
//               refused the job (or the submit command never ran), so no job exists;
//   unknown   → anything else (timeouts, lost responses, unparseable output,
//               unclassified errors). A job MAY exist; the runner must never
//               resubmit, only reconcile by submitTag.
// Classification is conservative: an error is "rejected" only when an adapter
// proves it; every other error counts as "unknown".
//
// The submit receipt (<runDir>/submit-receipt.json) is created with O_EXCL
// BEFORE the scheduler command runs. A receipt without a job id therefore means
// "a submit may have reached the scheduler", never "proven absent".
import { constants as fsConstants } from "node:fs";
import { link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "../lib/fsutil.mjs";

export class SubmitRejectedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SubmitRejectedError";
    this.submitOutcome = "rejected";
  }
}

export class SubmitOutcomeUnknownError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SubmitOutcomeUnknownError";
    this.submitOutcome = "unknown";
  }
}

/** True only for errors an adapter marked as a definitive rejection. */
export function isDefinitiveRejection(error) {
  return error?.submitOutcome === "rejected";
}

export const SUBMIT_RECEIPT = "submit-receipt.json";

/**
 * Creates <runDir>/submit-receipt.json with O_CREAT|O_EXCL. Resolves
 * {created:true} for the caller that won, or {created:false, receipt} when a
 * receipt already exists (receipt is null if it is unreadable or partial).
 */
export async function createSubmitReceipt(runDir, submitTag) {
  const path = join(runDir, SUBMIT_RECEIPT);
  let handle;
  try {
    handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { created: false, receipt: await readSubmitReceipt(runDir) };
  }
  try {
    await handle.writeFile(`${JSON.stringify({ submitTag, startedAt: new Date().toISOString(), pid: process.pid, jobId: null }, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { created: true };
}

/** null when there is no receipt; {partial:true} when it exists but cannot be parsed. */
export async function readSubmitReceipt(runDir) {
  let raw;
  try {
    raw = await readFile(join(runDir, SUBMIT_RECEIPT), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { partial: true };
  } catch {
    return { partial: true };
  }
}

/** Merges `patch` (e.g. {jobId} or {outcome:"rejected"}) into the receipt atomically. */
export async function updateSubmitReceipt(runDir, patch) {
  const current = (await readSubmitReceipt(runDir)) ?? {};
  await writeJsonAtomic(join(runDir, SUBMIT_RECEIPT), { ...current, ...patch, updatedAt: new Date().toISOString() });
}

/**
 * Publishes `value` at `path` only if nothing is there yet, atomically: the
 * JSON is written to a temp file and hard-linked into place (link(2) fails
 * with EEXIST exactly like O_EXCL, and readers never see a partial file).
 * Resolves true when this call created the file, false when it already existed.
 */
export async function writeJsonExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}
