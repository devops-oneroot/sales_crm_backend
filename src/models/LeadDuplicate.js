const mongoose = require("mongoose");

/**
 * A pair of leads flagged as possible duplicates. Nothing happens to the leads
 * until a user decides:
 *  - open:      waiting for a decision
 *  - dismissed: "not a duplicate" — never flagged again for this pair
 *  - resolved:  merged or one deleted (both archived first, see ArchivedRecord)
 */
const leadDuplicateSchema = new mongoose.Schema(
  {
    // Always stored with leadA < leadB so a pair exists only once.
    leadA: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },
    leadB: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },
    reasons: [{ type: String, trim: true }], // name | phone | email | website
    status: {
      type: String,
      enum: ["open", "dismissed", "resolved"],
      default: "open",
      index: true,
    },
    resolution: { type: String, trim: true }, // merged | deleted | dismissed
    resolvedBy: { type: String, trim: true },
    resolvedAt: { type: Date },
  },
  { timestamps: true, collection: "lead_duplicates" }
);

leadDuplicateSchema.index({ leadA: 1, leadB: 1 }, { unique: true });
leadDuplicateSchema.index({ leadB: 1 });

module.exports = mongoose.model("LeadDuplicate", leadDuplicateSchema);
