import "server-only";

import { z } from "zod";
import { Business, StoredAudit, AuditReport } from "@/types";
import { generateLLMResponse } from "@/lib/ai";
import { AI_CHAINS } from "@/lib/ai/chains";
import { prospectPersistenceService } from "@/services/prospectPersistenceService";
import { auditPersistenceService } from "@/services/auditPersistenceService";
import { persistenceService } from "@/services/persistenceService";
import { logger } from "@/lib/logger";

/**
 * The short Facebook opener.
 *
 * Every new prospect that carries a Facebook page URL (read off the About
 * screenshot's address bar) gets ONE small, personalized message the operator
 * can copy in a single click and paste into the page's chat. This is a DM
 * from a human, not the audit email: two to four sentences, warm, specific,
 * and ending with one easy question.
 *
 * Generated once during the REPORT stage (best-effort — a failure never fails
 * the job) and on demand from the prospect page's "Generate message" button.
 */

const MessageSchema = z.object({
  message: z.string().min(20).max(700),
});

const SYSTEM_PROMPT = `
You write ONE short Facebook page message (a direct message) for NextCall, an AI voice receptionist for local service businesses.

WHO IS WRITING
A real human consultant (the NextCall user) messaging the business's Facebook page from their own account, speaking in the first person ("I"). The message is pasted straight into Messenger, so it must read like a person typing, not like marketing copy.

THE ONE GOAL
Make the business owner curious enough to reply. A message that could have been sent to any business gets ignored; one that is clearly about THEIR business gets answers.

SHAPE (STRICT)
- 2 to 4 sentences, at most 55 words. Plain text only.
- No greeting like "Dear Sir/Madam", no subject line, no signature, no links, no hashtags, no emojis, no bullet points.
- Open with ONE concrete detail that is only true for this business: their rating or review count, their category and city, a service they list, being open around the clock, or a specific audit observation.
- Mention NextCall in ONE sentence, naturally: an AI receptionist that answers calls 24/7 and can help with booking. Tie it to a gap the audit actually noticed, with evidence-aware wording: "I noticed", "I didn't see", "no publicly detectable". NEVER claim they are losing calls, customers or money, and never invent facts.
- Close with ONE low-friction question (for example: whether they'd like the full audit, or whether missed after-hours calls are ever a concern — only if the data supports it).

ABSOLUTE RULES
- Use ONLY facts provided in the input. Never invent ratings, tools, services, hours or outcomes.
- Address the business as "your" ("your team", "your customers") — never by name, since the message is sent TO them and their name is already in front of them.
- The tone is warm, respectful, confident, brief.

Return ONLY valid JSON: { "message": "..." }
`;

function buildUserPrompt(
  business: Business,
  audit: StoredAudit["audit"] | null,
  aiReport: AuditReport | null
): string {
  const location =
    [business.location?.city, business.location?.state].filter(Boolean).join(", ") || "Unknown";
  const category = business.categories?.filter(Boolean).join(", ") || "Unknown";
  const rating =
    business.rating != null
      ? `${business.rating}/5${business.reviewCount ? ` across ${business.reviewCount} reviews` : ""}`
      : "Unknown";
  const websiteUrl = business.enrichment?.website?.url || business.website || null;

  const booking = business.enrichment?.booking;
  const bookingLine = !booking
    ? "Not verified"
    : booking.detected
      ? `Detected${booking.systemName ? ` (${booking.systemName})` : ""}`
      : "No publicly detectable online booking";

  const notesLine = business.notes?.trim()
    ? `"${business.notes.trim().slice(0, 500)}"`
    : "None";

  const weakest =
    audit
      ? Object.entries(audit.categoryScores)
          .sort((a, b) => a[1].score - b[1].score)
          .slice(0, 2)
          .map(([name, s]) => `${name} (${s.score}/100)`)
          .join(", ")
      : "Unknown";

  const findingLines =
    (audit?.findings ?? [])
      .filter((f) => f.type !== "STRENGTH")
      .slice(0, 4)
      .map((f) => `- [${f.category}] ${f.title} — ${f.evidence}`)
      .join("\n") || "- None recorded";

  const strengthLines =
    (audit?.findings ?? [])
      .filter((f) => f.type === "STRENGTH")
      .slice(0, 3)
      .map((f) => `- [${f.category}] ${f.title} — ${f.evidence}`)
      .join("\n") || "- None recorded";

  const reportOpportunities =
    aiReport?.opportunities?.slice(0, 3).map((o) => `- ${o}`).join("\n") || "- None";

  return `
BUSINESS INFORMATION:
- Name: ${business.name}
- Category: ${category}
- Location: ${location}
- Rating: ${rating}
- Phone: ${business.phone || "Not provided"}
- Website: ${websiteUrl || "None found"}
- Facebook page: ${business.metadata?.facebookUrl || "unknown"}

BOOKING SYSTEM:
${bookingLine}

OWNER-PROVIDED CONTEXT (verified — treat as ground truth):
${notesLine}

DETERMINISTIC AUDIT RESULT:
${audit ? `- Overall score: ${audit.overallScore}/100 (confidence: ${audit.confidence})` : "- No audit available"}
- Weakest categories: ${weakest}

AUDIT FINDINGS (non-strengths):
${findingLines}

STRENGTHS:
${strengthLines}

REPORT OPPORTUNITIES:
${reportOpportunities}

Write the Facebook message now. Remember: 2-4 sentences, at most 55 words, plain text, open with one detail that is only true for THIS business, one NextCall sentence tied to a real gap, one closing question.`;
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
   * Writes the short page message from the business's audit data.
   * Throws when the AI chain fails — callers decide how fatal that is.
   */
  async generateFacebookMessage(
    business: Business,
    storedAudit: StoredAudit | null
  ): Promise<string> {
    const audit = storedAudit?.audit ?? null;
    const aiReport = storedAudit?.aiReport ?? null;

    const llm = await generateLLMResponse({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(business, audit, aiReport),
      temperature: 0.6,
      maxOutputTokens: 500,
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
      throw new Error(
        `The Facebook message did not come back in a usable shape (${validated.error.issues
          .map((i) => i.code)
          .join(", ")}).`
      );
    }
    return validated.data.message;
  }

  /**
   * Makes sure the prospect HAS a Facebook message: generates and saves one
   * when a page URL exists and no message is stored yet. Returns the stored
   * message, or null when there is nothing to do (no page URL). Safe to call
   * repeatedly — the stored message is reused.
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

    const storedAudit = await auditPersistenceService.getLatestAudit(prospect.businessId);
    const message = await this.generateFacebookMessage(business, storedAudit);
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
