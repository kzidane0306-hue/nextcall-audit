import "server-only";

import { z } from "zod";
import { Business } from "@/types";
import { generateLLMResponse } from "@/lib/ai";
import { AI_CHAINS } from "@/lib/ai/chains";
import { prospectPersistenceService } from "@/services/prospectPersistenceService";
import { persistenceService } from "@/services/persistenceService";
import { logger } from "@/lib/logger";

/**
 * The short Facebook opener — a COLD first impression, personalized per
 * business.
 *
 * The operator has never spoken to this business. The message must read like
 * a polite stranger offering something useful, and it must feel written for
 * THIS business: one concrete, positive, publicly visible detail (their
 * reviews, a service they list, their hours) proves real research without
 * ever claiming familiarity or naming problems.
 *
 *   Hey {business}! 👋
 *
 *   I came across your business while researching local {category} companies.
 *   {One specific positive fact.} I noticed a few small things that might be
 *   worth a quick look.
 *
 *   I put together a quick audit for {business} — it walks through what is
 *   already working and a couple of places where small changes could bring in
 *   more calls. Would you be open to seeing it?
 *
 * No NextCall pitch, no audit findings, no "your business doesn't have X" —
 * all of that comes later, in the audit email, AFTER they say yes. The AI
 * personalizes inside the skeleton; anything that breaks it (a NextCall
 * pitch, a gap claim, familiarity) is rejected and the deterministic template
 * below ships instead — the copy button never dead-ends.
 */

const MessageSchema = z.object({
  message: z.string().min(30).max(650),
});

const SYSTEM_PROMPT = `
You write ONE short first-contact Facebook message for a human consultant to send to a local business's page. COLD first impression: the owner does NOT know the sender and has never been contacted. A stranger is politely offering something useful — and the message must feel written specifically for THIS business.

SHAPE — exactly 3 short paragraphs separated by blank lines:
Para 1: "Hey {business name}! 👋"
Para 2 (the personalized hook, 2-4 short sentences):
  - Open with how you came across the business while researching local {category} companies (mention the city if provided).
  - Then ONE concrete, POSITIVE detail from the FACTS below that caught your eye — their rating and review count, a service they list, hours they keep, or their website. Phrase it as an outside researcher: "your 776 reviews at 4.7 stars caught my eye", "the fact that you list emergency service stands out". This detail is what makes them curious — pick the strongest one you have.
  - Close the paragraph softly: "I noticed a few small things that might be worth a quick look." Never say WHAT the things are.
Para 3: "I put together a quick audit for {business name} — it walks through what is already working and a couple of places where small changes could bring in more calls. Would you be open to seeing it?"

HARD RULES
- 60 to 90 words total. Casual, human, plain text.
- Use ONLY the FACTS provided. Never invent ratings, services, hours or anything else.
- NEVER state problems or gaps: no "you don't have", "no online booking", "missed calls", "lost customers", "losing money". Positive observations and the neutral "a few small things" only.
- NEVER mention NextCall, an AI receptionist, or any product pitch. The first message offers the audit only.
- NEVER imply prior contact ("as you know", "following up", "your impressive rating as we discussed").
- NO gushing flattery words ("impressive", "amazing", "incredible") — let the fact speak: "caught my eye", "stands out", "not easy to build".
- NEVER include email addresses, phone numbers or links in the message.
- The ONLY emoji allowed is the single 👋 in para 1. No hashtags, no signature.
- The business name appears only in para 1 and para 3, spelled exactly as given.

Return ONLY valid JSON: { "message": "..." }
`;

function buildUserPrompt(business: Business): string {
  const category = business.categories?.filter(Boolean).join(", ") || "local service";
  const city = business.location?.city?.trim();
  const rating =
    business.rating != null
      ? `${business.rating}/5${business.reviewCount ? ` across ${business.reviewCount} reviews` : ""}`
      : null;
  const website = business.enrichment?.website?.url || business.website || null;
  const booking = business.enrichment?.booking;

  const lines = [
    "BUSINESS FACTS (public and verified — use ONLY these):",
    `- Name (use exactly): ${business.name}`,
    `- Category: ${category}`,
    city ? `- City: ${city}${business.location?.state ? `, ${business.location.state}` : ""}` : "- City: not known — do not mention one",
    rating ? `- Rating: ${rating}` : "- Rating: not known — do not mention one",
    website ? `- Website: ${website}` : "- Website: none found — do not mention one",
    booking
      ? `- Online booking on their listing: ${booking.detected ? `yes${booking.systemName ? ` (${booking.systemName})` : ""}` : "not detected"} (do NOT call attention to either way — never claim they lack anything)`
      : null,
    business.notes?.trim() ? `- Listing notes (services / hours): """${business.notes.trim().slice(0, 400)}"""` : "- Listing notes: none",
    "",
    "TASK: write the message following the 3-paragraph shape exactly, 60-90 words, with the strongest positive fact as the hook.",
  ];

  return lines.filter(Boolean).join("\n");
}

/**
 * Anything in here means the model slipped back into "we already know you"
 * mode or started pitching. Checked against the message with every occurrence
 * of the business name removed first — a business literally named "24/7
 * Mobile Locksmith" must not trip the marketing-claim filters.
 */
const BANNED_MESSAGE_PATTERNS: RegExp[] = [
  /nextcall/i,
  /receptionist/i,
  /missed\s+(call|opportunity|customer)/i,
  /lost\s+(customer|money|lead)/i,
  /(doesn'?t|does not|don'?t|do not)\s+(have|see|offer)/i,
  /no online booking/i,
  /\b(impressive|amazing|incredible|outstanding|blown away)\b/i,
  /as you know/i,
  /following up/i,
];

