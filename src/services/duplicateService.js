/**
 * Possible-duplicate leads: find, flag, and let a person decide.
 *
 * Nothing is merged or deleted automatically. A user picks, per pair:
 *  - Merge: keep one lead, fold the other's data into it (blanks filled,
 *    lists combined), move its importer/emails/activity across.
 *  - Delete: remove one lead (and its importer).
 *  - Not a duplicate: the pair is never flagged again.
 * Before anything is merged away or deleted, a full copy goes to
 * ArchivedRecord, and can be restored.
 */
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Importer = require("../models/Importer");
const EmailMessage = require("../models/EmailMessage");
const Activity = require("../models/Activity");
const LeadDuplicate = require("../models/LeadDuplicate");
const ArchivedRecord = require("../models/ArchivedRecord");
const { leadMatchKeys, leadBook } = require("../lib/duplicateMatching");
const { importerLinkFilter } = require("./leadImporterSync");

const MATCH_FIELDS =
  "name company phone whatsappNumber whatsappNumbers contacts email emails website leadType";
// A key shared by more leads than this (e.g. a switchboard number) is too
// generic to mean "same company" — skip it rather than flag every pair.
const MAX_GROUP = 15;

const idStr = (v) => String(v);
const pairKey = (a, b) => (idStr(a) < idStr(b) ? [idStr(a), idStr(b)] : [idStr(b), idStr(a)]);

// ------------------------------------------------------------------ detection

