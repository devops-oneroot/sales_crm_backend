/**
 * Keeps Importers in step with export Leads — automatically.
 *
 * Every time an export lead is created or edited (Lead model hooks), its
 * importer is created or updated. On server start, syncAllLeads() catches up
 * anything changed while the hooks weren't running (migrations, old data).
 *
 * Every importer has a lead. Importers created from a lead link via
 * source_url manual://lead/<id>; importers added any other way (CSV import,
 * Add Manually, ...) get an export lead created for them automatically
 * (responsible person: admin) and link via linked_lead_id.
 *
 * Sync is two-way for linked importers:
 * - Lead edited  -> importer updated (syncLeadToImporter, via Lead model hooks)
 * - Importer edited in the Pipeline -> lead updated (syncImporterToLead, via
 *   Importer model hooks)
 * Shared fields: name, contact person, email, phone, website, country, address,
 * responsible person, sales status, products and export specs.
 * Importer-only: tags, outreach/verification/tracking data.
 *
 * Loop guard: saves made by the lead->importer sync carry $locals.fromLeadSync so
 * the importer hook ignores them, and importer->lead writes use updateOne, which
 * does not fire the Lead hooks.
 *
 * Nothing is invented: a value the source doesn't have stays empty.
 * A lead matching an importer from another source (same name/email/website)
 * only fills that importer's blanks — it doesn't take it over.
 */
const mongoose = require("mongoose");
const Importer = require("../models/Importer");
const User = require("../models/User");
const { toCurrentStatus, isCurrentStatus } = require("../lib/leadStatuses");
const { normalizeDomain } = require("../lib/importerProvenance");
const { normalizeTags, sameTags } = require("../lib/tags");

// Placeholder values older syncs invented when the lead had none.
const OLD_SYNC_PLACEHOLDERS = {
  materialType: "Export Grade Turmeric",
  polishLevel: "Double Polished",
  curcuminPercent: 3.5,
  quantityKg: 25000,
  price: 155,
  incoterm: "CIF",
  paymentTerms: "30% Advance, 70% BL scan",
};

const num = (v) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v);

/**
 * One sync at a time per record: two saves a split second apart (double-click,
 * startup catch-up + an edit) must not both create an importer or a lead.
 */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function leadProductsOf(lead) {
  const list = Array.isArray(lead.products)
    ? lead.products.map((p) => (typeof p === "string" ? p : p?.name)).filter(Boolean)
    : [];
  if (!list.length && lead.exportDetails?.materialType) return [lead.exportDetails.materialType];
  return list;
}

function contactOf(lead) {
  return {
    contactPerson: String(lead.contactPerson || lead.contacts?.[0]?.name || "").trim(),
    email: String(
      lead.email || lead.emails?.[0] || lead.contacts?.find((c) => c.email)?.email || ""
    )
      .trim()
      .toLowerCase(),
    phone: String(
      lead.phone ||
        lead.whatsappNumber ||
        lead.whatsappNumbers?.[0] ||
        lead.contacts?.[0]?.phone ||
        lead.contacts?.[0]?.phones?.[0] ||
        ""
    ).trim(),
  };
}

let fallbackUserCache = null;
async function fallbackUser() {
  if (!fallbackUserCache) {
    const admin = await User.findOne({ role: "admin" }).select("_id name").lean();
    fallbackUserCache = { id: admin?._id, name: admin?.name || "System" };
  }
  return fallbackUserCache;
}

/**
 * Create or update the importer for one lead.
 * Returns "created" | "updated" | "unchanged" | "skipped".
 */
function syncLeadToImporter(lead, opts = {}) {
  return withLock(`lead:${lead?._id}`, () => syncLeadToImporterNow(lead, opts));
}

