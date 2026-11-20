/**
 * Importer Provenance, Ingestion Validation, and Outreach Timing Rules
 * Strictly enforces that lead data is never fabricated and has verified provenance.
 */

const PIPELINE_STATUSES = [
  "New",
  "Verified",
  "Emailed",
  "Followed up",
  "LinkedIn sent",
  "Replied",
  "Sample sent",
  "Negotiation",
  "Order",
  "Lost",
];

const SOURCE_TYPES = [
  "google_places",
  "trade_fair",
  "csv_upload",
  "manual",
  "web_scraper",
];

const EMAIL_STATUSES = ["unverified", "verified", "risky", "invalid"];
const VERIFICATION_GRADES = ["A", "B", "C", "Unrated"];
const LINKEDIN_TASK_STATUSES = ["to_send", "sent", "accepted", "replied"];

/**
 * Normalizes a URL into a clean domain for deduplication.
 * e.g. "https://www.turmeric-vietnam.vn/contact?lang=en" -> "turmeric-vietnam.vn"
 */
function normalizeDomain(inputUrl) {
  if (!inputUrl || typeof inputUrl !== "string") return "";
  let clean = inputUrl.trim().toLowerCase();
  clean = clean.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "");
  clean = clean.split("/")[0];
  clean = clean.split("?")[0];
  clean = clean.split("#")[0];
  clean = clean.split(":")[0];
  return clean.trim();
}

/**
 * Which source_url schemes each source_type may use.
 * Fetched sources must point at the real page/API they came from; only manual
 * entry may use manual://, and only CSV rows without their own URL may use csv://.
 */
const ALLOWED_PROTOCOLS_BY_SOURCE = {
  google_places: ["https:"],
  trade_fair: ["http:", "https:"],
  web_scraper: ["http:", "https:"],
  csv_upload: ["http:", "https:", "csv:"],
  manual: ["manual:", "http:", "https:"],
};

/** Source types whose contact fields must be found in the stored fetched text. */
const GROUNDED_SOURCE_TYPES = ["google_places", "trade_fair", "web_scraper", "csv_upload"];

/** Allowed clock skew when checking fetched_at is not in the future. */
const FETCHED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const FETCHED_AT_EARLIEST = new Date("2000-01-01T00:00:00Z");

const PLACEHOLDER_NAME_RE =
  /^(?:csv imported buyer|extracted spice importer|unknown|n\/?a|none|test|—|-|\.+)$/i;
const PLACEHOLDER_EMAIL_DOMAIN_RE = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|test|invalid|localhost)$/i;

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Placeholder / dummy phone numbers that have been used to fill required fields.
 * e.g. "+1-000-000-0000", "0000000", "+1-800-555-0199" (NANP fictional range 555-01xx).
 */
function isPlaceholderPhone(phone) {
  const d = digitsOnly(phone);
  if (!d) return false; // empty is "absent", not a placeholder
  if (d.length < 7) return true;
  const national = d.slice(-7);
  if (/^(\d)\1{6}$/.test(national)) return true; // 0000000, 1111111 …
  if (/555(01\d\d)$/.test(d)) return true; // reserved fictional numbers
  return false;
}

function isPlaceholderName(name) {
  return PLACEHOLDER_NAME_RE.test(String(name || "").trim());
}

function isPlaceholderEmail(email) {
  return PLACEHOLDER_EMAIL_DOMAIN_RE.test(String(email || "").trim());
}

/** Lower-case and collapse whitespace so text comparisons survive HTML stripping. */
function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip phone punctuation so "+49 (40) 7333-0" matches "+49-40-73333-0" style variants. */
function normalizePhoneText(value) {
  return String(value || "").replace(/[\s().\-\/]/g, "");
}

/**
 * Grounding rule: an extractor (regex or LLM) may only copy contacts out of fetched
 * text, never create them. Every contact field a fetched record carries must appear
 * in raw_extracted_text — the text that was actually fetched.
 */
function checkGrounding(payload) {
  const errors = [];
  const raw = payload.raw_extracted_text;
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    errors.push(
      `raw_extracted_text is required for source_type "${payload.source_type}" (store the fetched text the record was extracted from)`
    );
    return errors;
  }

  const haystack = normalizeForMatch(raw);
  const phoneHaystack = normalizePhoneText(raw);

  const name = payload.companyName || payload.importerName;
  if (name && !haystack.includes(normalizeForMatch(name))) {
    errors.push(`Company name "${name}" not found in fetched source text`);
  }
  if (payload.email && !haystack.includes(normalizeForMatch(payload.email))) {
    errors.push(`Email "${payload.email}" not found in fetched source text`);
  }
  if (payload.importerNumber) {
    const p = normalizePhoneText(payload.importerNumber);
    if (p && !phoneHaystack.includes(p)) {
      errors.push(`Phone "${payload.importerNumber}" not found in fetched source text`);
    }
  }
  if (payload.contactPerson && !haystack.includes(normalizeForMatch(payload.contactPerson))) {
    errors.push(`Contact person "${payload.contactPerson}" not found in fetched source text`);
  }
  const domain = payload.website_domain || normalizeDomain(payload.website);
  if (domain && !haystack.includes(domain)) {
    errors.push(`Website domain "${domain}" not found in fetched source text`);
  }
  return errors;
}

