"use client";

// Per-file unified diff view for change review (frontend plan F2, G2).
// `splitUnifiedDiff` is pure and handles both `git diff` output (with
// `diff --git` headers, binary markers, new/deleted file modes) and bare
// `---`/`+++` diffs. Hunk bodies are consumed by their @@ line counts, so a
// removed line whose content starts with "--" is never taken for a header.

import styles from "./change-review.module.css";

export type DiffFileStatus = "add" | "modify" | "delete";

export type DiffFile = {
  /** Repository path (new path, or old path for deletions); "" when unrecognised. */
  path: string;
  status: DiffFileStatus;
  binary: boolean;
  added: number;
  removed: number;
  /** The section's raw lines, headers included. */
  text: string;
};

function stripPrefix(raw: string): string | null {
  let value = raw.split("\t")[0].trimEnd();
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) value = value.slice(1, -1);
  if (value === "/dev/null") return null;
  return /^[ab]\//.test(value) ? value.slice(2) : value;
}

/** Paths from `diff --git a/X b/Y`; handles paths with spaces when X === Y. */
function gitHeaderPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) return left.slice(2);
  }
  const match = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(rest);
  return match ? match[2] : "";
}

type Section = { lines: string[]; path: string; oldPath: string | null; newPath: string | null; status: DiffFileStatus; binary: boolean; added: number; removed: number; git: boolean };

function newSection(git: boolean, path = ""): Section {
  return { lines: [], path, oldPath: null, newPath: null, status: "modify", binary: false, added: 0, removed: 0, git };
}

function finish(section: Section): DiffFile {
  const path = section.newPath ?? section.oldPath ?? section.path;
  return { path, status: section.status, binary: section.binary, added: section.added, removed: section.removed, text: section.lines.join("\n") };
}

/** Splits a unified diff into one entry per file, with +/− counts. */
export function splitUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text) return files;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let current: Section | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const push = () => { if (current && (current.lines.some((line) => line.trim()) || current.path)) files.push(finish(current)); };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk body.
      if (line.startsWith("\\")) { current?.lines.push(line); continue; }
      const mark = line[0];
      if (mark === "+" && newLeft > 0) { newLeft -= 1; if (current) current.added += 1; current?.lines.push(line); continue; }
      if (mark === "-" && oldLeft > 0) { oldLeft -= 1; if (current) current.removed += 1; current?.lines.push(line); continue; }
      if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) { oldLeft -= 1; newLeft -= 1; current?.lines.push(line); continue; }
      // Malformed or truncated hunk: fall through and treat as a header line.
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      push();
      current = newSection(true, gitHeaderPath(line));
      current.lines.push(line);
      continue;
    }
    const startsBare = line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ");
    if (startsBare && (!current || !current.git || current.oldPath !== null || current.newPath !== null || current.lines.some((entry) => entry.startsWith("@@")))) {
      push();
      current = newSection(false);
    }
    current ??= newSection(false);
    current.lines.push(line);
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      current.oldPath = stripPrefix(line.slice(4));
      if (current.oldPath === null) current.status = "add";
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = stripPrefix(line.slice(4));
      if (current.newPath === null) current.status = "delete";
      continue;
    }
    if (line.startsWith("new file mode")) current.status = "add";
    else if (line.startsWith("deleted file mode")) current.status = "delete";
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
    else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      }
    }
  }
  push();
  return files;
}

const statusLabels: Record<DiffFileStatus, string> = { add: "新增", modify: "修改", delete: "删除" };

function lineClass(line: string) {
  if (line.startsWith("@@")) return styles.lineHunk;
  if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity|Binary files |GIT binary patch)/.test(line)) return styles.lineMeta;
  if (line.startsWith("+")) return styles.lineAdd;
  if (line.startsWith("-")) return styles.lineDel;
  return undefined;
}

/** One collapsible file section. */
export function DiffFileSection({ file, defaultOpen, flagged, truncated }: { file: DiffFile; defaultOpen: boolean; flagged?: string; truncated?: boolean }) {
  return <details className={styles.fileDiff} open={defaultOpen}>
    <summary>
      <span className={styles.fileName}>{file.path || "（未识别的文件）"}</span>
      <span className={styles.fileMeta}>
        {flagged ? <span className={styles.flag}>{flagged}</span> : null}
        <span className={`${styles.badge} ${styles[`badge_${file.status}`] ?? ""}`}>{statusLabels[file.status]}</span>
        {file.binary ? <span className={styles.badge}>二进制</span> : <><span className={styles.plus}>+{file.added}</span><span className={styles.minus}>−{file.removed}</span></>}
      </span>
    </summary>
    <pre className={styles.code}>{file.text.split("\n").map((line, index) => <span key={index} className={lineClass(line)}>{line || " "}</span>)}</pre>
    {truncated ? <p className={styles.truncated}>diff 已截断，本文件之后的内容未返回，完整改动请在 PR 中查看。</p> : null}
  </details>;
}

/** All files of a unified diff, each collapsible. `flags` maps path → marker
 * text; flagged files are expanded by default. */
export function DiffView({ files, truncated, flags }: { files: DiffFile[]; truncated: boolean; flags: ReadonlyMap<string, string> }) {
  if (!files.length) return <p className={styles.note}>{truncated ? "diff 已截断，未能解析出文件内容，请在 PR 中查看。" : "diff 为空。"}</p>;
  return <div className={styles.diffList}>
    {files.map((file, index) => <DiffFileSection key={`${file.path}:${index}`} file={file} defaultOpen={flags.has(file.path)} flagged={flags.get(file.path)}
      truncated={truncated && index === files.length - 1} />)}
  </div>;
}
