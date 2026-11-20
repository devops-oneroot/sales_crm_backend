/**
 * "Find missing contacts" for importers already in the CRM: for each importer that has
 * a website but no email (or no phone), read the company's own site and fill ONLY the
 * empty fields. Existing values are never overwritten. The page URL and the excerpt
 * containing the value are stored, and a timeline entry records the change.
 */
const Importer = require("../models/Importer");
const { findContactsWithFallback } = require("./contactFinder");
const { claudeSearchStatus, resetClaudeSearch } = require("./claudeContactSearch");
const { isPlaceholderEmail, isPlaceholderPhone } = require("../lib/importerProvenance");

const MAX_PER_REQUEST = 50;
const CONCURRENCY = 4;

let running = false;

async function enrichImporterContacts({ ids = null, userName = "System" } = {}) {
  if (running) {
    const err = new Error("A contact search is already running");
    err.status = 409;
    throw err;
  }
  running = true;
  try {
    resetClaudeSearch();
    const claudeOn = claudeSearchStatus().available;
    const missing = { $or: [{ email: { $in: [null, ""] } }, { importerNumber: { $in: [null, ""] } }] };
    // Without a website, only Claude web search can help (by company name + country).
    const query = claudeOn
      ? { ...missing, $and: [{ $or: [{ website: { $nin: [null, ""] } }, { email: { $in: [null, ""] } }] }] }
      : { ...missing, website: { $nin: [null, ""] } };
    if (Array.isArray(ids) && ids.length) query._id = { $in: ids };
    const total = await Importer.countDocuments(query);
    const targets = await Importer.find(query).select("companyName importerName country website email importerNumber").limit(MAX_PER_REQUEST).lean();

    const results = [];
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const imp = targets[i++];
        const name = imp.companyName || imp.importerName;
        try {
          const found = await findContactsWithFallback({
            companyName: name,
            country: imp.country,
            website: imp.website,
            have: { email: Boolean(imp.email), phone: Boolean(imp.importerNumber) },
          });
          const set = {};
          if (!imp.email && found.email && !isPlaceholderEmail(found.email)) set.email = found.email;
          if (!imp.importerNumber && found.phone && !isPlaceholderPhone(found.phone)) set.importerNumber = found.phone;
          if (!Object.keys(set).length) {
            const unreachable = imp.website && !found.websiteOk && !found.usedClaude;
            results.push({ id: imp._id, companyName: name, status: unreachable ? "unreachable" : "none", detail: found.notes.join("; "), usedClaude: found.usedClaude });
            continue;
          }
          const sourceUrl = set.email ? found.emailUrl : found.phoneUrl;
          set.contact_source_url = sourceUrl;
          set.contact_found_at = new Date();
          set.contact_evidence = found.evidence.join("\n");
          const what = [set.email && `email ${set.email}`, set.importerNumber && `phone ${set.importerNumber}`].filter(Boolean).join(" and ");
          await Importer.updateOne(
            { _id: imp._id },
            {
              $set: set,
              $push: { timeline: { status: "Contact found", note: `${what} found on ${sourceUrl}${found.usedClaude && found.evidence.some((e) => / web search → verified/.test(e)) ? " (AI web search, verified on the page)" : ""}`, changed_by: userName, timestamp: new Date() } },
            }
          );
          results.push({ id: imp._id, companyName: name, status: "found", email: set.email || "", phone: set.importerNumber || "", sourceUrl, usedClaude: found.usedClaude });
        } catch (err) {
          results.push({ id: imp._id, companyName: name, status: "error", detail: err.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

    const count = (s) => results.filter((r) => r.status === s).length;
    const claude = claudeSearchStatus();
    return {
      claudeSearch: claudeOn ? (claude.available ? "on" : `stopped: ${claude.reason}`) : `off: ${claude.reason}`,
      usedClaude: results.filter((r) => r.usedClaude).length,
      checked: results.length,
      remaining: Math.max(0, total - results.length),
      found: count("found"),
      none: count("none"),
      unreachable: count("unreachable"),
      errors: count("error"),
      results,
    };
  } finally {
    running = false;
  }
}

module.exports = { enrichImporterContacts };
