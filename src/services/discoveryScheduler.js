/**
 * Daily Discovery schedule. Reads the saved schedule each time it fires, so changes
 * made in the UI take effect without a restart (reschedule() is also called on save).
 */
const DiscoverySchedule = require("../models/DiscoverySchedule");

let timer = null;

function msUntil(hhmm, now = new Date()) {
  const [h, m] = String(hhmm || "05:00").split(":").map((n) => parseInt(n, 10) || 0);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function reschedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const schedule = await DiscoverySchedule.findOne();
  if (!schedule?.enabled) {
    if (schedule) await DiscoverySchedule.updateOne({ _id: schedule._id }, { $unset: { nextRunAt: 1 } });
    return null;
  }
  const delay = msUntil(schedule.scheduledTime);
  const nextRunAt = new Date(Date.now() + delay);
  await DiscoverySchedule.updateOne({ _id: schedule._id }, { $set: { nextRunAt } });
  timer = setTimeout(fire, delay);
  console.log(`[Discovery] Daily run scheduled for ${nextRunAt.toISOString()}`);
  return nextRunAt;
}

async function fire() {
  // Lazy require avoids a circular import with discoveryService.
  const { startDiscoveryRun, isRunActive } = require("./discoveryService");
  try {
    const s = await DiscoverySchedule.findOne();
    if (s?.enabled && !isRunActive()) {
      const kinds = Object.entries(s.kinds?.toObject?.() || s.kinds || {})
        .filter(([, on]) => on)
        .map(([k]) => k);
      await startDiscoveryRun({
        kinds,
        country: s.filters?.country || "Global",
        city: s.filters?.city || "",
        importerType: s.filters?.importerType || "All",
        triggerType: "scheduled",
      });
    }
  } catch (err) {
    console.error("[Discovery] Scheduled run failed to start:", err.message);
  }
  await reschedule().catch(() => {});
}

module.exports = { reschedule, msUntil };
