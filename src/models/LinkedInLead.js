const mongoose = require("mongoose");
const { LEAD_STATUSES, LEGACY_STATUSES, DEFAULT_LEAD_STATUS } = require("../lib/leadStatuses");

const linkedInLeadSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    headline: { type: String, trim: true, default: "" },
    companyName: { type: String, required: true, trim: true },
    jobTitle: { type: String, trim: true, default: "" },
    profileUrl: { type: String, required: true, trim: true },
    companyLinkedinUrl: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "United States" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    connectionStatus: {
      type: String,
      enum: [
        "not_connected",
        "connection_sent",
        "connected",
        "messaged",
        "in_discussion",
        "converted",
      ],
      default: "not_connected",
    },
    targetProducts: [{ type: String, trim: true }],
    curcuminPercent: { type: Number, min: 0 },
    quantityKg: { type: Number, min: 0 },
    notes: { type: String, trim: true, default: "" },
    outreachMessages: [
      {
        sentAt: { type: Date, default: Date.now },
        messageType: {
          type: String,
          enum: ["connection_request", "inmail", "followup", "quote"],
          default: "connection_request",
        },
        subject: { type: String, trim: true },
        text: { type: String, trim: true },
        status: { type: String, enum: ["sent", "replied"], default: "sent" },
      },
    ],
    status: {
      type: String,
      enum: [...LEAD_STATUSES, ...LEGACY_STATUSES],
      default: DEFAULT_LEAD_STATUS,
    },
    responsiblePerson: { type: String, required: true, trim: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, collection: "linkedin_leads" }
);

linkedInLeadSchema.index({
  fullName: "text",
  headline: "text",
  companyName: "text",
  location: "text",
  country: "text",
});
linkedInLeadSchema.index({ profileUrl: 1 });
linkedInLeadSchema.index({ email: 1 });

module.exports = mongoose.model("LinkedInLead", linkedInLeadSchema);

