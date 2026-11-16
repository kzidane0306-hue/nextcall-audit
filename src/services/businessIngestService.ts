import "server-only";

import { randomUUID } from "crypto";
import { Business, SocialProfile } from "@/types";
import { persistenceService } from "@/services/persistenceService";
import { getBusinessesCollection } from "@/lib/db";
import { cleanValue, ExtractedScreenshotFields } from "@/services/screenshotExtractor";
import { normalizeFacebookPageUrl } from "@/lib/facebookUrl";
import { logger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/errors";

/**
 * Turns the AI's screenshot reads into a saved business.
 *
 * Used by the audit worker after it has read the stored uploads. The old
 * ingest route owned this logic inline; it moved here so queue time does zero
 * AI work and the read+save+pipeline all happen inside one resumable job.
 */

function normalizeWebsite(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function domainOf(url: string): string | null {
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalises a phone number into a stable identity fragment. */
function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `p:${digits.slice(-10)}`;
}

/**
 * All the keys this business could be recognised by later.
 *
 * The duplicate check matches ANY of them ($in) — so a second upload of the
 * same business is caught even when the vision read differs between the two
 * screenshots (one read finds the website, the other doesn't, the phone is
 * printed on both, the name carries a different suffix…).
 *
 * `facebookKey` ("f:...") is included when the About screenshot showed the
 * page's own URL in the address bar — the same page screenshotted twice then
 * matches even if the name/website/phone reads disagree.
 */
export function dedupeKeysFor(
  name: string,
  website: string | null,
  phone?: string | null,
  facebookKey?: string | null
): string[] {
  const keys = new Set<string>();
  const domain = website ? domainOf(website) : null;
  if (domain) keys.add(`d:${domain}`);
  const phoneFragment = phoneKey(phone);
  if (phoneFragment) keys.add(phoneFragment);
  if (facebookKey) keys.add(facebookKey);
  if (name?.trim()) keys.add(`n:${normalizeName(name)}`);
  return [...keys];
}

/** The single key stored on the business document (most specific first). */
export function dedupeKeyFor(
  name: string,
  website: string | null,
  phone?: string | null,
  facebookKey?: string | null
): string {
  const keys = dedupeKeysFor(name, website, phone, facebookKey);
  return keys[0] ?? `n:${normalizeName(name)}`;
}

export async function findExistingBusiness(dedupeKeys: string[]): Promise<Business | null> {
  try {
    const collection = await getBusinessesCollection();
    const doc = await collection.findOne({ dedupeKey: { $in: dedupeKeys } });
    return (doc as unknown as Business) ?? null;
  } catch (error) {
    // Fail open: a lookup problem must not block work from proceeding.
    logger.warn(`[BusinessIngest] Duplicate lookup skipped: ${getErrorMessage(error)}`);
    return null;
  }
}

/** The Facebook extras feed the audit — services and hours are real signals. */
function buildNotes(facebook: {
  services?: string[] | null;
  hours?: string | null;
}): string | undefined {
  const lines: string[] = [];

  const services = (facebook.services ?? []).map((s) => s.trim()).filter(Boolean);
  if (services.length > 0) lines.push(`Services (from Facebook): ${services.join(", ")}`);
  if (facebook.hours) lines.push(`Hours (from Facebook): ${facebook.hours}`);

  return lines.length > 0 ? lines.join("\n") : undefined;
}

export interface SavedBusinessResult {
  business: Business;
  /** Non-null when the screenshots matched a business already in the app. */
  duplicateOf: Business | null;
}

/**
 * Merges the two reads (Google wins where both have a value — it is the
 * canonical listing; Facebook fills the gaps, above all the email address)
 * and saves the business. Returns the existing row untouched on a duplicate.
 *
 * The Facebook read's `pageUrl` (the address-bar URL) becomes the business's
 * Facebook page: stored under metadata.facebookUrl so the crawl can never
 * overwrite it, and mirrored into enrichment.socialProfiles as a proper
 * facebook profile so the audit credits it.
 */
export async function saveBusinessFromScreenshots(
  google: ExtractedScreenshotFields | null,
  facebook: ExtractedScreenshotFields | null
): Promise<SavedBusinessResult> {
  const name = cleanValue(google?.name) ?? cleanValue(facebook?.name);
  if (!name) {
    throw new Error("The business name could not be read from the screenshots.");
  }

  const website = normalizeWebsite(cleanValue(google?.website) ?? cleanValue(facebook?.website));
  const phone = cleanValue(google?.phone) ?? cleanValue(facebook?.phone);
  const address = cleanValue(google?.address) ?? cleanValue(facebook?.address);
  const category = cleanValue(google?.category) ?? cleanValue(facebook?.category);
  const email = (cleanValue(facebook?.email) ?? cleanValue(google?.email))?.toLowerCase() ?? null;
  const rating = google?.rating ?? facebook?.rating ?? null;
  const reviewCount = google?.reviewCount ?? facebook?.reviewCount ?? null;

  // The page's own URL, read out of the address bar on the About screenshot.
  // Anything that is not recognisably a Facebook page (a business website the
  // model picked instead, google.com, junk) is dropped here.
  const facebookIdentity = normalizeFacebookPageUrl(facebook?.pageUrl ?? null);
  const facebookUrl = facebookIdentity?.url ?? null;

  const dedupeKey = dedupeKeyFor(name, website, phone, facebookIdentity?.key ?? null);
  const existing = await findExistingBusiness(
    dedupeKeysFor(name, website, phone, facebookIdentity?.key ?? null)
  );

  if (existing) {
    return { business: existing, duplicateOf: existing };
  }

  const id = randomUUID();

  // The Facebook page as a proper social profile, so the deterministic audit
  // and the AI report credit it (SOCIAL category) without any extra wiring.
  const socialProfiles: SocialProfile[] = facebookUrl
    ? [
        {
          platform: "facebook",
          url: facebookUrl,
          sourceUrl: "facebook about screenshot (address bar)",
          confidence: 100,
        },
      ]
    : [];

  const business: Business = {
    id,
    name,
    phone: phone ?? undefined,
    website: website ?? undefined,
    location: address ? { address } : undefined,
    rating: rating ?? undefined,
    reviewCount: reviewCount ?? undefined,
    categories: category ? [category] : [],
    providerIds: { manual: id },
    status: "active",
    sources: ["MANUAL"],
    notes: buildNotes(facebook ?? {}),
    dedupeKey,
    // The page URL lives on metadata, NOT on enrichment: the website crawl
    // rebuilds enrichment from scratch and would silently drop it.
    metadata: facebookUrl ? { facebookUrl } : undefined,
    enrichment:
      email || socialProfiles.length > 0
        ? {
            status: "NOT_STARTED",
            emails: email
              ? [
                  {
                    address: email,
                    type: "BUSINESS" as const,
                    sourceUrl: "facebook about screenshot",
                    sourceType: "VISIBLE_TEXT" as const,
                    confidence: 100,
                  },
                ]
              : undefined,
            preferredEmail: email ?? null,
            socialProfiles: socialProfiles.length > 0 ? socialProfiles : undefined,
          }
        : undefined,
  };

  await persistenceService.upsertBusiness(business);
  logger.info(
    `[BusinessIngest] Saved "${name}" (${id}) from screenshots${facebookUrl ? ` — Facebook page ${facebookUrl}` : ""}.`
  );

  return { business, duplicateOf: null };
}
