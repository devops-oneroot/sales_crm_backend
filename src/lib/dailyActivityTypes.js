/** Keep in sync with frontend/lib/leadOptions.ts DAILY_ACTIVITY_TYPES */
const DAILY_ACTIVITY_SELECTABLE_IDS = [
  "call_initiated",
  "email",
  "whatsapp_text",
  "response",
  "meeting",
  "price_discussion",
  "payment_discussion",
  "sample_discussion",
  "negotiation",
  "sent_quotations",
  "email_reply",
  "follow_up_calls",
];

const DAILY_ACTIVITY_TYPE_IDS = ["new_lead", ...DAILY_ACTIVITY_SELECTABLE_IDS];

const LEGACY_OUTREACH_TO_DAILY = {
  outreach_call: "call_initiated",
  outreach_email: "email",
  outreach_whatsapp: "whatsapp_text",
};

function emptyDailyCounts() {
  return Object.fromEntries(
    DAILY_ACTIVITY_TYPE_IDS.map((id) => [id, 0])
  );
}

function emptyDailyBuckets() {
  return Object.fromEntries(
    DAILY_ACTIVITY_TYPE_IDS.map((id) => [id, []])
  );
}

function isDailyActivityType(type) {
  return DAILY_ACTIVITY_TYPE_IDS.includes(type);
}

function resolveDailyActivityType(activity) {
  if (activity.type === "daily_activity") {
    const type = String(activity.dailyActivityType || "").trim();
    return isDailyActivityType(type) ? type : null;
  }
  return LEGACY_OUTREACH_TO_DAILY[activity.type] || null;
}

function normalizeDailyActivitiesList(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return [
    ...new Set(
      raw
        .map((item) => String(item || "").trim())
        .filter((id) => DAILY_ACTIVITY_SELECTABLE_IDS.includes(id))
    ),
  ];
}

function leadDailyActivities(lead) {
  if (Array.isArray(lead?.dailyActivities) && lead.dailyActivities.length) {
    return normalizeDailyActivitiesList(lead.dailyActivities);
  }
  return normalizeDailyActivitiesList(lead?.dailyActivity);
}

function dailyActivitiesEqual(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

module.exports = {
  DAILY_ACTIVITY_TYPE_IDS,
  DAILY_ACTIVITY_SELECTABLE_IDS,
  LEGACY_OUTREACH_TO_DAILY,
  emptyDailyCounts,
  emptyDailyBuckets,
  isDailyActivityType,
  resolveDailyActivityType,
  normalizeDailyActivitiesList,
  leadDailyActivities,
  dailyActivitiesEqual,
};