async function syncLeadToImporterNow(lead, { dryRun = false } = {}) {
  if (!lead || lead.leadType !== "export") return "skipped";

  const compName = String(lead.company || lead.name || "").trim();
  if (!compName) return "skipped";

  const { contactPerson, email, phone } = contactOf(lead);
  const website = lead.website ? String(lead.website).trim() : "";
  const website_domain = website ? normalizeDomain(website) : "";
  const leadUrl = `manual://lead/${lead._id}`;
  const exp = lead.exportDetails || {};
  const products = leadProductsOf(lead);

  const orConditions = [{ importerName: new RegExp(`^${escapeRegex(compName)}$`, "i") }];
  if (email) orConditions.push({ email });
  if (website_domain) orConditions.push({ website_domain });

  // Prefer the importer linked to this exact lead; fall back to a duplicate match.
  const existing =
    (await Importer.findOne(importerLinkFilter(lead._id))) ||
    (await Importer.findOne({ $or: orConditions }));

  if (existing) {
    let modified = false;

    if (linkedLeadIdOf(existing) === String(lead._id)) {
      const fromLead = {
        importerName: compName,
        companyName: compName,
        contactPerson: contactPerson || undefined,
        email: email || undefined,
        importerNumber: phone || undefined,
        website: website || undefined,
        website_domain: website_domain || undefined,
        country: lead.country || undefined,
        address: lead.address || undefined,
        status: toCurrentStatus(lead.status, lead.pipelineStatus),
        materialType: exp.materialType || undefined,
        polishLevel: exp.polishLevel || undefined,
        curcuminPercent: num(exp.minCurcumin),
        quantityKg: num(exp.quantityNeededKg),
        price: num(exp.maxPrice),
        incoterm: exp.incoterm || undefined,
        portOfDischarge: exp.portDelivery || undefined,
        paymentDays: num(exp.paymentDays),
        state: exp.deliveryState || undefined,
        city: exp.deliveryDistrict || undefined,
        responsiblePerson: lead.responsiblePerson || undefined,
      };
      // Tags mirror exactly (including clearing) once the lead has a tags list.
      if (Array.isArray(lead.tags) && !sameTags(lead.tags, existing.tags)) {
        existing.tags = normalizeTags(lead.tags);
        modified = true;
      }
      for (const [key, placeholder] of Object.entries(OLD_SYNC_PLACEHOLDERS)) {
        if (fromLead[key] === undefined && existing[key] === placeholder) {
          existing[key] = undefined;
          modified = true;
        }
      }
      for (const [key, value] of Object.entries(fromLead)) {
        if (value !== undefined && existing[key] !== value) {
          existing[key] = value;
          modified = true;
        }
      }
      const sameProducts =
        products.map((p) => p.toLowerCase()).sort().join("|") ===
        (existing.products || []).map((p) => p.toLowerCase()).sort().join("|");
      if (products.length && !sameProducts) {
        existing.products = products;
        modified = true;
      }
    }

    const blanks = {
      email,
      importerNumber: phone,
      contactPerson,
      country: lead.country || "",
      website,
    };
    for (const [key, value] of Object.entries(blanks)) {
      if (value && !existing[key]) {
        existing[key] = value;
        modified = true;
      }
    }

    if (!modified) return "unchanged";
    if (!dryRun) {
      existing.$locals.fromLeadSync = true;
      await existing.save();
    }
    return "updated";
  }

  if (dryRun) return "created";
  const fallback = await fallbackUser();
  const created = new Importer({
    importerName: compName,
    companyName: compName,
    contactPerson,
    importerNumber: phone,
    email,
    website,
    website_domain,
    country: lead.country || "",
    state: exp.deliveryState || "",
    city: exp.deliveryDistrict || "",
    address: lead.address || "",
    products,
    materialType: exp.materialType || "",
    curcuminPercent: num(exp.minCurcumin),
    polishLevel: exp.polishLevel || "",
    quantityKg: num(exp.quantityNeededKg),
    price: num(exp.maxPrice),
    incoterm: exp.incoterm || "",
    portOfDischarge: exp.portDelivery || "",
    paymentTerms: exp.paymentDays ? `${exp.paymentDays} days credit` : "",
    paymentDays: num(exp.paymentDays),
    status: toCurrentStatus(lead.status, lead.pipelineStatus),
    tags: normalizeTags(lead.tags),
    pipeline_status: "New",
    source_type: "manual",
    source_url: leadUrl,
    fetched_at: lead.createdAt || new Date(),
    createdBy: lead.createdBy || fallback.id,
    responsiblePerson: lead.responsiblePerson || fallback.name,
    timeline: [
      {
        status: "Created",
        note: `Added automatically from Leads (Lead ID: ${lead._id})`,
        changed_by: "System Sync",
        timestamp: new Date(),
      },
    ],
  });
  created.$locals.fromLeadSync = true;
  await created.save();
  return "created";
}

// ------------------------------------------------------------ importer -> lead

const LEAD_URL_RE = /^manual:\/\/lead\/([0-9a-f]{24})$/i;

const sameValue = (a, b) => {
  const empty = (v) => v === undefined || v === null || v === "";
  if (empty(a) && empty(b)) return true;
  return a === b || (typeof a === "number" && Number(b) === a);
};

