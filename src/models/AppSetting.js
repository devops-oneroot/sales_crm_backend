const mongoose = require("mongoose");

/** Small key → value settings changed from the CRM (e.g. LinkedIn auto-send on/off). */
const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AppSetting", appSettingSchema);
