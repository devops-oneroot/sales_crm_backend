const mongoose = require("mongoose");

/** Addresses (or whole domains) that must never be emailed. Checked before every send. */
const suppressionSchema = new mongoose.Schema(
  {
    // A full address ("jan@firm.com") or a domain ("@firm.com").
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    reason: {
      type: String,
      enum: ["unsubscribed", "bounced", "complaint", "manual"],
      required: true,
    },
    note: { type: String, trim: true, default: "" },
    importerId: { type: mongoose.Schema.Types.ObjectId, ref: "Importer" },
    addedBy: { type: String, trim: true, default: "System" },
  },
  { timestamps: true, collection: "suppressions" }
);

/** True if the address or its domain is suppressed. */
suppressionSchema.statics.isSuppressed = async function (email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  const domain = "@" + e.split("@")[1];
  return Boolean(await this.exists({ email: { $in: [e, domain] } }));
};

module.exports = mongoose.model("Suppression", suppressionSchema);
