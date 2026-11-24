/**
 * Extraction + buyer classification for Discovery.
 *
 * The LLM (Gemini or Claude, per LLM_PROVIDER) reads fetched text and may only COPY values out
 * of it. Everything it returns is re-checked against the text: values that are not
 * present verbatim are dropped, and the provenance gate re-checks again at save time.
 * Without a working key, rule-based parsing is used and the run log says so.
 */
const Anthropic = require("@anthropic-ai/sdk");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
const { z } = require("zod");
const { normalizeDomain } = require("../lib/importerProvenance");

// LLM_PROVIDER=gemini (default when GEMINI_API_KEY is set) or anthropic.
const PROVIDER = (process.env.LLM_PROVIDER?.trim().toLowerCase() ||
  (process.env.GEMINI_API_KEY?.trim() ? "gemini" : "anthropic"));
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview";
const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
const ANTHROPIC_MODEL = process.env.DISCOVERY_LLM_MODEL?.trim() || "claude-opus-5-5";
const MODEL = PROVIDER === "gemini" ? GEMINI_MODEL : ANTHROPIC_MODEL;
const GEMINI_TIMEOUT_MS = 120_000;
const MAX_LISTING_CHARS = 150_000;
const MAX_SITE_CHARS = 30_000;

/** Buyer types we keep, and types we reject. */
const BUYER_TYPES = ["importer", "distributor", "wholesaler", "processor_manufacturer"];
const NON_BUYER_TYPES = ["exporter_supplier", "retailer", "restaurant_foodservice", "service_provider", "other"];
const ALL_TYPES = [...BUYER_TYPES, ...NON_BUYER_TYPES];

const SOCIAL_OR_NOISE_HOSTS =
  /(facebook|twitter|x\.com|linkedin|instagram|youtube|tiktok|pinterest|google|apple\.com|microsoft|wa\.me|whatsapp|t\.me|cookiebot|gstatic|cloudflare|wordpress\.org|w3\.org|schema\.org|addthis|sharethis|mailchimp|hubspot|vimeo|flickr)\./i;

// ---------------------------------------------------------------- LLM plumbing

let client = null;
let llmDisabledReason = "";

function llmStatus() {
  const keyVar = PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyVar]?.trim()) return { available: false, reason: `${keyVar} not set`, provider: PROVIDER };
  if (llmDisabledReason) return { available: false, reason: llmDisabledReason, provider: PROVIDER };
  return { available: true, reason: "", provider: PROVIDER };
}

let geminiModel = GEMINI_MODEL;

