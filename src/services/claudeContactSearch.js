/**
 * LLM web search (Gemini + Google Search, or Claude) for a company's published contact details.
 *
 * Used only when the company's own website gave no email. Claude searches the web
 * (web_search + web_fetch server tools) and must cite the page each value is on.
 * Claude's answer is NOT trusted: the CRM fetches every cited page itself and keeps an
 * email/phone only if it literally appears on that page. Everything else is dropped.
 *
 * Enabled when ANTHROPIC_API_KEY is set (CONTACT_SEARCH_LLM=off disables it).
 */
const Anthropic = require("@anthropic-ai/sdk");
const { fetchPage } = require("../lib/webFetch");
const { normalizeDomain, isPlaceholderEmail } = require("../lib/importerProvenance");
const { extractSiteContacts } = require("./buyerExtractor");

const MAX_CONTINUATIONS = 3;
const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";

/**
 * Which LLM searches the web: CONTACT_SEARCH_PROVIDER=gemini|claude.
 * Default: gemini when LLM_PROVIDER=gemini (or only a Gemini key is set), else claude.
 */
function provider() {
  const p = (process.env.CONTACT_SEARCH_PROVIDER || "").trim().toLowerCase();
  if (p === "gemini" || p === "claude") return p;
  if ((process.env.LLM_PROVIDER || "").trim().toLowerCase() === "gemini") return "gemini";
  if (process.env.GEMINI_API_KEY?.trim() && !process.env.ANTHROPIC_API_KEY?.trim()) return "gemini";
  return "claude";
}
const modelFor = (p) =>
  p === "gemini"
    ? process.env.GEMINI_SEARCH_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview"
    : process.env.CONTACT_SEARCH_MODEL?.trim() || "claude-opus-5-5";
const LABEL = { gemini: "Gemini web search", claude: "Claude web search" };

let client = null;
let disabledReason = "";
let geminiModelOverride = "";

function claudeSearchStatus() {
  const p = provider();
  if ((process.env.CONTACT_SEARCH_LLM || "").trim().toLowerCase() === "off") return { available: false, reason: "CONTACT_SEARCH_LLM=off", provider: p };
  const keyVar = p === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyVar]?.trim()) return { available: false, reason: `${keyVar} not set`, provider: p };
  if (disabledReason) return { available: false, reason: disabledReason, provider: p };
  return { available: true, reason: "", provider: p, model: geminiModelOverride || modelFor(p), label: LABEL[p] };
}

/** Called at the start of each batch so a topped-up account is retried. */
function resetClaudeSearch() {
  disabledReason = "";
}

function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim(), maxRetries: 2 });
  return client;
}

const SYSTEM = `You find a company's publicly published business contact details on the web.

Rules:
- Use web search / web fetch. Prefer the company's own website (contact, imprint/impressum, about pages), then official trade directories or association listings.
- Report ONLY an email address or phone number you actually saw on a specific web page, copied exactly as written, together with that page's full URL.
- Never guess or construct an address (no "info@" + domain unless that exact address is on the page). If you didn't find one, return an empty list.
- Make sure the page is about the same company (name and country match).
- Skip personal social-media profiles, recruitment/HR, press, and privacy addresses.

Finish with ONLY this JSON (no other text):
{"website":"","contacts":[{"email":"","phone":"","source_url":"","company_name_on_page":""}]}
"website" = the company's own official website URL if you found it, else "".`;

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function askClaude({ companyName, country, website }) {
  const userText = [
    `Company: ${companyName}`,
    country ? `Country: ${country}` : "",
    website ? `Known website: ${website} (its pages did not show an email — check other pages or reliable listings)` : "Website: unknown",
    "Find this company's published business email address and phone number.",
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [{ role: "user", content: userText }];
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 4 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
  ];

  let res;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    res = await getClient().beta.messages.create({
      model: modelFor("claude"),
      max_tokens: 4000,
      system: SYSTEM,
      messages,
      tools,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason !== "pause_turn") break;
    // Server-side tool loop paused: send the turn back and let it resume.
    messages.splice(1, messages.length - 1, { role: "assistant", content: res.content });
  }
  if (!res || res.stop_reason === "refusal") return { contacts: [], usage: res?.usage };
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const parsed = parseJson(text);
  return { contacts: Array.isArray(parsed?.contacts) ? parsed.contacts : [], website: typeof parsed?.website === "string" ? parsed.website.trim() : "", usage: res.usage };
}

