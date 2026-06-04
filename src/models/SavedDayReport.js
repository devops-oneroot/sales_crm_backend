const mongoose = require("mongoose");

const savedDaySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userName: { type: String, required: true, trim: true },
    date: { type: String, required: true, trim: true },
    report: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true, collection: "saved_day_reports" }
);

savedDaySchema.index({ userId: 1, date: 1 }, { unique: true });
savedDaySchema.index({ date: -1, updatedAt: -1 });

module.exports = mongoose.model("SavedDayReport", savedDaySchema);
