const { todayBusinessDate } = require("./businessDate");
const { logActivity } = require("./logActivity");

const TOUCH_TYPES = {
  call: "outreach_call",
  email: "outreach_email",
  whatsapp: "outreach_whatsapp",
};

function emptyOutreachLog(date) {
  return {
    date,
    call: false,
    email: false,
    whatsapp: false,
  };
}

function readOutreachLog(lead, today) {
  const log = lead?.outreachLog;
  if (!log || String(log.date || "") !== today) {
    return emptyOutreachLog(today);
  }
  return {
    date: today,
    call: Boolean(log.call),
    email: Boolean(log.email),
    whatsapp: Boolean(log.whatsapp),
  };
}

/**
 * Apply touch checkboxes from PATCH body. Logs each channel once per lead per day.
 */
async function applyOutreachTouches(req, existing, body, leadAfterUpdate) {
  const today = todayBusinessDate();
  const requested = {
    call: Boolean(body.touchCall),
    email: Boolean(body.touchEmail),
    whatsapp: Boolean(body.touchWhatsapp),
  };

  const current = readOutreachLog(existing, today);
  const next = { ...current };
  const toLog = [];

  for (const [key, activityType] of Object.entries(TOUCH_TYPES)) {
    if (requested[key] && !current[key]) {
      next[key] = true;
      toLog.push(activityType);
    }
  }

  const lead = leadAfterUpdate;
  for (const type of toLog) {
    await logActivity({
      type,
      userId: req.userId,
      userName: req.userName,
      lead,
    });
  }

  return next;
}

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
  applyOutreachTouches,
  applyFollowUpLog,
  followUpIso,
  followUpDateOnly,
  readOutreachLog,
  TOUCH_TYPES,
};
