const mongoose = require("mongoose");
const Activity = require("../models/Activity");
const Lead = require("../models/Lead");
const User = require("../models/User");
const { BUSINESS_TZ } = require("../lib/businessDate");
const { leadFilterForRequest } = require("../lib/leadQuery");

const OUTREACH_ACTIVITY_TYPES = [
  "outreach_call",
  "outreach_email",
  "outreach_whatsapp",
  "follow_up_set",
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function businessDateFromInstant(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(
    date
  );
}

function dayBounds(dateStr) {
  const d =
    dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? dateStr
      : businessDateFromInstant(new Date());
  const start = new Date(`${d}T00:00:00.000Z`);
  const end = new Date(`${d}T23:59:59.999Z`);
  return { start, end, date: d };
}

function listDatesInclusive(fromDate, toDate) {
  const dates = [];
  const cursor = new Date(`${fromDate}T12:00:00.000Z`);
  const end = new Date(`${toDate}T12:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function rowKey(date, userName) {
  return `${date}|${userName.toLowerCase()}`;
}

function ensureRow(map, date, userName) {
  const key = rowKey(date, userName);
  if (!map.has(key)) {
    map.set(key, {
      date,
      userName,
      calls: 0,
      emails: 0,
      whatsapp: 0,
      newLeads: 0,
      followUps: 0,
    });
  }
  return map.get(key);
}

function matchesUserFilter(userName, filterName) {
  if (!filterName) return true;
  return (
    userName.toLowerCase() === String(filterName).trim().toLowerCase()
  );
}

function activityToLeadRow(activity) {
  return {
    leadId: String(activity.leadId),
    name: activity.leadName?.trim() || activity.company?.trim() || "—",
    company: activity.company?.trim() || "",
    contactPerson: activity.contactPerson?.trim() || "",
    at: activity.createdAt,
    followUpDate: activity.followUpDate?.trim() || undefined,
  };
}

function leadDocToRow(lead) {
  return {
    leadId: String(lead._id),
    name: lead.name?.trim() || lead.company?.trim() || "—",
    company: lead.company?.trim() || "",
    contactPerson: lead.contactPerson?.trim() || "",
    at: lead.createdAt,
  };
}

function userNameRegex(name) {
  return new RegExp(`^${escapeRegex(String(name || "").trim())}$`, "i");
}

async function getOutreachDetail(req, { date, userName } = {}) {
  const dateStr =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : businessDateFromInstant(new Date());
  const name = String(userName || req.userName || "").trim();
  if (!name) {
    return null;
  }

  if (
    !req.isAdmin &&
    name.toLowerCase() !== String(req.userName || "").trim().toLowerCase()
  ) {
    return null;
  }

  const { start, end } = dayBounds(dateStr);
  const namePattern = userNameRegex(name);

  const activities = await Activity.find({
    type: { $in: OUTREACH_ACTIVITY_TYPES },
    userName: { $regex: namePattern },
    createdAt: { $gte: start, $lte: end },
  })
    .sort({ createdAt: -1 })
    .lean();

  const calls = [];
  const emails = [];
  const whatsapp = [];
  const followUps = [];

  for (const activity of activities) {
    const activityDate = businessDateFromInstant(new Date(activity.createdAt));
    if (activityDate !== dateStr) continue;

    const row = activityToLeadRow(activity);
    switch (activity.type) {
      case "outreach_call":
        calls.push(row);
        break;
      case "outreach_email":
        emails.push(row);
        break;
      case "outreach_whatsapp":
        whatsapp.push(row);
        break;
      case "follow_up_set":
        followUps.push(row);
        break;
      default:
        break;
    }
  }

  const baseLeadFilter = leadFilterForRequest(req);
  const newLeadDocs = await Lead.find({
    ...baseLeadFilter,
    responsiblePerson: { $regex: namePattern },
    createdAt: { $gte: start, $lte: end },
  })
    .select("name company contactPerson createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const newLeads = newLeadDocs
    .filter(
      (lead) =>
        businessDateFromInstant(new Date(lead.createdAt)) === dateStr
    )
    .map(leadDocToRow);

  return {
    date: dateStr,
    userName: name,
    calls,
    emails,
    whatsapp,
    newLeads,
    followUps,
  };
}

async function getOutreachTable(req, { from, to, userName: userFilter } = {}) {
  const endBounds = dayBounds(to);
  const fromDate =
    from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : endBounds.date;
  const toDate = endBounds.date;
  const rangeStart = new Date(`${fromDate}T00:00:00.000Z`);
  const rangeEnd = new Date(`${toDate}T23:59:59.999Z`);

  const salesUsers = await User.find({ role: "sales" })
    .select("name")
    .sort({ name: 1 })
    .lean();
  const teamNames = salesUsers
    .map((u) => u.name?.trim())
    .filter(Boolean);

  const effectiveFilter = req.isAdmin
    ? userFilter?.trim() || ""
    : req.userName?.trim() || "";

  const rows = new Map();

  for (const name of teamNames) {
    if (!matchesUserFilter(name, effectiveFilter)) continue;
    for (const date of listDatesInclusive(fromDate, toDate)) {
      ensureRow(rows, date, name);
    }
  }

  const activities = await Activity.find({
    type: { $in: OUTREACH_ACTIVITY_TYPES },
    createdAt: { $gte: rangeStart, $lte: rangeEnd },
  }).lean();

  for (const activity of activities) {
    const name = activity.userName?.trim();
    if (!name) continue;
    if (!matchesUserFilter(name, effectiveFilter)) continue;

    const date = businessDateFromInstant(new Date(activity.createdAt));
    if (date < fromDate || date > toDate) continue;

    const row = ensureRow(rows, date, name);
    switch (activity.type) {
      case "outreach_call":
        row.calls += 1;
        break;
      case "outreach_email":
        row.emails += 1;
        break;
      case "outreach_whatsapp":
        row.whatsapp += 1;
        break;
      case "follow_up_set":
        row.followUps += 1;
        break;
      default:
        break;
    }
  }

  const baseLeadFilter = leadFilterForRequest(req);
  const newLeads = await Lead.find({
    ...baseLeadFilter,
    createdAt: { $gte: rangeStart, $lte: rangeEnd },
  })
    .select("createdAt responsiblePerson")
    .lean();

  for (const lead of newLeads) {
    const name = lead.responsiblePerson?.trim();
    if (!name) continue;
    if (!matchesUserFilter(name, effectiveFilter)) continue;

    const date = businessDateFromInstant(new Date(lead.createdAt));
    if (date < fromDate || date > toDate) continue;

    const row = ensureRow(rows, date, name);
    row.newLeads += 1;
  }

  const result = [...rows.values()].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.userName.localeCompare(b.userName);
  });

  return {
    from: fromDate,
    to: toDate,
    rows: result,
  };
}

module.exports = { getOutreachTable, getOutreachDetail };
