const mongoose = require("mongoose");

/**
 * A public page Discovery crawls for buyer companies: a trade-fair exhibitor list,
 * an association member directory, or a buy-lead listing. Managed from the UI.
 */
const SOURCE_KINDS = ["trade_fair", "association", "buy_leads"];

const discoverySourceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      validate: {
        validator: (v) => /^https?:\/\//i.test(v),
        message: "Source URL must start with http:// or https://",
      },
    },
    kind: { type: String, enum: SOURCE_KINDS, required: true },
    // Country the list covers, or "" for international lists.
    country: { type: String, trim: true, default: "" },
    enabled: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: "" },

    // Outcome of the most recent fetch, shown in the UI.
    lastRunAt: { type: Date },
    lastStatus: { type: String, enum: ["ok", "empty", "blocked", "error", ""], default: "" },
    lastMessage: { type: String, trim: true, default: "" },
    lastFound: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "discovery_sources" }
);

module.exports = mongoose.model("DiscoverySource", discoverySourceSchema);
module.exports.SOURCE_KINDS = SOURCE_KINDS;
