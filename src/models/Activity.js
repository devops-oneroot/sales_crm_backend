const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "lead_created",
        "status_changed",
        "remark_added",
        "daily_activity",
      ],
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userName: { type: String, trim: true, default: "" },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
    },
    leadName: { type: String, trim: true, default: "" },
    contactPerson: { type: String, trim: true, default: "" },
    company: { type: String, trim: true, default: "" },
    fromStatus: { type: String, trim: true },
    toStatus: { type: String, trim: true },
    remarkText: { type: String, trim: true },
    dailyActivityType: { type: String, trim: true },
  },
  { timestamps: true, collection: "activities" }
);

activitySchema.index({ userId: 1, createdAt: -1 });
activitySchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model("Activity", activitySchema);
