/**
 * Importers Discovery
 *
 * Pipeline per run:
 *   1. Fetch each enabled directory page (trade-fair exhibitor list, association member
 *      directory, buy-lead board) — honouring robots.txt.
 *   2. Extract company entries from the fetched text (Gemini or Claude, copy-only; or link rules).
 *   3. Dedupe by website domain (in-run and against the CRM) before any further fetch.
 *   4. Fetch the company's own website and classify it. Only importers, distributors,
 *      wholesalers and processors/manufacturers are kept.
 *   5. Save through the provenance gate: source_url + fetched_at required, and every
 *      contact field must appear in the stored fetched text.
 *
 * Nothing is ever generated: a missing value stays empty, and a record that can't be
 * supported by fetched text is rejected with the reason in the run log.
 */

const Importer = require("../models/Importer");
const DiscoveryLog = require("../models/DiscoveryLog");
const DiscoverySchedule = require("../models/DiscoverySchedule");
const DiscoverySource = require("../models/DiscoverySource");
const User = require("../models/User");
const { normalizeDomain, validateImporterProvenance } = require("../lib/importerProvenance");
const { fetchPage } = require("../lib/webFetch");
const { parseCsvTradeData, parseTradeFile, extractContactsFromText } = require("../lib/discoveryParsers");
const extractor = require("./buyerExtractor");
const { findContactsOnWebsite, findContactsWithFallback, contactEvidence } = require("./contactFinder");
const { claudeSearchStatus, resetClaudeSearch } = require("./claudeContactSearch");

const MAX_PER_SOURCE = Number(process.env.DISCOVERY_MAX_PER_SOURCE) || 25;
const CONCURRENCY = 4;
// Exporter's home market(s): buyers located here are domestic, not international.
const HOME_COUNTRIES = (process.env.DISCOVERY_HOME_COUNTRIES || "India")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_RAW_TEXT = 60_000;
const ITEM_LOG_LIMIT = 500;

/**
 * Directory pages verified (2026-11-17) to be publicly fetchable, allowed by robots.txt,
 * and to contain company entries in their HTML. Inserted only into an empty source list.
 */
const DEFAULT_SOURCES = [
  {
    name: "Seasoning & Spice Association (UK) — members",
    url: "https://www.seasoningandspice.org.uk/members/",
    kind: "association",
    country: "United Kingdom",
    notes: "Member companies with address and website.",
  },
  {
    name: "Go4WorldBusiness — turmeric buy leads",
    url: "https://www.go4worldbusiness.com/find?searchText=turmeric&_type=buyers",
    kind: "buy_leads",
    country: "",
    notes: "Posted import requirements. Many entries hide the company name; those are rejected.",
  },
  {
    name: "Go4WorldBusiness — curcumin buy leads",
    url: "https://www.go4worldbusiness.com/find?searchText=curcumin&_type=buyers",
    kind: "buy_leads",
    country: "",
  },
  {
    name: "Go4WorldBusiness — spices buy leads",
    url: "https://www.go4worldbusiness.com/find?searchText=spices&_type=buyers",
    kind: "buy_leads",
    country: "",
  },
];

const KIND_TO_SOURCE_TYPE = { trade_fair: "trade_fair", association: "web_scraper", buy_leads: "web_scraper" };

let activeRunId = null;

// ------------------------------------------------------------------ helpers

async function ensureDefaultSources() {
  if ((await DiscoverySource.estimatedDocumentCount()) > 0) return;
  await DiscoverySource.insertMany(DEFAULT_SOURCES, { ordered: false }).catch(() => {});
}

async function mapPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const sameText = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

function countryMatches(filter, country) {
  if (!filter || filter === "Global") return true;
  return sameText(filter, country) || String(country || "").toLowerCase().includes(filter.toLowerCase());
}

/** Fetch home page, plus a contact page when the home page shows no email. */
/** Homepage + contact/about/imprint pages (see contactFinder). */
async function fetchCompanySite(website) {
  return findContactsOnWebsite(website);
}

/**
 * Excel/CSV row with a website but missing email or phone: read them from the
 * company's own site. Found values and the page excerpts they came from are added to
 * the row (and its evidence text, so the provenance check can verify them).
 */
