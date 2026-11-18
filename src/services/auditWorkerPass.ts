import "server-only";

import { warmRouter } from "@/lib/ai/warmup";
import { logger } from "@/lib/logger";
import { selfOrigin } from "@/lib/appOrigin";
import { getErrorMessage } from "@/lib/errors";
import { jobQueueService } from "@/services/jobQueueService";
import { auditPipelineService, AuditPipelineError } from "@/services/auditPipelineService";
import {
  extractFromScreenshot,
  ExtractedScreenshotFields,
  ScreenshotError,
  ScreenshotKind,
} from "@/services/screenshotExtractor";
import { saveBusinessFromScreenshots } from "@/services/businessIngestService";
import { getScreenshotUploadsCollection } from "@/lib/db";
import { AuditJob, ScreenshotUpload } from "@/types";
import { notificationService } from "@/services/notificationService";
import { engineStateService } from "@/services/engineStateService";

/**
 * The worker pass — the machine's one heartbeat of work.
 *
 * Extracted from the audit worker route so TWO callers can drive it:
 *   1. The external scheduler / Render self-cron (POST /api/workers/audit).
 *   2. The operator's own dashboard: every queue-telemetry poll the console
 *      makes piggybacks a pass via after(). On Vercel there is no always-on
 *      process, so the operator's open dashboard IS the machine's heartbeat —
 *      the app runs while the operator works and sleeps when they leave, with
 *      zero idle invocations to burn the Hobby CPU budget.
 *
 * Guardrails (all preserved from the route version):
 *   - Engine gate: a pass without `respectEngineGate: false` bows out when the
 *     engine is OFF. Manual cookie-authenticated tests bypass it.
 *   - In-process lock: overlapping triggers (poll + cron landing together)
 *     share one pass instead of stacking.
 *   - The worker's own gates (job leases, the 60-second send gap) still apply,
 *     so concurrent passes can never double-send.
 */

/** Two jobs per pass — a screenshot job adds an AI read on top of the
 *  15-25s pipeline; the window below gates how many actually start. */
const MAX_JOBS_PER_PASS = 2;

/** Keep a margin at the end of the pass for the final database writes.
 *  Everything a pass starts must also end inside this budget. */
const FUNCTION_BUDGET_MS = 55_000;

/** A job is only claimed when at least this much room is left — every stage
 *  (vision read + crawl + audit, or a report call) fits inside it. */
const JOB_RESERVE_MS = 45_000;

/** One pass at a time per instance: overlapping triggers share the result. */
let passInFlight = false;

export interface PassSummary {
  done: number;
  failed: number;
  requeued: number;
  elapsedMs: number;
  results: Array<{ job: string; status: string; message?: string }>;
  /** True when the pass did not run (engine off, or one is already in flight). */
  skipped?: boolean;
  reason?: string;
}

