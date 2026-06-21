const mongoose = require("mongoose");
const SavedDayReport = require("../models/SavedDayReport");
const User = require("../models/User");
const { getDailySummary } = require("./dailyActivityService");

async function getAdminUserIds() {
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  return admins.map((u) => u._id);
}

async function saveDayForUser(req, { date } = {}) {
  if (req.isAdmin) return null;

  const report = await getDailySummary(req, { date });
  const userId = new mongoose.Types.ObjectId(String(req.userId));

  const doc = await SavedDayReport.findOneAndUpdate(
    { userId, date: report.date },
    {
      userName: req.userName || report.userName || "User",
      report,
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return formatSavedDayListItem(doc);
}

function formatSavedDayListItem(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  const summary = o.report?.summary || {};
  return {
    _id: String(o._id),
    userId: String(o.userId),
    userName: o.userName,
    date: o.date,
    summary: {
      leadsAdded: summary.leadsAdded ?? 0,
      statusChanges: summary.statusChanges ?? 0,
      remarksAdded: summary.remarksAdded ?? 0,
      reassignments: summary.reassignments ?? 0,
    },
    savedAt: o.updatedAt || o.createdAt,
  };
}

async function listSavedDays(req, { userId, userName } = {}) {
  const adminIds = await getAdminUserIds();
  const filter = { userId: { $nin: adminIds } };

  if (req.isAdmin) {
    if (userId) {
      const id = new mongoose.Types.ObjectId(String(userId));
      if (adminIds.some((aid) => aid.equals(id))) return [];
      filter.userId = id;
    } else if (userName) {
      filter.userName = {
        $regex: new RegExp(
          `^${String(userName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i"
        ),
      };
    }
  } else {
    filter.userId = new mongoose.Types.ObjectId(String(req.userId));
  }

  const rows = await SavedDayReport.find(filter)
    .sort({ date: -1, updatedAt: -1 })
    .lean();

  return rows.map((row) =>
    formatSavedDayListItem({
      ...row,
      report: { summary: row.report?.summary },
    })
  );
}

async function getSavedDayById(req, id) {
  const filter = { _id: id };
  if (!req.isAdmin) {
    filter.userId = new mongoose.Types.ObjectId(String(req.userId));
  }

  const doc = await SavedDayReport.findOne(filter).lean();
  if (!doc) return null;

  const adminIds = await getAdminUserIds();
  if (adminIds.some((aid) => aid.equals(doc.userId))) return null;

  return {
    _id: String(doc._id),
    userId: String(doc.userId),
    userName: doc.userName,
    date: doc.date,
    report: doc.report,
    savedAt: doc.updatedAt || doc.createdAt,
  };
}

module.exports = { saveDayForUser, listSavedDays, getSavedDayById };
