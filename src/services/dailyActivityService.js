const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Activity = require("../models/Activity");
const User = require("../models/User");
const { leadFilterForRequest } = require("../lib/leadQuery");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dayBounds(dateStr) {
  const d =
    dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? dateStr
      : new Date().toISOString().slice(0, 10);
  const start = new Date(`${d}T00:00:00.000Z`);
  const end = new Date(`${d}T23:59:59.999Z`);
  return { start, end, date: d };
}

async function resolveTargetUser(req, responsibleName) {
  const name = String(responsibleName || "").trim();
  if (name && req.isAdmin) {
    const user = await User.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
    })
      .select("_id name")
      .lean();
    return {
      userId: user?._id ?? null,
      userName: user?.name?.trim() || name,
    };
  }
  return {
    userId: new mongoose.Types.ObjectId(String(req.userId)),
    userName: req.userName || "",
  };
}

function userMatchClause(userId, userName) {
  const clauses = [];
  if (userId) {
    clauses.push({ userId: new mongoose.Types.ObjectId(String(userId)) });
  }
  if (userName) {
    clauses.push({
      userName: { $regex: new RegExp(`^${escapeRegex(userName)}$`, "i") },
    });
  }
  return clauses.length ? { $or: clauses } : {};
}

function leadOwnerClause(userId, userName) {
  const clauses = [];
  if (userId) {
    clauses.push({
      createdBy: new mongoose.Types.ObjectId(String(userId)),
    });
  }
  if (userName) {
    clauses.push({
      responsiblePerson: {
        $regex: new RegExp(`^${escapeRegex(userName)}$`, "i"),
      },
    });
  }
  return clauses.length ? { $or: clauses } : {};
}

function formatLeadRow(lead) {
  return {
    leadId: String(lead._id),
    name: lead.name?.trim() || "—",
    company: lead.company?.trim() || "",
    contactPerson: lead.contactPerson?.trim() || "",
    status: lead.status,
    createdAt: lead.createdAt,
  };
}

async function getDailySummary(req, { date, responsible } = {}) {
  const { start, end, date: day } = dayBounds(date);
  const target = await resolveTargetUser(req, responsible);
  const baseLeadFilter = leadFilterForRequest(req);
  const ownerClause = leadOwnerClause(target.userId, target.userName);

  const leadsCreated = await Lead.find({
    ...baseLeadFilter,
    createdAt: { $gte: start, $lte: end },
    ...ownerClause,
  })
    .sort({ createdAt: -1 })
    .lean();

  const statusActivities = await Activity.find({
    type: "status_changed",
    createdAt: { $gte: start, $lte: end },
    ...userMatchClause(target.userId, target.userName),
  })
    .sort({ createdAt: -1 })
    .lean();

  const authorMatch = target.userName
    ? {
        $or: [
          {
            "remarks.author": {
              $regex: new RegExp(`^${escapeRegex(target.userName)}$`, "i"),
            },
          },
          {
            $and: [
              {
                $or: [
                  { "remarks.author": { $exists: false } },
                  { "remarks.author": null },
                  { "remarks.author": "" },
                ],
              },
              {
                responsiblePerson: {
                  $regex: new RegExp(`^${escapeRegex(target.userName)}$`, "i"),
                },
              },
            ],
          },
        ],
      }
    : {};

  const remarkAgg = await Lead.aggregate([
    { $match: baseLeadFilter },
    { $unwind: "$remarks" },
    {
      $match: {
        "remarks.createdAt": { $gte: start, $lte: end },
        ...authorMatch,
      },
    },
    { $sort: { "remarks.createdAt": -1 } },
    {
      $project: {
        remarkId: { $toString: "$remarks._id" },
        leadId: { $toString: "$_id" },
        name: "$name",
        company: "$company",
        contactPerson: "$contactPerson",
        status: "$status",
        text: "$remarks.text",
        author: "$remarks.author",
        createdAt: "$remarks.createdAt",
      },
    },
  ]);

  const statusChanges = statusActivities.map((a) => ({
    leadId: String(a.leadId),
    name: a.leadName || "—",
    company: a.company || "",
    contactPerson: a.contactPerson || "",
    fromStatus: a.fromStatus,
    toStatus: a.toStatus,
    at: a.createdAt,
  }));

  const seenRemarks = new Set();
  const remarks = [];
  for (const r of remarkAgg) {
    const text = String(r.text || "").trim();
    const remarkId = r.remarkId ? String(r.remarkId) : "";
    const dedupeKey = remarkId || `${r.leadId}:${text}`;
    if (seenRemarks.has(dedupeKey)) continue;
    seenRemarks.add(dedupeKey);

    remarks.push({
      remarkId,
      leadId: r.leadId,
      name: r.name?.trim() || "—",
      company: r.company?.trim() || "",
      contactPerson: r.contactPerson?.trim() || "",
      text,
      author: r.author,
      at: r.createdAt,
    });
  }
  remarks.sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    date: day,
    userName: target.userName,
    summary: {
      leadsAdded: leadsCreated.length,
      statusChanges: statusChanges.length,
      remarksAdded: remarks.length,
    },
    leadsAdded: leadsCreated.map(formatLeadRow),
    statusChanges,
    remarks,
  };
}

module.exports = { getDailySummary };
