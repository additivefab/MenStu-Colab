export const MAX_PROGRESS_FILES = 5;
export const MAX_PROGRESS_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PROGRESS_TOTAL_BYTES = 80 * 1024 * 1024;

const allowedExtensions = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx",
  "txt", "md", "json", "zip", "png", "jpg", "jpeg", "webp", "tif", "tiff",
]);

export class AttachmentInputError extends Error {}

export function cleanAttachmentName(value: string) {
  const name = Array.from(value.split(/[\\/]/u).pop() ?? "")
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .trim();
  if (!name) throw new AttachmentInputError("附件文件名无效");
  if (name.length > 180) throw new AttachmentInputError("附件文件名不能超过 180 个字符");
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  if (!allowedExtensions.has(extension)) {
    throw new AttachmentInputError("附件仅支持 PDF、Office、文本、图片或 ZIP 文件");
  }
  return name;
}

export function validateProgressFiles(files: File[]) {
  if (files.length > MAX_PROGRESS_FILES) {
    throw new AttachmentInputError(`每次最多上传 ${MAX_PROGRESS_FILES} 个附件`);
  }
  let totalBytes = 0;
  return files.map((file) => {
    const fileName = cleanAttachmentName(file.name);
    if (!file.size) throw new AttachmentInputError(`${fileName} 是空文件`);
    if (file.size > MAX_PROGRESS_FILE_BYTES) {
      throw new AttachmentInputError(`${fileName} 不能超过 50 MB`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_PROGRESS_TOTAL_BYTES) {
      throw new AttachmentInputError("本次附件总大小不能超过 80 MB");
    }
    return { file, fileName, contentType: file.type || "application/octet-stream" };
  });
}

export function attachmentStorageKey(studentId: string, progressId: number, fileName: string) {
  const extension = fileName.includes(".") ? `.${fileName.split(".").pop()?.toLowerCase()}` : "";
  return `progress/${encodeURIComponent(studentId)}/${progressId}/${crypto.randomUUID()}${extension}`;
}

export function attachmentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "attachment";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
