import "server-only";

import { getSettingsCollection } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/errors";
import { jobQueueService } from "@/services/jobQueueService";
import { autoSendService } from "@/services/autoSendService";

/**
 * The engine switch — one switch that decides whether the background
 * automation lives or sleeps.
 *
 * The operator works in bursts: a couple of hours a day with the dashboard
 * open, and the rest of the day (and night) the app sits idle. Every worker
 * used to run around the clock anyway, which is what burned the Vercel Hobby
 * CPU quota. The engine flips that around:
 *
 *   - The operator presses ENGINE ON in the dashboard when they start working.
 *   - While the engine is ON, an open dashboard keeps heartbeating — but only
 *     while the tab is visible AND the operator actually interacts.
 *   - Every scheduled caller (cron-job.org, Vercel Cron, the in-process
 *     scheduler) checks the engine first and bows out immediately when it is
 *     OFF: a wake-up costs milliseconds instead of a whole worker pass.
 *   - Manual, cookie-authenticated actions (uploads, "Run now", ?wait=1 tests)
 *     always work — a human pressing a button is a deliberate decision.
 *
 * Auto-off is implicit: "ON" simply means "ON and heartbeated within the TTL".
 * A closed window, a sleeping laptop or a power cut stops the heartbeats, and
 * within the TTL every worker sees the engine as OFF — no separate timer, no
 * cleanup. The stale expiry is stamped into the document, so the dashboard
 * switch can show WHY it went dark.
 */

const ENGINE_DOC_ID = "engine-state";

/**
 * How long the engine stays live without a dashboard heartbeat. Configurable
 * per deployment via ENGINE_TTL_MINUTES: a Vercel Hobby install keeps the
 * 30-minute default to cap CPU, while a Render free instance sets 90 so the
 * operator gets a long grace window before the instance is allowed to sleep.
 */
export const ENGINE_LIVE_TTL_MS =
  Math.min(24 * 60, Math.max(5, Number(process.env.ENGINE_TTL_MINUTES) || 30)) *
  60 *
  1000;

/** The reason stamped when the TTL expires without a heartbeat. */
export const ENGINE_AUTO_OFF_REASON = "auto-off — 30 minutes without activity";

export interface EngineState {
  on: boolean;
  lastHeartbeatAt: string | null;
  lastOffAt: string | null;
  lastOffReason: string | null;
  updatedAt: string | null;
}

export interface EngineLive {
  /** True when the switch is ON and the heartbeat is fresh OR jobs are pending. */
  live: boolean;
  /** Raw switch position (may be ON with an expired heartbeat). */
  on: boolean;
  /** "on" | "work-pending" | "off" | "auto-off" | "stale-heartbeat" | "no-heartbeat" | "storage-error" */
  reason: string;
  lastHeartbeatAt: string | null;
}

export function defaultEngineState(): EngineState {
  return {
    on: false,
    lastHeartbeatAt: null,
    lastOffAt: null,
    lastOffReason: null,
    updatedAt: null,
  };
}

/** Pure: does this heartbeat timestamp still count as alive at `now`? */
export function isHeartbeatFresh(
  lastHeartbeatAt: string | null,
  now: number,
  ttlMs: number = ENGINE_LIVE_TTL_MS
): boolean {
  if (!lastHeartbeatAt) return false;
  const last = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last <= ttlMs;
}

/** Pure: why is the engine in its current live/not-live state? */
export function engineLiveReason(state: EngineState, now: number): string {
  if (!state.on) {
    return state.lastOffReason === ENGINE_AUTO_OFF_REASON ? "auto-off" : "off";
  }
  if (!state.lastHeartbeatAt) return "no-heartbeat";
  return isHeartbeatFresh(state.lastHeartbeatAt, now) ? "on" : "stale-heartbeat";
}

function toState(raw: unknown): EngineState {
  const doc = (raw ?? {}) as Record<string, unknown>;
  return {
    on: doc.on === true,
    lastHeartbeatAt: typeof doc.lastHeartbeatAt === "string" ? doc.lastHeartbeatAt : null,
    lastOffAt: typeof doc.lastOffAt === "string" ? doc.lastOffAt : null,
    lastOffReason: typeof doc.lastOffReason === "string" ? doc.lastOffReason : null,
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null,
  };
}

export interface LivenessDecision {
  live: boolean;
  reason: string;
  /** True when the heartbeat must be rolled because real work is pending. */
  keepAlive: boolean;
}

/**
 * Pure: should the engine count as live right now?
 *
 *   - OFF stays OFF — pending work never resurrects a switch the operator
 *     turned off.
 *   - A fresh heartbeat is live.
 *   - A STALE heartbeat is still live while jobs wait or run: the operator
 *     queues a batch, closes the laptop and sleeps, and the workers must
 *     finish that batch before the engine (and the Render instance) may idle
 *     out.
 *   - A stale heartbeat with an empty queue expires (auto-off).
 */
