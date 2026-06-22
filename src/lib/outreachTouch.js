const { todayBusinessDate } = require("./businessDate");
const { logActivity } = require("./logActivity");

function followUpDateOnly(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readFollowUpLog(lead, today) {
  const log = lead?.followUpLog;
  if (!log || String(log.date || "") !== today) {
    return { date: today, logged: false };
  }
  return { date: today, logged: Boolean(log.logged) };
}

/**
 * Log when user adds or changes a lead's follow-up date (once per lead per day).
 */
async function applyFollowUpLog(req, existing, rawFollowUpDate, leadAfterUpdate) {
  const today = todayBusinessDate();
  const prevDay = followUpDateOnly(existing.followUpDate);

  let nextDay = prevDay;
  if (rawFollowUpDate !== undefined) {
    nextDay = rawFollowUpDate ? followUpDateOnly(rawFollowUpDate) : "";
  }

  if (!nextDay || nextDay === prevDay) {
    return { nextDay, followUpLog: readFollowUpLog(existing, today), logged: false };
  }

  const current = readFollowUpLog(existing, today);
  if (current.logged) {
    return { nextDay, followUpLog: current, logged: false };
  }

  const lead = leadAfterUpdate;
  await logActivity({
    type: "follow_up_set",
    userId: req.userId,
    userName: req.userName,
    lead,
    followUpDate: nextDay,
  });

  return {
    nextDay,
    followUpLog: { date: today, logged: true },
    logged: true,
  };
}

function followUpIso(lead) {
  const day = followUpDateOnly(lead?.followUpDate);
  return day ? `${day}T00:00:00.000Z` : "";
}

module.exports = {
  applyFollowUpLog,
  followUpIso,
  followUpDateOnly,
};
