import { NextRequest, NextResponse, after } from "next/server";
import { env } from "@/lib/env";
import { authorizeSweep } from "@/lib/sweepAuth";
import { logger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/errors";
import { jobQueueService } from "@/services/jobQueueService";
import { runWorkerPass } from "@/services/auditWorkerPass";
import { engineStateService } from "@/services/engineStateService";

/**
 * The audit worker endpoint.
 *
 * Triggered by an external scheduler (cron-job.org) every few minutes, by the
 * Render self-cron every minute, and — the newest driver — by the operator's
 * own open dashboard: every queue-telemetry poll piggybacks a pass via
 * after() (see auditWorkerPass.ts). That is what makes the machine run while
 * the operator works and sleep when they leave, which is exactly how the
 * Vercel Hobby CPU budget stays inside its limits.
 *
 * One pass: reclaim jobs whose worker died, claim jobs (an AUDIT, then its
 * follow-up REPORT) one at a time, mark each DONE or schedule a retry. The
 * pass also chains the send worker, whose own 60-second gap paces the emails.
 *
 * Add `?wait=1` to run the pass synchronously and get the summary back —
 * handy for a manual test, never used by the scheduler.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function runPass(workerId: string): Promise<void> {
  try {
    await runWorkerPass({ workerId, respectEngineGate: false });
  } catch (error) {
    logger.error("[Worker /audit] Pass crashed:", getErrorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  const auth = authorizeSweep({
    headerSecret: request.headers.get("x-cron-secret"),
    querySecret: new URL(request.url).searchParams.get("secret"),
    authorizationHeader: request.headers.get("authorization"),
    authCookie: request.cookies.get("nextcall_auth")?.value ?? null,
    cronSecret: process.env.CRON_SECRET,
    appPassword: env.APP_PASSWORD,
  });

  if (!auth.ok) {
    logger.warn(`[Worker /audit] Rejected: ${auth.reason}`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The engine gate: a scheduled caller only runs a pass while the operator's
  // engine is ON and freshly heartbeated. Manual ?wait=1 tests authenticate
  // with the dashboard cookie and deliberately bypass this gate.
  if (auth.via === "cron-secret") {
    const engine = await engineStateService.isAutomationLive();
    if (!engine.live) {
      logger.info(`[Worker /audit] Engine off (${engine.reason}) — pass skipped.`);
      return NextResponse.json(
        { accepted: false, engine: "off", reason: engine.reason },
        { status: 200 }
      );
    }
  }

  const workerId = `audit-${Date.now()}`;
  const wantsToWait = new URL(request.url).searchParams.get("wait") === "1";

  // Manual test: answer with the real summary.
  if (wantsToWait) {
    try {
      const summary = await runWorkerPass({ workerId, respectEngineGate: false });
      return NextResponse.json({ ok: true, ...summary });
    } catch (error) {
      logger.error("[Worker /audit] Pass crashed:", getErrorMessage(error));
      return NextResponse.json({ error: "Worker pass failed." }, { status: 500 });
    }
  }

  // Scheduler: hang up now, keep working.
  after(async () => {
    await runPass(workerId);
  });

  return NextResponse.json({ accepted: true, worker: workerId }, { status: 202 });
}

/** A GET is handy for uptime checkers and for eyeballing the endpoint. */
export async function GET() {
  const stats = await jobQueueService.stats();
  return NextResponse.json({ worker: "audit", stats });
}
