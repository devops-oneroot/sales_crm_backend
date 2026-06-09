const BUSINESS_TZ = "Asia/Kolkata";

function todayBusinessDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(
    new Date()
  );
}

module.exports = { todayBusinessDate, BUSINESS_TZ };