async function enrichRowFromWebsite(row) {
  if (row.email && row.importerNumber) return { row, note: "" };
  if (!row.website && !(row.companyName && claudeSearchStatus().available)) return { row, note: "" };
  const found = await findContactsWithFallback({
    companyName: row.companyName,
    country: row.country,
    website: row.website,
    have: { email: Boolean(row.email), phone: Boolean(row.importerNumber) },
  });
  const add = {};
  if (!row.email && found.email) add.email = found.email;
  if (!row.importerNumber && found.phone) add.importerNumber = found.phone;
  const note = found.notes.join("; ");
  if (!Object.keys(add).length) return { row, note };
  return {
    row: {
      ...row,
      ...add,
      website_url_fetched: found.websiteUrl || row.website_url_fetched,
      contact_source_url: add.email ? found.emailUrl : found.phoneUrl,
      contact_found_at: new Date(),
      // The page excerpts containing each value: the provenance check verifies against these.
      raw_extracted_text: `${row.raw_extracted_text}\n${found.evidence.join("\n")}`,
    },
    note,
  };
}

// ------------------------------------------------------------------ ingest

function makeLogger(log) {
  return {
    push(item) {
      log.stats[item.status === "added" ? "added" : item.status === "duplicate" ? "duplicates" : item.status === "rejected" ? "rejected" : "errorCount"]++;
      if (log.items.length < ITEM_LOG_LIMIT) log.items.push(item);
    },
  };
}

/** Provenance gate + domain dedupe + save. Returns the log item. */
async function ingestOne(candidate, { userId, userName, seenDomains }) {
  const base = {
    companyName: candidate.companyName || candidate.importerName || "(no name)",
    source_url: candidate.source_url || "MISSING",
    website_domain: candidate.website_domain || "",
    buyer_type: candidate.buyer_type || "",
  };
  const provenance = validateImporterProvenance(candidate);
  if (!provenance.valid) return { ...base, status: "rejected", reason: provenance.errors.join("; ") };

  const domain = candidate.website_domain;
  if (domain) {
    if (seenDomains.has(domain)) return { ...base, status: "duplicate", reason: `Domain ${domain} already seen in this run` };
    seenDomains.add(domain);
    const existing = await Importer.findOne({ website_domain: domain }).select("companyName importerName").lean();
    if (existing) {
      return { ...base, status: "duplicate", reason: `Domain ${domain} already in CRM (${existing.companyName || existing.importerName})` };
    }
  } else {
    const existing = await Importer.findOne({ companyName: candidate.companyName, country: candidate.country }).select("_id").lean();
    if (existing) return { ...base, status: "duplicate", reason: `"${candidate.companyName}" (${candidate.country || "no country"}) already in CRM` };
  }

  try {
    await Importer.create({
      ...candidate,
      verification_score: 0,
      verification_grade: "Unrated",
      email_status: "unverified",
      website_live: false,
      pipeline_status: "New",
      status: "New",
      timeline: [
        {
          status: "New",
          note: `Discovered via ${candidate.discovery_source_name || candidate.source_type} (${candidate.source_url})`,
          changed_by: userName,
          timestamp: new Date(),
        },
      ],
      createdBy: userId,
      responsiblePerson: userName,
    });
    return { ...base, status: "added", reason: candidate.buyer_type ? `Added as ${candidate.buyer_type} — awaiting verification` : "Added — awaiting verification" };
  } catch (err) {
    if (err?.code === 11000) return { ...base, status: "duplicate", reason: `Domain ${domain} already in CRM` };
    return { ...base, status: "error", reason: err.message };
  }
}

// ------------------------------------------------------------------ crawl one source

async function crawlSource(source, ctx) {
  const { log, filters, logger } = ctx;
  const page = await fetchPage(source.url);
  const result = { name: source.name, url: source.url, found: 0, method: "" };

  if (!page.ok) {
    Object.assign(result, {
      status: page.blockedByRobots ? "blocked" : "error",
      message: page.error || "Fetch failed",
    });
    log.errors.push(`${source.name}: ${result.message}`);
    return result;
  }

  const { method, companies, note } = await extractor.extractCompaniesFromListing(page, source.kind);
  result.method = method;
  if (note && !log.extraction.note) log.extraction.note = note;
  if (!log.extraction.method || method !== "llm") log.extraction.method = method === "skipped" ? log.extraction.method || "rules" : method;
  if (method === "skipped") {
    Object.assign(result, { status: "empty", found: 0, message: note });
    return result;
  }

  const candidates = companies.slice(0, MAX_PER_SOURCE);
  result.found = companies.length;
  result.status = companies.length ? "ok" : "empty";
  result.message = companies.length
    ? `${companies.length} entries${companies.length > candidates.length ? `, first ${candidates.length} processed` : ""}`
    : page.text.length < 3000
      ? "Page has almost no text — list is probably loaded by JavaScript"
      : "No company entries found on the page";
  log.stats.found += candidates.length;
  log.progress.total += candidates.length;

  const fetchedAt = new Date();

  await mapPool(candidates, CONCURRENCY, async (c) => {
    try {
      const item = await processCandidate(c, source, page, fetchedAt, ctx);
      logger.push(item);
    } catch (err) {
      logger.push({ companyName: c.companyName || c.website || "(unknown)", source_url: page.finalUrl, status: "error", reason: err.message });
    } finally {
      log.progress.processed++;
    }
  });
  return result;
}

