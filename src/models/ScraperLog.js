const mongoose = require("mongoose");

const scraperLogSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    status: {
      type: String,
      enum: ["running", "completed", "failed"],
      default: "running",
    },
    triggerType: {
      type: String,
      enum: ["scheduled", "manual"],
      default: "scheduled",
    },
    sourcesAttempted: [{ type: String, trim: true }],
    totalFound: { type: Number, default: 0 },
    newAdded: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    newImporters: [{ type: String, trim: true }],
    message: { type: String, trim: true },
    error: { type: String, trim: true },
  },
  { timestamps: true, collection: "scraper_logs" }
);

module.exports = mongoose.model("ScraperLog", scraperLogSchema);

