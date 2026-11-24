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
      enum: ["unread", "read", "sent", "delivered", "failed", "bounced", "opened", "clicked"],
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
    // Mailchimp-Grade Open & Click Tracking
    trackingId: { type: String, trim: true, unique: true, sparse: true, index: true },
    openCount: { type: Number, default: 0 },
    firstOpenedAt: { type: Date },
    lastOpenedAt: { type: Date },
    isOpenAppleMpp: { type: Boolean, default: false }, // Flagged when pre-loaded by Apple Mail Privacy Protection proxy
    inferredFromClick: { type: Boolean, default: false }, // Inferred open if recipient had images disabled but clicked a link
    opens: [
      {
        timestamp: { type: Date, default: Date.now },
        ip: { type: String, trim: true },
        userAgent: { type: String, trim: true },
        isAppleMpp: { type: Boolean, default: false },
        inferredFromClick: { type: Boolean, default: false },
        isBot: { type: Boolean, default: false }, // security scanner / prefetch — not counted as a human open
        botReason: { type: String, trim: true },
      },
    ],
    botOpenCount: { type: Number, default: 0 },
    // Hits on the invisible honeypot link — only automated scanners follow it
    scannerHits: [
      {
        timestamp: { type: Date, default: Date.now },
        ip: { type: String, trim: true },
        userAgent: { type: String, trim: true },
      },
    ], // pixel loads filtered out as scanners/prefetch
    clickCount: { type: Number, default: 0 },
    firstClickedAt: { type: Date },
    lastClickedAt: { type: Date },
    clicks: [
      {
        url: { type: String, trim: true },
        timestamp: { type: Date, default: Date.now },
        ip: { type: String, trim: true },
        userAgent: { type: String, trim: true },
        isBot: { type: Boolean, default: false },
        botReason: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true, collection: "email_messages" }
);

emailMessageSchema.index({ importerId: 1, createdAt: 1 });
emailMessageSchema.index({ recipientEmail: 1 });
emailMessageSchema.index({ senderEmail: 1 });

module.exports = mongoose.model("EmailMessage", emailMessageSchema);