function userPrompt({ companyName, country, website }) {
  return [
    `Company: ${companyName}`,
    country ? `Country: ${country}` : "",
    website ? `Known website: ${website} (its pages did not show an email — check other pages or reliable listings)` : "Website: unknown",
    "Find this company's published business email address and phone number.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Gemini with Google Search grounding + URL reading. Throws with .status on API errors. */
async function askGemini(args) {
  let model = geminiModelOverride || modelFor("gemini");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY.trim() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userPrompt(args) }] }],
        tools: [{ google_search: {} }, { url_context: {} }],
        generationConfig: { temperature: 0, maxOutputTokens: 4000 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const cand = json.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
      const parsed = parseJson(text);
      const gm = cand?.groundingMetadata || {};
      // Pages Google actually returned — used as extra candidate sources.
      const groundingUrls = (gm.groundingChunks || []).map((g) => g.web?.uri).filter(Boolean);
      return {
        contacts: Array.isArray(parsed?.contacts) ? parsed.contacts : [],
        website: typeof parsed?.website === "string" ? parsed.website.trim() : "",
        groundingUrls,
        usage: {
          provider: "gemini",
          model,
          input_tokens: json.usageMetadata?.promptTokenCount || 0,
          output_tokens: (json.usageMetadata?.candidatesTokenCount || 0) + (json.usageMetadata?.thoughtsTokenCount || 0),
          search_queries: (gm.webSearchQueries || []).length,
        },
      };
    }
    const msg = json.error?.message || `HTTP ${res.status}`;
    if (res.status === 404 && model !== GEMINI_FALLBACK_MODEL) {
      model = geminiModelOverride = GEMINI_FALLBACK_MODEL;
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  throw new Error("Gemini request failed after retries");
}

/** Google grounding links are redirects (vertexaisearch…); resolve to the real page. */
async function resolveRedirect(url) {
  if (!/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/i.test(url)) return url;
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return r.headers.get("location") || url;
  } catch {
    return url;
  }
}

/** Distinctive words of a company name (legal suffixes and filler removed). */
function companyTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(
      (t) =>
        t.length > 2 &&
        !/^(ltd|llc|inc|gmbh|bv|co|the|and|sa|spa|srl|pvt|limited|company|trading|group|corp|corporation|international|general|foodstuff|foods|food|fze|fzco|llp|plc|sdn|bhd|pte|est|establishment)$/.test(t)
    );
}

const phoneDigits = (s) => String(s || "").replace(/\D/g, "");
const phoneNorm = (s) => String(s || "").replace(/[\s().\-\/]/g, "");

/**
 * → { ok, email, phone, emailUrl, phoneUrl, evidence[], checked: [{value, url, verified, why}], note }
 * Only values found verbatim on the cited page (fetched by us) are returned.
 */
