import { describe, expect, it, vi, beforeEach } from 'vitest';

// The gate reads the settings document and the job queue; both are isolated
// here. The queue mock is what simulates "background work is pending".
const mocks = vi.hoisted(() => ({
  stats: vi.fn(async () => ({ QUEUED: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 })),
  pendingSends: vi.fn(async () => 0),
}));

vi.mock('@/lib/db', async () => {
  const { getMemoryDb } = await import('@/lib/memoryDb');
  return {
    getSettingsCollection: async () => getMemoryDb().collection('settings'),
  };
});

vi.mock('@/services/jobQueueService', () => ({
  jobQueueService: { stats: mocks.stats },
}));

vi.mock('@/services/autoSendService', () => ({
  autoSendService: { countPendingSends: mocks.pendingSends },
}));

import {
  ENGINE_LIVE_TTL_MS,
  decideLiveness,
  defaultEngineState,
  engineLiveReason,
  engineStateService,
  isHeartbeatFresh,
} from '@/services/engineStateService';
import { getMemoryDb } from '@/lib/memoryDb';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');

describe('isHeartbeatFresh', () => {
  it('is fresh within the TTL', () => {
    // 20 minutes old — well inside the 30-minute window.
    expect(isHeartbeatFresh('2026-11-10T09:40:00.000Z', NOW)).toBe(true);
  });

  it('is stale past the TTL', () => {
    // 31 minutes old — the engine must look OFF to every worker.
    expect(isHeartbeatFresh('2026-11-10T09:29:00.000Z', NOW)).toBe(false);
  });

  it('treats exactly TTL-old as fresh (boundary)', () => {
    const exactlyTtlOld = new Date(NOW - ENGINE_LIVE_TTL_MS).toISOString();
    expect(isHeartbeatFresh(exactlyTtlOld, NOW)).toBe(true);
  });

  it('is never fresh without a heartbeat', () => {
    expect(isHeartbeatFresh(null, NOW)).toBe(false);
    expect(isHeartbeatFresh('not-a-date', NOW)).toBe(false);
  });
});

describe('engineLiveReason', () => {
  it('says "off" for a switch that was turned off by the operator', () => {
    const state = { ...defaultEngineState(), on: false, lastOffReason: 'operator' };
    expect(engineLiveReason(state, NOW)).toBe('off');
  });

  it('says "auto-off" when the TTL expired and was stamped', () => {
    const state = { ...defaultEngineState(), on: false, lastOffReason: 'auto-off — 30 minutes without activity' };
    expect(engineLiveReason(state, NOW)).toBe('auto-off');
  });

  it('says "stale-heartbeat" for ON with an expired heartbeat', () => {
    const state = { ...defaultEngineState(), on: true, lastHeartbeatAt: '2026-11-10T09:00:00.000Z' };
    expect(engineLiveReason(state, NOW)).toBe('stale-heartbeat');
  });

  it('says "no-heartbeat" for ON that never heartbeated', () => {
    const state = { ...defaultEngineState(), on: true };
    expect(engineLiveReason(state, NOW)).toBe('no-heartbeat');
  });

  it('says "on" only for ON with a fresh heartbeat', () => {
    const state = { ...defaultEngineState(), on: true, lastHeartbeatAt: '2026-11-10T09:45:00.000Z' };
    expect(engineLiveReason(state, NOW)).toBe('on');
  });
});

