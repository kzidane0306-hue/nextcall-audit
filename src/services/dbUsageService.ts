import "server-only";

import { env } from "@/lib/env";
import { getDbClient } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/errors";

/**
 * How much of the database the app is actually using.
 *
 * The Astra Data API has no "database size" call, so this is an estimate:
 * count the documents in each collection, measure a sample of them, and
 * multiply. That is accurate enough to answer the only question that matters
 * here — "is it time to clean up?" — without pulling every audit body out of
 * the database on each page load.
 *
 * The biggest consumers are `audits` (a full audit plus the AI report per
 * business) and `outreach` (the rendered HTML body of every email), so those
 * two are the ones to prune first when the bar starts climbing.
 */

const COLLECTIONS = [
  "businesses",
  "audits",
  "prospects",
  "outreach",
  "notifications",
  "settings",
] as const;

/** Documents read per collection to work out an average size. */
const SAMPLE_SIZE = 20;

/** The settings page is not a live dashboard; a few minutes of cache is fine. */
const CACHE_TTL_MS = 30 * 60_000;

/** Give up (and hide the panel) rather than stall the page render. */
const TIMEOUT_MS = 6_000;

export interface CollectionUsage {
  name: string;
  documents: number;
  estimatedBytes: number;
}

export interface DatabaseUsage {
  collections: CollectionUsage[];
  totalDocuments: number;
  estimatedBytes: number;
  /** Plan allowance in bytes (ASTRA_STORAGE_LIMIT_MB, default 25 GB). */
  limitBytes: number;
  /** Share of the plan allowance, 0-100, rounded. */
  percentUsed: number;
  measuredAt: string;
}

interface MinimalCollection {
  find: (filter: Record<string, unknown>, options?: { limit?: number }) => {
    toArray: () => Promise<Record<string, unknown>[]>;
  };
  countDocuments?: (filter: Record<string, unknown>, upperBound: number) => Promise<number>;
  estimatedDocumentCount?: () => Promise<number>;
}

export class DbUsageService {
  private cache: { value: DatabaseUsage; at: number } | null = null;

  async getUsage(force = false): Promise<DatabaseUsage | null> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.value;
    }

    let db;
    try {
      db = await getDbClient();
    } catch (error) {
      logger.warn(`[DbUsage] Database unavailable: ${getErrorMessage(error)}`);
      return null;
    }

    let failures = 0;

    // The settings page must not hang on a hibernating database: if the
    // measurement takes too long, hide the panel and let the next visit try
    // again with a warm connection.
    const measured = await withTimeout(
      Promise.all(
        COLLECTIONS.map(async (name): Promise<CollectionUsage> => {
          try {
            const collection = db.collection(name) as unknown as MinimalCollection;
            const sample = await collection.find({}, { limit: SAMPLE_SIZE }).toArray();

            const sampleBytes = sample.reduce(
              (sum, doc) => sum + Buffer.byteLength(JSON.stringify(doc), "utf8"),
              0
            );
            const averageBytes = sample.length > 0 ? sampleBytes / sample.length : 0;
            const documents = await countDocuments(collection, sample.length);

            return {
              name,
              documents,
              estimatedBytes: Math.round(averageBytes * documents),
            };
          } catch (error) {
            // A collection that has never been written to does not exist yet.
            failures += 1;
            logger.warn(`[DbUsage] Could not measure "${name}": ${getErrorMessage(error)}`);
            return { name, documents: 0, estimatedBytes: 0 };
          }
        })
      ),
      TIMEOUT_MS,
      null
    );

    if (!measured) {
      logger.warn(`[DbUsage] Measurement timed out after ${TIMEOUT_MS}ms.`);
      return null;
    }

    const collections = measured;

    // Every collection failing means the database itself is unreachable — show
    // nothing rather than a reassuring "0 B" that is simply wrong.
    if (failures === COLLECTIONS.length) {
      logger.warn("[DbUsage] No collection could be measured; hiding the usage panel.");
      return null;
    }

    const totalDocuments = collections.reduce((sum, c) => sum + c.documents, 0);
    const estimatedBytes = collections.reduce((sum, c) => sum + c.estimatedBytes, 0);
    const limitBytes = Math.round(env.ASTRA_STORAGE_LIMIT_MB * 1024 * 1024);

    const value: DatabaseUsage = {
      collections: [...collections].sort((a, b) => b.estimatedBytes - a.estimatedBytes),
      totalDocuments,
      estimatedBytes,
      limitBytes,
      percentUsed: limitBytes > 0 ? Math.min(100, Math.round((estimatedBytes / limitBytes) * 100)) : 0,
      measuredAt: new Date().toISOString(),
    };

    this.cache = { value, at: Date.now() };
    return value;
  }

  /** Test/dev hook. */
  resetCache(): void {
    this.cache = null;
  }
}

/** The Data API's hard ceiling for one count call. */
const COUNT_UPPER_BOUND = 1000;

/**
 * Document count without reading the documents.
 *
 * `estimatedDocumentCount` is exact on the Data API and works past the count
 * call's 1000-document ceiling; the capped `countDocuments` is the fallback.
 * The settings page must never scan a whole collection — that is what used to
 * make it take 30 seconds once the tables grew past a thousand rows.
 */
async function countDocuments(collection: MinimalCollection, sampleLength: number): Promise<number> {
  if (typeof collection.estimatedDocumentCount === "function") {
    try {
      const count = await collection.estimatedDocumentCount();
      if (typeof count === "number" && Number.isFinite(count)) return count;
    } catch {
      // Unsupported by this driver/database — try the capped count.
    }
  }

  if (typeof collection.countDocuments === "function") {
    try {
      const count = await collection.countDocuments({}, COUNT_UPPER_BOUND);
      if (typeof count === "number" && Number.isFinite(count)) return count;
    } catch {
      // More than COUNT_UPPER_BOUND documents (or unsupported).
    }
  }

  // Unknown but clearly non-empty: report the sample size instead of scanning.
  return sampleLength;
}

export const dbUsageService = new DbUsageService();

/** Resolves with `fallback` if `promise` has not settled within `ms`. */
async function withTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