async function searchContactsWithClaude({ companyName, country = "", website = "" }) {
  const status = claudeSearchStatus();
  if (!status.available) return { ok: false, email: "", phone: "", evidence: [], checked: [], note: status.reason };
  if (!companyName) return { ok: false, email: "", phone: "", evidence: [], checked: [], note: "No company name" };

  const p = status.provider;
  const label = LABEL[p];
  let answer;
  try {
    answer = p === "gemini" ? await askGemini({ companyName, country, website }) : await askClaude({ companyName, country, website });
  } catch (err) {
    if (p === "gemini") {
      if (err.status === 429) {
        disabledReason = /per ?day|perday|quota/i.test(err.message)
          ? "Gemini quota exceeded — the free tier has a small daily limit and no Google Search; enable billing on the Google project"
          : "Gemini rate limit reached";
      } else if (err.status === 401 || err.status === 403) disabledReason = "Gemini key rejected or Google Search not allowed for this key";
      else if (err.status === 400 && /api key|billing|permission/i.test(err.message)) disabledReason = `Gemini: ${err.message.slice(0, 120)}`;
    } else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) disabledReason = "Anthropic key rejected";
    else if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) disabledReason = "Anthropic account has no API credit";
    else if (err instanceof Anthropic.RateLimitError) disabledReason = "Anthropic rate limit reached";
    return { ok: false, email: "", phone: "", evidence: [], checked: [], note: `${label} failed: ${disabledReason || err.message}` };
  }
  // Resolve Google grounding redirects to the real page URLs before checking them.
  for (const c of answer.contacts) if (c && c.source_url) c.source_url = await resolveRedirect(String(c.source_url));

  const domain = normalizeDomain(website);
  const checked = [];
  const verifiedEmails = [];
  const verifiedPhones = [];
  const pageCache = new Map();
  const getPage = async (url) => {
    if (!pageCache.has(url)) pageCache.set(url, await fetchPage(url));
    return pageCache.get(url);
  };

  for (const c of answer.contacts.slice(0, 6)) {
    const url = String(c.source_url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      if (c.email || c.phone) checked.push({ value: c.email || c.phone, url, verified: false, why: "no source page given" });
      continue;
    }
    const page = await getPage(url);
    if (!page.ok) {
      checked.push({ value: c.email || c.phone, url, verified: false, why: `source page not reachable (${page.error})` });
      continue;
    }
    const lower = page.text.toLowerCase();
    // The page must be about this company.
    const nameTokens = companyTokens(companyName);
    const pageDomain = normalizeDomain(page.finalUrl);
    const aboutCompany = (domain && (pageDomain === domain || pageDomain.endsWith("." + domain))) || nameTokens.some((t) => lower.includes(t));
    if (!aboutCompany) {
      checked.push({ value: c.email || c.phone, url, verified: false, why: "cited page doesn't mention the company" });
      continue;
    }
    const email = String(c.email || "").trim().toLowerCase();
    if (email) {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && !isPlaceholderEmail(email) && lower.includes(email);
      checked.push({ value: email, url: page.finalUrl, verified: ok, why: ok ? "found on page" : "not on the cited page" });
      if (ok) verifiedEmails.push({ email, url: page.finalUrl, text: page.text });
    }
    const phone = String(c.phone || "").trim();
    if (phone) {
      const ok = phoneDigits(phone).length >= 7 && phoneNorm(page.text).includes(phoneNorm(phone));
      checked.push({ value: phone, url: page.finalUrl, verified: ok, why: ok ? "found on page" : "not on the cited page" });
      if (ok) verifiedPhones.push({ phone, url: page.finalUrl, text: page.text });
    }
  }

  // Rank verified emails the same way as website emails (purchasing > info; never HR/noreply).
  const best = extractSiteContacts(verifiedEmails.map((e) => e.email).join("\n"), domain).email;
  const pickedEmail = verifiedEmails.find((e) => e.email === best) || null;
  const pickedPhone = verifiedPhones[0] || null;

  const excerpt = (text, value) => {
    const i = text.toLowerCase().indexOf(String(value).toLowerCase());
    return i < 0 ? "" : text.slice(Math.max(0, i - 160), i + String(value).length + 160).replace(/\s+/g, " ");
  };
  const evidence = [];
  if (pickedEmail) evidence.push(`[${label} → verified on ${pickedEmail.url}] ${excerpt(pickedEmail.text, pickedEmail.email)}`);
  if (pickedPhone) evidence.push(`[${label} → verified on ${pickedPhone.url}] ${excerpt(pickedPhone.text, pickedPhone.phone)}`);

  // Website: keep only if it loads and mentions the company (or a verified email uses its domain).
  let verifiedWebsite = "";
  const claimed = /^https?:\/\//i.test(answer.website || "") ? answer.website : answer.website ? `https://${answer.website}` : "";
  if (claimed) {
    const site = await getPage(claimed);
    const siteDomain = site.ok ? normalizeDomain(site.finalUrl) : "";
    const nameHit = site.ok && companyTokens(companyName).some((t) => site.text.toLowerCase().includes(t));
    const emailDomainHit = siteDomain && verifiedEmails.some((e) => e.email.endsWith("@" + siteDomain) || e.email.endsWith("." + siteDomain));
    if (site.ok && (nameHit || emailDomainHit)) verifiedWebsite = site.finalUrl;
  }

  const rejected = checked.filter((c) => !c.verified).length;
  return {
    ok: true,
    website: verifiedWebsite,
    email: pickedEmail?.email || "",
    phone: pickedPhone?.phone || "",
    emailUrl: pickedEmail?.url || "",
    phoneUrl: pickedPhone?.url || "",
    evidence,
    checked,
    note:
      pickedEmail || pickedPhone
        ? `${label}: verified on ${pickedEmail?.url || pickedPhone?.url}${rejected ? ` (${rejected} unverified value(s) dropped)` : ""}`
        : `${label}: nothing verifiable${rejected ? ` (${rejected} value(s) not found on the cited pages, dropped)` : ""}`,
    usage: answer.usage,
  };
}

/** Tests only: replace the Anthropic client with a stub. */
function _setClientForTests(stub) {
  client = stub;
}

module.exports = { searchContactsWithClaude, claudeSearchStatus, resetClaudeSearch, _setClientForTests };
