export {};

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      FILES: R2Bucket;
      FEISHU_BOT_APP_ID?: string;
      FEISHU_BOT_APP_SECRET?: string;
      FEISHU_BOT_VERIFICATION_TOKEN?: string;
      FEISHU_BOT_ENCRYPT_KEY?: string;
      /** Base64/hex/raw secret used to encrypt research output submission passwords. */
      RESEARCH_OUTPUT_CREDENTIALS_KEY?: string;
      RESEARCH_OUTPUTS_ENCRYPTION_KEY?: string;
      RESEARCH_OUTPUT_PASSWORD_KEY?: string;
    }
  }
}
