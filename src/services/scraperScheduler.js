const { runTurmericImporterScraper } = require("./turmericScraperService");

let dailyTimerId = null;

/**
 * Calculates milliseconds until the next target hour & minute
 * Default: 05:00 AM
 */
function getMsUntilNextRun(targetHour = 5, targetMinute = 0) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);

  if (now.getTime() >= next.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * Starts the daily automated scraper schedule
 */
function startScraperScheduler() {
  const targetHour = parseInt(process.env.SCRAPER_RUN_HOUR || "5", 10);
  const targetMinute = parseInt(process.env.SCRAPER_RUN_MINUTE || "0", 10);

  const msUntilFirstRun = getMsUntilNextRun(targetHour, targetMinute);
  const hoursUntil = (msUntilFirstRun / (1000 * 60 * 60)).toFixed(1);

  console.log(
    `🤖 [Scraper Scheduler] Initialized daily auto-scraper. Next run in ~${hoursUntil} hours (at ${String(
      targetHour
    ).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")}).`
  );

  // Schedule first run
  dailyTimerId = setTimeout(async function runAndReschedule() {
    console.log(
      `⏰ [Scraper Scheduler] Executing scheduled daily turmeric importer scraping...`
    );
    try {
      await runTurmericImporterScraper({ triggerType: "scheduled" });
    } catch (err) {
      console.error(
        `❌ [Scraper Scheduler] Error during scheduled scrape:`,
        err.message
      );
    }

    // Schedule next run in 24 hours
    const msUntilNext = getMsUntilNextRun(targetHour, targetMinute);
    dailyTimerId = setTimeout(runAndReschedule, msUntilNext);
  }, msUntilFirstRun);
}

function stopScraperScheduler() {
  if (dailyTimerId) {
    clearTimeout(dailyTimerId);
    dailyTimerId = null;
    console.log(`⏹️ [Scraper Scheduler] Scheduler stopped.`);
  }
}

module.exports = {
  startScraperScheduler,
  stopScraperScheduler,
};

