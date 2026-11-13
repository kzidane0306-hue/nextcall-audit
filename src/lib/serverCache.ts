import "server-only";

/**
 * A tiny in-process TTL cache.
 *
 * The app runs as ONE Node process (Render), so a module-level cache is the
 * cheapest way to keep a dashboard render from re-reading the same collections
 * on every click. It is deliberately tiny: no persistence, no invalidation
 * graph — just "reuse this promise's result for N seconds".
 *
 * Two behaviours matter:
 *   - concurrent callers share the same in-flight promise (10 parallel renders
 *     still make one database round trip)
 *   - a rejected load is never cached, so a transient database error does not
 *     keep the page broken for the rest of the window
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const values = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export function cachedFor<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = values.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = load()
    .then((value) => {
      values.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Drop one key (used by tests and by explicit "refresh" actions). */
export function invalidateCache(key: string): void {
  values.delete(key);
}
