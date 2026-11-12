import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', async () => {
  const { getMemoryDb } = await import('@/lib/memoryDb');
  return {
    getProspectsCollection: async () => getMemoryDb().collection('prospects'),
  };
});

import { prospectPersistenceService } from '@/services/prospectPersistenceService';
import { getMemoryDb } from '@/lib/memoryDb';

const NOW = Date.now();
const DAY = 86_400_000;

const prospects = () =>
  getMemoryDb().collection('prospects') as unknown as {
    insertOne: (doc: Record<string, unknown>) => Promise<unknown>;
    find: (f: Record<string, unknown>) => { toArray: () => Promise<Record<string, unknown>[]> };
    deleteMany: (f: Record<string, unknown>) => Promise<unknown>;
  };

async function seed(docs: Record<string, unknown>[]) {
  for (const d of docs) {
    await prospects().insertOne(d);
  }
}

const row = (overrides: Record<string, unknown>) => ({
  id: overrides.id ?? crypto.randomUUID(),
  businessId: overrides.businessId ?? crypto.randomUUID(),
  businessName: overrides.businessName ?? 'Unknown',
  outreachState: overrides.outreachState ?? 'UNCONTACTED',
  createdAt: overrides.createdAt ?? new Date(NOW).toISOString(),
  ...overrides,
});

describe('deleteStaleUncontacted (1-month auto-cleanup)', () => {
  beforeEach(async () => {
    await prospects().deleteMany({});
  });

  it('deletes UNCONTACTED prospects older than 30 days and keeps everything else', async () => {
    await seed([
      row({ id: 'old-1', businessName: 'Old No Email', createdAt: new Date(NOW - 40 * DAY).toISOString() }),
      row({ id: 'old-2', businessName: 'Old Uncontacted', outreachState: 'UNCONTACTED', createdAt: new Date(NOW - 35 * DAY).toISOString() }),
      row({ id: 'emailed-old', businessName: 'Emailed Long Ago', outreachState: 'INITIAL_SENT', createdAt: new Date(NOW - 40 * DAY).toISOString() }),
      row({ id: 'fresh', businessName: 'Fresh Lead', createdAt: new Date(NOW - 3 * DAY).toISOString() }),
    ]);

    const result = await prospectPersistenceService.deleteStaleUncontacted({ olderThanDays: 30 });

    expect(result.deleted).toBe(2);
    const remaining = (await prospects().find({}).toArray()).map((d) => d.id);
    expect(remaining).not.toContain('old-1'); // UNCONTACTED + 40 days → deleted
    expect(remaining).not.toContain('old-2');
    expect(remaining).toContain('emailed-old'); // emailed once → never deleted
    expect(remaining).toContain('fresh'); // new lead → stays
  });

  it('respects the maxDelete cap', async () => {
    await seed([
      row({ id: `stale-${1}`, createdAt: new Date(NOW - 40 * DAY).toISOString() }),
      row({ id: `stale-${2}`, createdAt: new Date(NOW - 41 * DAY).toISOString() }),
      row({ id: `stale-${3}`, createdAt: new Date(NOW - 42 * DAY).toISOString() }),
    ]);

    const result = await prospectPersistenceService.deleteStaleUncontacted({ olderThanDays: 30, maxDelete: 1 });
    expect(result.deleted).toBe(1);
  });

  it('deletes nothing when nothing is stale', async () => {
    await seed([row({ id: 'fresh-1', createdAt: new Date(NOW - 2 * DAY).toISOString() })]);
    const result = await prospectPersistenceService.deleteStaleUncontacted({ olderThanDays: 30 });
    expect(result.deleted).toBe(0);
  });
});
