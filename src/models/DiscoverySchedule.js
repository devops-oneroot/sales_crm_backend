const mongoose = require("mongoose");

const discoveryScheduleSchema = new mongoose.Schema(
  {
    // Off by default: a daily crawl fetches many pages and spends Claude credit.
    enabled: { type: Boolean, default: false },
    scheduledTime: { type: String, default: "05:00" }, // HH:MM, UTC
    timezone: { type: String, default: "UTC" },
    kinds: {
      trade_fair: { type: Boolean, default: true },
      association: { type: Boolean, default: true },
      buy_leads: { type: Boolean, default: true },
    },
    filters: {
      country: { type: String, default: "Global" },
      city: { type: String, default: "" },
      importerType: { type: String, default: "All" },
    },
    schemaVersion: { type: Number, default: 2 },
    lastRunAt: { type: Date },
    nextRunAt: { type: Date },
  },
  { timestamps: true, collection: "discovery_schedules" }
);

module.exports = mongoose.model("DiscoverySchedule", discoveryScheduleSchema);
