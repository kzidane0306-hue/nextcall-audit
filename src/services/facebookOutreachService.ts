import "server-only";

import { z } from "zod";
import { Business } from "@/types";
import { generateLLMResponse } from "@/lib/ai";
import { AI_CHAINS } from "@/lib/ai/chains";
import { prospectPersistenceService } from "@/services/prospectPersistenceService";
import { persistenceService } from "@/services/persistenceService";
import { logger } from "@/lib/logger";

/**
 * The short Facebook opener — a COLD first impression.
 *
 * The operator has never spoken to this business. The message must read like
 * a polite stranger offering something useful, NOT like a follow-up from
 * someone they already know. So the shape is fixed:
 *
 *   Hey {business}! 👋
 *
 *   I came across your business while researching local {category} companies.
 *   I noticed a few things that might be worth a quick look.
 *
 *   I put together a quick audit for {business} — would you be open to seeing it?
 *
 * No NextCall pitch, no audit findings, no "your business doesn't have X" —
 * all of that comes later, in the audit email, AFTER they say yes. The AI
 * only softens the phrasing inside the skeleton; anything that breaks the
 * skeleton (a NextCall pitch, a gap claim, familiarity) is rejected and the
 * deterministic template below ships instead — the button never dead-ends.
 */

const MessageSchema = z.object({
  message: z.string().min(30).max(400),
});

const SYSTEM_PROMPT = `
You write ONE very short first-contact Facebook message for a human consultant to send to a local business's page. This is a COLD first impression: the owner does NOT know the sender and has never been contacted. A stranger is politely offering something useful.

SHAPE — exactly 3 short lines separated by blank lines:
Line 1: "Hey {business name}! 👋"
Line 2: ONE flowing sentence or two tiny ones: you came across the business while researching local {category} companies (mention the city if provided), and you noticed a few things that might be worth a quick look. Never say WHAT the things are.
Line 3: "I put together a quick audit for {business name} — would you be open to seeing it?"

HARD RULES
- At most 45 words total. Casual, human, plain text.
- NEVER imply prior contact or familiarity ("your impressive rating", "as you know", "following up").
- NEVER state audit findings or gaps: no missing booking, no missed calls, no lost customers, no "you don't have X". "A few things worth a quick look" is as far as it goes.
- NEVER mention NextCall, an AI receptionist, or 24/7 answering. The first message offers the audit only — the details come later, after they reply.
- The ONLY emoji allowed is the single 👋 in line 1. No links, no hashtags, no signature.
- Use ONLY the provided business facts (name, category, city). Never invent anything.
- The business name appears only in lines 1 and 3, spelled exactly as given.

Return ONLY valid JSON: { "message": "..." }
`;

function buildUserPrompt(business: Business): string {
  const category = business.categories?.filter(Boolean).join(", ") || "local service";
  const city = business.location?.city?.trim();
  const cityLine = city ? `- City: ${city}${business.location?.state ? `, ${business.location.state}` : ""}` : "- City: not known — do not mention one";

  return `
BUSINESS:
- Name (use exactly): ${business.name}
- Category: ${category}
${cityLine}

Write the message now, following the 3-line shape exactly. At most 45 words. Remember: a cold first impression — no audit details, no NextCall, no familiarity.`;
}

/** Anything in here means the model slipped back into "we already know you" mode. */
const BANNED_MESSAGE_PATTERNS: RegExp[] = [
  /nextcall/i,
  /receptionist/i,
  /\b24\s*\/\s*7\b/i,
  /missed\s+(call|opportunity|customer)/i,
  /lost\s+(customer|money|lead)/i,
  /(doesn'?t|does not|don'?t|do not)\s+(have|see|offer)/i,
  /no online booking/i,
  /(your|their)\s+(rating|review)s?\s+(is|are)\s+(impressive|great|amazing)/i,
  /as you know/i,
  /following up/i,
];

/** Checks the draft stayed inside the cold-outreach skeleton. */
function validateColdMessage(message: string, business: Business): string | null {
  const text = message.trim();

  if (!/^hey\b/i.test(text)) return "must open with a Hey greeting";
  if (!/\baudit\b/i.test(text)) return "must offer the audit";
  if (!text.toLowerCase().includes(business.name.toLowerCase())) return "must address the business by name";
  for (const pattern of BANNED_MESSAGE_PATTERNS) {
    if (pattern.test(text)) return `contains banned phrasing (${pattern})`;
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 60) return `too long (${words} words)`;

  return null;
}

/** The deterministic shape the user wrote — used when the AI drifts or fails. */
function fallbackFacebookMessage(business: Business): string {
  const name = business.name;
  const city = business.location?.city?.trim();

  return [
    `Hey ${name}! 👋`,
    "",
    `I came across your business while researching local companies${city ? ` in ${city}` : ""}. I noticed a few things on your online presence that might be worth a quick look.`,
    "",
    `I put together a quick audit for ${name} — would you be open to seeing it?`,
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
   * Writes the short page message. Two AI attempts inside the strict skeleton;
   * if both drift (or the chain is down), the deterministic template ships —
   * this message is too important to leave the operator with nothing to copy.
   */
  async generateFacebookMessage(business: Business): Promise<string> {
    let lastProblem = "the AI chain did not answer";

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const llm = await generateLLMResponse({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(business),
          temperature: 0.6,
          maxOutputTokens: 400,
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
