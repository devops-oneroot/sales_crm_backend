const { saveDayForUser } = require("../services/savedDayService");

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Recompute and upsert today's saved report for the logged-in user. */
async function autoSaveToday(req) {
  if (!req?.userId || req.isAdmin) return;
  try {
    await saveDayForUser(req, { date: todayDateStr() });
  } catch (err) {
    console.warn("autoSaveToday:", err.message);
  }
}

module.exports = autoSaveToday;
