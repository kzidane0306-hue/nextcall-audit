/**
 * Probe: what does the personalized Facebook opener look like for ONE real
 * business? Mirrors src/services/facebookOutreachService.ts (same prompts,
 * same validation, same fallback) but calls the locally configured
 * OpenAI-compatible providers directly (Groq first, then NVIDIA), since the
 * production router chain is not configured in this local env.
 *
 * Usage: node --env-file=.env scripts/probe-facebook-message.mjs
 */

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

const business = {
  name: "24/7 Mobile Locksmith - Tampa",
  categories: ["Locksmith"],
  location: { city: "Tampa", state: "FL" },
  rating: 4.7,
  reviewCount: 776,
  website: "https://247mobilelocksmith.com",
  booking: { detected: true },
  notes: "Hours (from Facebook): Open · Closes 12 AM",
};

function buildUserPrompt(b) {
  const category = b.categories?.filter(Boolean).join(", ") || "local service";
  const city = b.location?.city?.trim();
  const rating = b.rating != null ? `${b.rating}/5 across ${b.reviewCount} reviews` : null;
  const lines = [
    "BUSINESS FACTS (public and verified — use ONLY these):",
    `- Name (use exactly): ${b.name}`,
    `- Category: ${category}`,
    city ? `- City: ${city}, ${b.location.state}` : "- City: not known — do not mention one",
    rating ? `- Rating: ${rating}` : "- Rating: not known — do not mention one",
    b.website ? `- Website: ${b.website}` : "- Website: none found — do not mention one",
    b.booking
      ? `- Online booking on their listing: ${b.booking.detected ? "yes" : "not detected"} (do NOT call attention to either way — never claim they lack anything)`
      : null,
    b.notes?.trim() ? `- Listing notes (services / hours): """${b.notes.trim().slice(0, 400)}"""` : "- Listing notes: none",
    "",
    "TASK: write the message following the 3-paragraph shape exactly, 60-90 words, with the strongest positive fact as the hook.",
  ];
  return lines.filter(Boolean).join("\n");
}

const BANNED_MESSAGE_PATTERNS = [
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

function validateColdMessage(message, b) {
  const text = message.trim();
  if (!/^hey\b/i.test(text)) return "must open with a Hey greeting";
  if (!/\baudit\b/i.test(text)) return "must offer the audit";
  if (!text.toLowerCase().includes(b.name.toLowerCase())) return "must address the business by name";

  const escapedName = b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prose = text
    .split(escapedName)
    .join(" ")
    .replace(new RegExp(b.name.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi"), " ");
  for (const pattern of BANNED_MESSAGE_PATTERNS) {
    if (pattern.test(prose)) return `contains banned phrasing (${pattern})`;
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 110) return `too long (${words} words)`;
  return null;
}

function tidyMessage(raw) {
  let text = (raw ?? "").trim();
  if (/^"[\s\S]*"$/.test(text)) text = text.slice(1, -1).trim();
  text = text.replace(/\\n/g, "\n").replace(/\r/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function callOpenAICompatible(label, baseUrl, access, model, system, user) {
  const started = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 600,
      temperature: 0.6,
      stream: false,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("")
      : "";
  console.log(`[${label}] ${model} answered in ${Date.now() - started}ms.`);
  return text;
}

function fallbackFacebookMessage(b) {
  const name = b.name;
  const city = b.location?.city?.trim();
  const hook = b.rating != null
    ? ` Your ${b.rating}${b.reviewCount ? `★ rating across ${b.reviewCount} reviews` : "★ rating"} stood out.`
    : "";
  return [
    `Hey ${name}! 👋`,
    "",
    `I came across your business while researching local companies${city ? ` in ${city}` : ""}.${hook} I noticed a few small things on your online presence that might be worth a quick look.`,
    "",
    `I put together a quick audit for ${name} — it walks through what is already working and a couple of places where small changes could bring in more calls. Would you be open to seeing it?`,
  ].join("\n");
}

const endpoint = process.env.ASTRA_DB_API_ENDPOINT; // touch check that .env loaded
if (!endpoint) {
  console.error("Missing .env — run with: node --env-file=.env scripts/probe-facebook-message.mjs");
  process.exit(1);
}

const providers = [];
if (process.env.GROK_BASE_URL && process.env.GROK_ACCESS && process.env.GROK_MODEL) {
  providers.push(["groq", process.env.GROK_BASE_URL, process.env.GROK_ACCESS, process.env.GROK_MODEL]);
}
if (process.env.NVIDIA_BASE_URL && process.env.NVIDIA_ACCESS && process.env.NVIDIA_MODEL) {
  providers.push(["nvidia", process.env.NVIDIA_BASE_URL, process.env.NVIDIA_ACCESS, process.env.NVIDIA_MODEL]);
}

const userPrompt = buildUserPrompt(business);
let finalMessage = null;
let note = "";

for (const [label, baseUrl, access, model] of providers) {
  try {
    const raw = await callOpenAICompatible(label, baseUrl, access, model, SYSTEM_PROMPT, userPrompt);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { message: raw };
    }
    const candidate = tidyMessage(parsed.message ?? "");
    const problem = validateColdMessage(candidate, business);
    if (problem) {
      note = `${label} draft rejected: ${problem}`;
      console.warn(`[probe] ${note}`);
      continue;
    }
    finalMessage = candidate;
    note = `generated by ${label} (${model})`;
    break;
  } catch (error) {
    note = `${label} failed: ${error?.message || error}`;
    console.warn(`[probe] ${note}`);
  }
}

if (!finalMessage) {
  finalMessage = fallbackFacebookMessage(business);
  note = "deterministic fallback template";
}

console.log("\n===== FINAL MESSAGE (the exact text the operator would copy) =====\n");
console.log(finalMessage);
console.log("\n===== source =====");
console.log(note);
