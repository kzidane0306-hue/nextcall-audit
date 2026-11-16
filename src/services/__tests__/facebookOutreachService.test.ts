import { describe, it, expect, vi, beforeEach } from "vitest";
import { facebookOutreachService } from "@/services/facebookOutreachService";
import { Business, Prospect } from "@/types";

const mocks = vi.hoisted(() => ({
  generateLLMResponse: vi.fn(),
  getProspectById: vi.fn(),
  updateFacebookMessage: vi.fn(),
  getBusinessById: vi.fn(),
}));

vi.mock("@/lib/ai", () => ({
  generateLLMResponse: mocks.generateLLMResponse,
}));

vi.mock("@/services/prospectPersistenceService", () => ({
  prospectPersistenceService: {
    getProspectById: mocks.getProspectById,
    updateFacebookMessage: mocks.updateFacebookMessage,
  },
}));

vi.mock("@/services/persistenceService", () => ({
  persistenceService: {
    getBusinessById: mocks.getBusinessById,
  },
}));

const business = {
  id: "b1",
  name: "Acme Plumbing",
  categories: ["Plumber"],
  location: { city: "Sandy", state: "UT" },
  metadata: { facebookUrl: "https://www.facebook.com/acmeplumbing" },
  sources: [],
  providerIds: {},
} as unknown as Business;

const prospect = {
  id: "p1",
  businessId: "b1",
  facebookUrl: "https://www.facebook.com/acmeplumbing",
  facebookStatus: "READY",
  facebookMessage: null,
} as unknown as Prospect;

function llmReply(message: string) {
  return {
    text: JSON.stringify({ message }),
    provider: "router",
    model: "test-model",
    fallback: false,
  };
}

beforeEach(() => {
  mocks.generateLLMResponse.mockReset();
  mocks.getProspectById.mockReset();
  mocks.updateFacebookMessage.mockReset();
  mocks.getBusinessById.mockReset();

  mocks.getProspectById.mockResolvedValue(prospect);
  mocks.getBusinessById.mockResolvedValue(business);
  mocks.updateFacebookMessage.mockResolvedValue(undefined);
});

describe("facebookOutreachService.ensureFacebookMessage", () => {
  it("keeps a good cold draft and saves it on the prospect", async () => {
    mocks.generateLLMResponse.mockResolvedValue(
      llmReply(
        "Hey Acme Plumbing! 👋\n\nI came across your business while researching local plumbing companies in Sandy. I noticed a few things that might be worth a quick look.\n\nI put together a quick audit for Acme Plumbing — would you be open to seeing it?"
      )
    );

    const message = await facebookOutreachService.ensureFacebookMessage("p1");

    expect(message).toContain("Hey Acme Plumbing! 👋");
    expect(message).toContain("audit for Acme Plumbing");
    expect(mocks.updateFacebookMessage).toHaveBeenCalledWith("p1", expect.any(String));
    expect(mocks.generateLLMResponse).toHaveBeenCalledTimes(1);
  });

  it("rejects a familiar NextCall pitch and ships the deterministic template instead", async () => {
    // The old style: assumes a relationship, names gaps, pitches NextCall.
    mocks.generateLLMResponse.mockResolvedValue(
      llmReply(
        "Your 4.9/5 rating is impressive! I noticed your business doesn't have online booking, which could be a missed opportunity. NextCall is an AI receptionist that answers calls 24/7 and can help with booking. Would you like to see how it could help your customers?"
      )
    );

    const message = await facebookOutreachService.ensureFacebookMessage("p1");

    expect(message).toMatch(/^Hey Acme Plumbing! 👋/);
    expect(message).toMatch(/audit for Acme Plumbing/i);
    expect(message).not.toMatch(/nextcall/i);
    expect(message).not.toMatch(/doesn't have/i);
    expect(message).not.toMatch(/missed opportunity/i);
    expect(message).not.toMatch(/receptionist/i);
    expect(mocks.updateFacebookMessage).toHaveBeenCalledWith("p1", expect.any(String));
  });

  it("lets a personalized hook pass and accepts a business named with 24/7", async () => {
    const locksmith = {
      ...business,
      name: "24/7 Mobile Locksmith - Tampa",
      metadata: { facebookUrl: "https://www.facebook.com/247mobilelocksmith" },
    } as unknown as Business;
    mocks.getBusinessById.mockResolvedValue(locksmith);
    mocks.getProspectById.mockResolvedValue({
      ...prospect,
      facebookUrl: "https://www.facebook.com/247mobilelocksmith",
    } as unknown as Prospect);

    mocks.generateLLMResponse.mockResolvedValue(
      llmReply(
        "Hey 24/7 Mobile Locksmith - Tampa! 👋\n\nI came across your business while researching local locksmith companies in Tampa. Your 776 reviews at 4.7 stars caught my eye — that is not easy to build. I noticed a few small things that might be worth a quick look.\n\nI put together a quick audit for 24/7 Mobile Locksmith - Tampa — would you be open to seeing it?"
      )
    );

    const message = await facebookOutreachService.ensureFacebookMessage("p1");

    expect(message).toContain("Hey 24/7 Mobile Locksmith - Tampa! 👋");
    expect(message).toContain("776 reviews");
    expect(message).toContain("audit for 24/7 Mobile Locksmith");
    expect(mocks.updateFacebookMessage).toHaveBeenCalledWith("p1", expect.any(String));
  });

  it("returns null when neither the prospect nor the business carries a page URL", async () => {
    mocks.getProspectById.mockResolvedValue({
      ...prospect,
      facebookUrl: null,
    } as unknown as Prospect);
    mocks.getBusinessById.mockResolvedValue({
      ...business,
      metadata: {},
    } as unknown as Business);

    const message = await facebookOutreachService.ensureFacebookMessage("p1");

    expect(message).toBeNull();
    expect(mocks.generateLLMResponse).not.toHaveBeenCalled();
    expect(mocks.updateFacebookMessage).not.toHaveBeenCalled();
  });

  it("reuses the stored message and only rewrites it when force is set", async () => {
    const stored = (await import("@/types"), {
      ...prospect,
      facebookMessage: "Hey Acme Plumbing! 👋 stored draft",
    } as unknown as Prospect);
    mocks.getProspectById.mockResolvedValue(stored);

    const message = await facebookOutreachService.ensureFacebookMessage("p1");
    expect(message).toBe("Hey Acme Plumbing! 👋 stored draft");
    expect(mocks.generateLLMResponse).not.toHaveBeenCalled();

    mocks.generateLLMResponse.mockResolvedValue(
      llmReply(
        "Hey Acme Plumbing! 👋\n\nI came across your business while researching local plumbing companies in Sandy. A few things on your online presence might be worth a quick look.\n\nI put together a quick audit for Acme Plumbing — would you be open to seeing it?"
      )
    );

    const fresh = await facebookOutreachService.ensureFacebookMessage("p1", { force: true });
    expect(fresh).not.toBe("Hey Acme Plumbing! 👋 stored draft");
    expect(mocks.generateLLMResponse).toHaveBeenCalledTimes(1);
    expect(mocks.updateFacebookMessage).toHaveBeenCalledWith("p1", expect.any(String));
  });
});
