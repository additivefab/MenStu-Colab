import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as Lark from "@larksuiteoapi/node-sdk";

import {
  detectMeetingSummary,
  detectSummaryReplyRequest,
  detectSummaryImportCommand,
  extractFeishuDocxDocumentIds,
  extractFeishuMinuteTokens,
  extractFeishuMessageText,
  feishuMentionsBot,
  hasUsableMeetingSummaryText,
  isFeishuMentionOnly,
} from "../lib/feishu-events.ts";
import { formatFeishuImportFeedback } from "../lib/feishu-import-feedback.ts";

const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
const siteUrl = process.env.TANYAN_SITE_URL?.trim() || "https://progress.tz-ndt.com";
const relayUrl = new URL("/api/feishu/long-connection", siteUrl);
const curlBin = process.env.TANYAN_CURL_BIN?.trim() || "/usr/bin/curl";

if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) {
  throw new Error("请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
}
if (relayUrl.protocol !== "https:") throw new Error("TANYAN_SITE_URL 必须使用 HTTPS");

const pending = new Map();
const historyScans = new Map();
const minuteArtifacts = new Map();
const docxSummaries = new Map();
const maxHistoryMessages = 10_000;
let botIdentityPromise;

const apiClient = new Lark.Client({
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
});

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveBotIdentity() {
  if (botIdentityPromise) return botIdentityPromise;
  botIdentityPromise = apiClient.request({
    url: "/open-apis/bot/v3/info",
    method: "GET",
  }).then((response) => {
    if ((response.code ?? 0) !== 0) throw new Error(`飞书机器人接口返回 code ${response.code}`);
    if (!response.bot?.open_id) throw new Error("飞书机器人接口未返回身份");
    return {
      openId: response.bot.open_id,
      name: response.bot.app_name || "",
    };
  }).catch((error) => {
    console.warn(`[探研] 暂时无法确认机器人身份 · ${error instanceof Error ? error.message : "未知错误"}`);
    setTimeout(() => {
      botIdentityPromise = undefined;
      void resolveBotIdentity();
    }, 60_000);
    return { openId: "", name: "" };
  });
  return botIdentityPromise;
}

function messageMentionsBot(message, identity) {
  return feishuMentionsBot(message?.mentions, identity.openId);
}

function eventIsAutomated(event) {
  const senderType = (event.sender?.sender_type || "").toLowerCase();
  return senderType === "app" || senderType === "bot" || senderType === "assistant";
}

function eventComesFromBot(event, identity) {
  const senderOpenId = event.sender?.sender_id?.open_id || "";
  const senderAppId = event.sender?.sender_id?.app_id || "";
  if (identity.openId) return senderOpenId === identity.openId || senderAppId === appId;
  return eventIsAutomated(event);
}

function apiItemComesFromCurrentBot(item, identity) {
  const senderId = item?.sender?.id || "";
  const openBotId = item?.sender?.open_bot_id || "";
  return Boolean(
    senderId === appId
    || (identity.openId && (senderId === identity.openId || openBotId === identity.openId)),
  );
}

function apiItemIsAutomated(item) {
  const senderType = (item?.sender?.sender_type || "").toLowerCase();
  return senderType === "app" || senderType === "bot" || senderType === "assistant";
}

async function replyToMessage(messageId, text, phase = "result") {
  if (!messageId || !text) return false;
  try {
    const response = await apiClient.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: text.slice(0, 2_000) }),
        uuid: createHmac("sha256", appSecret).update(`reply:${messageId}:${phase}`).digest("hex").slice(0, 32),
      },
    });
    if (response.code && response.code !== 0) throw new Error(`飞书消息接口返回 code ${response.code}`);
    return Boolean(response.data?.message_id);
  } catch (error) {
    console.warn(`[探研] 导入结果暂时无法回复到群里 · ${error instanceof Error ? error.message : "未知错误"}`);
    return false;
  }
}

function relaySignature(rawBody, timestamp, nonce) {
  return createHmac("sha256", appSecret)
    .update(`${timestamp}\n${nonce}\n${rawBody}`)
    .digest("hex");
}