/**
 * Push an importer's shared fields back to the lead it was created from.
 * Returns "updated" | "unchanged" | "skipped".
 */
// Older importers stored outreach values ("Emailed"...) in status; map to a sales stage.
const PIPELINE_TO_SALES_STATUS = {
  New: "lead_generation",
  Verified: "lead_generation",
  Emailed: "contact_established",
  "Followed up": "contact_established",
  "LinkedIn sent": "contact_established",
  Replied: "requirement_understood",
  "Sample sent": "quotation_sent",
  Negotiation: "quotation_sent",
  Order: "closed_won",
  Lost: "closed_lost",
};
function salesStatusOfImporter(importer) {
  if (isCurrentStatus(importer.status)) return importer.status;
  return (
    PIPELINE_TO_SALES_STATUS[importer.status] ||
    PIPELINE_TO_SALES_STATUS[importer.pipeline_status] ||
    "lead_generation"
  );
}

/**
 * The lead an importer is mirrored with. linked_lead_id wins (it is set when an
 * importer is re-linked, e.g. after a duplicate merge); otherwise the lead it
 * was created from (source_url manual://lead/<id>).
 */
function linkedLeadIdOf(importer) {
  if (importer?.linked_lead_id) return String(importer.linked_lead_id);
  const match = LEAD_URL_RE.exec(String(importer?.source_url || ""));
  return match ? match[1] : null;
}

/** Mongo filter for "the importer linked to this lead". */
function importerLinkFilter(leadId) {
  return {
    $or: [
      { linked_lead_id: leadId },
      { source_url: `manual://lead/${leadId}`, linked_lead_id: { $exists: false } },
    ],
  };
}

/**
 * Importer with no lead (CSV import, Add Manually, ...): link it to an existing
 * export lead for the same company/email if there is one, otherwise create a
 * new export lead owned by the admin. Returns the lead id.
 */
async function ensureLeadForImporter(importer) {
  const Lead = require("../models/Lead");
  const name = String(importer.importerName || importer.companyName || "").trim();
  if (!name || name === "—") return null;
  const email = String(importer.email || "").trim().toLowerCase();

  // Reuse a matching export lead that no other importer is linked to.
  const nameRe = new RegExp(`^${escapeRegex(name)}$`, "i");
  const candidates = await Lead.find({
    leadType: "export",
    $or: [{ company: nameRe }, { name: nameRe }, ...(email ? [{ email }] : [])],
  })
    .select("_id")
    .lean();
  for (const c of candidates) {
    const taken = await Importer.exists({
      _id: { $ne: importer._id },
      ...importerLinkFilter(c._id),
    });
    if (!taken) {
      await Importer.updateOne({ _id: importer._id }, { $set: { linked_lead_id: c._id } });
      return String(c._id);
    }
  }

  // Otherwise create one. Link first (fixed id) so the Lead hook finds this importer.
  const admin = await fallbackUser();
  if (!admin.id) throw new Error("No admin user to own the new lead");
  const leadId = new mongoose.Types.ObjectId();
  await Importer.updateOne({ _id: importer._id }, { $set: { linked_lead_id: leadId } });
  await Lead.create({
    _id: leadId,
    name,
    company: name,
    leadType: "export",
    contactPerson: importer.contactPerson || undefined,
    email: email || undefined,
    phone: importer.importerNumber || undefined,
    website: importer.website || undefined,
    country: importer.country || undefined,
    address: importer.address || undefined,
    responsiblePerson: admin.name,
    createdBy: admin.id,
    status: salesStatusOfImporter(importer),
    tags: normalizeTags(importer.tags),
    products: (importer.products || []).filter(Boolean).map((n) => ({ name: String(n).trim() })),
    exportDetails: {
      materialType: importer.materialType || undefined,
      polishLevel: importer.polishLevel || undefined,
      minCurcumin: num(importer.curcuminPercent),
      quantityNeededKg: num(importer.quantityKg),
      maxPrice: num(importer.price),
      incoterm: importer.incoterm || undefined,
      portDelivery: importer.portOfDischarge || undefined,
      paymentDays: num(importer.paymentDays),
      deliveryState: importer.state || undefined,
      deliveryDistrict: importer.city || undefined,
    },
  });
  console.log(`[LeadSync] Created export lead for importer "${name}" (owner: ${admin.name})`);
  return String(leadId);
}

