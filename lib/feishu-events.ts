const encoder = new TextEncoder();

function ownedBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string | Uint8Array) {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(input)));
}

export async function secureTextEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) difference |= leftHash[index] ^ rightHash[index];
  return difference === 0;
}

async function verifySignature(rawBody: string, encryptKey: string, timestamp: string, nonce: string, signature: string) {
  if (!timestamp || !nonce || !signature) return false;
  const expected = bytesToHex(await sha256(`${timestamp}${nonce}${encryptKey}${rawBody}`));
  return secureTextEqual(expected, signature.toLowerCase());
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptEvent(value: string, encryptKey: string) {
  const keyBytes = await sha256(encryptKey);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const encrypted = decodeBase64(value);
  if (encrypted.length <= 16) throw new Error("飞书加密事件内容无效");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: encrypted.slice(0, 16) },
    key,
    encrypted.slice(16),
  );
  return new TextDecoder().decode(decrypted);
}

export async function parseFeishuEvent(rawBody: string, headers: Headers, encryptKey: string) {
  if (encryptKey) {
    const validSignature = await verifySignature(
      rawBody,
      encryptKey,
      headers.get("x-lark-request-timestamp") ?? "",
      headers.get("x-lark-request-nonce") ?? "",
      headers.get("x-lark-signature") ?? "",
    );
    if (!validSignature) throw new Error("飞书事件签名无效");
  }

  const envelope = JSON.parse(rawBody) as Record<string, unknown>;
  if (typeof envelope.encrypt === "string") {
    if (!encryptKey) throw new Error("飞书事件已加密，但系统未配置 Encrypt Key");
    return JSON.parse(await decryptEvent(envelope.encrypt, encryptKey)) as Record<string, unknown>;
  }
  return envelope;
}

function collectStrings(value: unknown, output: string[], depth = 0) {
  if (output.length >= 240 || depth > 9 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output, depth + 1));
  }
}

export function extractFeishuMessageText(rawContent: string) {
  let parsed: unknown = rawContent;
  try { parsed = JSON.parse(rawContent); } catch { /* 纯文本消息直接继续处理 */ }
  const strings: string[] = [];
  collectStrings(parsed, strings);
  return strings
    .filter((item) => !/^(om_|oc_|ou_|cli_|ctp_|img_|file_)[A-Za-z0-9_-]+$/.test(item))
    .join("\n")
    .replace(/@_user_\d+/g, "@成员")
    .trim()
    .slice(0, 50000);
}

export function detectMeetingSummary(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const strongSignals = ["AI总结", "AI 总结", "会议总结", "会议纪要", "智能纪要", "妙记"];
  const strong = strongSignals.find((signal) => normalized.includes(signal));
  const shortQuestion = normalized.length < 120 && /(?:在哪|哪里|怎么|如何|打不开|发了吗|有吗|是否|能否|可以吗|什么时候|吗)[^。！!]*[？?]$/u.test(normalized);
  if (strong && normalized.length >= 16 && !shortQuestion) return strong;
  const structuralSignals = ["行动项", "待办事项", "参会人", "会议时间", "讨论内容", "会议主题"];
  const matches = structuralSignals.filter((signal) => normalized.includes(signal));
  return normalized.length >= 120 && matches.length >= 2 ? matches.join("+") : null;
}

export function hasUsableMeetingSummaryText(text: string) {
  if (!detectMeetingSummary(text)) return false;
  const content = text
    .replace(/https?:\/\/[^\s<>"']+/giu, "")
    .replace(/AI\s*总结|会议总结|会议纪要|智能纪要|妙记/giu, "")
    .replace(/@成员/g, "")
    .replace(/[\s，,。.!！?？:：；;、~～\-—_()[\]（）【】]/g, "");
  return content.length >= 8;
}

function orderedJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => orderedJsonValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, orderedJsonValue(item, depth + 1)]),
  );
}

export function extractFeishuSummarySourceFingerprint(rawContent: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(rawContent); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const content = parsed as Record<string, unknown>;
  const documentId = typeof content.document_id === "string" ? content.document_id : "";
  const summary = typeof content.ai_summary === "string" ? content.ai_summary.replace(/\r\n/g, "\n").trim() : "";
  if (/^[A-Za-z0-9]{20,64}$/.test(documentId) && summary) {
    return `docx:${documentId}\n${summary}`;
  }
  const minuteToken = typeof content.minute_token === "string" ? content.minute_token : "";
  if (/^[A-Za-z0-9]{24}$/.test(minuteToken) && content.ai_artifacts && typeof content.ai_artifacts === "object") {
    return `minutes:${minuteToken}\n${JSON.stringify(orderedJsonValue(content.ai_artifacts))}`;
  }
  return null;
}

