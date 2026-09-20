const noBlockerStatements = new Set([
  "无", "暂无", "没有", "无阻塞", "暂无阻塞", "没有阻塞", "当前无阻塞", "目前无阻塞", "目前暂无阻塞", "目前没有阻塞",
  "无困难", "暂无困难", "没有困难", "目前没有困难", "暂时没有困难",
  "无问题", "暂无问题", "没有问题", "无卡点", "暂无卡点", "无阻碍", "暂无阻碍",
  "已解决", "已解除", "问题已解决", "阻塞已解决", "阻塞已解除", "困难已解决", "已无阻塞",
  "无需协助", "暂不需要协助", "不需要协助", "正常", "一切正常", "进展顺利",
  "none", "no", "n/a", "na", "null", "nil", "noblocker", "noblockers", "noissues", "resolved", "notapplicable", "-", "—",
]);

export function activeBlockerText(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  // Match complete statements only: “已解决，但设备仍未到位” must remain visible.
  const normalized = text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "").replace(/[。.!！;；,，]+$/u, "");
  return noBlockerStatements.has(normalized) ? "" : text;
}
