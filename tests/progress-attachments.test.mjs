import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROGRESS_FILE_BYTES,
  attachmentDisposition,
  cleanAttachmentName,
  validateProgressFiles,
} from "../lib/progress-attachments.ts";

test("progress attachments accept research documents and sanitize submitted paths", () => {
  assert.equal(cleanAttachmentName("C:\\drafts\\论文初稿.docx"), "论文初稿.docx");
  assert.equal(cleanAttachmentName("../results/项目验收.pdf"), "项目验收.pdf");
  assert.equal(validateProgressFiles([new File(["paper"], "论文初稿.pdf", { type: "application/pdf" })])[0].fileName, "论文初稿.pdf");
  assert.match(attachmentDisposition("论文初稿.pdf"), /filename\*=UTF-8''/);
});

test("progress attachments reject executable, empty, oversized, and excessive files", () => {
  assert.throws(() => cleanAttachmentName("payload.exe"), /仅支持/);
  assert.throws(() => validateProgressFiles([new File([], "empty.pdf")]), /空文件/);
  const oversized = { name: "too-large.zip", size: MAX_PROGRESS_FILE_BYTES + 1, type: "application/zip" };
  assert.throws(() => validateProgressFiles([oversized]), /20 MB/);
  const tooMany = Array.from({ length: 6 }, (_, index) => new File(["x"], `${index}.txt`));
  assert.throws(() => validateProgressFiles(tooMany), /最多上传 5 个/);
});
