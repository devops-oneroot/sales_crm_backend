/**
 * Verification: website live check, email verification, score + A/B/C grade.
 *
 * Email verification uses a verifier API set in .env:
 *   EMAIL_VERIFIER_PROVIDER = neverbounce | zerobounce
 *   EMAIL_VERIFIER_API_KEY  = <key>
 * Without a key, only a DNS check runs: a domain with no mail server → "invalid";
 * otherwise the email stays "unverified" (a DNS check can't prove a mailbox exists),
 * so it can never pass the outreach gate without a real verifier.
 */
const dnsModule = require("dns");

/**
 * DNS lookups for MX checks. On Windows, Node sometimes reports only 127.0.0.1 as the
 * resolver (nothing listens there → ECONNREFUSED), the same issue src/config/db.js works
 * around. Use a dedicated resolver with public fallbacks in that case.
 * Exposed as an object so tests can stub resolveMx / resolve4.
 */
const dnsClient = (() => {
  const resolver = new dnsModule.promises.Resolver({ timeout: 5000, tries: 2 });
  const servers = dnsModule.getServers();
  const isLoopback = (s) => s === "127.0.0.1" || s === "::1";
  if (!servers.length || servers.every(isLoopback)) resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return {
    resolveMx: (d) => resolver.resolveMx(d),
    resolve4: (d) => resolver.resolve4(d),
  };
})();
const dns = dnsClient;
const Importer = require("../models/Importer");
const { fetchPage } = require("../lib/webFetch");
const { calculateLeadGrade } = require("../lib/importerProvenance");

const CONCURRENCY = 5;
const MAX_PER_REQUEST = 100;
const VERIFIER_TIMEOUT_MS = 30_000;

function verifierConfig() {
  const provider = (process.env.EMAIL_VERIFIER_PROVIDER || "").trim().toLowerCase();
  const key = (process.env.EMAIL_VERIFIER_API_KEY || "").trim();
  if (!key) return { provider: "dns-only", configured: false, reason: "EMAIL_VERIFIER_API_KEY not set" };
  if (!["neverbounce", "zerobounce"].includes(provider)) {
    return { provider: "dns-only", configured: false, reason: `EMAIL_VERIFIER_PROVIDER must be neverbounce or zerobounce (got "${provider || "empty"}")` };
  }
  return { provider, configured: true, key, reason: "" };
}

// ------------------------------------------------------------------ website

async function checkWebsite(website) {
  if (!website) return { live: false, status: undefined, note: "no website" };
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const page = await fetchPage(url);
  if (page.ok) return { live: true, status: page.status, note: `HTTP ${page.status}` };
  // robots.txt blocking our crawler still proves the site is up.
  if (page.blockedByRobots) return { live: true, status: undefined, note: "site up (robots.txt blocks crawling)" };
  return { live: false, status: page.status, note: page.error || "unreachable" };
}

// ------------------------------------------------------------------ email

/** Map provider verdicts to verified / risky / invalid / unverified. */
const NEVERBOUNCE_MAP = { valid: "verified", catchall: "risky", unknown: "risky", invalid: "invalid", disposable: "invalid" };
const ZEROBOUNCE_MAP = {
  valid: "verified",
  "catch-all": "risky",
  unknown: "risky",
  invalid: "invalid",
  spamtrap: "invalid",
  abuse: "invalid",
  do_not_mail: "invalid",
};

async function mxCheck(email) {
  const domain = String(email).split("@")[1];
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) return { ok: true, detail: `MX: ${mx.sort((a, b) => a.priority - b.priority)[0].exchange}` };
  } catch (err) {
    if (err.code !== "ENODATA" && err.code !== "ENOTFOUND") return { ok: null, detail: `DNS error ${err.code}` };
  }
  // RFC 5321: with no MX, mail goes to the A record.
  try {
    const a = await dns.resolve4(domain);
    if (a.length) return { ok: true, detail: "no MX, A record present" };
  } catch {
    /* fallthrough */
  }
  return { ok: false, detail: "domain has no mail server (no MX/A record)" };
}

async function callVerifier(cfg, email) {
  const enc = encodeURIComponent(email);
  const url =
    cfg.provider === "neverbounce"
      ? `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(cfg.key)}&email=${enc}`
      : `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(cfg.key)}&email=${enc}&ip_address=`;
  const res = await fetch(url, { signal: AbortSignal.timeout(VERIFIER_TIMEOUT_MS) });
  const json = await res.json().catch(() => ({}));
  if (cfg.provider === "neverbounce") {
    if (json.status !== "success") throw new Error(`NeverBounce: ${json.message || json.status || `HTTP ${res.status}`}`);
    return { raw: json.result, status: NEVERBOUNCE_MAP[json.result] || "risky" };
  }
  if (json.error || !json.status) throw new Error(`ZeroBounce: ${json.error || `HTTP ${res.status}`}`);
  return { raw: json.sub_status ? `${json.status}/${json.sub_status}` : json.status, status: ZEROBOUNCE_MAP[json.status] || "risky" };
}

