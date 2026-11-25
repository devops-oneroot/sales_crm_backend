const mongoose = require("mongoose");

/**
 * Full copy of a lead or importer taken just before it is merged away or
 * deleted from the duplicate review, so nothing is ever lost and it can be
 * restored later.
 */
const archivedRecordSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["lead", "importer"], required: true, index: true },
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    title: { type: String, trim: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    reason: { type: String, enum: ["merged", "deleted"], required: true },
    // For merges: the lead/importer the data was folded into.
    mergedInto: { type: mongoose.Schema.Types.ObjectId },
    // Lead archive rows point at their importer's archive row (restored together).
    relatedArchiveId: { type: mongoose.Schema.Types.ObjectId },
    archivedBy: { type: String, trim: true },
    restoredAt: { type: Date },
    restoredBy: { type: String, trim: true },
  },
  { timestamps: true, collection: "archived_records" }
);

module.exports = mongoose.model("ArchivedRecord", archivedRecordSchema);
