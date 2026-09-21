type Environment = Record<string, string | undefined>;

export class FeishuBotConfigError extends Error {
  constructor() {
    super("独立机器人须同时配置 FEISHU_BOT_APP_ID 和 FEISHU_BOT_APP_SECRET");
    this.name = "FeishuBotConfigError";
  }
}

/** Shared by the Worker and Node bridge; never combines credentials from two apps. */
export function resolveFeishuBotConfig(values: Environment) {
  const botAppId = values.FEISHU_BOT_APP_ID?.trim() ?? "";
  const botAppSecret = values.FEISHU_BOT_APP_SECRET?.trim() ?? "";
  const botVerificationToken = values.FEISHU_BOT_VERIFICATION_TOKEN?.trim() ?? "";
  const botEncryptKey = values.FEISHU_BOT_ENCRYPT_KEY?.trim() ?? "";
  const dedicated = Boolean(botAppId || botAppSecret || botVerificationToken || botEncryptKey);

  if (dedicated) {
    if (!botAppId || !botAppSecret) throw new FeishuBotConfigError();
    return {
      mode: "dedicated" as const,
      appId: botAppId,
      appSecret: botAppSecret,
      verificationToken: botVerificationToken,
      encryptKey: botEncryptKey,
    };
  }

  return {
    mode: "legacy" as const,
    appId: values.FEISHU_APP_ID?.trim() ?? "",
    appSecret: values.FEISHU_APP_SECRET?.trim() ?? "",
    verificationToken: values.FEISHU_VERIFICATION_TOKEN?.trim() ?? "",
    encryptKey: values.FEISHU_ENCRYPT_KEY?.trim() ?? "",
  };
}