/** Gemini generateContent with a JSON schema; returns parsed + zod-validated output or null. */
async function callGemini(system, userText, schema, maxTokens) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(schema),
      maxOutputTokens: maxTokens,
      temperature: 0,
    },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY.trim() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < 2) continue; // network hiccup / timeout → retry
      throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
      if (!text || cand?.finishReason === "SAFETY") return null;
      try {
        const parsed = schema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
      } catch {
        return null; // truncated / invalid JSON → treat as no result
      }
    }
    const msg = json.error?.message || `HTTP ${res.status}`;
    if (res.status === 404 && geminiModel !== GEMINI_FALLBACK_MODEL) {
      geminiModel = GEMINI_FALLBACK_MODEL; // model retired → use the stable lite model
      continue;
    }
    if (res.status === 429) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      llmDisabledReason = "Gemini quota / rate limit reached";
    } else if (res.status === 401 || res.status === 403) {
      llmDisabledReason = "Gemini key rejected";
    } else if (res.status === 400 && /api key|billing|permission/i.test(msg)) {
      llmDisabledReason = `Gemini: ${msg.slice(0, 120)}`;
    } else if (res.status >= 500 && attempt < 2) {
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${msg.slice(0, 200)}`);
  }
  return null;
}

/** Called at the start of each run so a topped-up account is retried. */
function resetLlmStatus() {
  llmDisabledReason = "";
}

function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim(), maxRetries: 2 });
  return client;
}

async function callStructured(system, userText, schema, maxTokens = 16000) {
  if (PROVIDER === "gemini") return callGemini(system, userText, schema, maxTokens);
  try {
    const res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: "low", format: zodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: userText }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return null;
    return res.parsed_output;
  } catch (err) {
    // Account-level failures disable the LLM for the rest of the run → rule-based.
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      llmDisabledReason = "Anthropic key rejected";
    } else if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
      llmDisabledReason = "Anthropic account has no API credit";
    } else if (err instanceof Anthropic.RateLimitError) {
      llmDisabledReason = "Anthropic rate limit reached";
    } else if (err instanceof Anthropic.NotFoundError) {
      llmDisabledReason = `Model ${MODEL} not available to this key`;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- grounding helpers

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const phoneNorm = (s) => String(s || "").replace(/[\s().\-\/]/g, "");

/** Keep a value only if it literally appears in the source text. */
function keepIfPresent(value, text, kind = "text") {
  const v = String(value || "").trim();
  if (!v) return "";
  if (kind === "phone") return phoneNorm(text).includes(phoneNorm(v)) ? v : "";
  if (kind === "domain") return norm(text).includes(normalizeDomain(v)) ? v : "";
  return norm(text).includes(norm(v)) ? v : "";
}

function snippetAround(text, needle, radius = 900) {
  const i = norm(text).indexOf(norm(needle));
  if (!needle || i < 0) return "";
  // norm() collapses whitespace, so map back approximately via a regex search
  const re = new RegExp(String(needle).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i");
  const m = re.exec(text);
  const at = m ? m.index : 0;
  return text.slice(Math.max(0, at - radius), at + String(needle).length + radius);
}

// ---------------------------------------------------------------- listing extraction

const ListingSchema = z.object({
  companies: z.array(
    z.object({
      companyName: z.string(),
      contactPerson: z.string(),
      email: z.string(),
      phone: z.string(),
      website: z.string(),
      country: z.string(),
      city: z.string(),
      address: z.string(),
    })
  ),
});

const LISTING_SYSTEM = `You extract company entries from the text of a web page (a trade-fair exhibitor list, an association member directory, or a buy-lead board).

Rules:
- Copy values exactly as they appear in the text. Never infer, complete, translate, or guess a value.
- If a field is not present in the text for that company, return an empty string for it.
- companyName must be the company's own name as written. If an entry shows only a person or a generic label such as "Buyer from United Kingdom", set companyName to "".
- Include every distinct company entry on the page. Ignore navigation, menus, filters, sponsors and the site owner itself.
- Return {"companies": []} if the page lists no companies.`;

async function extractListingWithLlm(text, pageUrl) {
  const body = text.length > MAX_LISTING_CHARS ? text.slice(0, MAX_LISTING_CHARS) : text;
  // 16k output tokens covers ~150 entries and stays under the SDK's non-streaming limit.
  const out = await callStructured(LISTING_SYSTEM, `Page URL: ${pageUrl}\n\nPage text:\n${body}`, ListingSchema, 16000);
  if (!out) return [];
  // Drop anything the model returned that is not in the text.
  return out.companies.map((c) => ({
    companyName: keepIfPresent(c.companyName, body),
    contactPerson: keepIfPresent(c.contactPerson, body),
    email: keepIfPresent(c.email, body),
    phone: keepIfPresent(c.phone, body, "phone"),
    website: keepIfPresent(c.website, body, "domain"),
    country: keepIfPresent(c.country, body),
    city: keepIfPresent(c.city, body),
    address: keepIfPresent(c.address, body),
  }));
}

/**
 * Rule-based fallback: every outbound link to another company's website is a candidate.
 * The name is read later from that website (title / og:site_name).
 */
function extractListingByRules(page) {
  const ownDomain = normalizeDomain(page.finalUrl);
  const seen = new Set();
  const out = [];
  for (const link of page.links) {
    const domain = normalizeDomain(link.href);
    if (!domain || domain === ownDomain || domain.endsWith("." + ownDomain) || ownDomain.endsWith("." + domain)) continue;
    if (SOCIAL_OR_NOISE_HOSTS.test(domain + ".") || seen.has(domain)) continue;
    seen.add(domain);
    const linkText = /^(https?:\/\/|www\.)/i.test(link.text) ? "" : link.text;
    out.push({
      companyName: linkText.length >= 3 && linkText.length <= 80 ? linkText : "",
      contactPerson: "",
      email: "",
      phone: "",
      website: link.href,
      country: "",
      city: "",
      address: "",
    });
  }
  return out;
}

/**
 * → { method: "llm"|"rules"|"skipped", companies, note }
 * Buy-lead boards are free text with no company links; link rules only pick up ads
 * there, so without an LLM those sources are skipped rather than mined for noise.
 */
async function extractCompaniesFromListing(page, kind = "") {
  const status = llmStatus();
  let reason = status.reason;
  if (status.available) {
    try {
      const companies = await extractListingWithLlm(page.text, page.finalUrl);
      if (kind === "buy_leads") return { method: "llm", companies, note: "" };
      // Directory pages: add company websites the AI missed (links are fetched data too).
      const known = new Set(companies.map((c) => normalizeDomain(c.website)).filter(Boolean));
      const extra = extractListingByRules(page).filter((c) => !known.has(normalizeDomain(c.website)));
      return { method: extra.length && !companies.length ? "rules" : "llm", companies: [...companies, ...extra], note: "" };
    } catch (err) {
      reason = `AI extraction failed: ${llmDisabledReason || err.message}`;
    }
  }
  if (kind === "buy_leads") {
    return { method: "skipped", companies: [], note: `Buy-lead boards need the AI extractor (${reason})` };
  }
  return { method: "rules", companies: extractListingByRules(page), note: `Rule-based extraction (${reason})` };
}

// ---------------------------------------------------------------- contacts from a company site

function extractSiteContacts(siteText, websiteDomain) {
  const emails = Array.from(new Set(siteText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []))
    .map((e) => e.replace(/\.$/, ""))
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e) && !/(example|sentry|wixpress|domain)\./i.test(e));
  const score = (e) => {
    let s = 0;
    if (websiteDomain && e.toLowerCase().endsWith("@" + websiteDomain)) s += 10;
    // Purchasing desk first (a supplier wants the buyer), then general trade/sales/info.
    if (/^(purchas|procure|buy|import|sourcing|einkauf|inkop|inköp|achat|compras|acquisti|inkoop)/i.test(e)) s += 5;
    else if (/^(trade|sales|export|info|contact|office|mail|hello|enquir|inquir)/i.test(e)) s += 3;
    // Addresses that never reach a buyer: system, legal, HR/recruitment, press, investors.
    const local = e.split("@")[0];
    if (/^(noreply|no-reply|donotreply|privacy|gdpr|dpo|dataprotection|webmaster|postmaster|abuse|jobs|careers?|hr|press|media|investors?|ir)\b/i.test(local) ||
        /recruit|career|vacanc|jobs|privacy|unsubscribe/i.test(local)) {
      s -= 20;
    }
    return s;
  };
  emails.sort((a, b) => score(b) - score(a));

  const NUM = String.raw`(\+?\(?\d[\d\s().-]{6,20}\d)`;
  const validDigits = (p) => {
    const n = p.replace(/\D/g, "").length;
    return n >= 8 && n <= 15;
  };
  // 1) Labelled: "Tel:", "Phone:", "T:", "Call (us)", "Fon:", "Teléfono:", "Mobile:", tel:/structured-data lines.
  const labelled = new RegExp(
    String.raw`(?:\b(?:tel(?:ephone)?|phone(?: links)?|page data phone|ph|fon|t[ée]l[ée]phone|tel[ée]fono|mob(?:ile)?|cell|whatsapp|call(?: us)?(?: on| at)?)\b|\bt\s*:)\.?\s*[:.]?\s*` + NUM,
    "gi"
  );
  // 2) Unlabelled but in international format (+44 …, 0044 …) — can't be a date or order no.
  const international = /(?:^|[\s(,;:|])((?:\+|00)\d{1,3}[\s().-]*\(?\d[\d\s().-]{5,18}\d)/g;
  let phone = "";
  for (const m of siteText.matchAll(labelled)) {
    if (validDigits(m[1])) {
      phone = m[1].trim();
      break;
    }
  }
  if (!phone) {
    for (const m of siteText.matchAll(international)) {
      if (validDigits(m[1])) {
        phone = m[1].trim();
        break;
      }
    }
  }
  const digits = phone.replace(/\D/g, "").length;

  return {
    email: emails.length && score(emails[0]) >= 0 ? emails[0] : "",
    phone: digits >= 8 && digits <= 15 ? phone : "",
  };
}

// ---------------------------------------------------------------- buyer classification

const ClassifySchema = z.object({
  buyer_type: z.enum(ALL_TYPES),
  evidence: z.string(),
  country: z.string(),
});

const CLASSIFY_SYSTEM = `You classify a company from the text of its own website (and, if given, the directory entry it was found in), for a supplier of turmeric and spices looking for international buyers.

buyer_type:
- importer: imports food ingredients / spices / herbs into its country
- distributor: distributes ingredients or spices to other businesses
- wholesaler: bulk trading of spices or food commodities
- processor_manufacturer: grinds, blends, extracts or manufactures food, seasonings, nutraceuticals or cosmetics using spices/turmeric as an input
- exporter_supplier: primarily sells or exports spices from a producing country (a competitor, not a buyer)
- retailer: shop or online store selling to consumers
- restaurant_foodservice: restaurant, café, caterer
- service_provider: logistics, testing lab, consultancy, software, trade body
- other: anything else or not enough information

evidence: one sentence copied word-for-word from the text that supports the type. Empty string if none.
country: the country of the company's address exactly as written in the text, or "" if not stated.
Use only the text provided.`;

const KEYWORDS = {
  importer: /\b(importer|importers|import(?:ing)? of|we import|direct import)\b/i,
  distributor: /\b(distributor|distributors|distribution of)\b/i,
  wholesaler: /\b(wholesale|wholesaler|bulk supply|bulk spices|trading company|traders?)\b/i,
  processor_manufacturer: /\b(manufacturer|manufacturing|processing|processor|blending|grinding|milling|extraction|ingredients? (?:supplier|solutions)|seasonings? manufacturer)\b/i,
  retailer: /\b(add to cart|add to basket|shop now|checkout|free delivery on orders)\b/i,
  restaurant_foodservice: /\b(our menu|book a table|reservations?|restaurant)\b/i,
};

function classifyByRules(siteText) {
  const hits = {};
  for (const [type, re] of Object.entries(KEYWORDS)) {
    const m = siteText.match(re);
    if (m) hits[type] = m[0];
  }
  // Consumer shop / restaurant signals win only if no trade signal exists.
  const trade = BUYER_TYPES.find((t) => hits[t]);
  const type = trade || (hits.retailer ? "retailer" : hits.restaurant_foodservice ? "restaurant_foodservice" : "other");
  const word = hits[type];
  return { buyer_type: type, evidence: word ? snippetAround(siteText, word, 120).replace(/\s+/g, " ").trim() : "", country: "" };
}

/** → { buyer_type, is_buyer, evidence, country, method } */
async function classifyBuyer({ companyName, siteText, listingSnippet = "" }) {
  const status = llmStatus();
  const text = siteText.slice(0, MAX_SITE_CHARS);
  if (status.available) {
    try {
      const out = await callStructured(
        CLASSIFY_SYSTEM,
        `Company: ${companyName || "(unknown)"}\n\nDirectory entry:\n${listingSnippet || "(none)"}\n\nWebsite text:\n${text}`,
        ClassifySchema,
        2000
      );
      if (out) {
        const combined = `${listingSnippet}\n${text}`;
        // Evidence must be a real quote; otherwise we don't trust the label.
        const evidence = keepIfPresent(out.evidence, combined);
        const type = evidence ? out.buyer_type : "other";
        return {
          buyer_type: type,
          is_buyer: BUYER_TYPES.includes(type),
          evidence,
          country: keepIfPresent(out.country, combined),
          method: "llm",
        };
      }
    } catch {
      /* fall through to rules */
    }
  }
  const r = classifyByRules(`${listingSnippet}\n${text}`);
  return { ...r, is_buyer: BUYER_TYPES.includes(r.buyer_type), method: "rules" };
}

/** Company name from the company's own site when the directory didn't give one. */
function nameFromSite(page) {
  const candidates = [page.siteName, (page.title || "").split(/\s+[|–—-]\s+/)[0]].map((s) => (s || "").trim());
  return candidates.find((c) => c.length >= 3 && c.length <= 80 && !/^(home|welcome|index)$/i.test(c)) || "";
}

module.exports = {
  BUYER_TYPES,
  NON_BUYER_TYPES,
  MODEL,
  llmStatus,
  resetLlmStatus,
  extractCompaniesFromListing,
  extractListingByRules,
  extractSiteContacts,
  classifyBuyer,
  classifyByRules,
  nameFromSite,
  keepIfPresent,
  snippetAround,
};