/**
 * Validates lead provenance rules.
 * STRICT RULE: Every importer must come from a fetched source or manual entry,
 * and MUST store source_url and fetched_at. Reject records without them.
 *
 * Rules:
 *  1. source_url present, parseable, and its scheme allowed for the source_type.
 *  2. fetched_at present, a valid date, not in the future, not absurdly old.
 *  3. source_type is one of SOURCE_TYPES.
 *  4. A real company name (no placeholder names).
 *  5. No placeholder phones / emails used to pad required fields.
 *  6. Fetched sources: every contact field must appear in raw_extracted_text.
 */
function validateImporterProvenance(payload, { now = new Date() } = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Importer payload is missing"] };
  }
  const sourceType = payload.source_type || "manual";

  // 1. source_url
  if (!payload.source_url || typeof payload.source_url !== "string" || !payload.source_url.trim()) {
    errors.push("Missing required provenance field: source_url (every importer must come from a verified source or manual entry)");
  } else {
    let protocol = "";
    try {
      protocol = new URL(payload.source_url.trim()).protocol;
    } catch {
      protocol = "";
    }
    const allowed = ALLOWED_PROTOCOLS_BY_SOURCE[sourceType] || [];
    if (!protocol || !["http:", "https:", "manual:", "csv:"].includes(protocol)) {
      errors.push("Invalid source_url protocol. Must be an http(s):// page, manual:// (manual entry) or csv:// (uploaded file row)");
    } else if (!allowed.includes(protocol)) {
      errors.push(
        `source_url scheme "${protocol}//" is not allowed for source_type "${sourceType}" (allowed: ${allowed.map((p) => p + "//").join(", ")})`
      );
    }
  }

  // 2. fetched_at
  if (!payload.fetched_at) {
    errors.push("Missing required provenance field: fetched_at (timestamp when lead data was fetched/entered)");
  } else {
    const date = new Date(payload.fetched_at);
    if (isNaN(date.getTime())) {
      errors.push("Invalid fetched_at date value");
    } else if (date.getTime() > new Date(now).getTime() + FETCHED_AT_FUTURE_SKEW_MS) {
      errors.push("fetched_at cannot be in the future");
    } else if (date < FETCHED_AT_EARLIEST) {
      errors.push("fetched_at is before 2000-01-01 and is not a plausible fetch time");
    }
  }

  // 3. source_type
  if (!SOURCE_TYPES.includes(sourceType)) {
    errors.push(`Unknown source_type "${sourceType}"`);
  }

  // 4. name
  const name = payload.importerName || payload.companyName;
  if (!name || typeof name !== "string" || !name.trim()) {
    errors.push("Importer or Company name is required");
  } else if (isPlaceholderName(name)) {
    errors.push(`"${name}" is a placeholder, not a company name`);
  }

  // 5. placeholders
  if (isPlaceholderPhone(payload.importerNumber)) {
    errors.push(`Phone "${payload.importerNumber}" is a placeholder; leave it empty if the source has none`);
  }
  if (payload.email && isPlaceholderEmail(payload.email)) {
    errors.push(`Email "${payload.email}" uses a reserved/placeholder domain`);
  }

  // 6. grounding (only once the basic shape is valid, so messages stay readable)
  if (errors.length === 0 && GROUNDED_SOURCE_TYPES.includes(sourceType)) {
    errors.push(...checkGrounding(payload));
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Provenance fields that may never change after a record is created. */
const IMMUTABLE_PROVENANCE_FIELDS = ["source_url", "fetched_at", "source_type", "raw_extracted_text"];

/**
 * Scores and grades a lead based on verification signals.
 * Grade A: Live website + verified email + complete contact info
 * Grade B: Live website + verified email or contact number
 * Grade C: Unverified/risky email or website down
 */
function calculateLeadGrade(verificationData = {}) {
  const {
    websiteLive = false,
    emailStatus = "unverified",
    hasPhone = false,
    hasContactPerson = false,
  } = verificationData;

  let score = 0;
  if (websiteLive) score += 35;
  if (emailStatus === "verified") score += 45;
  else if (emailStatus === "risky") score += 15;
  if (hasPhone) score += 10;
  if (hasContactPerson) score += 10;

  // A: verified email + live website.
  // B: verified email but website down, OR risky (catch-all) email + live website.
  // C: everything else (unverified/invalid email, or risky email with no live site).
  let grade = "C";
  if (emailStatus === "verified" && websiteLive) grade = "A";
  else if (emailStatus === "verified" || (emailStatus === "risky" && websiteLive)) grade = "B";

  return { score, grade };
}

/**
 * Outreach enrollment rule:
 * STRICT RULE: Only verified A/B leads can be enrolled in outreach.
 */
function canEnrollInOutreach(lead) {
  if (!lead) return { allowed: false, reason: "Lead data is missing" };
  if (lead.unsubscribed) return { allowed: false, reason: "Lead has unsubscribed" };
  if (lead.suppressed) return { allowed: false, reason: "Lead email is suppressed" };

  const emailStatus = lead.email_status || lead.emailStatus || "unverified";
  const grade = lead.verification_grade || lead.verificationGrade || "C";

  if (emailStatus !== "verified") {
    return {
      allowed: false,
      reason: `Email status is "${emailStatus}". Only leads with "verified" email can be enrolled in outreach.`,
    };
  }

  if (grade !== "A" && grade !== "B") {
    return {
      allowed: false,
      reason: `Lead grade is "${grade}". Only Grade A or B leads can be enrolled in outreach.`,
    };
  }

  return { allowed: true };
}

/**
 * Calculates follow-up wait time.
 * Default wait: 48 hours. Allowed range: 24h to 72h.
 */
function validateFollowUpWaitHours(hours) {
  const parsed = Number(hours);
  if (isNaN(parsed) || parsed < 24 || parsed > 72) {
    return {
      valid: false,
      error: "Follow-up wait time must be between 24 and 72 hours (default: 48 hours)",
    };
  }
  return { valid: true, hours: parsed };
}

/**
 * Calculates Email #2 scheduled timestamp given Email #1 sentAt and waitHours.
 */
function calculateNextEmailScheduledTime(email1SentAt, waitHours = 48) {
  const waitCheck = validateFollowUpWaitHours(waitHours);
  const effectiveHours = waitCheck.valid ? waitCheck.hours : 48;
  const sentDate = new Date(email1SentAt);
  if (isNaN(sentDate.getTime())) {
    throw new Error("Invalid email_1_sent_at timestamp");
  }
  return new Date(sentDate.getTime() + effectiveHours * 60 * 60 * 1000);
}

/**
 * Checks if a given timestamp falls within business hours (09:00 - 18:00 Mon-Fri)
 * in the recipient's timezone.
 */
function isWithinBusinessHours(targetDate, timezone = "UTC") {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    });
    const parts = formatter.formatToParts(targetDate);
    const hourPart = parts.find((p) => p.type === "hour");
    const weekdayPart = parts.find((p) => p.type === "weekday");

    const hour = parseInt(hourPart?.value || "0", 10);
    const weekday = weekdayPart?.value || "";

    const isWeekend = weekday === "Sat" || weekday === "Sun";
    const isWorkingHour = hour >= 9 && hour < 18;

    return !isWeekend && isWorkingHour;
  } catch {
    // If timezone is invalid, fallback to UTC hour
    const utcHour = targetDate.getUTCHours();
    const utcDay = targetDate.getUTCDay();
    return utcDay >= 1 && utcDay <= 5 && utcHour >= 9 && utcHour < 18;
  }
}