function postRelayWithCurl(rawBody, timestamp, nonce, signature) {
  return new Promise((resolve, reject) => {
    const statusMarker = "\n__TANYAN_HTTP_STATUS__:";
    const child = spawn(curlBin, [
      "--silent",
      "--show-error",
      "--http1.1",
      "--max-time",
      "12",
      "--proto",
      "=https",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--header",
      `x-tanyan-timestamp: ${timestamp}`,
      "--header",
      `x-tanyan-nonce: ${nonce}`,
      "--header",
      `x-tanyan-signature: ${signature}`,
      "--data-binary",
      "@-",
      "--write-out",
      `${statusMarker}%{http_code}`,
      relayUrl.href,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 16_384) {
        outputTooLarge = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk;
    });
    child.on("error", (error) => reject(new Error(`无法启动系统 HTTPS 客户端：${error.message}`)));
    child.on("close", (code) => {
      if (outputTooLarge) return reject(new Error("站点响应内容异常"));
      const markerIndex = stdout.lastIndexOf(statusMarker);
      const status = markerIndex >= 0 ? Number(stdout.slice(markerIndex + statusMarker.length)) : 0;
      if (code !== 0) return reject(new Error(stderr.trim() || `HTTPS 客户端退出码 ${code}`));
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        return reject(new Error(`站点返回 HTTP ${status || "未知"}`));
      }
      const responseBody = markerIndex >= 0 ? stdout.slice(0, markerIndex).trim() : "";
      if (!responseBody) return reject(new Error("站点响应内容为空"));
      try {
        const parsed = JSON.parse(responseBody);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new Error("站点响应格式异常"));
        }
        resolve(parsed);
      } catch {
        reject(new Error("站点响应格式异常"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(rawBody);
  });
}

async function forwardOnce(event) {
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return await postRelayWithCurl(rawBody, timestamp, nonce, relaySignature(rawBody, timestamp, nonce));
}

async function forwardWithRetry(event) {
  const messageId = event.message?.message_id ?? event.event_id ?? "unknown";
  if (pending.has(messageId)) return pending.get(messageId);
  const task = (async () => {
    let lastError;
    for (const delay of [0, 1_000, 3_000, 8_000, 15_000]) {
      if (delay) await sleep(delay);
      try {
        const result = await forwardOnce(event);
        console.info(`[探研] 已处理候选总结 · ${messageId.slice(-10)} · ${result.outcome || "ok"}`);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    console.error(`[探研] 候选总结转发失败 · ${messageId.slice(-10)} · ${lastError?.message || "未知错误"}`);
    return { outcome: "relay_failed" };
  })().finally(() => pending.delete(messageId));
  pending.set(messageId, task);
  return task;
}

function boundedMinuteArtifacts(data) {
  return {
    summary: (data.summary || "").slice(0, 60_000),
    chapters: (data.minute_chapters || []).slice(0, 100).map((chapter) => ({
      title: (chapter.title || "").slice(0, 500),
      start_ms: chapter.start_ms || "",
      stop_ms: chapter.stop_ms || "",
      summary_content: (chapter.summary_content || "").slice(0, 4_000),
    })),
    todos: (data.minute_todos || []).slice(0, 200).map((todo) => ({
      content: (todo.content || "").slice(0, 2_000),
      assignees: (todo.assignees || []).slice(0, 30),
      is_done: Boolean(todo.is_done),
    })),
    keywords: (data.keywords || []).slice(0, 80).map((keyword) => keyword.slice(0, 300)),
  };
}

async function fetchMinuteArtifacts(minuteToken) {
  if (minuteArtifacts.has(minuteToken)) return minuteArtifacts.get(minuteToken);
  const task = (async () => {
    const response = await apiClient.minutes.v1.minute.artifacts({ path: { minute_token: minuteToken } });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书妙记接口返回 code ${response.code}`);
    }
    const artifacts = boundedMinuteArtifacts(response.data || {});
    const hasContent = Boolean(
      artifacts.summary || artifacts.chapters.length || artifacts.todos.length || artifacts.keywords.length,
    );
    return hasContent ? artifacts : null;
  })().catch((error) => {
    console.warn(`[探研] 妙记 AI 产物暂不可读取 · ${error instanceof Error ? error.message : "未知错误"}`);
    return null;
  });
  minuteArtifacts.set(minuteToken, task);
  setTimeout(() => minuteArtifacts.delete(minuteToken), 15 * 60 * 1000);
  return task;
}

async function enrichMinuteMessage(event, text) {
  const minuteToken = extractFeishuMinuteTokens(text)[0];
  if (!minuteToken) return null;
  const artifacts = await fetchMinuteArtifacts(minuteToken);
  if (!artifacts) return null;
  return {
    ...event,
    message: {
      ...event.message,
      content: JSON.stringify({
        type: "飞书妙记 AI 会议纪要",
        minute_token: minuteToken,
        original_content: event.message?.content || "",
        ai_artifacts: artifacts,
      }),
    },
  };
}

async function fetchDocxSummary(documentId) {
  if (docxSummaries.has(documentId)) return docxSummaries.get(documentId);
  const task = (async () => {
    const response = await apiClient.docx.v1.document.rawContent({ path: { document_id: documentId } });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书文档接口返回 code ${response.code}`);
    }
    const content = (response.data?.content || "").trim().slice(0, 60_000);
    return content && detectMeetingSummary(content) ? content : null;
  })().catch((error) => {
    console.warn(`[探研] 智能纪要文档暂不可读取 · ${error instanceof Error ? error.message : "未知错误"}`);
    return null;
  });
  docxSummaries.set(documentId, task);
  setTimeout(() => docxSummaries.delete(documentId), 15 * 60 * 1000);
  return task;
}

async function enrichDocxMessage(event, text) {
  const documentId = extractFeishuDocxDocumentIds(text)[0];
  if (!documentId) return null;
  const summary = await fetchDocxSummary(documentId);
  if (!summary) return null;
  return {
    ...event,
    message: {
      ...event.message,
      content: JSON.stringify({
        type: "飞书智能纪要 AI 文档",
        document_id: documentId,
        original_content: event.message?.content || "",
        ai_summary: summary,
      }),
    },
  };
}

async function enrichMeetingMessage(event, text, options = {}) {
  const minuteMessage = await enrichMinuteMessage(event, text);
  if (minuteMessage) return minuteMessage;
  if (options.allowBareDocx === false && !detectMeetingSummary(text)) return null;
  return await enrichDocxMessage(event, text);
}

function historySender(sender) {
  if (!sender?.id) return undefined;
  const idType = ["open_id", "user_id", "union_id", "app_id"].includes(sender.id_type)
    ? sender.id_type
    : "open_id";
  return {
    sender_id: { [idType]: sender.id },
    sender_type: sender.sender_type || "",
  };
}

function historyEvent(commandEvent, item) {
  const messageId = item.message_id || "";
  return {
    app_id: commandEvent.app_id,
    event_id: `history:${messageId}`,
    event_type: "im.message.receive_v1",
    sender: historySender(item.sender),
    message: {
      message_id: messageId,
      root_id: item.root_id || "",
      parent_id: item.parent_id || "",
      chat_id: item.chat_id || commandEvent.message?.chat_id || "",
      chat_type: "group",
      message_type: item.msg_type || "",
      content: item.body?.content || "",
      create_time: item.create_time || "",
    },
  };
}

async function fetchReferencedCandidate(commandEvent, identity) {
  const commandMessage = commandEvent.message;
  const commandChatId = commandMessage?.chat_id || "";
  let referenceId = commandMessage?.parent_id || commandMessage?.root_id || "";
  const visited = new Set();

  for (let depth = 0; referenceId && depth < 3 && !visited.has(referenceId); depth += 1) {
    visited.add(referenceId);
    const response = await apiClient.im.v1.message.get({ path: { message_id: referenceId } });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书消息读取接口返回 code ${response.code}`);
    }
    const items = response.data?.items || [];
    const item = items.find((candidate) => candidate.message_id === referenceId) || items[0];
    if (!item || item.deleted) return null;
    if (commandChatId && item.chat_id && commandChatId !== item.chat_id) return null;

    const parentId = item.parent_id || "";
    const rootId = item.root_id && item.root_id !== item.message_id ? item.root_id : "";
    const text = extractFeishuMessageText(item.body?.content || "");
    const hasSourceLink = extractFeishuMinuteTokens(text).length > 0 || extractFeishuDocxDocumentIds(text).length > 0;
    if (apiItemComesFromCurrentBot(item, identity)) {
      referenceId = parentId || rootId;
      continue;
    }

    if (
      detectMeetingSummary(text)
      || hasSourceLink
    ) {
      return { event: historyEvent(commandEvent, item), text };
    }

    referenceId = parentId || rootId;
  }
  return null;
}

async function processCandidate(candidateEvent, text, feedbackMessageId) {
  const hasSourceLink = extractFeishuMinuteTokens(text).length > 0 || extractFeishuDocxDocumentIds(text).length > 0;
  const enrichedEvent = await enrichMeetingMessage(candidateEvent, text);
  const hasUsableInlineSummary = hasUsableMeetingSummaryText(text);
  if (!enrichedEvent && hasSourceLink && !hasUsableInlineSummary) {
    await replyToMessage(
      feedbackMessageId,
      "链接已识别，但暂时没读取到可导入的内容。请确认机器人有这份记录或文档的访问权限。",
    );
    return { outcome: "source_unreadable" };
  }
  if (!enrichedEvent && !detectMeetingSummary(text)) {
    await replyToMessage(
      feedbackMessageId,
      "我读了你回复的消息，但没有识别出可导入的内容。请回复真正的原消息，或直接发送来源链接。",
    );
    return { outcome: "not_summary" };
  }
  const result = await forwardWithRetry(enrichedEvent || candidateEvent);
  await replyToMessage(feedbackMessageId, formatFeishuImportFeedback(result));
  return result;
}

async function scanChatHistory(commandEvent, identity) {
  const chatId = commandEvent.message?.chat_id || "";
  if (!chatId) {
    throw new Error("当前命令缺少群聊 ID");
  }

  let pageToken;
  let scanned = 0;
  let matched = 0;
  let truncated = false;

  while (scanned < maxHistoryMessages) {
    const response = await apiClient.im.v1.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: 50,
        page_token: pageToken,
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书历史消息接口返回 code ${response.code}`);
    }

    const items = response.data?.items || [];
    for (const item of items) {
      if (scanned >= maxHistoryMessages) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (!item.message_id || item.deleted) continue;
      if (apiItemComesFromCurrentBot(item, identity)) continue;
      const text = extractFeishuMessageText(item.body?.content || "");
      const hasSourceLink = extractFeishuMinuteTokens(text).length > 0 || extractFeishuDocxDocumentIds(text).length > 0;
      if (apiItemIsAutomated(item) && !hasSourceLink && text.length < 120) continue;
      if (detectSummaryImportCommand(text)) continue;
      const candidateEvent = historyEvent(commandEvent, item);
      const enrichedEvent = await enrichMeetingMessage(candidateEvent, text, { allowBareDocx: false });
      if (!enrichedEvent && !detectMeetingSummary(text)) continue;
      matched += 1;
      await forwardWithRetry(enrichedEvent || candidateEvent);
    }

    if (!response.data?.has_more || !response.data.page_token || truncated) break;
    pageToken = response.data.page_token;
  }

  console.info(`[探研] 群历史扫描完成 · 扫描 ${scanned} 条 · 识别 ${matched} 份纪要${truncated ? " · 已达安全上限" : ""}`);
  return { scanned, matched, truncated };
}