async function processCandidate(c, source, listingPage, fetchedAt, ctx) {
  const { filters, seenDomains } = ctx;
  const domain = normalizeDomain(c.website);
  const listingUrl = listingPage.finalUrl;
  const listingSnippet = extractor.snippetAround(listingPage.text, c.companyName || domain) || "";
  const label = c.companyName || domain || "(unnamed entry)";
  const reject = (reason, extra = {}) => ({ companyName: label, source_url: listingUrl, website_domain: domain, status: "rejected", reason, ...extra });

  if (!c.companyName && !domain) return reject("Listing entry has no company name and no website");

  // Cheap dedupe before fetching the company site.
  if (domain) {
    if (seenDomains.has(domain)) return { companyName: label, source_url: listingUrl, website_domain: domain, status: "duplicate", reason: `Domain ${domain} already seen in this run` };
    const existing = await Importer.findOne({ website_domain: domain }).select("companyName importerName").lean();
    if (existing) {
      seenDomains.add(domain);
      return { companyName: label, source_url: listingUrl, website_domain: domain, status: "duplicate", reason: `Domain ${domain} already in CRM (${existing.companyName || existing.importerName})` };
    }
  }

  // Company website → buyer check.
  let siteText = "";
  let siteUrl = "";
  let site = null;
  let companyName = c.companyName;
  if (domain) {
    site = await fetchCompanySite(c.website);
    if (!site.ok) return reject(`Company website not reachable (${site.error})`);
    // Title / og:site_name come from <head>; keep them in the evidence text.
    siteText = `Page title: ${site.home.title}\nSite name: ${site.home.siteName}\n${site.text}`;
    siteUrl = site.home.finalUrl;
    if (!companyName) companyName = extractor.nameFromSite(site.home);
    if (!companyName) return reject("No company name in listing or on its website");
  } else if (source.kind !== "buy_leads") {
    return reject("No website to check whether this company is a buyer");
  }

  const cls = await extractor.classifyBuyer({ companyName, siteText, listingSnippet });
  if (!cls.is_buyer) {
    return reject(`Not a buyer: ${cls.buyer_type}${cls.evidence ? ` — "${cls.evidence.slice(0, 140)}"` : ""}`, { buyer_type: cls.buyer_type });
  }
  if (filters.importerType && filters.importerType !== "All" && filters.importerType !== cls.buyer_type) {
    return reject(`Filtered out: buyer type is ${cls.buyer_type}`, { buyer_type: cls.buyer_type });
  }

  const country = c.country || cls.country || source.country || "";
  if (HOME_COUNTRIES.some((h) => sameText(h, country))) {
    return reject(`Domestic buyer (${country}) — international buyers only`, { buyer_type: cls.buyer_type });
  }
  if (!countryMatches(filters.country, country)) {
    return reject(country ? `Filtered out: country is ${country}` : "Filtered out: country not stated in listing or website", { buyer_type: cls.buyer_type });
  }
  if (filters.city) {
    const hay = `${c.city} ${c.address} ${siteText}`.toLowerCase();
    if (!hay.includes(filters.city.toLowerCase())) return reject(`Filtered out: ${filters.city} not mentioned`, { buyer_type: cls.buyer_type });
  }

  const siteContacts = siteText ? extractor.extractSiteContacts(siteText, domain) : { email: "", phone: "" };
  // Evidence: listing excerpt, then the website excerpts holding each saved value
  // (so the size cap can never cut them off), then the website text.
  const raw = [`[Listing: ${listingUrl}]`, listingSnippet || listingPage.text.slice(0, 4000)];
  if (siteText) {
    const excerpts = [siteContacts.email, siteContacts.phone, cls.evidence]
      .filter(Boolean)
      .map((v) => extractor.snippetAround(siteText, v, 200))
      .filter(Boolean);
    raw.push(`\n[Company website: ${siteUrl}]`, `Page title: ${siteText.split("\n")[0].replace(/^Page title: /, "")}`);
    if (excerpts.length) raw.push("[Excerpts]", ...excerpts);
    raw.push("[Full text]", siteText);
  }

  const candidate = {
    importerName: companyName,
    companyName,
    contactPerson: c.contactPerson || "",
    importerNumber: c.phone || siteContacts.phone || "",
    email: (c.email || siteContacts.email || "").toLowerCase(),
    website: domain ? siteUrl || c.website : "",
    website_domain: domain,
    country,
    city: c.city || "",
    address: c.address || "",
    importerType: cls.buyer_type,
    buyer_type: cls.buyer_type,
    buyer_evidence: cls.evidence,
    website_url_fetched: siteUrl,
    contact_source_url: !c.email && siteContacts.email ? site?.emailUrl || "" : !c.phone && siteContacts.phone ? site?.phoneUrl || "" : "",
    contact_found_at: siteUrl && (siteContacts.email || siteContacts.phone) ? new Date() : undefined,
    discovery_source_name: source.name,
    products: [],
    source_url: listingUrl,
    source_type: KIND_TO_SOURCE_TYPE[source.kind] || "web_scraper",
    fetched_at: fetchedAt,
    raw_extracted_text: raw.join("\n").slice(0, MAX_RAW_TEXT),
  };
  return ingestOne(candidate, ctx);
}