export function decideLiveness(
  state: EngineState,
  now: number,
  pendingJobs: number
): LivenessDecision {
  const reason = engineLiveReason(state, now);
  if (!state.on) return { live: false, reason, keepAlive: false };
  if (reason === "on") return { live: true, reason, keepAlive: false };
  if (pendingJobs > 0) return { live: true, reason: "work-pending", keepAlive: true };
  return { live: false, reason, keepAlive: false };
}

class EngineStateService {
  /** Raw stored state. Throws on storage failure (callers decide). */
  private async readState(): Promise<EngineState> {
    const collection = await getSettingsCollection();
    return toState(await collection.findOne({ id: ENGINE_DOC_ID }));
  }

  private async writeState(patch: Partial<EngineState>): Promise<EngineState> {
    const current = await this.readState();
    const next: EngineState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const collection = await getSettingsCollection();
    await collection.updateOne(
      { id: ENGINE_DOC_ID },
      {
        $set: {
          id: ENGINE_DOC_ID,
          on: next.on,
          lastHeartbeatAt: next.lastHeartbeatAt,
          lastOffAt: next.lastOffAt,
          lastOffReason: next.lastOffReason,
          updatedAt: next.updatedAt,
        },
      },
      { upsert: true }
    );
    return next;
  }

  /** The switch position as the dashboard sees it. Throws on storage failure. */
  async getState(): Promise<EngineState> {
    return this.readState();
  }

  /** ENGINE ON — turning it on counts as the first heartbeat. */
  async turnOn(): Promise<EngineState> {
    const next = await this.writeState({
      on: true,
      lastHeartbeatAt: new Date().toISOString(),
    });
    logger.info("[Engine] ON — operator switched the engine on.");
    return next;
  }

  /** ENGINE OFF — every scheduled worker stops at its next wake-up. */
  async turnOff(reason: string): Promise<EngineState> {
    const next = await this.writeState({
      on: false,
      lastOffAt: new Date().toISOString(),
      lastOffReason: reason.slice(0, 120),
    });
    logger.info(`[Engine] OFF — ${next.lastOffReason}.`);
    return next;
  }

  /** A dashboard heartbeat. Never resurrects a switch that is OFF. */
  async heartbeat(): Promise<EngineState> {
    const current = await this.readState();
    if (!current.on) return current;
    return this.writeState({ lastHeartbeatAt: new Date().toISOString() });
  }

  /**
   * How much background work is still waiting? The engine must outlive the
   * dashboard while work is busy — the operator closes the app and goes to
   * sleep, and the audits/reports AND the email backlog still have to finish.
   * An idle queue with nothing sendable does not keep the engine (or the
   * always-awake Render instance) alive.
   */
  private async pendingWorkCount(): Promise<number> {
    try {
      const [stats, pendingSends] = await Promise.all([
        jobQueueService.stats(),
        autoSendService.countPendingSends(),
      ]);
      return (stats.QUEUED ?? 0) + (stats.RUNNING ?? 0) + pendingSends;
    } catch (error) {
      logger.warn("[Engine] Could not read the pending work:", getErrorMessage(error));
      return 0;
    }
  }

  /**
   * The gate every scheduled caller runs through. Fails closed: when storage
   * cannot be read, the scheduled pass does not run (manual actions are not
   * gated and keep working).
   */
  async isAutomationLive(): Promise<EngineLive> {
    let state: EngineState;
    try {
      state = await this.readState();
    } catch (error) {
      logger.warn("[Engine] Could not read the switch:", getErrorMessage(error));
      return { live: false, on: false, reason: "storage-error", lastHeartbeatAt: null };
    }

    const now = Date.now();
    // Only an ON engine pays for the queue lookup.
    const pending = state.on ? await this.pendingWorkCount() : 0;
    const decision = decideLiveness(state, now, pending);

    if (decision.keepAlive) {
      // Work is still running: roll the heartbeat so the window keeps
      // covering the job, not the operator's bedtime.
      try {
        state = await this.writeState({ lastHeartbeatAt: new Date().toISOString() });
      } catch (error) {
        logger.warn("[Engine] Could not roll the heartbeat for pending work:", getErrorMessage(error));
      }
      logger.info(`[Engine] ${pending} job(s) pending — engine kept alive past the idle window.`);
    }

    // Stamp the auto-off so the dashboard can show why it went dark. Cheap and
    // idempotent — several callers may stamp the same transition.
    if (state.on && !decision.live) {
      try {
        await this.turnOff(ENGINE_AUTO_OFF_REASON);
      } catch (error) {
        logger.warn("[Engine] Could not stamp the auto-off:", getErrorMessage(error));
      }
    }

    return { live: decision.live, on: state.on, reason: decision.reason, lastHeartbeatAt: state.lastHeartbeatAt };
  }
}

export const engineStateService = new EngineStateService();