/**
 * Enforces maximum character count on LinkedIn short message template.
 * STRICT RULE: Short message must be < 300 chars.
 */
function validateLinkedInMessage(message) {
  if (!message || typeof message !== "string") {
    return { valid: false, error: "LinkedIn message cannot be empty" };
  }
  const length = message.trim().length;
  if (length >= 300) {
    return {
      valid: false,
      length,
      error: `LinkedIn message exceeds 300 character limit (length: ${length})`,
    };
  }
  return { valid: true, length };
}

module.exports = {
  PIPELINE_STATUSES,
  SOURCE_TYPES,
  EMAIL_STATUSES,
  VERIFICATION_GRADES,
  LINKEDIN_TASK_STATUSES,
  ALLOWED_PROTOCOLS_BY_SOURCE,
  GROUNDED_SOURCE_TYPES,
  IMMUTABLE_PROVENANCE_FIELDS,
  normalizeDomain,
  validateImporterProvenance,
  checkGrounding,
  isPlaceholderPhone,
  isPlaceholderName,
  isPlaceholderEmail,
  calculateLeadGrade,
  canEnrollInOutreach,
  validateFollowUpWaitHours,
  calculateNextEmailScheduledTime,
  isWithinBusinessHours,
  validateLinkedInMessage,
};
