/**
 * Outreach rules (pure functions, no I/O): recipient timezone, business-hours
 * scheduling, follow-up timing, merge-field rendering, unsubscribe tokens and
 * inbound mail classification.
 */
const crypto = require("crypto");

// ------------------------------------------------------------------ timezones

/**
 * Main business timezone per country (capital / largest commercial hub).
 * Countries spanning several zones use the main trade hub; set recipient_timezone
 * on the importer to override.
 */
const COUNTRY_TZ = {
  "united arab emirates": "Asia/Dubai", uae: "Asia/Dubai", "saudi arabia": "Asia/Riyadh", qatar: "Asia/Qatar",
  kuwait: "Asia/Kuwait", bahrain: "Asia/Bahrain", oman: "Asia/Muscat", jordan: "Asia/Amman", lebanon: "Asia/Beirut",
  israel: "Asia/Jerusalem", iraq: "Asia/Baghdad", iran: "Asia/Tehran", turkey: "Europe/Istanbul", "türkiye": "Europe/Istanbul",
  egypt: "Africa/Cairo", morocco: "Africa/Casablanca", algeria: "Africa/Algiers", tunisia: "Africa/Tunis",
  "south africa": "Africa/Johannesburg", nigeria: "Africa/Lagos", kenya: "Africa/Nairobi", ghana: "Africa/Accra",
  ethiopia: "Africa/Addis_Ababa", tanzania: "Africa/Dar_es_Salaam", uganda: "Africa/Kampala", mauritius: "Indian/Mauritius",
  "united kingdom": "Europe/London", uk: "Europe/London", "great britain": "Europe/London", england: "Europe/London",
  ireland: "Europe/Dublin", germany: "Europe/Berlin", netherlands: "Europe/Amsterdam", "the netherlands": "Europe/Amsterdam",
  belgium: "Europe/Brussels", france: "Europe/Paris", spain: "Europe/Madrid", portugal: "Europe/Lisbon", italy: "Europe/Rome",
  switzerland: "Europe/Zurich", austria: "Europe/Vienna", denmark: "Europe/Copenhagen", sweden: "Europe/Stockholm",
  norway: "Europe/Oslo", finland: "Europe/Helsinki", iceland: "Atlantic/Reykjavik", poland: "Europe/Warsaw",
  "czech republic": "Europe/Prague", czechia: "Europe/Prague", slovakia: "Europe/Bratislava", hungary: "Europe/Budapest",
  romania: "Europe/Bucharest", bulgaria: "Europe/Sofia", greece: "Europe/Athens", croatia: "Europe/Zagreb",
  slovenia: "Europe/Ljubljana", serbia: "Europe/Belgrade", ukraine: "Europe/Kyiv", russia: "Europe/Moscow",
  estonia: "Europe/Tallinn", latvia: "Europe/Riga", lithuania: "Europe/Vilnius", luxembourg: "Europe/Luxembourg",
  malta: "Europe/Malta", cyprus: "Asia/Nicosia",
  "united states": "America/New_York", usa: "America/New_York", "united states of america": "America/New_York",
  us: "America/New_York", canada: "America/Toronto", mexico: "America/Mexico_City", brazil: "America/Sao_Paulo",
  argentina: "America/Argentina/Buenos_Aires", chile: "America/Santiago", colombia: "America/Bogota", peru: "America/Lima",
  ecuador: "America/Guayaquil", "costa rica": "America/Costa_Rica", panama: "America/Panama",
  "dominican republic": "America/Santo_Domingo", jamaica: "America/Jamaica", "trinidad and tobago": "America/Port_of_Spain",
  guatemala: "America/Guatemala", uruguay: "America/Montevideo",
  china: "Asia/Shanghai", "hong kong": "Asia/Hong_Kong", taiwan: "Asia/Taipei", japan: "Asia/Tokyo",
  "south korea": "Asia/Seoul", korea: "Asia/Seoul", singapore: "Asia/Singapore", malaysia: "Asia/Kuala_Lumpur",
  indonesia: "Asia/Jakarta", thailand: "Asia/Bangkok", vietnam: "Asia/Ho_Chi_Minh", "viet nam": "Asia/Ho_Chi_Minh",
  philippines: "Asia/Manila", cambodia: "Asia/Phnom_Penh", myanmar: "Asia/Yangon", bangladesh: "Asia/Dhaka",
  "sri lanka": "Asia/Colombo", nepal: "Asia/Kathmandu", pakistan: "Asia/Karachi", afghanistan: "Asia/Kabul",
  maldives: "Indian/Maldives", kazakhstan: "Asia/Almaty", uzbekistan: "Asia/Tashkent", india: "Asia/Kolkata",
  australia: "Australia/Sydney", "new zealand": "Pacific/Auckland", fiji: "Pacific/Fiji",
};

function isValidTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** → { tz, source: "importer"|"country"|"default" } */
function resolveTimezone(importer = {}) {
  const explicit = importer.recipient_timezone;
  if (explicit && explicit !== "UTC" && isValidTimezone(explicit)) return { tz: explicit, source: "importer" };
  const byCountry = COUNTRY_TZ[String(importer.country || "").trim().toLowerCase()];
  if (byCountry) return { tz: byCountry, source: "country" };
  return { tz: "UTC", source: "default" };
}

// ------------------------------------------------------------------ business hours

const DEFAULT_HOURS = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] }; // Mon–Fri, 09:00–17:00
const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: WEEKDAY_NUM[get("weekday")], hour: Number(get("hour")), minute: Number(get("minute")) };
}

function isWithinHours(date, tz, hours = DEFAULT_HOURS) {
  const { weekday, hour, minute } = localParts(date, tz);
  const mins = hour * 60 + minute;
  return hours.days.includes(weekday) && mins >= hours.startHour * 60 && mins < hours.endHour * 60;
}

/**
 * Earliest instant ≥ `from` inside the recipient's business hours. Walks forward in
 * 15-minute steps (DST-safe), then snaps back to the exact opening minute.
 */
function nextBusinessSlot(from, tz, hours = DEFAULT_HOURS) {
  const start = new Date(from);
  if (isWithinHours(start, tz, hours)) return start;
  const STEP = 15 * 60 * 1000;
  let t = new Date(Math.ceil(start.getTime() / STEP) * STEP);
  for (let i = 0; i < 4 * 24 * 10; i++) {
    if (isWithinHours(t, tz, hours)) {
      // Snap to the first in-hours minute inside the 15-minute window just crossed.
      let m = new Date(t.getTime() - STEP + 60_000);
      while (m < t && !isWithinHours(m, tz, hours)) m = new Date(m.getTime() + 60_000);
      return m < start ? start : m;
    }
    t = new Date(t.getTime() + STEP);
  }
  throw new Error("No business-hours slot within 10 days — check the business hours settings");
}

// ------------------------------------------------------------------ follow-up timing

const WAIT_MIN = 24;
const WAIT_MAX = 72;
const WAIT_DEFAULT = 48;

function normalizeWaitHours(hours) {
  if (hours === undefined || hours === null || hours === "") return WAIT_DEFAULT;
  const n = Number(hours);
  if (!Number.isFinite(n) || n < WAIT_MIN || n > WAIT_MAX) {
    throw new Error(`Follow-up wait must be between ${WAIT_MIN} and ${WAIT_MAX} hours (default ${WAIT_DEFAULT})`);
  }
  return n;
}

/**
 * Email #2 time: at least `waitHours` after Email #1, moved forward to the
 * recipient's next business-hours slot.
 */
function scheduleFollowUp(email1SentAt, waitHours, tz, hours = DEFAULT_HOURS) {
  const sent = new Date(email1SentAt);
  if (Number.isNaN(sent.getTime())) throw new Error("Invalid Email #1 sent time");
  const earliest = new Date(sent.getTime() + normalizeWaitHours(waitHours) * 3600 * 1000);
  return nextBusinessSlot(earliest, tz, hours);
}

// ------------------------------------------------------------------ merge fields

const MERGE_FIELDS = ["first_name", "company", "country", "product_details"];

const GENERIC_CONTACT =
  /\b(dept|department|team|manager|procurement|purchasing|purchase|sales|sourcing|office|desk|buyer|import|export|director|officer|head|general|info|admin|customer|service|support|quality|qa|operations|ceo|owner|staff)\b/i;
const TITLES = /^(mr|mrs|ms|miss|dr|prof|sir|madam|herr|frau|m|mme|sr|sra)\.?$/i;