function normalizeMentionCommand(text: string) {
  return text
    .replace(/@成员/g, "")
    .replace(/[\s，,。.!！?？:：；;、~～]/g, "")
    .trim();
}

export function isFeishuMentionOnly(text: string) {
  return normalizeMentionCommand(text) === "";
}

export function feishuMentionsBot(
  mentions: Array<{ id?: string | { open_id?: string } }> | undefined,
  botOpenId: string,
) {
  if (!botOpenId) return false;
  return (mentions ?? []).some((mention) => {
    const mentionId = typeof mention.id === "string" ? mention.id : mention.id?.open_id;
    return mentionId === botOpenId;
  });
}

export function detectSummaryReplyRequest(
  text: string,
  context: { hasReference: boolean; mentionedBot: boolean },
) {
  if (!context.hasReference || !context.mentionedBot) return null;
  const normalized = normalizeMentionCommand(text);
  if (!normalized) return "回复并@机器人";
  if (normalized.length > 28) return null;

  const exactCommands = [
    "导入", "导一下", "导进去", "录入", "同步", "收录", "记一下", "处理一下",
    "这个", "这份", "这个总结", "这份总结", "这个纪要", "这份纪要", "总结", "纪要",
    "导入这个总结", "导入这份总结", "导入这个纪要", "导入这份纪要",
  ];
  if (exactCommands.includes(normalized)) return normalized;
  const objectBeforeAction = /^(?:请)?(?:帮我)?(?:把)?(?:这个|这份)?(?:总结|纪要|内容|记录)?(?:导入|导一下|导进去|导进|录入|同步|收录|记一下|处理一下)(?:系统)?(?:吧|下|一下)?$/u;
  const actionBeforeObject = /^(?:请)?(?:帮我)?(?:导入|导一下|导进去|导进|录入|同步|收录|记一下|处理一下)(?:这个|这份)?(?:总结|纪要|内容|记录)?(?:到系统|进系统)?(?:吧|下|一下)?$/u;
  return (objectBeforeAction.test(normalized) || actionBeforeObject.test(normalized))
    ? normalized
    : null;
}

export function detectSummaryImportCommand(text: string) {
  const normalized = normalizeMentionCommand(text).toUpperCase();
  if (!normalized) return null;
  const commands = ["导入所有总结", "导入全部总结", "导入所有AI总结", "导入全部AI总结", "导入所有会议纪要", "导入全部会议纪要"];
  return commands.find((command) => normalized.includes(command.toUpperCase())) ?? null;
}

export function extractFeishuMinuteTokens(text: string) {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const rawUrl = match[0].replace(/[),，。.!！?？]+$/g, "");
    try {
      const url = new URL(rawUrl);
      if (url.hostname !== "feishu.cn" && !url.hostname.endsWith(".feishu.cn")) continue;
      const queryToken = url.searchParams.get("minute_token") ?? "";
      const pathToken = url.pathname.match(/\/minutes\/([A-Za-z0-9]{24})(?:\/|$)/)?.[1] ?? "";
      const token = queryToken || pathToken;
      if (/^[A-Za-z0-9]{24}$/.test(token)) tokens.add(token);
    } catch {
      // 忽略无法解析的链接；只接受飞书域名内格式正确的妙记链接。
    }
  }
  return Array.from(tokens);
}

export function extractFeishuDocxDocumentIds(text: string) {
  const documentIds = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const rawUrl = match[0].replace(/[),，。.!！?？]+$/g, "");
    try {
      const url = new URL(rawUrl);
      if (url.hostname !== "feishu.cn" && !url.hostname.endsWith(".feishu.cn")) continue;
      const documentId = url.pathname.match(/\/docx\/([A-Za-z0-9]{20,64})(?:\/|$)/)?.[1] ?? "";
      if (documentId) documentIds.add(documentId);
    } catch {
      // 忽略无法解析的链接；只接受飞书域名内格式正确的 Docx 文档链接。
    }
  }
  return Array.from(documentIds);
}
