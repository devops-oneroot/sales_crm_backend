/**
 * "Smart" duplicate matching for leads.
 *
 * Two leads are possible duplicates when they share any of:
 *  - company name, after normalising away case, accents, punctuation, legal
 *    forms ("M/S", "Ltd", "Sdn Bhd", "Pvt", "GmbH", "Công ty TNHH"...) and
 *    plural "s" — so "M/S. Manzila Traders" = "M/S Manzila Trader"
 *  - email address
 *  - website domain
 *  - phone number (last 10 digits)
 *
 * Matching only FLAGS pairs. Nothing is merged or deleted automatically.
 */

// Legal forms / honorifics that don't identify a company. Matched as whole tokens.
const NOISE_TOKENS = new Set([
  "messrs",
  "pt", "cv", "tbk",
  "ltd", "limited", "pvt", "private", "plc", "llc", "llp", "lp",
  "inc", "incorporated", "corp", "corporation", "co", "company", "cos",
  "sdn", "bhd", "berhad",
  "gmbh", "ag", "kg", "bv", "nv", "sa", "sarl", "srl", "spa", "ab", "as", "oy",
  "jsc", "jsco", "joint", "stock", "tnhh", "cong", "ty", "ctcp", "mtv",
  "the",
]);

// "M/S", "M/S.", "M S", "Ms." at the start of a name (Indian/Bangladeshi "Messrs")
const MS_PREFIX = /^\s*m\s*[/.\s]?\s*s\b\.?/;
// "A & S" = "A&S" = "A and S"
const AMPERSAND = /\s*(?:&|\band\b)\s*/g;
const COMBINING_MARKS = /[̀-ͯ]/g;

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Normalised company key, or "" when shorter than minLength (too short to be
 * meaningful for automatic duplicate flagging).
 */
function smartCompanyKey(value, minLength = 4, { plurals = true } = {}) {
  const tokens = stripAccents(value)
    .toLowerCase()
    .replace(MS_PREFIX, " ")
    .replace(AMPERSAND, "and")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !NOISE_TOKENS.has(t))
    // "foods" = "food", "traders" = "trader"
    .map((t) =>
      plurals && t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t
    );
  const key = tokens.join("");
  return key.length >= minLength ? key : "";
}

function phoneKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 8) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function emailKey(value) {
  const e = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}

// Free-mail domains are shared by unrelated companies — never match on them.
const SHARED_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "aol.com", "mail.ru", "yandex.ru", "qq.com", "163.com", "126.com", "rediffmail.com",
  "protonmail.com", "gmx.de", "web.de", "yahoo.co.in", "ymail.com",
]);

function domainKey(website) {
  let host = String(website || "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  if (!host.includes(".") || SHARED_DOMAINS.has(host)) return "";
  return host;
}

/** All match keys for one lead, grouped by kind. */
function leadMatchKeys(lead) {
  const phones = [
    lead.phone,
    lead.whatsappNumber,
    ...(lead.whatsappNumbers || []),
    ...(lead.contacts || []).flatMap((c) => [c?.phone, ...(c?.phones || [])]),
  ];
  const emails = [lead.email, ...(lead.emails || []), ...(lead.contacts || []).map((c) => c?.email)];
  return {
    name: [...new Set([smartCompanyKey(lead.company), smartCompanyKey(lead.name)].filter(Boolean))],
    phone: [...new Set(phones.map(phoneKey).filter(Boolean))],
    email: [...new Set(emails.map(emailKey).filter(Boolean))],
    website: [domainKey(lead.website)].filter(Boolean),
  };
}

const REASON_LABEL = {
  name: "Similar company name",
  phone: "Same phone number",
  email: "Same email",
  website: "Same website",
};

/** Export and domestic are separate books — only compare within one type. */
function leadBook(lead) {
  return lead.leadType === "export" ? "export" : "domestic";
}

module.exports = {
  smartCompanyKey,
  phoneKey,
  emailKey,
  domainKey,
  leadMatchKeys,
  leadBook,
  REASON_LABEL,
};