/** All duplicate pairs among the given leads: Map "a|b" -> Set(reasons). */
function findPairs(leads) {
  const groups = new Map(); // "book|kind|key" -> [leadId]
  for (const lead of leads) {
    const book = leadBook(lead);
    const keys = leadMatchKeys(lead);
    for (const [kind, values] of Object.entries(keys)) {
      for (const value of values) {
        const g = `${book}|${kind}|${value}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(idStr(lead._id));
      }
    }
  }
  const pairs = new Map();
  for (const [g, ids] of groups) {
    const unique = [...new Set(ids)];
    if (unique.length < 2 || unique.length > MAX_GROUP) continue;
    const kind = g.split("|")[1];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [a, b] = pairKey(unique[i], unique[j]);
        const k = `${a}|${b}`;
        if (!pairs.has(k)) pairs.set(k, new Set());
        pairs.get(k).add(kind);
      }
    }
  }
  return pairs;
}

/** Store found pairs: new -> open, resolved (after a restore) -> reopened, dismissed -> left alone. */
async function upsertPairs(pairs) {
  let flagged = 0;
  for (const [k, reasons] of pairs) {
    const [a, b] = k.split("|");
    const existing = await LeadDuplicate.findOne({ leadA: a, leadB: b });
    if (existing?.status === "dismissed") continue;
    if (!existing) {
      await LeadDuplicate.create({ leadA: a, leadB: b, reasons: [...reasons] }).catch((err) => {
        if (err.code !== 11000) throw err; // created concurrently — fine
      });
      flagged++;
    } else {
      const update = { reasons: [...reasons] };
      if (existing.status === "resolved") {
        Object.assign(update, { status: "open", resolution: undefined, resolvedBy: undefined, resolvedAt: undefined });
        flagged++;
      }
      await LeadDuplicate.updateOne({ _id: existing._id }, { $set: update });
    }
  }
  return flagged;
}

/** Full scan of every lead. Also drops open flags that no longer match. */
async function scanAll() {
  const leads = await Lead.find({}).select(MATCH_FIELDS).lean();
  const pairs = findPairs(leads);
  const flagged = await upsertPairs(pairs);
  const stale = await LeadDuplicate.find({ status: "open" }).select("leadA leadB").lean();
  const dropIds = stale.filter((p) => !pairs.has(`${p.leadA}|${p.leadB}`)).map((p) => p._id);
  if (dropIds.length) await LeadDuplicate.deleteMany({ _id: { $in: dropIds } });
  return { leads: leads.length, pairs: pairs.size, newlyFlagged: flagged, cleared: dropIds.length };
}

/** Re-check one lead against all others (after it is created or edited). */
async function scanLead(leadId) {
  const lead = await Lead.findById(leadId).select(MATCH_FIELDS).lean();
  if (!lead) return;
  const others = await Lead.find({ _id: { $ne: lead._id } }).select(MATCH_FIELDS).lean();
  const all = findPairs([lead, ...others]);
  const mine = new Map([...all].filter(([k]) => k.includes(idStr(lead._id))));
  await upsertPairs(mine);
  // Open flags on this lead that no longer match (e.g. name was corrected)
  const open = await LeadDuplicate.find({
    status: "open",
    $or: [{ leadA: lead._id }, { leadB: lead._id }],
  }).lean();
  const drop = open.filter((p) => !mine.has(`${p.leadA}|${p.leadB}`)).map((p) => p._id);
  if (drop.length) await LeadDuplicate.deleteMany({ _id: { $in: drop } });
}

const pendingScans = new Set();
/** Fire-and-forget scan after a lead write (coalesces rapid repeats). */
function queueScan(leadId) {
  const key = idStr(leadId);
  if (!leadId || pendingScans.has(key)) return;
  pendingScans.add(key);
  setTimeout(() => {
    pendingScans.delete(key);
    scanLead(key).catch((err) => console.error(`[Duplicates] scan ${key} failed:`, err.message));
  }, 300);
}

// ------------------------------------------------------------------ listing

const LEAD_SUMMARY =
  "name company contactPerson phone whatsappNumber email website country status responsiblePerson leadType createdAt updatedAt products exportDetails";

async function importerSummary(leadId) {
  const imp = await Importer.findOne(importerLinkFilter(leadId))
    .select("_id importerName pipeline_status tags email_1_sent_at")
    .lean();
  if (!imp) return null;
  const emails = await EmailMessage.countDocuments({ importerId: imp._id });
  return { _id: imp._id, pipeline_status: imp.pipeline_status, tags: imp.tags || [], emails };
}

async function listOpen() {
  const pairs = await LeadDuplicate.find({ status: "open" }).sort({ createdAt: -1 }).lean();
  const ids = [...new Set(pairs.flatMap((p) => [idStr(p.leadA), idStr(p.leadB)]))];
  const leads = new Map(
    (await Lead.find({ _id: { $in: ids } }).select(LEAD_SUMMARY).lean()).map((l) => [idStr(l._id), l])
  );
  const out = [];
  const orphaned = [];
  for (const p of pairs) {
    const a = leads.get(idStr(p.leadA));
    const b = leads.get(idStr(p.leadB));
    if (!a || !b) {
      orphaned.push(p._id); // one side was deleted elsewhere
      continue;
    }
    out.push({
      _id: p._id,
      reasons: p.reasons,
      createdAt: p.createdAt,
      leads: [
        { ...a, importer: await importerSummary(a._id) },
        { ...b, importer: await importerSummary(b._id) },
      ],
    });
  }
  if (orphaned.length) await LeadDuplicate.deleteMany({ _id: { $in: orphaned } });
  return out;
}

/** Lead ids currently in an open pair (for "possible duplicate" badges). */
async function flaggedLeadIds() {
  const pairs = await LeadDuplicate.find({ status: "open" }).select("leadA leadB").lean();
  return {
    ids: [...new Set(pairs.flatMap((p) => [idStr(p.leadA), idStr(p.leadB)]))],
    pairs: pairs.length,
  };
}

// ------------------------------------------------------------------ decisions

async function getOpenPair(pairId, leadIds = []) {
  const pair = await LeadDuplicate.findById(pairId);
  if (!pair) throw httpError(404, "This duplicate flag no longer exists");
  if (pair.status !== "open") throw httpError(409, "This pair was already handled");
  const inPair = [idStr(pair.leadA), idStr(pair.leadB)];
  for (const id of leadIds) {
    if (!inPair.includes(idStr(id))) throw httpError(400, "That lead is not part of this pair");
  }
  return pair;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function dismiss(pairId, userName) {
  const pair = await getOpenPair(pairId);
  pair.status = "dismissed";
  pair.resolution = "dismissed";
  pair.resolvedBy = userName;
  pair.resolvedAt = new Date();
  await pair.save();
  return { ok: true };
}

const isEmpty = (v) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Comparable form of a list item (ignores sub-document _id). */
function itemKey(item) {
  if (item && typeof item === "object") {
    const { _id, ...rest } = item;
    return JSON.stringify(rest).toLowerCase();
  }
  return String(item).trim().toLowerCase();
}

/**
 * Fold `other` into `keep` without overwriting anything `keep` already has:
 * empty fields are filled, lists are combined (no repeats), nested objects
 * (exportDetails) are merged the same way. Returns the $set for `keep`.
 */
function mergeFields(keep, other, skip) {
  const set = {};
  for (const [key, value] of Object.entries(other)) {
    if (skip.has(key) || isEmpty(value)) continue;
    const mine = keep[key];
    if (isEmpty(mine)) {
      set[key] = value;
    } else if (Array.isArray(mine) && Array.isArray(value)) {
      const seen = new Set(mine.map(itemKey));
      const extra = value.filter((v) => !seen.has(itemKey(v)));
      if (extra.length) set[key] = [...mine, ...extra];
    } else if (
      mine && value && typeof mine === "object" && typeof value === "object" &&
      !(mine instanceof Date) && !mongoose.isValidObjectId(mine)
    ) {
      for (const [sub, subVal] of Object.entries(value)) {
        if (sub !== "_id" && !isEmpty(subVal) && isEmpty(mine[sub])) set[`${key}.${sub}`] = subVal;
      }
    }
  }
  return set;
}

const LEAD_SKIP = new Set(["_id", "__v", "createdAt", "updatedAt", "createdBy"]);
const IMPORTER_SKIP = new Set([
  "_id", "__v", "createdAt", "updatedAt", "createdBy",
  // provenance is immutable; link and dedupe key are handled explicitly
  "source_url", "fetched_at", "source_type", "raw_extracted_text", "linked_lead_id", "website_domain",
]);

async function archive(kind, doc, reason, userName, extra = {}) {
  return ArchivedRecord.create({
    kind,
    originalId: doc._id,
    title: doc.company || doc.name || doc.importerName || doc.companyName || "",
    data: doc,
    reason,
    archivedBy: userName,
    ...extra,
  });
}

/** Keep `keepId`, fold `removeId` into it. */
async function merge(pairId, keepId, userName) {
  const pair = await getOpenPair(pairId, [keepId]);
  const removeId = idStr(pair.leadA) === idStr(keepId) ? pair.leadB : pair.leadA;

  const keep = await Lead.findById(keepId).lean();
  const other = await Lead.findById(removeId).lean();
  if (!keep || !other) throw httpError(404, "One of these leads no longer exists");

  const keepImp = await Importer.findOne(importerLinkFilter(keep._id)).lean();
  const otherImp = await Importer.findOne(importerLinkFilter(other._id)).lean();

  // 1) Archive full copies first — nothing below can lose data.
  const impArchive = otherImp
    ? await archive("importer", otherImp, "merged", userName, { mergedInto: keepImp?._id })
    : null;
  await archive("lead", other, "merged", userName, {
    mergedInto: keep._id,
    relatedArchiveId: impArchive?._id,
  });

  // 2) Importers
  if (otherImp && keepImp) {
    const set = mergeFields(keepImp, otherImp, IMPORTER_SKIP);
    if (otherImp.timeline?.length) {
      set.timeline = [...(keepImp.timeline || []), ...otherImp.timeline].sort(
        (x, y) => new Date(x.timestamp) - new Date(y.timestamp)
      );
    }
    await EmailMessage.updateMany({ importerId: otherImp._id }, { $set: { importerId: keepImp._id } });
    await Importer.deleteOne({ _id: otherImp._id }); // frees its website_domain
    if (!keepImp.website_domain && otherImp.website_domain) set.website_domain = otherImp.website_domain;
    if (Object.keys(set).length) await Importer.updateOne({ _id: keepImp._id }, { $set: set });
  } else if (otherImp) {
    // Only the removed lead had an importer: hand it to the kept lead.
    await Importer.updateOne({ _id: otherImp._id }, { $set: { linked_lead_id: keep._id } });
  }

  // 3) History and the lead itself
  await Activity.updateMany({ leadId: other._id }, { $set: { leadId: keep._id } });
  await Lead.deleteOne({ _id: other._id });
  const leadSet = mergeFields(keep, other, LEAD_SKIP);
  // findOneAndUpdate fires the Lead hooks: importer sync + duplicate re-scan.
  await Lead.findOneAndUpdate({ _id: keep._id }, Object.keys(leadSet).length ? { $set: leadSet } : { $set: { updatedAt: new Date() } });

  // 4) Flags
  await LeadDuplicate.updateOne(
    { _id: pair._id },
    { $set: { status: "resolved", resolution: "merged", resolvedBy: userName, resolvedAt: new Date() } }
  );
  await LeadDuplicate.deleteMany({
    _id: { $ne: pair._id },
    status: "open",
    $or: [{ leadA: other._id }, { leadB: other._id }],
  });
  return { ok: true, keptLeadId: keep._id, mergedFields: Object.keys(leadSet) };
}

/** Delete `removeId` (and its importer) — archived first. */
async function removeLead(pairId, removeId, userName) {
  const pair = await getOpenPair(pairId, [removeId]);
  const lead = await Lead.findById(removeId).lean();
  if (!lead) throw httpError(404, "That lead no longer exists");
  const imp = await Importer.findOne(importerLinkFilter(lead._id)).lean();

  const impArchive = imp ? await archive("importer", imp, "deleted", userName) : null;
  await archive("lead", lead, "deleted", userName, { relatedArchiveId: impArchive?._id });

  if (imp) await Importer.deleteOne({ _id: imp._id });
  await Lead.deleteOne({ _id: lead._id });

  await LeadDuplicate.updateOne(
    { _id: pair._id },
    { $set: { status: "resolved", resolution: "deleted", resolvedBy: userName, resolvedAt: new Date() } }
  );
  await LeadDuplicate.deleteMany({
    _id: { $ne: pair._id },
    status: "open",
    $or: [{ leadA: lead._id }, { leadB: lead._id }],
  });
  return { ok: true };
}

// ------------------------------------------------------------------ archive

async function listArchived(limit = 100) {
  return ArchivedRecord.find({ kind: "lead", restoredAt: { $exists: false } })
    .select("title reason mergedInto archivedBy createdAt originalId relatedArchiveId")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/** Put an archived lead (and its importer, if archived with it) back. */
async function restore(archiveId, userName) {
  const rec = await ArchivedRecord.findById(archiveId);
  if (!rec || rec.kind !== "lead") throw httpError(404, "Archived lead not found");
  if (rec.restoredAt) throw httpError(409, "Already restored");
  if (await Lead.exists({ _id: rec.originalId })) throw httpError(409, "A lead with this id already exists");

  // Raw insert keeps the original _id and immutable fields, and skips hooks
  // (we sync explicitly below).
  await Lead.collection.insertOne(rec.data);
  let importerRestored = false;
  if (rec.relatedArchiveId) {
    const impRec = await ArchivedRecord.findById(rec.relatedArchiveId);
    if (impRec && !impRec.restoredAt && !(await Importer.exists({ _id: impRec.originalId }))) {
      const data = { ...impRec.data };
      // Its website may now belong to the importer it was merged into.
      if (data.website_domain && (await Importer.exists({ website_domain: data.website_domain }))) {
        delete data.website_domain;
      }
      await Importer.collection.insertOne(data);
      impRec.restoredAt = new Date();
      impRec.restoredBy = userName;
      await impRec.save();
      importerRestored = true;
    }
  }
  rec.restoredAt = new Date();
  rec.restoredBy = userName;
  await rec.save();

  require("./leadImporterSync").queueLeadSync({ _id: rec.originalId });
  queueScan(rec.originalId);
  return { ok: true, leadId: rec.originalId, importerRestored };
}

module.exports = {
  scanAll,
  scanLead,
  queueScan,
  listOpen,
  flaggedLeadIds,
  dismiss,
  merge,
  removeLead,
  listArchived,
  restore,
  // exported for tests
  findPairs,
  mergeFields,
};
