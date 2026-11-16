/**
 * One-time cleanup: drop crawl-found Facebook URLs from the Facebook box.
 *
 * The Facebook box is a work queue of pages the OPERATOR can actually message.
 * For one deploy window the audit pipeline also fed it with Facebook links the
 * website crawl found on the business's own site — and those are frequently
 * dead, generic or not-messageable pages, so the operator opens a prospect and
 * finds no Facebook page at all.
 *
 * This script unsets facebookStatus / facebookUrl / facebookMessage from every
 * prospect whose Facebook URL is NOT confirmed by its business's
 * metadata.facebookUrl (the screenshot-verified address-bar URL). Rows the
 * operator already sent (facebookStatus === "SENT") are left untouched —
 * never undo real work.
 *
 * Idempotent: safe to run multiple times.
 *
 * Usage: node --env-file=.env scripts/remove-crawl-facebook-status.mjs
 */

import { DataAPIClient } from "@datastax/astra-db-ts";

if (process.env.DATA_MODE === "memory") {
  console.error("DATA_MODE=memory — data is in-memory only, nothing to clean.");
  process.exit(1);
}

const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
if (!endpoint || !token) {
  console.error("Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN (load .env via --env-file).");
  process.exit(1);
}

const db = new DataAPIClient(token).db(endpoint);
const prospects = db.collection("prospects");
const businesses = db.collection("businesses");

const rows = (await prospects.find({ facebookStatus: { $in: ["READY", "SENT"] } }).toArray());

let cleaned = 0;
let keptReady = 0;
let keptSent = 0;
let failed = 0;

for (const doc of rows) {
  const name = doc.businessSnapshot?.name || doc.id;

  // Rows the operator already messaged are real work — keep them.
  if (doc.facebookStatus === "SENT") {
    keptSent++;
    continue;
  }

  let verifiedUrl = null;
  try {
    const business = await businesses.findOne({ id: doc.businessId }, { projection: { id: true, "metadata.facebookUrl": true } });
    verifiedUrl = business?.metadata?.facebookUrl ?? null;
  } catch (err) {
    failed++;
    console.error(`[fb-cleanup] FAILED to load business for ${name} (${doc.id}):`, err?.message || err);
    continue;
  }

  // The screenshot-verified URL is the only trusted source. Anything else
  // (crawl-found, missing) leaves the Facebook box.
  if (verifiedUrl && doc.facebookUrl === verifiedUrl) {
    keptReady++;
    continue;
  }

  try {
    await prospects.updateOne(
      { id: doc.id },
      { $unset: { facebookStatus: "", facebookUrl: "", facebookMessage: "", facebookSentAt: "" } }
    );
    cleaned++;
    console.log(
      `[fb-cleanup] ${name}: removed unverified Facebook URL ${doc.facebookUrl ?? "(none)"} (business metadata: ${verifiedUrl ?? "none"})`
    );
  } catch (err) {
    failed++;
    console.error(`[fb-cleanup] FAILED for ${name} (${doc.id}):`, err?.message || err);
  }
}

console.log(
  `Done. scanned=${rows.length} cleaned=${cleaned} keptReady=${keptReady} keptSent=${keptSent} failed=${failed}`
);