function syncImporterToLead(importer) {
  return withLock(`importer:${importer?._id}`, async () => {
    // Re-read inside the lock: an earlier queued run may have linked/created the lead.
    const fresh = importer?._id ? (await Importer.findById(importer._id).lean()) || importer : importer;
    return syncImporterToLeadNow(fresh);
  });
}

async function syncImporterToLeadNow(importer) {
  if (!importer) return "skipped";
  let leadId = linkedLeadIdOf(importer);
  if (!leadId) {
    leadId = await ensureLeadForImporter(importer);
    if (!leadId) return "skipped";
  }
  const Lead = require("../models/Lead");
  const lead = await Lead.findById(leadId).lean();
  if (!lead) return "skipped";

  const exp = lead.exportDetails || {};
  const set = {};
  const unset = {};
  const put = (path, next, current) => {
    if (sameValue(next, current)) return;
    if (next === undefined || next === null || next === "") unset[path] = "";
    else set[path] = next;
  };

  const name = String(importer.importerName || "").trim();
  if (name && name !== "—") {
    put("name", name, lead.name);
    put("company", name, lead.company);
  }
  // The Leads tab keeps contact details in contacts[] and rebuilds the top-level
  // fields from it on save, so update the first contact as well.
  const impContact = {
    name: importer.contactPerson || "",
    email: (importer.email || "").toLowerCase(),
    phone: importer.importerNumber || "",
  };
  const contacts = Array.isArray(lead.contacts) ? lead.contacts.map((c) => ({ ...c })) : [];
  const first = contacts[0] || {};
  const contactChanged =
    !sameValue(impContact.name, first.name) ||
    !sameValue(impContact.email, first.email) ||
    !sameValue(impContact.phone, first.phone);
  if (contactChanged && (impContact.name || impContact.email || impContact.phone || contacts.length)) {
    const phones = Array.isArray(first.phones) ? [...first.phones] : [];
    if (impContact.phone) {
      const i = phones.findIndex((p) => p === first.phone);
      if (i >= 0) phones[i] = impContact.phone;
      else if (!phones.includes(impContact.phone)) phones.unshift(impContact.phone);
    } else if (first.phone) {
      const i = phones.indexOf(first.phone);
      if (i >= 0) phones.splice(i, 1);
    }
    contacts[0] = { ...first, name: impContact.name, email: impContact.email, phone: impContact.phone, phones };
    set.contacts = contacts;
    set.contactPersons = contacts.map((c) => c.name).filter(Boolean);
    set.emails = contacts.map((c) => c.email).filter(Boolean);
  }
  put("contactPerson", impContact.name, lead.contactPerson);
  put("email", impContact.email, lead.email);
  put("phone", impContact.phone, lead.phone);
  put("website", importer.website || "", lead.website);
  put("country", importer.country || "", lead.country);
  put("address", importer.address || "", lead.address);
  if (importer.responsiblePerson) put("responsiblePerson", importer.responsiblePerson, lead.responsiblePerson);
  if (isCurrentStatus(importer.status)) put("status", importer.status, lead.status);

  put("exportDetails.materialType", importer.materialType || "", exp.materialType);
  put("exportDetails.polishLevel", importer.polishLevel || "", exp.polishLevel);
  put("exportDetails.minCurcumin", importer.curcuminPercent, exp.minCurcumin);
  put("exportDetails.quantityNeededKg", importer.quantityKg, exp.quantityNeededKg);
  put("exportDetails.maxPrice", importer.price, exp.maxPrice);
  put("exportDetails.incoterm", importer.incoterm || "", exp.incoterm);
  put("exportDetails.portDelivery", importer.portOfDischarge || "", exp.portDelivery);
  put("exportDetails.paymentDays", importer.paymentDays, exp.paymentDays);
  put("exportDetails.deliveryState", importer.state || "", exp.deliveryState);
  put("exportDetails.deliveryDistrict", importer.city || "", exp.deliveryDistrict);

  // Tags mirror exactly. (A lead that never had tags gets the importer's.)
  if (!sameTags(importer.tags, lead.tags) || !Array.isArray(lead.tags)) {
    const next = normalizeTags(importer.tags);
    if (!Array.isArray(lead.tags) || !sameTags(next, lead.tags)) set.tags = next;
  }

  // Products: keep the lead's existing entries (with their qty/price) for names
  // still on the importer, add new names, drop removed ones.
  const impProducts = (importer.products || []).map((p) => String(p).trim()).filter(Boolean);
  const leadProducts = Array.isArray(lead.products) ? lead.products : [];
  const key = (n) => String(n || "").trim().toLowerCase();
  const sameProducts =
    impProducts.map(key).sort().join("|") ===
    leadProducts.map((p) => key(typeof p === "string" ? p : p?.name)).filter(Boolean).sort().join("|");
  if (impProducts.length && !sameProducts) {
    const byName = new Map(
      leadProducts
        .filter((p) => p && typeof p === "object")
        .map((p) => [key(p.name), p])
    );
    set.products = impProducts.map((n) => byName.get(key(n)) || { name: n });
  }

  if (!Object.keys(set).length && !Object.keys(unset).length) return "unchanged";
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  // updateOne does not fire the Lead hooks, so this can't bounce back.
  await Lead.updateOne({ _id: lead._id }, update, { runValidators: true });
  return "updated";
}

