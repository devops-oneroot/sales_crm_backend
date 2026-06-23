const Activity = require("../models/Activity");
const Lead = require("../models/Lead");
const User = require("../models/User");
const { BUSINESS_TZ } = require("../lib/businessDate");
const { leadFilterForRequest } = require("../lib/leadQuery");
const {
  DAILY_ACTIVITY_TYPE_IDS,
  emptyDailyBuckets,
  emptyDailyCounts,
  resolveDailyActivityType,
} = require("../lib/dailyActivityTypes");

const OUTREACH_ACTIVITY_TYPES = [
  "daily_activity",
  "follow_up_set",
  "outreach_call",
  "outreach_email",
  "outreach_whatsapp",
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
      followUps: 0,
      daily: emptyDailyCounts(),
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
    dailyActivityType: activity.dailyActivityType?.trim() || undefined,
    remarkText: activity.remarkText?.trim() || undefined,
  };
}

function leadDocToRow(lead) {
  return {
    leadId: String(lead._id),
    name: lead.name?.trim() || lead.company?.trim() || "—",
    company: lead.company?.trim() || "",
    contactPerson: lead.contactPerson?.trim() || "",
    at: lead.createdAt,
    dailyActivityType: "new_lead",
  };
}

function userNameRegex(name) {
  return new RegExp(`^${escapeRegex(String(name || "").trim())}$`, "i");
}

function applyActivityToBuckets(activity, buckets) {
  if (activity.type === "follow_up_set") {
    buckets.followUps.push(activityToLeadRow(activity));
    return;
  }

  const dailyType = resolveDailyActivityType(activity);
  if (!dailyType) return;

  buckets.daily[dailyType].push(activityToLeadRow(activity));
}

function applyActivityToRowCounts(activity, row) {
  if (activity.type === "follow_up_set") {
    row.followUps += 1;
    return;
  }

  const dailyType = resolveDailyActivityType(activity);
  if (dailyType) row.daily[dailyType] += 1;
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

  const buckets = {
    followUps: [],
    daily: emptyDailyBuckets(),
  };

  for (const activity of activities) {
    const activityDate = businessDateFromInstant(new Date(activity.createdAt));
    if (activityDate !== dateStr) continue;
    applyActivityToBuckets(activity, buckets);
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

  for (const lead of newLeadDocs) {
    if (businessDateFromInstant(new Date(lead.createdAt)) !== dateStr) continue;
    const row = leadDocToRow(lead);
    const duplicate = buckets.daily.new_lead.some(
      (item) => item.leadId === row.leadId
    );
    if (!duplicate) buckets.daily.new_lead.push(row);
  }

  return {
    date: dateStr,
    userName: name,
    followUps: buckets.followUps,
    daily: buckets.daily,
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
    applyActivityToRowCounts(activity, row);
  }

  const baseLeadFilter = leadFilterForRequest(req);
  const newLeadDocs = await Lead.find({
    ...baseLeadFilter,
    createdAt: { $gte: rangeStart, $lte: rangeEnd },
  })
    .select("createdAt responsiblePerson")
    .lean();

  for (const lead of newLeadDocs) {
    const name = lead.responsiblePerson?.trim();
    if (!name) continue;
    if (!matchesUserFilter(name, effectiveFilter)) continue;

    const date = businessDateFromInstant(new Date(lead.createdAt));
    if (date < fromDate || date > toDate) continue;

    const row = ensureRow(rows, date, name);
    row.daily.new_lead += 1;
  }

  const assigneeNames = await Lead.distinct("responsiblePerson", {
    ...baseLeadFilter,
    responsiblePerson: { $exists: true, $nin: [null, ""] },
  });

  const userNames = [
    ...new Set(
      [
        ...teamNames,
        ...assigneeNames.map((n) => String(n || "").trim()).filter(Boolean),
        ...activities
          .map((a) => a.userName?.trim())
          .filter(Boolean),
      ]
    ),
  ].sort((a, b) => a.localeCompare(b));

  const result = [...rows.values()].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.userName.localeCompare(b.userName);
  });

  return {
    from: fromDate,
    to: toDate,
    dailyActivityTypes: DAILY_ACTIVITY_TYPE_IDS,
    userNames,
    rows: result,
  };
}

module.exports = { getOutreachTable, getOutreachDetail };
