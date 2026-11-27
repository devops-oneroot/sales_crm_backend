/**
 * Apollo.io people finder.
 *
 * search  → mixed_people/api_search: free, returns names (surname partly
 *           hidden), titles and Apollo ids for a company.
 * reveal  → people/match: costs 1 credit, returns the full name, LinkedIn link
 *           and work email. Every reveal is cached, so nobody is paid for twice.
 *
 * Env: APOLLO_API_KEY, optional APOLLO_TITLES (comma-separated job titles).
 */
const ApolloPerson = require("../models/ApolloPerson");

const BASE = "https://api.apollo.io/api/v1";
const SEARCH_TTL_DAYS = 30;
/** Only people who handle imports / buying — no general management or sales. */
const DEFAULT_TITLES = [
  "import manager",
  "import",
  "import export",
  "procurement",
  "purchasing",
  "purchase manager",
  "sourcing",
  "buyer",
  "raw material buyer",
  "spice buyer",
];
/**
 * Apollo's title search is fuzzy, so double-check each title: it must mention
 * importing or buying, and must not be an export / sales role.
 */
const IMPORT_ROLE = /\b(import|importing|importer|procure|procurement|purchas\w*|sourcing|buyer|buying)\b/i;
const NOT_IMPORT_ROLE = /\b(export(?!.*import)|sales|marketing|recruit\w*|hr|human resources)\b/i;
const isImportRole = (title) => IMPORT_ROLE.test(title || "") && !NOT_IMPORT_ROLE.test(title || "");

const apiKey = () => (process.env.APOLLO_API_KEY || "").trim();
const isConfigured = () => Boolean(apiKey());
const titles = () =>
  (process.env.APOLLO_TITLES || "").trim()
    ? process.env.APOLLO_TITLES.split(",").map((t) => t.trim()).filter(Boolean)
    : DEFAULT_TITLES;

async function apollo(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "X-Api-Key": apiKey(), "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok || data.error) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    const err = new Error(
      res.status === 429 || /credit|limit/i.test(msg) ? `Apollo: out of credits or rate limited (${msg})` : `Apollo: ${msg}`
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

/** "https://www.acme.co.uk/about" → "acme.co.uk" */
function domainOf(website) {
  const s = String(website || "").trim().toLowerCase();
  if (!s) return "";
  try {
    const host = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "");
    return host.includes(".") ? host : "";
  } catch {
    return "";
  }
}

const LEGAL_SUFFIX =
  /\b(co|company|corp|corporation|inc|incorporated|ltd|limited|llc|llp|plc|pvt|private|pte|gmbh|ag|sa|sas|srl|bv|nv|jsc|tnhh|cty|m\/s|the)\b\.?/gi;
/** "Minh Phat Products Import Export Co., Ltd." → "Minh Phat Products Import Export" */
function cleanCompanyName(name) {
  return String(name || "")
    .replace(/&/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+and\s*$/i, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const squash = (s) => cleanCompanyName(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** Apollo's name search is a loose keyword match; keep only the same company. */
function sameCompany(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "olamgroup" vs "olam" is fine; "alpha" vs "alphatechsolutions" is a different firm.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short) && short.length / long.length >= 0.6;
}

const shapeSearchPerson = (p) => ({
  apolloId: p.id,
  firstName: p.first_name || "",
  lastName: p.last_name_obfuscated || "",
  title: p.title || "",
  company: p.organization?.name || "",
  hasEmail: Boolean(p.has_email),
});

const shapeRevealed = (p) => ({
  apolloId: p.id,
  name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" "),
  title: p.title || "",
  company: p.organization?.name || "",
  linkedinUrl: (p.linkedin_url || "").replace(/^http:\/\//, "https://"),
  email: p.email && !/not_unlocked|email_not_unlocked/i.test(p.email) ? p.email : "",
  emailStatus: p.email_status || "",
  city: p.city || "",
  country: p.country || "",
});

/**
 * People at a company, by website domain (best) or company name.
 * Already-revealed people come back with their full details attached.
 */
async function findPeople({ website, company, page = 1, refresh = false }) {
  const domain = domainOf(website);
  const name = cleanCompanyName(company);
  if (!domain && !name) throw new Error("This lead has no website or company name to search with");

  const query = {
    ...(domain ? { q_organization_domains_list: [domain] } : { q_organization_name: name }),
    person_titles: titles(),
    page,
    per_page: 25,
  };
  const key = JSON.stringify(query);

  let cached = refresh ? null : await ApolloPerson.findOne({ kind: "search", key }).lean();
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() > SEARCH_TTL_DAYS * 86400000) cached = null;

  let result = cached?.data;
  if (!result) {
    const data = await apollo("/mixed_people/api_search", query);
    let people = (data.people || []).map(shapeSearchPerson);
    let total = data.total_entries || 0;
    const beforeRole = people.length;
    people = people.filter((p) => isImportRole(p.title));
    if (people.length < beforeRole && total <= 25) total = people.length;
    if (!domain) {
      const before = people.length;
      people = people.filter((p) => sameCompany(p.company, name));
      if (people.length < before) total = people.length; // Apollo's total counted other companies
    }
    result = { total, people };
    await ApolloPerson.updateOne({ kind: "search", key }, { $set: { data: result } }, { upsert: true });
  }

  const revealed = await ApolloPerson.find({
    kind: "person",
    key: { $in: result.people.map((p) => p.apolloId) },
  }).lean();
  const byId = new Map(revealed.map((r) => [r.key, r.data]));
  return {
    searchedBy: domain ? `website ${domain}` : `company name "${name}"`,
    total: result.total,
    page,
    cached: Boolean(cached),
    people: result.people.map((p) => ({ ...p, revealed: byId.get(p.apolloId) || null })),
  };
}

/** Full details for one person (1 Apollo credit the first time, free after). */
async function revealPerson(apolloId, userName) {
  const id = String(apolloId || "").trim();
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error("Invalid Apollo person id");
  const hit = await ApolloPerson.findOne({ kind: "person", key: id }).lean();
  if (hit) return { person: hit.data, charged: false };

  const qs = new URLSearchParams({ id, reveal_personal_emails: "false", reveal_phone_number: "false" });
  const data = await apollo(`/people/match?${qs}`);
  if (!data.person) throw new Error("Apollo couldn't find this person");
  const person = shapeRevealed(data.person);
  await ApolloPerson.updateOne(
    { kind: "person", key: id },
    { $set: { data: person, revealedBy: userName || "" } },
    { upsert: true }
  );
  return { person, charged: true };
}

module.exports = { isConfigured, findPeople, revealPerson, domainOf };
