const mongoose = require("mongoose");

const linkedInAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    accountName: { type: String, required: true, trim: true },
    accountEmail: { type: String, trim: true, lowercase: true, default: "" },
    profileUrl: { type: String, trim: true, default: "" },
    headline: { type: String, trim: true, default: "" },
    authMethod: {
      type: String,
      enum: ["session_cookie", "oauth", "api_key"],
      default: "session_cookie",
    },
    // Standard LinkedIn session cookie (li_at) used by sales automation tools
    sessionCookie: { type: String, trim: true, default: "" },
    // Optional RapidAPI / Proxycurl key for live public search
    apiKey: { type: String, trim: true, default: "" },
    // Optional OAuth access token
    accessToken: { type: String, trim: true, default: "" },
    isConnected: { type: Boolean, default: true },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
    totalLeadsFetched: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "linkedin_accounts" }
);

module.exports = mongoose.model("LinkedInAccount", linkedInAccountSchema);

