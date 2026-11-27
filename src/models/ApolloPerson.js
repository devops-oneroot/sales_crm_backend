const mongoose = require("mongoose");

/**
 * Apollo.io lookups we've already paid for or run, so the same company search
 * or person reveal is never charged twice.
 *  - kind "search": one company search (free in Apollo, cached to save time)
 *  - kind "person": one revealed person (costs 1 Apollo credit)
 */
const apolloPersonSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["search", "person"], required: true },
    key: { type: String, required: true }, // search: query key; person: Apollo id
    data: { type: mongoose.Schema.Types.Mixed },
    revealedBy: { type: String, trim: true },
  },
  { timestamps: true }
);
apolloPersonSchema.index({ kind: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("ApolloPerson", apolloPersonSchema);