/** → { status: verified|risky|invalid|unverified, detail, method } */
async function verifyEmail(email, cfg = verifierConfig()) {
  if (!email) return { status: "unverified", detail: "no email", method: "none" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { status: "invalid", detail: "malformed address", method: "syntax" };

  const mx = await mxCheck(email);
  if (mx.ok === false) return { status: "invalid", detail: mx.detail, method: "dns" };

  if (!cfg.configured) {
    return { status: "unverified", detail: `${mx.detail}; mailbox not checked (${cfg.reason})`, method: "dns" };
  }
  try {
    const v = await callVerifier(cfg, email);
    return { status: v.status, detail: `${cfg.provider}: ${v.raw}`, method: cfg.provider };
  } catch (err) {
    // Verifier failure must not mark anything verified; keep the previous status.
    return { status: null, detail: err.message, method: cfg.provider, error: true };
  }
}

// ------------------------------------------------------------------ batch

let running = false;

/**
 * Verify importers. ids → those; otherwise importers never checked (or older than
 * `staleDays`). Returns per-importer results and totals.
 */
async function verifyImporters({ ids = null, staleDays = 30, userName = "System" } = {}) {
  if (running) {
    const err = new Error("A verification run is already in progress");
    err.status = 409;
    throw err;
  }
  running = true;
  const cfg = verifierConfig();
  try {
    const query = {};
    if (Array.isArray(ids) && ids.length) query._id = { $in: ids };
    else {
      query.$or = [
        { verification_checked_at: { $exists: false } },
        { verification_checked_at: { $lt: new Date(Date.now() - staleDays * 864e5) } },
      ];
    }
    const total = await Importer.countDocuments(query);
    const targets = await Importer.find(query)
      .select("companyName importerName email website importerNumber contactPerson email_status pipeline_status verification_grade")
      .limit(MAX_PER_REQUEST)
      .lean();

    const results = [];
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const imp = targets[i++];
        try {
          const [site, mail] = await Promise.all([checkWebsite(imp.website), verifyEmail(imp.email, cfg)]);
          const emailStatus = mail.status ?? imp.email_status ?? "unverified";
          const { score, grade } = calculateLeadGrade({
            websiteLive: site.live,
            emailStatus,
            hasPhone: Boolean(imp.importerNumber),
            hasContactPerson: Boolean(imp.contactPerson),
          });
          const set = {
            website_live: site.live,
            website_status_code: site.status,
            email_status: emailStatus,
            email_check_detail: mail.detail,
            email_check_method: mail.method,
            website_check_detail: site.note,
            verification_score: score,
            verification_grade: grade,
            verification_checked_at: new Date(),
          };
          const timeline = {
            status: "Verification",
            note: `Website: ${site.live ? "live" : "down"} (${site.note}); email: ${emailStatus} (${mail.detail}); grade ${grade}, score ${score}`,
            changed_by: userName,
            timestamp: new Date(),
          };
          const push = [timeline];
          // Verified A/B leads move New → Verified on the pipeline.
          if (emailStatus === "verified" && (grade === "A" || grade === "B") && (!imp.pipeline_status || imp.pipeline_status === "New")) {
            set.pipeline_status = "Verified";
            push.push({ status: "Verified", note: `Passed verification (grade ${grade})`, changed_by: userName, timestamp: new Date() });
          }
          await Importer.updateOne({ _id: imp._id }, { $set: set, $push: { timeline: { $each: push } } });
          results.push({
            id: imp._id,
            companyName: imp.companyName || imp.importerName,
            email: imp.email || "",
            emailStatus,
            emailDetail: mail.detail,
            websiteLive: site.live,
            websiteDetail: site.note,
            score,
            grade,
            error: mail.error ? mail.detail : undefined,
          });
        } catch (err) {
          results.push({ id: imp._id, companyName: imp.companyName || imp.importerName, error: err.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

    const count = (fn) => results.filter(fn).length;
    return {
      provider: cfg.provider,
      verifierConfigured: cfg.configured,
      verifierNote: cfg.reason,
      checked: results.length,
      remaining: Math.max(0, total - results.length),
      verified: count((r) => r.emailStatus === "verified"),
      risky: count((r) => r.emailStatus === "risky"),
      invalid: count((r) => r.emailStatus === "invalid"),
      unverified: count((r) => r.emailStatus === "unverified"),
      gradeA: count((r) => r.grade === "A"),
      gradeB: count((r) => r.grade === "B"),
      gradeC: count((r) => r.grade === "C"),
      errors: count((r) => r.error),
      results,
    };
  } finally {
    running = false;
  }
}

module.exports = { dnsClient, verifierConfig, checkWebsite, verifyEmail, mxCheck, verifyImporters, NEVERBOUNCE_MAP, ZEROBOUNCE_MAP };
