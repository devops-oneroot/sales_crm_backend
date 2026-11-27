const mongoose = require("mongoose");

/**
 * One LinkedIn message queued from the CRM and sent through Unipile by the
 * background sender (a few a day, spaced out — see unipileService).
 */
const linkedInMessageSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
    company: { type: String, trim: true },
    contactName: { type: String, trim: true },
    profileUrl: { type: String, trim: true, required: true },
    text: { type: String, required: true },
    /** Short note sent with the connection request (LinkedIn max 300 chars). */
    note: { type: String, trim: true },
    /**
     * queued → waiting for its turn
     * sent → direct message delivered (already a 1st-degree connection)
     * invited → not connected yet, so a connection request with a short note went out
     * accepted → they accepted; the full message is next (auto-send or "Send now")
     * failed / cancelled
     */
    status: {
      type: String,
      enum: ["queued", "sent", "invited", "accepted", "failed", "cancelled"],
      default: "queued",
      index: true,
    },
    providerId: { type: String, trim: true },
    chatId: { type: String, trim: true },
    error: { type: String, trim: true },
    sentAt: { type: Date, index: true },
    invitedAt: { type: Date },
    acceptedAt: { type: Date },
    /** Last time we checked whether the request was accepted. */
    checkedAt: { type: Date },
    /** Earliest time the next message may go out (random gap after this one). */
    nextAllowedAt: { type: Date },
    queuedBy: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LinkedInMessage", linkedInMessageSchema);
