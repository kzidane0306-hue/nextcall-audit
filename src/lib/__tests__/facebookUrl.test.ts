import { describe, it, expect } from "vitest";
import {
  normalizeFacebookPageUrl,
  buildMessengerUrl,
  buildBrowserFacebookUrl,
} from "@/lib/facebookUrl";

describe("normalizeFacebookPageUrl", () => {
  it("normalises a vanity URL with a scheme", () => {
    expect(normalizeFacebookPageUrl("https://www.facebook.com/UtahFloodGuys")).toEqual({
      url: "https://www.facebook.com/UtahFloodGuys",
      key: "f:utahfloodguys",
    });
  });

  it("accepts the bare address-bar form the vision model reads", () => {
    expect(normalizeFacebookPageUrl("facebook.com/UtahFloodGuys")).toEqual({
      url: "https://www.facebook.com/UtahFloodGuys",
      key: "f:utahfloodguys",
    });
  });

  it("keeps the id of profile.php pages", () => {
    expect(normalizeFacebookPageUrl("facebook.com/profile.php?id=100079163705243")).toEqual({
      url: "https://www.facebook.com/profile.php?id=100079163705243",
      key: "f:100079163705243",
    });
  });

  it("strips /about and other sub-paths from a vanity URL", () => {
    expect(normalizeFacebookPageUrl("https://www.facebook.com/DealsPlumbing/about")).toEqual({
      url: "https://www.facebook.com/DealsPlumbing",
      key: "f:dealsplumbing",
    });
  });

  it("accepts m.facebook.com and mbasic hosts", () => {
    expect(normalizeFacebookPageUrl("https://m.facebook.com/AcmeHVAC")).toEqual({
      url: "https://www.facebook.com/AcmeHVAC",
      key: "f:acmehvac",
    });
    expect(normalizeFacebookPageUrl("mbasic.facebook.com/AcmeHVAC")).toEqual({
      url: "https://www.facebook.com/AcmeHVAC",
      key: "f:acmehvac",
    });
  });

  it("accepts fb.me short links", () => {
    expect(normalizeFacebookPageUrl("https://fb.me/acmeplumbing")).toEqual({
      url: "https://www.facebook.com/acmeplumbing",
      key: "f:acmeplumbing",
    });
  });

  it("normalises /people/<Name>/<id> mobile cards", () => {
    expect(
      normalizeFacebookPageUrl("https://www.facebook.com/people/Utah-Flood-Guys/100079163705243/")
    ).toEqual({
      url: "https://www.facebook.com/profile.php?id=100079163705243",
      key: "f:100079163705243",
    });
  });

  it("normalises /pages/<Name>/<id> classic permalinks", () => {
    expect(
      normalizeFacebookPageUrl("https://www.facebook.com/pages/Acme-Plumbing/123456789012345")
    ).toEqual({
      url: "https://www.facebook.com/profile.php?id=123456789012345",
      key: "f:123456789012345",
    });
  });

  it("keeps the group prefix for groups", () => {
    expect(normalizeFacebookPageUrl("https://www.facebook.com/groups/slcplumbers")).toEqual({
      url: "https://www.facebook.com/groups/slcplumbers",
      key: "f:group:slcplumbers",
    });
  });

  it("treats an all-digit vanity as a numeric page id", () => {
    expect(normalizeFacebookPageUrl("facebook.com/123456789012345")).toEqual({
      url: "https://www.facebook.com/profile.php?id=123456789012345",
      key: "f:123456789012345",
    });
  });

  it("ignores tracking params on vanity paths", () => {
    expect(
      normalizeFacebookPageUrl("https://www.facebook.com/Acme?mibextid=abc123&rdid=xyz")
    ).toEqual({
      url: "https://www.facebook.com/Acme",
      key: "f:acme",
    });
  });

  it("rejects non-Facebook URLs (the business website is not the page)", () => {
    expect(normalizeFacebookPageUrl("utahfloodguys.com")).toBeNull();
    expect(normalizeFacebookPageUrl("https://google.com/search?q=x")).toBeNull();
    expect(normalizeFacebookPageUrl("instagram.com/acme")).toBeNull();
  });

  it("rejects sharing and chrome paths", () => {
    expect(normalizeFacebookPageUrl("https://www.facebook.com/sharer.php")).toBeNull();
    expect(normalizeFacebookPageUrl("https://www.facebook.com/share/abc")).toBeNull();
    expect(normalizeFacebookPageUrl("https://www.facebook.com/watch?v=1")).toBeNull();
  });

  it("rejects empty, whitespace and junk input", () => {
    expect(normalizeFacebookPageUrl(null)).toBeNull();
    expect(normalizeFacebookPageUrl("")).toBeNull();
    expect(normalizeFacebookPageUrl("   ")).toBeNull();
    expect(normalizeFacebookPageUrl("not a url")).toBeNull();
  });

  it("trims wrapping punctuation the model sometimes adds", () => {
    expect(normalizeFacebookPageUrl('"facebook.com/Acme"')).toEqual({
      url: "https://www.facebook.com/Acme",
      key: "f:acme",
    });
  });
});

describe("buildMessengerUrl", () => {
  it("builds m.me links for vanity pages", () => {
    expect(buildMessengerUrl("facebook.com/UtahFloodGuys")).toBe("https://m.me/UtahFloodGuys");
  });

  it("builds m.me links for numeric page ids", () => {
    expect(buildMessengerUrl("facebook.com/profile.php?id=100079163705243")).toBe(
      "https://m.me/100079163705243"
    );
  });

  it("returns null for non-Facebook input", () => {
    expect(buildMessengerUrl("https://acme.com")).toBeNull();
    expect(buildMessengerUrl(null)).toBeNull();
  });
});

describe("buildBrowserFacebookUrl", () => {
  it("swaps www for the mobile web host", () => {
    expect(buildBrowserFacebookUrl("https://www.facebook.com/UtahFloodGuys")).toBe(
      "https://m.facebook.com/UtahFloodGuys"
    );
    expect(buildBrowserFacebookUrl("facebook.com/profile.php?id=100079163705243")).toBe(
      "https://m.facebook.com/profile.php?id=100079163705243"
    );
  });

  it("returns null for non-Facebook input", () => {
    expect(buildBrowserFacebookUrl("https://acme.com")).toBeNull();
  });
});
