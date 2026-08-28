export type FeishuImportRelayResult = {
  outcome?: string;
  staged?: boolean;
  filtered?: boolean;
  autoAssigned?: boolean;
  studentNames?: string[];
};

function studentNamesLabel(studentNames: string[] | undefined) {
  const names = Array.from(new Set((studentNames ?? []).filter(Boolean)));
  if (!names.length) return "";
  const visible = names.slice(0, 8).join("、");
  return names.length > 8 ? `${visible} 等 ${names.length} 人` : visible;
}

export function formatFeishuImportFeedback(result: FeishuImportRelayResult | undefined) {
  const names = studentNamesLabel(result?.studentNames);
  if (result?.outcome === "imported" || (result?.autoAssigned && names)) {
    return `已导入并按学生拆分${names ? `给：${names}` : ""}，现在在导师端等待审核。`;
  }
  if (result?.outcome === "duplicate" || (result?.autoAssigned && !result?.staged)) {
    return "这份总结此前已经导入，无需重复处理。";
  }
  if (result?.outcome === "needs_review" || (result?.staged && !result?.autoAssigned)) {
    return "已收到总结，但暂时无法明确匹配学生，已进入管理端待人工确认。";
  }
  if (result?.outcome === "ignored") return "这份总结此前已被忽略，我没有重复导入。";
  if (result?.outcome === "filtered" || result?.filtered) {
    return "我读到了消息，但没有识别出可导入的内容。你可以回复原消息只 @我，或直接发送原始记录链接。";
  }
  return "总结暂时未能写入系统，请稍后再试；原消息不会丢失。";
}