/** First name only when the contact looks like a real person's name. */
function firstNameFrom(contactPerson) {
  const raw = String(contactPerson || "").replace(/\(.*?\)/g, " ").trim();
  if (!raw || GENERIC_CONTACT.test(raw) || /[@\d]/.test(raw)) return "";
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  while (tokens.length && TITLES.test(tokens[0])) tokens.shift();
  const first = tokens[0] || "";
  return /^[\p{L}][\p{L}'-]{1,29}$/u.test(first) ? first[0].toUpperCase() + first.slice(1) : "";
}

function buildMergeFields(importer = {}, settings = {}) {
  return {
    first_name: firstNameFrom(importer.contactPerson),
    company: String(importer.companyName || importer.importerName || "").trim(),
    country: String(importer.country || "").trim(),
    product_details: String(settings.product_details || "").trim(),
  };
}

/**
 * Render {{field}} and {{field|fallback}}. A field with no value and no fallback is
 * reported in `missing` (the email is then not sent — nothing is made up).
 */
function renderTemplate(template, fields) {
  const missing = new Set();
  const unknown = new Set();
  const text = String(template || "").replace(/\{\{\s*([a-z_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_, name, fallback) => {
    const key = name.toLowerCase();
    if (!MERGE_FIELDS.includes(key)) {
      unknown.add(name);
      return `{{${name}}}`;
    }
    const value = fields[key];
    if (value) return value;
    if (fallback !== undefined) return fallback;
    missing.add(key);
    return "";
  });
  return { text, missing: [...missing], unknown: [...unknown] };
}

// ------------------------------------------------------------------ unsubscribe tokens

function tokenSecret() {
  const s = process.env.OUTREACH_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET (or OUTREACH_UNSUBSCRIBE_SECRET) must be set for unsubscribe links");
  return s;
}

/** Opaque, unguessable token: base64url(importerId).hmac */
function makeUnsubscribeToken(importerId) {
  const id = Buffer.from(String(importerId)).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecret()).update(`unsub:${importerId}`).digest("base64url").slice(0, 32);
  return `${id}.${sig}`;
}

function readUnsubscribeToken(token) {
  const [id64, sig] = String(token || "").split(".");
  if (!id64 || !sig) return null;
  let id;
  try {
    id = Buffer.from(id64, "base64url").toString();
  } catch {
    return null;
  }
  const expected = crypto.createHmac("sha256", tokenSecret()).update(`unsub:${id}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

// ------------------------------------------------------------------ inbound classification

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|mail-daemon)/i;
const BOUNCE_SUBJECT =
  /(undeliver|delivery (status notification|has failed|failure)|returned mail|failure notice|mail delivery failed|could not be delivered|not delivered|delivery incomplete)/i;
const AUTO_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the )?office|on (annual )?leave|abwesenheit|absence|réponse automatique|respuesta automática)/i;
const UNSUB_TEXT = /^\s*(unsubscribe|remove me|stop|opt[- ]?out|please remove)/i;

/**
 * → "bounce" | "auto_reply" | "unsubscribe" | "reply"
 * `msg`: { from, subject, text, headers: Map/obj (lower-case keys), contentType }
 */
function classifyInbound(msg) {
  const h = (k) => {
    const hs = msg.headers;
    const v = hs instanceof Map ? hs.get(k) : hs?.[k];
    return typeof v === "object" && v !== null ? v.value ?? JSON.stringify(v) : String(v ?? "");
  };
  const from = String(msg.from || "");
  const subject = String(msg.subject || "");
  const contentType = String(msg.contentType || h("content-type"));

  if (BOUNCE_FROM.test(from) || /report-type=["']?delivery-status/i.test(contentType) || (BOUNCE_SUBJECT.test(subject) && /daemon|postmaster|mailer|system/i.test(from))) {
    return "bounce";
  }
  const autoSubmitted = h("auto-submitted").toLowerCase();
  if (
    (autoSubmitted && autoSubmitted !== "no") ||
    h("x-autoreply") ||
    h("x-autorespond") ||
    /^(auto_reply|bulk|junk)$/i.test(h("precedence").trim()) ||
    AUTO_SUBJECT.test(subject)
  ) {
    return "auto_reply";
  }
  const firstLine = String(msg.text || "").trim().split(/\r?\n/)[0] || "";
  if (/^\s*(re:\s*)?unsubscribe\b/i.test(subject) || UNSUB_TEXT.test(firstLine)) return "unsubscribe";
  return "reply";
}

/** Recipient address a bounce report is about (DSN Final-/Original-Recipient, else first address). */
function bouncedRecipient(text, ownAddresses = []) {
  const s = String(text || "");
  const m = s.match(/(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/i);
  if (m) return m[1].toLowerCase();
  const own = ownAddresses.map((a) => a.toLowerCase());
  for (const e of s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
    const v = e.toLowerCase();
    if (!own.includes(v) && !/mailer-daemon|postmaster/.test(v)) return v;
  }
  return "";
}

module.exports = {
  COUNTRY_TZ,
  DEFAULT_HOURS,
  MERGE_FIELDS,
  WAIT_MIN,
  WAIT_MAX,
  WAIT_DEFAULT,
  isValidTimezone,
  resolveTimezone,
  localParts,
  isWithinHours,
  nextBusinessSlot,
  normalizeWaitHours,
  scheduleFollowUp,
  firstNameFrom,
  buildMergeFields,
  renderTemplate,
  makeUnsubscribeToken,
  readUnsubscribeToken,
  classifyInbound,
  bouncedRecipient,
};
