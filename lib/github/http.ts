import { env } from "cloudflare:workers";

// Minimal GitHub REST client. Only api.github.com is contacted (or, for the
// local demo loop, a GitHub double on this machine), every request carries an
// explicit API version, and response bodies are never echoed back to users
// (they may contain repository content).

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      /** Local development only: a GitHub double such as http://127.0.0.1:4610
       * (scripts/local-dev/demo-loop.mjs). Accepted only for plain http on
       * localhost / 127.0.0.1 / [::1]; anything else is refused so the App's
       * tokens can never be redirected to another host. */
      GITHUB_API_BASE_URL?: string;
    }
  }
}

export const GITHUB_API_BASE = "https://api.github.com";
const LOCAL_OVERRIDE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class GithubApiBaseOverrideError extends Error {}

/**
 * The API origin to call. Unset or blank → api.github.com. A set value must be
 * a bare http origin on a loopback host name (no credentials, path, query or
 * fragment); any other value throws instead of silently falling back, so a
 * misconfiguration is visible and never sends a token to a foreign host.
 */
export function resolveGithubApiBase(override: unknown): string {
  if (override === undefined || override === null) return GITHUB_API_BASE;
  if (typeof override !== "string") throw new GithubApiBaseOverrideError("GITHUB_API_BASE_URL 无效");
  const value = override.trim();
  if (!value) return GITHUB_API_BASE;
  let url: URL;
  try { url = new URL(value); } catch { throw new GithubApiBaseOverrideError("GITHUB_API_BASE_URL 无效"); }
  const bare = !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    && !value.includes("?") && !value.includes("#");
  if (url.protocol !== "http:" || !LOCAL_OVERRIDE_HOSTS.has(url.hostname) || !bare) {
    throw new GithubApiBaseOverrideError("GITHUB_API_BASE_URL 只允许本机 http 地址（localhost、127.0.0.1 或 [::1]），仅供本地演示");
  }
  return url.origin;
}
export const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "tanyan-research-platform";
const REQUEST_TIMEOUT_MS = 15_000;

export class GithubApiError extends Error {
  readonly status: number;
  readonly githubMessage: string;
  constructor(status: number, githubMessage: string, context: string) {
    super(`GitHub ${context} 失败（HTTP ${status}）`);
    this.status = status;
    this.githubMessage = githubMessage.slice(0, 300);
  }
}

export type GithubRequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  bearer: string;
  body?: unknown;
  context: string;
  /** Statuses returned as `{ status, data: null }` instead of throwing. */
  allowStatuses?: readonly number[];
};

export type GithubResponse<T> = { status: number; data: T | null };

/** Encodes each segment of a slash-separated value (owner/repo, branch names). */
export function encodePathSegments(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

export async function githubRequest<T>(path: string, options: GithubRequestOptions): Promise<GithubResponse<T>> {
  if (!path.startsWith("/")) throw new TypeError("GitHub API path must be absolute");
  const response = await fetch(resolveGithubApiBase(env.GITHUB_API_BASE_URL) + path, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${options.bearer}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T | null };
  }
  const message = await response.text().then((text) => {
    try { return String((JSON.parse(text) as { message?: unknown }).message ?? ""); } catch { return ""; }
  }).catch(() => "");
  if (options.allowStatuses?.includes(response.status)) return { status: response.status, data: null };
  throw new GithubApiError(response.status, message, options.context);
}

export async function githubJson<T>(path: string, options: GithubRequestOptions): Promise<T> {
  const { data, status } = await githubRequest<T>(path, options);
  if (data === null) throw new GithubApiError(status, "empty response", options.context);
  return data;
}