function startHistoryScan(event, identity) {
  const chatId = event.message?.chat_id || "";
  const messageId = event.message?.message_id || "";
  if (!chatId) return;
  if (historyScans.has(chatId)) {
    void replyToMessage(messageId, "这个群的历史总结正在扫描，不需要重复发起。完成后我会回复结果。", "busy");
    return;
  }
  const task = (async () => {
    await replyToMessage(messageId, "开始扫描当前群的历史总结，完成后我会回复识别结果。", "reading");
    const result = await scanChatHistory(event, identity);
    await replyToMessage(
      messageId,
      `历史扫描完成：查看 ${result.scanned} 条消息，识别 ${result.matched} 份纪要${result.truncated ? "；已到安全上限" : ""}。`,
    );
  })()
    .catch((error) => {
      console.error(`[探研] 群历史扫描失败 · ${error instanceof Error ? error.message : "未知错误"}`);
      void replyToMessage(messageId, "历史总结扫描暂时失败，请稍后再试；原消息不会丢失。");
    })
    .finally(() => historyScans.delete(chatId));
  historyScans.set(chatId, task);
}

async function handleReferencedImport(event, identity) {
  const messageId = event.message?.message_id || "";
  await replyToMessage(messageId, "收到，我正在读取你回复的那条消息。", "reading");
  try {
    const candidate = await fetchReferencedCandidate(event, identity);
    if (!candidate) {
      await replyToMessage(
        messageId,
        "我没能从回复上下文里找到可导入的内容。请直接回复原消息只 @我，或把来源链接发到群里。",
      );
      return;
    }
    await processCandidate(candidate.event, candidate.text, messageId);
  } catch (error) {
    console.warn(`[探研] 回复上下文暂不可读取 · ${error instanceof Error ? error.message : "未知错误"}`);
    await replyToMessage(messageId, "我看到了你的回复，但暂时读不到原消息。请稍后重试，或直接发送总结链接。");
  }
}