// ------------------------------------------------------------------ run orchestration

async function resolveUser(userId) {
  let user = userId ? await User.findById(userId).select("name role") : null;
  if (!user) user = (await User.findOne({ role: "admin" }).select("name")) || (await User.findOne().select("name"));
  return { userId: user?._id, userName: user?.name || "Discovery" };
}

function isRunActive() {
  return Boolean(activeRunId);
}

/**
 * Starts a run and returns its log immediately; work continues in the background.
 * The UI polls GET /logs/:id for progress.
 */
async function startDiscoveryRun({
  kinds = ["trade_fair", "association", "buy_leads"],
  sourceIds = null,
  country = "Global",
  city = "",
  importerType = "All",
  triggerType = "manual",
  csvContent = null,
  csvFilename = "upload.csv",
  userId,
}) {
  if (activeRunId) {
    const err = new Error("A discovery run is already in progress");
    err.status = 409;
    throw err;
  }
  await ensureDefaultSources();
  extractor.resetLlmStatus();
  resetClaudeSearch();

  const sourceKinds = csvContent ? ["csv_upload"] : kinds;
  const log = await DiscoveryLog.create({
    startedAt: new Date(),
    triggerType,
    sources: sourceKinds,
    filters: { country, city, importerType },
    status: "running",
  });
  activeRunId = String(log._id);

  executeRun(log, { kinds, sourceIds, country, city, importerType, csvContent, csvFilename, userId })
    .catch(async (err) => {
      log.status = "failed";
      log.errors.push(err.message);
      log.message = `Discovery failed: ${err.message}`;
      log.finishedAt = new Date();
      await log.save().catch(() => {});
    })
    .finally(() => {
      activeRunId = null;
    });

  return log;
}

