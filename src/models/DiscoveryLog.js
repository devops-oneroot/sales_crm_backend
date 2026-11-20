const mongoose = require("mongoose");

const discoveryLogSchema = new mongoose.Schema(
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
      default: "manual",
    },
    sources: [{ type: String, trim: true }],
    filters: {
      country: { type: String, default: "Global" },
      city: { type: String, default: "" },
      importerType: { type: String, default: "All" },
    },
    // "llm" (Claude extraction) or "rules"; with the reason when rules were used.
    extraction: {
      method: { type: String, default: "" },
      note: { type: String, default: "" },
    },
    progress: {
      total: { type: Number, default: 0 },
      processed: { type: Number, default: 0 },
    },
    stats: {
      found: { type: Number, default: 0 },
      added: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      errorCount: { type: Number, default: 0 },
    },
    // One row per directory page fetched in this run.
    sourceResults: [
      {
        name: String,
        url: String,
        status: { type: String, enum: ["ok", "empty", "blocked", "error"] },
        message: String,
        found: Number,
        method: String,
      },
    ],
    errors: [{ type: String, trim: true }],
    items: [
      {
        companyName: { type: String, trim: true },
        source_url: { type: String, trim: true },
        website_domain: { type: String, trim: true },
        buyer_type: { type: String, trim: true },
        status: {
          type: String,
          enum: ["added", "duplicate", "rejected", "error"],
        },
        reason: { type: String, trim: true },
      },
    ],
    message: { type: String, trim: true },
  },
  { timestamps: true, collection: "discovery_logs", suppressReservedKeysWarning: true }
);

module.exports = mongoose.model("DiscoveryLog", discoveryLogSchema);
