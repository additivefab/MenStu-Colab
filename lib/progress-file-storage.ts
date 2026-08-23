import { env } from "cloudflare:workers";

export function isProgressFileStorageConfigured() {
  return Boolean(env.FILES);
}

export function getProgressFileBucket() {
  if (!env.FILES) throw new Error("附件存储尚未配置");
  return env.FILES;
}