/** Fire-and-forget importer -> lead after a user edit on the importer. */
function queueImporterSync(importer) {
  if (!importer?._id || importer.$locals?.fromLeadSync) return;
  const id = importer._id;
  // Re-read: a findOneAndUpdate hook may hand us the pre-update document.
  setImmediate(async () => {
    try {
      const fresh = await Importer.findById(id).lean();
      if (fresh) await syncImporterToLead(fresh);
    } catch (err) {
      console.error(`[LeadSync] Importer ${id} → lead failed:`, err.message);
    }
  });
}

/** Sync every export lead. Used on startup and by the admin endpoint. */
async function syncAllLeads({ dryRun = false } = {}) {
  const Lead = require("../models/Lead");
  const leads = await Lead.find({ leadType: "export" }).lean();
  const stats = { totalFound: leads.length, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const failed = [];
  for (const lead of leads) {
    try {
      stats[await syncLeadToImporter(lead, { dryRun })]++;
    } catch (err) {
      stats.failed++;
      failed.push({ leadId: String(lead._id), name: lead.company || lead.name || "", error: err.message });
    }
  }
  if (failed.length) {
    console.warn(`[LeadSync] ${failed.length} lead(s) could not be synced:`, failed.slice(0, 10));
  }
  return { stats, failed };
}

/** Fire-and-forget sync after a lead write; never breaks the lead request. */
function queueLeadSync(lead) {
  if (!lead?._id) return;
  const id = lead._id;
  // Re-read: a findOneAndUpdate hook may hand us the pre-update document.
  setImmediate(async () => {
    try {
      const Lead = require("../models/Lead");
      const fresh = await Lead.findById(id).lean();
      if (fresh) await syncLeadToImporter(fresh);
    } catch (err) {
      console.error(`[LeadSync] Lead ${id} → importer failed:`, err.message);
    }
  });
}

/**
 * One-time: copy existing importer tags onto linked leads that have never had
 * a tags list, so turning on two-way tag sync can't wipe any tags.
 */
async function backfillLeadTags() {
  const Lead = require("../models/Lead");
  const importers = await Importer.find({ "tags.0": { $exists: true } })
    .select("tags source_url linked_lead_id")
    .lean();
  let copied = 0;
  for (const imp of importers) {
    const leadId = linkedLeadIdOf(imp);
    if (!leadId) continue;
    const r = await Lead.updateOne(
      { _id: leadId, tags: { $exists: false } },
      { $set: { tags: normalizeTags(imp.tags) } }
    );
    copied += r.modifiedCount;
  }
  return { importersWithTags: importers.length, copied };
}

/** Give every importer without a lead one (startup backfill). */
async function linkAllImporters({ dryRun = false } = {}) {
  const unlinked = await Importer.find({
    source_url: { $not: /^manual:\/\/lead\// },
    linked_lead_id: { $exists: false },
  }).lean();
  const stats = { found: unlinked.length, linked: 0, failed: 0 };
  if (dryRun) return { stats, names: unlinked.map((i) => i.importerName) };
  for (const imp of unlinked) {
    try {
      if ((await syncImporterToLead(imp)) !== "skipped") stats.linked++;
    } catch (err) {
      stats.failed++;
      console.warn(`[LeadSync] Could not create lead for importer "${imp.importerName}":`, err.message);
    }
  }
  return { stats };
}

module.exports = {
  backfillLeadTags,
  linkedLeadIdOf,
  importerLinkFilter,
  linkAllImporters,
  syncLeadToImporter,
  syncAllLeads,
  queueLeadSync,
  syncImporterToLead,
  queueImporterSync,
};