describe('decideLiveness (work-aware engine)', () => {
  const fresh = {
    ...defaultEngineState(),
    on: true,
    lastHeartbeatAt: new Date(NOW - 5 * 60_000).toISOString(),
  };
  const stale = {
    ...defaultEngineState(),
    on: true,
    lastHeartbeatAt: new Date(NOW - 4 * 60 * 60_000).toISOString(),
  };
  const off = { ...defaultEngineState(), on: false };

  it('stays live on a fresh heartbeat', () => {
    expect(decideLiveness(fresh, NOW, 0)).toEqual({ live: true, reason: 'on', keepAlive: false });
  });

  it('stays live with pending jobs even after the heartbeat expired (overnight batch)', () => {
    const decision = decideLiveness(stale, NOW, 6);
    expect(decision.live).toBe(true);
    expect(decision.reason).toBe('work-pending');
    expect(decision.keepAlive).toBe(true);
  });

  it('expires a stale heartbeat once the queue is empty', () => {
    const decision = decideLiveness(stale, NOW, 0);
    expect(decision.live).toBe(false);
    expect(decision.keepAlive).toBe(false);
  });

  it('never resurrects a switch that is OFF', () => {
    expect(decideLiveness(off, NOW, 99)).toEqual({ live: false, reason: 'off', keepAlive: false });
  });
});

describe('isAutomationLive (engine + queue integration)', () => {
  const settings = () => getMemoryDb().collection('settings') as unknown as {
    findOne: (f: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    updateOne: (f: Record<string, unknown>, u: Record<string, unknown>, o?: { upsert?: boolean }) => Promise<unknown>;
    deleteMany: (f: Record<string, unknown>) => Promise<unknown>;
  };

  async function seedEngine(on: boolean, heartbeatAgoMs: number) {
    await settings().updateOne(
      { id: 'engine-state' },
      {
        $set: {
          id: 'engine-state',
          on,
          lastHeartbeatAt: new Date(Date.now() - heartbeatAgoMs).toISOString(),
          lastOffAt: null,
          lastOffReason: null,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
  }

  beforeEach(async () => {
    mocks.stats.mockReset();
    mocks.stats.mockResolvedValue({ QUEUED: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 });
    mocks.pendingSends.mockReset();
    mocks.pendingSends.mockResolvedValue(0);
    await settings().deleteMany({});
  });

  it('keeps a stale engine alive while jobs are pending, and rolls the heartbeat', async () => {
    await seedEngine(true, 4 * 60 * 60_000);
    mocks.stats.mockResolvedValue({ QUEUED: 3, RUNNING: 1, DONE: 0, FAILED: 0, DEAD: 0 });

    const live = await engineStateService.isAutomationLive();
    expect(live.live).toBe(true);
    expect(live.reason).toBe('work-pending');

    const stored = (await settings().findOne({ id: 'engine-state' })) as Record<string, unknown>;
    const age = Date.now() - new Date(String(stored.lastHeartbeatAt)).getTime();
    expect(age).toBeLessThan(60_000);
    expect(stored.on).toBe(true);
  });

  it('keeps a stale engine alive while emails are waiting, even with an empty job queue', async () => {
    await seedEngine(true, 4 * 60 * 60_000);
    mocks.stats.mockResolvedValue({ QUEUED: 0, RUNNING: 0, DONE: 40, FAILED: 0, DEAD: 0 });
    mocks.pendingSends.mockResolvedValue(30);

    const live = await engineStateService.isAutomationLive();
    expect(live.live).toBe(true);
    expect(live.reason).toBe('work-pending');
  });

  it('auto-turns-off a stale engine once the queue is empty', async () => {
    await seedEngine(true, 4 * 60 * 60_000);
    mocks.stats.mockResolvedValue({ QUEUED: 0, RUNNING: 0, DONE: 9, FAILED: 0, DEAD: 0 });

    const live = await engineStateService.isAutomationLive();
    expect(live.live).toBe(false);

    const stored = (await settings().findOne({ id: 'engine-state' })) as Record<string, unknown>;
    expect(stored.on).toBe(false);
    expect(String(stored.lastOffReason)).toContain('auto-off');
  });

  it('never resurrects an operator-switched-OFF engine', async () => {
    await seedEngine(false, 4 * 60 * 60_000);
    mocks.stats.mockResolvedValue({ QUEUED: 5, RUNNING: 2, DONE: 0, FAILED: 0, DEAD: 0 });

    const live = await engineStateService.isAutomationLive();
    expect(live.live).toBe(false);
    expect(live.on).toBe(false);
  });
});
