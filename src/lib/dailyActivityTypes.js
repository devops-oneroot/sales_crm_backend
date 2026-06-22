/** Keep in sync with frontend/lib/leadOptions.ts DAILY_ACTIVITY_TYPES */
const DAILY_ACTIVITY_TYPE_IDS = [
  "new_lead",
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

module.exports = {
  DAILY_ACTIVITY_TYPE_IDS,
  LEGACY_OUTREACH_TO_DAILY,
  emptyDailyCounts,
  emptyDailyBuckets,
  isDailyActivityType,
  resolveDailyActivityType,
};
