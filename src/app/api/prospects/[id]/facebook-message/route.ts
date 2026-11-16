import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prospectPersistenceService } from "@/services/prospectPersistenceService";
import { facebookOutreachService } from "@/services/facebookOutreachService";
import { logger } from "@/lib/logger";

import { getErrorMessage } from "@/lib/errors";

const GenerateMessageSchema = z.object({
  /** true = write a fresh message even when one is already stored. */
  force: z.boolean().optional(),
});

/**
 * POST /api/prospects/[id]/facebook-message
 *
 * Writes (or rewrites) the short personalized Facebook page message for the
 * prospect. The message is normally generated during the REPORT stage; this
 * route covers the rest: a failed first attempt, prospects whose audit ran
 * before the feature shipped, and "give me a different version".
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const prospect = await prospectPersistenceService.getProspectById(id);
    if (!prospect) {
      return NextResponse.json({ error: "Prospect not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const parsed = GenerateMessageSchema.safeParse(body ?? {});
    const force = parsed.success ? Boolean(parsed.data.force) : false;

    const message = await facebookOutreachService.ensureFacebookMessage(id, { force });

    if (!message) {
      return NextResponse.json(
        {
          error:
            "No Facebook page is linked to this prospect yet. Screenshot the page's About section with the address bar visible, or add the page link on the card.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ message });
  } catch (error) {
    logger.error(
      "[API /prospects/[id]/facebook-message] Generation failed:",
      getErrorMessage(error)
    );
    return NextResponse.json(
      { error: `Failed to generate the Facebook message: ${getErrorMessage(error)}` },
      { status: 500 }
    );
  }
}