async function runPass(workerId: string): Promise<PassSummary> {
  const startedAt = Date.now();

  // The router warm-up is LAZY: it fires only when a job is actually about to
  // touch AI. A pass with no jobs used to ping the router's /models catalog
  // every minute anyway — the single biggest line on the bandwidth bill.
  let warmPromise: Promise<boolean> | null = null;
  const awaitWarm = async (): Promise<void> => {
    if (!warmPromise) warmPromise = warmRouter(8_000);
    await warmPromise;
  };

  const requeued = await jobQueueService.requeueStale();

  let done = 0;
  let failed = 0;
  const results: PassSummary["results"] = [];

  while (done + failed < MAX_JOBS_PER_PASS) {
    // Only claim a job that still has room to finish inside the budget.
    const remainingMs = FUNCTION_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs < JOB_RESERVE_MS) break;

    const job = await jobQueueService.claimNext(workerId);
    if (!job) break;

    try {
      // Report-stage job: the deterministic audit already exists — write its
      // AI report and finish. Text-only, so it always fits the window.
      if (job.stage === "REPORT") {
        await awaitWarm();
        await jobQueueService.setPhase(job.id, "AI REPORT");
        await jobQueueService.setEngine(job.id, "router");
        const { generated } = await auditPipelineService.runReportStage(job.businessId);
        await jobQueueService.complete(job.id);
        done += 1;
        results.push({
          job: job.businessName,
          status: "DONE",
          ...(generated ? { message: "AI report ready" } : {}),
        });
        continue;
      }

      // Screenshot-stage job: read the stored uploads with AI, create the
      // business, then run the pipeline on it. Returns null for a duplicate
      // (the job is completed with a note instead).
      await jobQueueService.setPhase(job.id, "VISION READ");
      const businessId = await ensureBusinessFromScreenshots(job, awaitWarm);

      if (!businessId) {
        done += 1;
        results.push({
          job: job.businessName,
          status: "DONE",
          message: "Duplicate — already in the app, nothing queued",
        });
        continue;
      }

      await jobQueueService.setPhase(job.id, "PIPELINE");
      const result = await auditPipelineService.run(businessId, (phase) => {
        void jobQueueService.setPhase(job.id, phase).catch(() => undefined);
      });
      await jobQueueService.complete(job.id);
      done += 1;
      results.push({
        job: job.businessName,
        status: "DONE",
        ...(result.needsReport ? { message: "Audit ready — AI report queued" } : {}),
      });

      // The AI report runs as its own small job in this same queue — picked up
      // right away if the window still fits, otherwise by the next pass.
      if (result.needsReport) {
        await jobQueueService.enqueue({
          businessId,
          businessName: job.businessName,
          stage: "REPORT",
        });
      }
    } catch (error) {
      const pipelineError =
        error instanceof AuditPipelineError
          ? error
          : new AuditPipelineError("UNKNOWN", "Something went wrong while building this audit.", error);

      const status = await jobQueueService.fail(job, pipelineError.userMessage, pipelineError.code);
      failed += 1;
      results.push({ job: job.businessName, status, message: pipelineError.userMessage });

      // Only the final failure reaches the bell — a job that will retry in a
      // minute should not send three notifications.
      if (status === "DEAD") {
        await notificationService.notify({
          type: "AUTOMATION_ISSUE",
          title: `Audit failed: ${job.businessName}`,
          body: pipelineError.userMessage,
          href: "/dashboard/screenshot",
          businessId: job.businessId,
          dedupeKey: `audit-dead:${job.id}`,
        });
      }

      logger.error(
        `[WorkerPass] ${job.businessName} failed (${pipelineError.code}): ${getErrorMessage(error)}`
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  logger.info(
    `[WorkerPass] Pass done in ${elapsedMs}ms — ${done} completed, ${failed} failed, ${requeued} reclaimed.`
  );

  return { done, failed, requeued, elapsedMs, results };
}

export async function runWorkerPass(
  options: { workerId?: string; respectEngineGate?: boolean } = {}
): Promise<PassSummary> {
  const respectEngineGate = options.respectEngineGate !== false;

  // Overlapping triggers share one pass instead of stacking on top of each
  // other — a dashboard poll and a cron tick landing together are one pass.
  if (passInFlight) {
    return {
      done: 0,
      failed: 0,
      requeued: 0,
      elapsedMs: 0,
      results: [],
      skipped: true,
      reason: "a pass is already in flight",
    };
  }

  try {
    const engine = await engineStateService.isAutomationLive();
    if (respectEngineGate && !engine.live) {
      logger.debug(`[WorkerPass] skipped — engine off (${engine.reason}).`);
      return {
        done: 0,
        failed: 0,
        requeued: 0,
        elapsedMs: 0,
        results: [],
        skipped: true,
        reason: engine.reason,
      };
    }

    passInFlight = true;
    const workerId = options.workerId ?? `audit-${Date.now()}`;
    const summary = await runPass(workerId);

    // The send pass rides this heartbeat: one ping per pass, its own 60-second
    // gap enforces the pacing, so a poll-driven pass and a cron pass can never
    // double-send.
    try {
      const baseUrl = selfOrigin();
      if (baseUrl) {
        void fetch(`${baseUrl}/api/workers/send`, {
          method: "POST",
          headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
        }).catch(() => undefined);
      }
    } catch {
      // Never let the send ping break the audit pass.
    }

    return summary;
  } finally {
    passInFlight = false;
  }
}

/**
 * Screenshot-stage jobs: read the stored uploads with the vision chain, both
 * reads in parallel, then create the business and stamp it on the job.
 * Resumable by design: once the business is saved (and stamped on the job)
 * the uploads are deleted, so a retry skips straight to the pipeline instead
 * of re-reading the same images. A duplicate completes the job and returns
 * null.
 */
async function ensureBusinessFromScreenshots(
  job: AuditJob,
  awaitWarm: () => Promise<void>
): Promise<string | null> {
  const screenshots = job.screenshots;

  if (!screenshots) return job.businessId || null;

  // Resumed run: the business already exists, the pipeline continues.
  if (job.businessId) return job.businessId;

  const collection = await getScreenshotUploadsCollection();
  const ids = screenshots.facebookId
    ? [screenshots.googleId, screenshots.facebookId]
    : [screenshots.googleId];
  const docs = (await collection
    .find({ id: { $in: ids } })
    .toArray()) as unknown as ScreenshotUpload[];
  const google = docs.find((d) => d.kind === "google");
  const facebook = docs.find((d) => d.kind === "facebook");

  if (!google) {
    throw new AuditPipelineError(
      "SCREENSHOT_MISSING",
      "The stored screenshot could not be found any more. Add the business again."
    );
  }

  const visionRead = async (
    kind: ScreenshotKind,
    upload: ScreenshotUpload,
    timeoutMs: number
  ): Promise<{ fields: ExtractedScreenshotFields | null; engine: string | null; error: unknown }> => {
    await awaitWarm();
    try {
      const read = await extractFromScreenshot(
        kind,
        { bytes: Buffer.from(upload.dataBase64, "base64"), mimeType: upload.mimeType },
        { timeoutMs }
      );
      return { fields: read.fields, engine: read.engine, error: null };
    } catch (error) {
      return { fields: null, engine: null, error };
    }
  };

  const [googleRead, facebookRead] = await Promise.all([
    google
      ? visionRead("google", google, 30_000)
      : Promise.resolve({ fields: null, error: null as unknown }),
    facebook
      ? visionRead("facebook", facebook, 25_000)
      : Promise.resolve({ fields: null, error: null as unknown }),
  ]);

  if (!googleRead.fields) {
    const error = googleRead.error;
    if (error instanceof ScreenshotError) {
      throw new AuditPipelineError("SCREENSHOT_READ_FAILED", error.userMessage, error);
    }
    throw error ?? new Error("The Google screenshot read failed without an error.");
  }
  const googleFields: ExtractedScreenshotFields = googleRead.fields;
  if (googleRead.engine) {
    await jobQueueService.setEngine(job.id, googleRead.engine);
  }

  // Facebook is best-effort: no page (or an unreadable one) still leaves a
  // runnable audit — the website crawl gets a chance at the email instead.
  let facebookFields: ExtractedScreenshotFields | null = facebookRead.fields;
  if (facebook && !facebookRead.fields) {
    logger.warn(
      `[WorkerPass] Facebook read failed, continuing without it: ${getErrorMessage(facebookRead.error)}`
    );
    facebookFields = null;
  }

  const name = googleFields?.name?.trim() || facebookFields?.name?.trim() || "";
  if (!name) {
    throw new AuditPipelineError(
      "SCREENSHOT_UNREADABLE",
      "The business name could not be read from the screenshots. Take the Google screenshot again with the name clearly visible, then add the business again."
    );
  }

  const { business, duplicateOf } = await saveBusinessFromScreenshots(googleFields, facebookFields);

  // Delete the uploads before the pipeline: the reads are done, and this
  // keeps a failed pipeline retry from re-reading (and re-paying for) them.
  await collection.deleteMany({ id: { $in: docs.map((d) => d.id) } });
  await jobQueueService.attachBusiness(job.id, business.id, business.name);
  job.businessId = business.id;
  job.businessName = business.name;

  if (duplicateOf) {
    await notificationService.notify({
      type: "AUTOMATION_ISSUE",
      title: `Duplicate skipped: ${business.name}`,
      body: "These screenshots matched a business that is already in your app, so no second audit was built.",
      href: "/dashboard/screenshot",
      businessId: duplicateOf.id,
      dedupeKey: `screenshot-duplicate:${duplicateOf.id}`,
    });
    await jobQueueService.complete(job.id, "Duplicate — already in the app, nothing queued");
    return null;
  }

  return business.id;
}
