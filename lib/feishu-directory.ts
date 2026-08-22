import { getFeishuTenantToken } from "./feishu-auth";
import { normalizeFeishuContact, type FeishuContactIdentifier } from "./feishu-contact";

export type ResolvedFeishuIdentity = FeishuContactIdentifier & {
  openId: string;
};

type BatchGetIdResponse = {
  code?: number;
  msg?: string;
  data?: {
    user_list?: Array<{
      user_id?: string;
      email?: string;
      mobile?: string;
      status?: {
        is_frozen?: boolean;
        is_resigned?: boolean;
        is_activated?: boolean;
        is_exited?: boolean;
        is_unjoin?: boolean;
      };
    }>;
  };
};

export async function resolveFeishuOpenIds(contacts: FeishuContactIdentifier[]) {
  if (!contacts.length) return [];
  const emails = contacts.filter((item) => item.kind === "email").map((item) => item.value);
  const mobiles = contacts.filter((item) => item.kind === "mobile").map((item) => item.value);
  if (emails.length > 50 || mobiles.length > 50) throw new Error("单次飞书身份核验数量超出限制");

  const token = await getFeishuTenantToken();
  const response = await fetch("https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      ...(emails.length ? { emails } : {}),
      ...(mobiles.length ? { mobiles } : {}),
      include_resigned: false,
    }),
  });
  const payload = await response.json() as BatchGetIdResponse;
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `飞书用户身份核验失败（${response.status}）`);
  }

  const emailSet = new Set(emails);
  const mobileSet = new Set(mobiles);
  const resolved: ResolvedFeishuIdentity[] = [];
  for (const item of payload.data?.user_list ?? []) {
    const email = item.email ? normalizeFeishuContact("email", item.email) : "";
    const mobile = item.mobile ? normalizeFeishuContact("mobile", item.mobile) : "";
    const kind = email && emailSet.has(email) ? "email" : mobile && mobileSet.has(mobile) ? "mobile" : null;
    const value = kind === "email" ? email : kind === "mobile" ? mobile : "";
    const blocked = item.status?.is_frozen
      || item.status?.is_resigned
      || item.status?.is_exited
      || item.status?.is_unjoin
      || item.status?.is_activated === false;
    if (!kind || !value || !item.user_id || blocked) continue;
    resolved.push({ kind, value, openId: item.user_id });
  }
  return resolved;
}