/** Checks the draft stayed inside the cold-outreach skeleton. */
function validateColdMessage(message: string, business: Business): string | null {
  const text = message.trim();

  if (!/^hey\b/i.test(text)) return "must open with a Hey greeting";
  if (!/\baudit\b/i.test(text)) return "must offer the audit";
  if (!text.toLowerCase().includes(business.name.toLowerCase())) return "must address the business by name";

  // The business name may legitimately contain phrases like "24/7" that the
  // marketing filters target — judge the prose, not the name.
  const prose = text
    .split(business.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(" ")
    .replace(new RegExp(business.name.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi"), " ");
  for (const pattern of BANNED_MESSAGE_PATTERNS) {
    if (pattern.test(prose)) return `contains banned phrasing (${pattern})`;
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 110) return `too long (${words} words)`;

  return null;
}

/** The deterministic shape — used when the AI drifts or the chain is down. */
function fallbackFacebookMessage(business: Business): string {
  const name = business.name;
  const city = business.location?.city?.trim();
  const hook =
    business.rating != null
      ? ` Your ${business.rating}${business.reviewCount ? `★ rating across ${business.reviewCount} reviews` : "★ rating"} stood out.`
      : "";

  return [
    `Hey ${name}! 👋`,
    "",
    `I came across your business while researching local companies${city ? ` in ${city}` : ""}.${hook} I noticed a few small things on your online presence that might be worth a quick look.`,
    "",
    `I put together a quick audit for ${name} — it walks through what is already working and a couple of places where small changes could bring in more calls. Would you be open to seeing it?`,
  ].join("\n");
}

/** Trims the small messes models add around an otherwise clean answer. */
function tidyMessage(raw: string): string {
  let text = (raw ?? "").trim();
  // The model may wrap the message in quotes or escape newlines.
  if (/^"[\s\S]*"$/.test(text)) text = text.slice(1, -1).trim();
  text = text.replace(/\\n/g, "\n").replace(/\r/g, "");
  // Collapse any accidental 3+ blank lines; keep deliberate paragraph breaks.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export class FacebookOutreachService {
  /**
   * Writes the personalized page message. Two AI attempts inside the strict
   * skeleton; if both drift (or the chain is down), the deterministic
   * template ships — this message is too important to leave the operator
   * with nothing to copy.
   */
  async generateFacebookMessage(business: Business): Promise<string> {
    let lastProblem = "the AI chain did not answer";

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const llm = await generateLLMResponse({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(business),
          temperature: 0.6,
          maxOutputTokens: 600,
          json: true,
          model: AI_CHAINS.main,
          timeoutMs: 30_000,
          singleAttempt: true,
        });

        logger.info(
          `[FacebookOutreach] Message drafted by ${llm.provider} (${llm.model})${llm.fallback ? " [fallback]" : ""}.`
        );

        let parsed: { message?: string };
        try {
          parsed = JSON.parse(llm.text) as { message?: string };
        } catch {
          // Some models answer with the bare string instead of JSON.
          parsed = { message: llm.text };
        }

        const candidate = tidyMessage(parsed.message ?? "");
        const validated = MessageSchema.safeParse({ message: candidate });
        if (!validated.success) {
          lastProblem = `shape check failed (${validated.error.issues.map((i) => i.code).join(", ")})`;
          continue;
        }

        const problem = validateColdMessage(validated.data.message, business);
        if (problem) {
          lastProblem = problem;
          logger.warn(`[FacebookOutreach] Draft rejected: ${problem}`);
          continue;
        }

        return validated.data.message;
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
        logger.warn(`[FacebookOutreach] Attempt ${attempt}/2 failed: ${lastProblem}`);
      }
    }

    logger.warn(`[FacebookOutreach] Using the deterministic template for ${business.name}: ${lastProblem}`);
    return fallbackFacebookMessage(business);
  }

  /**
   * Makes sure the prospect HAS a Facebook message: generates and saves one
   * when a page URL exists and no message is stored yet. Returns the stored
   * message, or null when there is nothing to do (no page URL). Safe to call
   * repeatedly — the stored message is reused unless force is set.
   */
  async ensureFacebookMessage(
    prospectId: string,
    options: { force?: boolean } = {}
  ): Promise<string | null> {
    const prospect = await prospectPersistenceService.getProspectById(prospectId);
    if (!prospect) return null;

    const facebookUrl =
      prospect.facebookUrl ??
      (await this.facebookUrlForBusiness(prospect.businessId));
    if (!facebookUrl) return null;

    if (!options.force && prospect.facebookMessage?.trim()) return prospect.facebookMessage;

    const business = await persistenceService.getBusinessById(prospect.businessId);
    if (!business) return null;

    const message = await this.generateFacebookMessage(business);
    await prospectPersistenceService.updateFacebookMessage(prospectId, message);
    return message;
  }

  /**
   * The prospect row is the source of truth for the page URL; the business
   * metadata is the fallback for rows created before the field existed.
   */
  private async facebookUrlForBusiness(businessId: string): Promise<string | null> {
    try {
      const business = await persistenceService.getBusinessById(businessId);
      return (business?.metadata?.facebookUrl as string | undefined) ?? null;
    } catch {
      return null;
    }
  }
}

export const facebookOutreachService = new FacebookOutreachService();
