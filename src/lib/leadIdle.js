const Activity = require("../models/Activity");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Log entries that mean someone worked the lead. Reassigning it, creating
 * it or deleting it are bookkeeping, not activity, and do not reset the
 * clock — a lead handed to someone who then ignores it is still idle.
 */
const WORK_ACTIVITY_TYPES = [
  "daily_activity",
  "remark_added",
  "status_changed",
  "outreach_call",
  "outreach_email",
  "outreach_whatsapp",
  "follow_up_set",
];

/**
 * When someone last actually worked a lead: the newest remark or document,
 * or the newest work entry in the activity log (calls, notes, status moves,
 * follow-ups). A lead nobody has touched since it was created counts from
 * its creation.
 *
 * updatedAt is deliberately left out. It is bumped by any write at all —
 * a typo fix, a data migration — which would make an untouched lead look
 * freshly worked and hide it from the follow-up alerts.
 */
function lastActivityAt(lead, latestLogAt) {
  const times = [new Date(lead.createdAt).getTime()];

  for (const remark of lead.remarks ?? []) {
    if (remark.createdAt) times.push(new Date(remark.createdAt).getTime());
  }
  for (const doc of lead.documents ?? []) {
    if (doc.createdAt) times.push(new Date(doc.createdAt).getTime());
  }
  if (latestLogAt) times.push(new Date(latestLogAt).getTime());

  const valid = times.filter((t) => Number.isFinite(t) && t > 0);
  return valid.length ? new Date(Math.max(...valid)) : null;
}

function idleDaysSince(at, now = Date.now()) {
  if (!at) return null;
  return Math.max(0, Math.floor((now - at.getTime()) / DAY_MS));
}

/** Newest activity-log timestamp per lead, in one query. */
async function latestLogAtByLead(leadIds) {
  if (!leadIds.length) return {};
  const rows = await Activity.aggregate([
    { $match: { leadId: { $in: leadIds }, type: { $in: WORK_ACTIVITY_TYPES } } },
    { $group: { _id: "$leadId", at: { $max: "$createdAt" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.at]));
}

/**
 * Adds lastActivityAt and idleDays to each lead object (plain objects, not
 * documents). Read-only: nothing is written back.
 */
async function attachIdleInfo(leads) {
  const byLead = await latestLogAtByLead(leads.map((l) => l._id));
  const now = Date.now();
  for (const lead of leads) {
    const at = lastActivityAt(lead, byLead[String(lead._id)]);
    lead.lastActivityAt = at;
    lead.idleDays = idleDaysSince(at, now);
  }
  return leads;
}

module.exports = { lastActivityAt, idleDaysSince, attachIdleInfo };
