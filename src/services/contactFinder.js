/**
 * Find a company's published email / phone on its own website.
 *
 * Reads the homepage plus up to MAX_EXTRA_PAGES same-site pages that look like contact,
 * about or imprint pages. Values are copied from the fetched text (including mailto:/tel:
 * links and "info [at] x [dot] com" style addresses). Nothing is guessed: if the site
 * doesn't publish an address, the result is empty. The page each value came from is
 * returned so it can be stored and shown.
 */
const { fetchPage } = require("../lib/webFetch");
const { normalizeDomain } = require("../lib/importerProvenance");
const { extractSiteContacts } = require("./buyerExtractor");
const { searchContactsWithClaude, claudeSearchStatus } = require("./claudeContactSearch");

const MAX_EXTRA_PAGES = 3;
const CONTACT_LINK_RE =
  /contact|kontakt|contacto|contato|contatti|contactez|impressum|imprint|enquir|inquir|get-in-touch|reach-us|find-us|locations?\b|offices?\b|customer-service|about|ueber-uns|uber-uns|qui-sommes|chi-siamo|sobre/i;

function rankLink(link) {
  const s = `${link.href} ${link.text}`.toLowerCase();
  if (/contact|kontakt|contacto|contato|contatti|contactez|get-in-touch|reach-us|find-us|enquir|inquir/.test(s)) return 0;
  if (/impressum|imprint/.test(s)) return 1; // German/EU legal notice: always lists email + phone
  return 2; // about pages
}

/** → { ok, error, home, text, email, phone, emailUrl, phoneUrl, pages } */
async function findContactsOnWebsite(website) {
  const start = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  let home = await fetchPage(start);
  // Bare "company.com" sometimes only answers on www.
  if (!home.ok && !/^https?:\/\/www\./i.test(start)) {
    const www = start.replace(/^(https?:\/\/)/i, "$1www.");
    const retry = await fetchPage(www);
    if (retry.ok) home = retry;
  }
  if (!home.ok) return { ok: false, error: home.error, home, text: "", email: "", phone: "", pages: [] };

  const domain = normalizeDomain(home.finalUrl) || normalizeDomain(website);
  const pages = [{ url: home.finalUrl, text: home.text }];
  const host = new URL(home.finalUrl).host.replace(/^www\./, "");
  const sameSite = (href) => {
    try {
      return new URL(href).host.replace(/^www\./, "") === host;
    } catch {
      return false;
    }
  };

  const seen = new Set([home.finalUrl.replace(/[#?].*$/, "").replace(/\/$/, "")]);
  let candidates = home.links
    .filter((l) => sameSite(l.href) && CONTACT_LINK_RE.test(`${l.href} ${l.text}`))
    .sort((a, b) => rankLink(a) - rankLink(b))
    .map((l) => l.href.replace(/#.*$/, ""));
  if (!candidates.length) {
    candidates = ["/contact", "/contact-us", "/impressum"].map((p) => new URL(p, home.finalUrl).toString());
  }

  for (const url of candidates) {
    if (pages.length > MAX_EXTRA_PAGES) break;
    const key = url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const page = await fetchPage(url);
    if (page.ok && page.text) pages.push({ url: page.finalUrl, text: page.text });
    // Stop early once a same-domain email and a phone are both found.
    const so_far = extractSiteContacts(pages.map((p) => p.text).join("\n"), domain);
    if (so_far.email && so_far.phone && so_far.email.endsWith("@" + domain)) break;
  }

  const text = pages.map((p, i) => (i === 0 ? p.text : `\n\n[Page: ${p.url}]\n${p.text}`)).join("");
  const { email, phone } = extractSiteContacts(text, domain);
  const pageWith = (value, isPhone = false) => {
    if (!value) return "";
    const norm = (s) => (isPhone ? String(s).replace(/[\s().\-\/]/g, "") : String(s).toLowerCase());
    return (pages.find((p) => norm(p.text).includes(norm(value))) || {}).url || "";
  };
  return {
    ok: true,
    home,
    text,
    email,
    phone,
    emailUrl: pageWith(email),
    phoneUrl: pageWith(phone, true),
    pages: pages.map((p) => p.url),
  };
}

/** Short excerpts around found values, for storing as evidence. */
function contactEvidence(found, radius = 160) {
  const out = [];
  for (const v of [found.email, found.phone].filter(Boolean)) {
    const i = found.text.toLowerCase().indexOf(String(v).toLowerCase());
    if (i >= 0) out.push(found.text.slice(Math.max(0, i - radius), i + String(v).length + radius).replace(/\s+/g, " "));
  }
  return out;
}

/**
 * Website first; if it gives no email, Claude web search (answers verified against the
 * cited page). Only fills what's missing.
 * → { email, phone, emailUrl, phoneUrl, evidence[], websiteUrl, notes[], websiteOk, usedClaude }
 */
async function findContactsWithFallback({ companyName, country = "", website = "", have = {} }) {
  const out = { email: "", phone: "", emailUrl: "", phoneUrl: "", evidence: [], websiteUrl: "", notes: [], websiteOk: false, usedClaude: false };
  if (website) {
    const site = await findContactsOnWebsite(website);
    if (site.ok) {
      out.websiteOk = true;
      out.websiteUrl = site.home.finalUrl;
      if (!have.email && site.email) Object.assign(out, { email: site.email, emailUrl: site.emailUrl });
      if (!have.phone && site.phone) Object.assign(out, { phone: site.phone, phoneUrl: site.phoneUrl });
      if (out.email || out.phone) {
        out.evidence.push(`[Company website: ${site.home.finalUrl}]`, ...contactEvidence({ ...site, email: out.email, phone: out.phone }));
        out.notes.push(`${[out.email && "email", out.phone && "phone"].filter(Boolean).join(" + ")} found on ${out.emailUrl || out.phoneUrl}`);
      } else {
        out.notes.push(`website checked (${site.pages.length} page${site.pages.length === 1 ? "" : "s"}), no email/phone published`);
      }
    } else {
      out.notes.push(`website not reachable (${site.error})`);
    }
  }

  if (!have.email && !out.email && claudeSearchStatus().available) {
    out.usedClaude = true;
    const c = await searchContactsWithClaude({ companyName, country, website: out.websiteUrl || website });
    if (c.email) Object.assign(out, { email: c.email, emailUrl: c.emailUrl });
    if (!have.phone && !out.phone && c.phone) Object.assign(out, { phone: c.phone, phoneUrl: c.phoneUrl });
    out.evidence.push(...c.evidence);
    out.notes.push(c.note);
  }
  return out;
}

module.exports = { findContactsOnWebsite, findContactsWithFallback, contactEvidence };