async function executeRun(log, opts) {
  const { userId, userName } = await resolveUser(opts.userId);
  const filters = { country: opts.country, city: opts.city?.trim() || "", importerType: opts.importerType };
  const ctx = { log, filters, userId, userName, seenDomains: new Set(), logger: makeLogger(log) };

  // Persist progress every few seconds so the UI can poll it.
  const saver = setInterval(() => log.save().catch(() => {}), 3000);
  try {
    if (opts.csvContent) {
      log.extraction.method = "file";
      const rows = parseTradeFile(opts.csvContent, opts.csvFilename);
      const meta = rows.meta;
      log.stats.found = rows.length;
      log.progress.total = rows.length;

      const mapped = Object.entries(meta.columns).map(([f, h]) => `${f}←"${h}"`).join(", ");
      let message = rows.length
        ? `${rows.length} rows · ${meta.sheet ? `sheet "${meta.sheet}" (header on row ${meta.headerRow}${meta.sheets.length > 1 ? `, workbook sheets: ${meta.sheets.join(", ")}` : ""})` : `delimiter "${meta.delimiter}"`} · columns: ${mapped || "none recognised"}` +
          (meta.unmatchedColumns.length ? ` · ignored: ${meta.unmatchedColumns.join(", ")}` : "")
        : "No data rows found (the file needs a header row plus at least one data row)";
      if (rows.length && meta.columns.companyName === undefined) {
        message = `No company-name column recognised (use a header like "Company Name", "Importer" or "Consignee"). Found: ${meta.unmatchedColumns.join(", ")}`;
      }

      let enriched = 0;
      await mapPool(rows, CONCURRENCY, async (original) => {
        const item = (status, reason, r = original) => ({
          companyName: r.companyName || "(no name)",
          source_url: r.source_url,
          website_domain: r.website_domain,
          status,
          reason,
        });
        try {
          // Cheap checks first, so no website is fetched for rows that can't be imported.
          if (!original.companyName) return ctx.logger.push(item("rejected", "Importer or Company name is required"));
          if (original.country && HOME_COUNTRIES.some((h) => sameText(h, original.country))) {
            return ctx.logger.push(item("rejected", `Domestic buyer (${original.country}) — international buyers only`));
          }
          if (original.website_domain) {
            const existing = await Importer.findOne({ website_domain: original.website_domain }).select("companyName importerName").lean();
            if (existing) {
              return ctx.logger.push(item("duplicate", `Domain ${original.website_domain} already in CRM (${existing.companyName || existing.importerName})`));
            }
          }

          // Web searching is disabled: extract strictly what is present in the file.
          const row = original;
          const note = "";

          const reason = fileRowRejection(row);
          if (reason) return ctx.logger.push(item("rejected", note ? `${reason}; ${note}` : reason, row));
          const result = await ingestOne(row, ctx);
          if (note && result.status === "added") result.reason = `${result.reason} · ${note}`;
          ctx.logger.push(result);
        } catch (err) {
          ctx.logger.push(item("error", err.message));
        } finally {
          log.progress.processed++;
        }
      });
      log.sourceResults.push({
        name: `${meta.sheet !== undefined ? "Excel" : "CSV"}: ${opts.csvFilename}`,
        url: `csv://${opts.csvFilename}`,
        status: rows.length && meta.columns.companyName !== undefined ? "ok" : rows.length ? "error" : "empty",
        message,
        found: rows.length,
        method: meta.sheet !== undefined ? "excel" : "csv",
      });
    } else {
      throw new Error("Web search discovery is disabled. Buyers can only be imported via CSV or Excel file upload or manual entry.");
    }

    const s = log.stats;
    log.status = "completed";
    log.message = `Found ${s.found}: ${s.added} added, ${s.duplicates} duplicates, ${s.rejected} rejected, ${s.errorCount} errors.`;
  } finally {
    clearInterval(saver);
    log.finishedAt = new Date();
    await log.save();
    await DiscoverySchedule.updateOne({}, { $set: { lastRunAt: new Date() } });
  }
}

// ------------------------------------------------------------------ queries

async function getDiscoveryLogs(limit = 15) {
  return DiscoveryLog.find().sort({ createdAt: -1 }).limit(limit);
}

async function getDiscoveryLog(id) {
  return DiscoveryLog.findById(id);
}

async function getDiscoverySchedule() {
  let schedule = await DiscoverySchedule.findOne();
  if (!schedule) {
    schedule = await DiscoverySchedule.create({});
  } else if (schedule.schemaVersion !== 2) {
    // Older schedule records referred to Google Places and were never actually run.
    // Start them paused so a daily crawl only begins when someone switches it on.
    schedule.set({ schemaVersion: 2, enabled: false });
    await schedule.save();
  }
  return schedule;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Extra rules for uploaded Excel/CSV rows (checked before provenance/dedupe).
 * Returns a rejection reason, or "" if the row may be imported.
 *  - At least one contact detail: a well-formed email or a phone with 7+ digits.
 *  - Not a domestic buyer (international buyers only).
 */
function fileRowRejection(row) {
  const hasEmail = EMAIL_RE.test(String(row.email || "").trim());
  const hasPhone = String(row.importerNumber || "").replace(/\D/g, "").length >= 7;
  if (!hasEmail && !hasPhone) {
    const bad = [row.email && `email "${row.email}" is not valid`, row.importerNumber && `phone "${row.importerNumber}" is too short`].filter(Boolean);
    return `No contact details — needs an email or phone number${bad.length ? ` (${bad.join(", ")})` : ""}`;
  }
  if (row.country && HOME_COUNTRIES.some((h) => sameText(h, row.country))) {
    return `Domestic buyer (${row.country}) — international buyers only`;
  }
  return "";
}

module.exports = {
  fileRowRejection,
  enrichRowFromWebsite,
  DEFAULT_SOURCES,
  startDiscoveryRun,
  isRunActive,
  ensureDefaultSources,
  getDiscoveryLogs,
  getDiscoveryLog,
  getDiscoverySchedule,
  ingestOne,
  // parsers (re-exported for tests and CSV upload)
  parseCsvTradeData,
  extractContactsFromText,
  fetchPage,
};
