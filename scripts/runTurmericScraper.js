const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { runTurmericImporterScraper } = require("../src/services/turmericScraperService");

async function run() {
  await connectDB();
  console.log("🌐 Triggering manual turmeric importers scrape...");
  const result = await runTurmericImporterScraper({ triggerType: "manual" });
  console.log("Scrape Results:", JSON.stringify(result, null, 2));
}

run()
  .catch((err) => {
    console.error("Scrape failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });

