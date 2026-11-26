const mongoose = require("mongoose");
const {
  PIPELINE_STATUSES,
  SOURCE_TYPES,
  EMAIL_STATUSES,
  VERIFICATION_GRADES,
  LINKEDIN_TASK_STATUSES,
  normalizeDomain,
  validateImporterProvenance,
} = require("../lib/importerProvenance");

const importerSchema = new mongoose.Schema(
  {
    // Core Profile Info
    importerName: { type: String, required: true, trim: true },
    companyName: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    // Optional: many real sources list no phone. Never pad with a placeholder.
    importerNumber: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    country: { type: String, trim: true, default: "United States" },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true }, // pincode / ZIP (synced with the lead)
    city: { type: String, trim: true },
    address: { type: String, trim: true },

    // Provenance (MANDATORY: Never invent lead data).
    // No defaults: a record that arrives without these is rejected, not back-filled.
    // Immutable: provenance describes where the record came from and never changes.
    source_url: {
      type: String,
      required: [true, "source_url is required for lead provenance"],
      trim: true,
      index: true,
      immutable: true,
    },
    fetched_at: {
      type: Date,
      required: [true, "fetched_at is required for lead provenance"],
      index: true,
      immutable: true,
    },
    source_type: {
      type: String,
      enum: SOURCE_TYPES,
      required: [true, "source_type is required for lead provenance"],
      index: true,
      immutable: true,
    },
    // The fetched text (page text, API response, CSV row) contacts were extracted from.
    raw_extracted_text: { type: String, immutable: true },
    website_domain: { type: String, trim: true, index: true },
    // Discovery: which directory the company was found in, and why it counts as a buyer.
    discovery_source_name: { type: String, trim: true },
    buyer_type: { type: String, trim: true, index: true },
    buyer_evidence: { type: String, trim: true }, // verbatim quote from fetched text
    website_url_fetched: { type: String, trim: true }, // company page fetched for the buyer check
    contact_source_url: { type: String, trim: true }, // page the email/phone was read from
    contact_found_at: { type: Date },
    contact_evidence: { type: String }, // page excerpt(s) containing the found email/phone

    // Verification & Scoring
    website_live: { type: Boolean, default: false },
    website_status_code: { type: Number },
    email_status: {
      type: String,
      enum: EMAIL_STATUSES,
      default: "unverified",
      index: true,
    },
    verification_score: { type: Number, default: 0, min: 0, max: 100 },
    verification_grade: {
      type: String,
      enum: VERIFICATION_GRADES,
      default: "Unrated",
      index: true,
    },
    verification_checked_at: { type: Date },
    email_check_detail: { type: String, trim: true }, // e.g. "neverbounce: valid", "domain has no mail server"
    email_check_method: { type: String, trim: true }, // neverbounce | zerobounce | dns | syntax | none
    website_check_detail: { type: String, trim: true }, // e.g. "HTTP 200", "Timed out"

    // Pipeline Status & Timeline
    pipeline_status: {
      type: String,
      enum: PIPELINE_STATUSES,
      default: "New",
      index: true,
    },
    timeline: [
      {
        status: { type: String, required: true },
        note: { type: String, trim: true },
        changed_by: { type: String, default: "System" },
        timestamp: { type: Date, default: Date.now },
      },
    ],

    // Outreach Sequence Configuration & Tracking
    outreach_enrolled: { type: Boolean, default: false, index: true },
    outreach_step: { type: Number, default: 0 },
    outreach_wait_hours: { type: Number, default: 48, min: 24, max: 72 },
    email_1_sent_at: { type: Date },
    email_2_scheduled_at: { type: Date },
    email_2_sent_at: { type: Date },
    thread_message_id: { type: String, trim: true },
    recipient_timezone: { type: String, default: "UTC" },
    unsubscribed: { type: Boolean, default: false, index: true },
    suppressed: { type: Boolean, default: false, index: true },
    reply_detected_at: { type: Date },
    bounce_detected_at: { type: Date },
    // Sequence state: scheduled → waiting_followup → completed, or stopped early.
    outreach_status: {
      type: String,
      enum: ["", "scheduled", "waiting_followup", "completed", "replied", "bounced", "unsubscribed", "stopped", "blocked"],
      default: "",
      index: true,
    },
    outreach_next_send_at: { type: Date, index: true },
    outreach_inbox: { type: String, trim: true, lowercase: true }, // inbox used for the thread
    outreach_subject: { type: String, trim: true },
    outreach_message_ids: [{ type: String, trim: true }], // our Message-IDs, to match replies
    outreach_last_error: { type: String, trim: true },
    outreach_enrolled_at: { type: Date },

    // LinkedIn Outreach Queue
    linkedin_short_message: { type: String, trim: true, maxlength: 299 },
    linkedin_task_status: {
      type: String,
      enum: LINKEDIN_TASK_STATUSES,
      default: "to_send",
      index: true,
    },
    linkedin_task_due: { type: Date },
    linkedin_sent_at: { type: Date },
    linkedin_replied_at: { type: Date },

    // Business & Trade Specs (Preserved for existing features)
    taxIdOrIec: { type: String, trim: true },
    importerType: { type: String, trim: true },
    products: [{ type: String, trim: true }],
    materialType: { type: String, trim: true },
    polishLevel: { type: String, trim: true },
    curcuminPercent: { type: Number, min: 0 },
    grade: { type: String, trim: true },
    price: { type: Number, min: 0 },
    quantityKg: { type: Number, min: 0 },
    incoterm: { type: String, trim: true },
    portOfLoading: { type: String, trim: true },
    portOfDischarge: { type: String, trim: true },
    paymentTerms: { type: String, trim: true },
    paymentDays: { type: Number, min: 0 },
    remarks: { type: String, trim: true },
    // Lead this importer is mirrored with (for importers not created from a lead,
    // e.g. CSV import / manual entry). Lead-created importers link via source_url.
    linked_lead_id: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
    // Free-form, user-defined labels (e.g. "Focus", "Active") for segmenting the pipeline
    tags: { type: [{ type: String, trim: true }], default: [], index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    responsiblePerson: { type: String, required: true, trim: true },
    followUpDate: { type: Date },
    // Backwards-compatible legacy status
    status: { type: String, default: "New" },
  },
  { timestamps: true, collection: "importers" }
);

// Derive website_domain (dedupe key) and enforce provenance rules on new records.
// Runs before schema validation, so it covers create(), save() and insertMany().
// (Mongoose 9: pre hooks no longer receive `next`; throw/invalidate instead.)
importerSchema.pre("validate", function () {
  if (this.website && !this.website_domain) {
    this.website_domain = normalizeDomain(this.website);
  } else if (this.website_domain) {
    this.website_domain = normalizeDomain(this.website_domain);
  }

  if (this.isNew) {
    const { valid, errors } = validateImporterProvenance(this.toObject());
    if (!valid) {
      this.invalidate("source_url", `Provenance rejected: ${errors.join("; ")}`);
    }
  }
});

// Note: `status` (sales stage, set by a person) and `pipeline_status` (outreach
// tracking, set by the system) are independent. A hook used to copy
// pipeline_status over status on every save, which erased the user's choice.

importerSchema.index({
  importerName: "text",
  companyName: "text",
  importerNumber: "text",
  country: "text",
  website_domain: 1,
});

// Database-level dedupe by website domain (records without a website are exempt).
importerSchema.index(
  { website_domain: 1 },
  {
    name: "uniq_website_domain",
    unique: true,
    partialFilterExpression: { website_domain: { $type: "string", $gt: "" } },
  }
);

// Importers created from a lead push user edits back to that lead (two-way sync).
// Saves made by the lead->importer sync are flagged and skipped to avoid loops.
// (Required lazily to avoid a circular import with the sync service.)
function mirrorToLead(doc) {
  if (doc) require("../services/leadImporterSync").queueImporterSync(doc);
}
importerSchema.post("save", mirrorToLead);
importerSchema.post("findOneAndUpdate", mirrorToLead);

module.exports = mongoose.model("Importer", importerSchema);
