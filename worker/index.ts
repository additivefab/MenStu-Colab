/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  /** Optional public origin for notification links sent from the cron sweep. */
  PUBLIC_SITE_ORIGIN?: string;
  DB: D1Database;
  FILES: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  // G2 compensating reconciliation (lib/loop-maintenance.ts). Runs on a Worker
  // cron trigger: `triggers: { crons: ["*/10 * * * *"] }` in vite.config.ts
  // `localBindingConfig` (emitted to dist/server/wrangler.json) for a Wrangler deploy.
  // The hosted Sites deployment exposes no trigger setting; there the lab
  // runner host calls POST /api/admin/maintenance instead (see that route).
  // Imported lazily: the module graph uses `cloudflare:workers`, which the
  // plain-Node render tests of this entry cannot load.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) return;
    const now = Number.isFinite(event.scheduledTime) ? new Date(event.scheduledTime) : new Date();
    const run = import("../lib/loop-maintenance").then(({ runLoopMaintenance }) => runLoopMaintenance(env.DB, env, { now }));
    ctx.waitUntil(run.then((report) => {
      const counts = {
        runsCanceled: report.runs.cancelFinalized.count,
        runsNeedingAttention: report.runs.staleAttention.count,
        attemptsFailed: report.agentAttempts.leaseExpiredFailed.count,
        attemptsCanceled: report.agentAttempts.cancelFinalized.count,
        changeRequestsChecked: report.changeRequests.checked.count,
        publishingStuck: report.changeRequests.publishingStuck.count,
        notificationsSent: report.notifications.sent.count,
        errors: report.errors.length,
      };
      console.log(`loop maintenance ${event.cron}: ${JSON.stringify(counts)}`);
    }, (error: unknown) => {
      console.error("loop maintenance failed", error instanceof Error ? error.message : error);
    }));
  },
};

export default worker;
