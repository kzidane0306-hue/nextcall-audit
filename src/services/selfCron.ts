import "server-only";

import { engineStateService } from "@/services/engineStateService";
import { logger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/errors";

/**
 * The self-cron: on a real server (Render), the platform timer is dependable,
 * so the app can drive itself. Once a minute — exactly what cron-job.org is
 * configured to do — the instance calls its own audit worker, which also
 * chains the send pass (one email per minute). The external cron may be
 * paused, rate-limited or misconfigured; the pipeline no longer cares.
 *
 * Guardrails:
 *   - Only on Render (RENDER_EXTERNAL_URL exists); Vercel keeps using the
 *     external cron, where in-process timers are not reliable.
 *   - Only while the engine is live: an idle engine stops the ticks, lets the
 *     idle TTL expire, and the instance spins down as the operator wants.
 *   - The worker's own gates (leases, the 60-second send gap, the engine
 *     check) still apply, so a second, external cron tick cannot double-send.
 */

const TICK_INTERVAL_MS = 60 * 1000;

export function startSelfCron(): void {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) {
    logger.debug("[SelfCron] RENDER_EXTERNAL_URL is not set — self-cron disabled (not on Render).");
    return;
  }

  setInterval(() => {
    void (async () => {
      try {
        const engine = await engineStateService.isAutomationLive();
        if (!engine.live) return;

        await fetch(`${baseUrl}/api/workers/audit`, {
          method: "POST",
          headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
        }).catch(() => undefined);
        logger.debug("[SelfCron] tick sent — audit pass requested.");
      } catch (error) {
        logger.warn("[SelfCron] tick failed:", getErrorMessage(error));
      }
    })();
  }, TICK_INTERVAL_MS);

  logger.info(`[SelfCron] Started — one worker tick per minute at ${baseUrl} while the engine is live.`);
}
