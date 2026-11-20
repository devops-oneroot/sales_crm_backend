const mongoose = require("mongoose");

const emailMessageSchema = new mongoose.Schema(
  {
    importerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Importer",
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
      default: "outbound",
    },
    senderEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    senderName: {
      type: String,
      trim: true,
      default: "",
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    recipientName: {
      type: String,
      trim: true,
      default: "",
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
    },
    snippet: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["unread", "read", "sent", "delivered", "failed", "bounced"],
      default: "sent",
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    receivedAt: {
      type: Date,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    userName: {
      type: String,
      trim: true,
      default: "",
    },
    tags: [{ type: String, trim: true }],
    inReplyTo: {
      type: String,
      trim: true,
    },
    // Real email threading / tracking
    messageId: { type: String, trim: true, index: true }, // RFC 5322 Message-ID
    references: [{ type: String, trim: true }],
    inboxEmail: { type: String, trim: true, lowercase: true }, // sending/receiving inbox
    outreachStep: { type: Number }, // 1 = Email #1, 2 = Email #2
    classification: { type: String, trim: true }, // reply | bounce | auto_reply | unsubscribe
    error: { type: String, trim: true },
  },
  { timestamps: true, collection: "email_messages" }
);

emailMessageSchema.index({ importerId: 1, createdAt: 1 });
emailMessageSchema.index({ recipientEmail: 1 });
emailMessageSchema.index({ senderEmail: 1 });

module.exports = mongoose.model("EmailMessage", emailMessageSchema);