async function handleDirectImport(event, text) {
  const messageId = event.message?.message_id || "";
  if (extractFeishuMinuteTokens(text).length || extractFeishuDocxDocumentIds(text).length) {
    await replyToMessage(messageId, "链接收到，我正在读取其中的内容。", "reading");
  } else {
    await replyToMessage(messageId, "总结收到，我正在识别学生并写入系统。", "reading");
  }
  await processCandidate(event, text, messageId);
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (event) => {
    const message = event.message;
    if (!message || message.chat_type !== "group") return;
    const identity = await resolveBotIdentity();
    if (eventComesFromBot(event, identity)) return;
    const text = extractFeishuMessageText(message.content || "");
    const hasSourceLink = extractFeishuMinuteTokens(text).length > 0 || extractFeishuDocxDocumentIds(text).length > 0;
    if (eventIsAutomated(event) && !hasSourceLink && text.length < 120) return;
    if (detectSummaryImportCommand(text)) {
      startHistoryScan(event, identity);
      return;
    }
    const hasReference = Boolean(message.parent_id || message.root_id);
    const mentionedBot = messageMentionsBot(message, identity);
    if (detectSummaryReplyRequest(text, { hasReference, mentionedBot })) {
      void handleReferencedImport(event, identity);
      return;
    }
    if (
      detectMeetingSummary(text)
      || hasSourceLink
    ) {
      void handleDirectImport(event, text);
      return;
    }
    if (mentionedBot && isFeishuMentionOnly(text)) {
      void replyToMessage(
        message.message_id,
        "我可以直接理解导入上下文：回复一条原消息只 @我即可；来源链接也可以直接发，不用再写“导入这个总结”。",
      );
    }
  },
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    wsClient.close({ force: true });
    process.exit(0);
  });
}

async function startBridge() {
  const identity = await resolveBotIdentity();
  await wsClient.start({ eventDispatcher });
  console.info(`[探研] 飞书长连接客户端已启动；机器人身份${identity.openId ? "已确认" : "暂未确认、将自动重试"}；支持回复总结仅 @机器人、链接直传、结果回执与“导入所有总结”。`);
}

startBridge().catch(() => {
  console.error("[探研] 飞书长连接客户端启动失败，将由系统自动重试。");
  process.exitCode = 1;
});
