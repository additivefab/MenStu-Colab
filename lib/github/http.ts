// Minimal GitHub REST client. Only api.github.com is ever contacted, every
// request carries an explicit API version, and response bodies are never
// echoed back to users (they may contain repository content).

export const GITHUB_API_BASE = "https://api.github.com";
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
  const response = await fetch(GITHUB_API_BASE + path, {
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
