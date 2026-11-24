const express = require("express");
const EmailMessage = require("../models/EmailMessage");
const Importer = require("../models/Importer");

const router = express.Router();

// 1x1 transparent GIF (43 bytes)
const TRANSPARENT_1X1_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/**
 * Mailchimp Accuracy Logic:
 * Detect Apple Mail Privacy Protection (MPP) proxy pre-fetches vs Real Human Opens.
 * Apple MPP caches/pre-fetches images from Apple's server network.
 */
function detectAppleMailMpp(userAgent, headers = {}) {
  if (!userAgent) return false;
  const ua = String(userAgent).toLowerCase();

  // Apple Mail headers or proxy signatures
  if (headers["apple-mail-proxy"] || headers["x-apple-mail-proxy"]) {
    return true;
  }

  // Apple WebKit without standard Chrome/Firefox/Edge tokens
  const isAppleEngine =
    ua.includes("applewebkit") &&
    !ua.includes("chrome") &&
    !ua.includes("firefox") &&
    !ua.includes("edg");
  const isApplePlatform =
    ua.includes("macintosh") ||
    ua.includes("iphone") ||
    ua.includes("ipad") ||
    ua.includes("cfnetwork");
  const isMailClient = ua.includes("mail") || ua.includes("applemail");

  return isAppleEngine && (isMailClient || isApplePlatform);
}

/**
 * GET /api/emails/track/o/:trackingId.gif
 * GET /api/emails/track/open/:trackingId
 * Mailchimp Step 1 & 2 & 3: Transparent 1x1 pixel tracking
 */
async function handlePixelOpen(req, res) {
  const trackingId = String(req.params.trackingId || "")
    .replace(/\.gif$/i, "")
    .trim();

  // Send non-cacheable 1x1 transparent image immediately to the client
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": TRANSPARENT_1X1_GIF.length,
    "Cache-Control":
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, post-check=0, pre-check=0",
    Pragma: "no-cache",
    Expires: "0",
    "Access-Control-Allow-Origin": "*",
  });
  res.status(200).end(TRANSPARENT_1X1_GIF);

  // Asynchronously log the open event
  if (!trackingId) return;

  try {
    const email = await EmailMessage.findOne({ trackingId });
    if (!email) return;

    const userAgent = req.get("user-agent") || "";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "";
    const isAppleMpp = detectAppleMailMpp(userAgent, req.headers);

    const now = new Date();
    email.openCount = (email.openCount || 0) + 1;
    if (!email.firstOpenedAt) email.firstOpenedAt = now;
    email.lastOpenedAt = now;
    if (isAppleMpp) email.isOpenAppleMpp = true;

    if (email.status === "sent" || email.status === "delivered") {
      email.status = "opened";
    }

    email.opens = email.opens || [];
    email.opens.push({
      timestamp: now,
      ip,
      userAgent: userAgent.slice(0, 300),
      isAppleMpp,
      inferredFromClick: false,
    });

    await email.save();

    // Update Importer pipeline/timeline
    if (email.importerId) {
      const importer = await Importer.findById(email.importerId);
      if (importer) {
        if (!importer.email_opened_at) importer.email_opened_at = now;
        importer.email_open_count = (importer.email_open_count || 0) + 1;

        importer.timeline = importer.timeline || [];
        const openType = isAppleMpp ? "Apple MPP Pre-fetch" : "Direct Open";
        importer.timeline.push({
          status: "Opened",
          note: `Outreach email opened by ${email.recipientEmail} (${openType})`,
          changed_by: "System Tracker",
          timestamp: now,
        });
        await importer.save();
      }
    }
  } catch (err) {
    console.error("[EmailTracker] Open logging error:", err.message);
  }
}

router.get("/o/:trackingId", handlePixelOpen);
router.get("/open/:trackingId", handlePixelOpen);

/**
 * GET /api/emails/track/c/:trackingId?url=...
 * Mailchimp Step 4: Inferred Opens via Link Clicks
 */
router.get("/c/:trackingId", async (req, res) => {
  const trackingId = String(req.params.trackingId || "").trim();
  const rawTargetUrl = String(req.query.url || "https://oneroot.farm").trim();

  // Validate redirect URL (prevent open redirect attacks)
  let targetUrl = "https://oneroot.farm";
  try {
    const parsed = new URL(rawTargetUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      targetUrl = rawTargetUrl;
    }
  } catch {}

  // Immediate 302 redirect to recipient's destination
  res.redirect(302, targetUrl);

  // Asynchronously record click & inferred open
  if (!trackingId) return;

  try {
    const email = await EmailMessage.findOne({ trackingId });
    if (!email) return;

    const userAgent = req.get("user-agent") || "";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "";
    const now = new Date();

    email.clickCount = (email.clickCount || 0) + 1;
    if (!email.firstClickedAt) email.firstClickedAt = now;
    email.lastClickedAt = now;

    email.clicks = email.clicks || [];
    email.clicks.push({
      url: targetUrl,
      timestamp: now,
      ip,
      userAgent: userAgent.slice(0, 300),
    });

    // Mailchimp Step 4: If email was never marked opened (e.g. images disabled), infer open!
    if (!email.firstOpenedAt || email.openCount === 0) {
      email.openCount = (email.openCount || 0) + 1;
      email.firstOpenedAt = now;
      email.lastOpenedAt = now;
      email.inferredFromClick = true;
      email.status = "opened";

      email.opens = email.opens || [];
      email.opens.push({
        timestamp: now,
        ip,
        userAgent: userAgent.slice(0, 300),
        isAppleMpp: false,
        inferredFromClick: true,
      });
    }

    await email.save();

    if (email.importerId) {
      const importer = await Importer.findById(email.importerId);
      if (importer) {
        importer.timeline = importer.timeline || [];
        importer.timeline.push({
          status: "Clicked",
          note: `Link clicked by ${email.recipientEmail} -> ${targetUrl} (Inferred Email Open)`,
          changed_by: "System Tracker",
          timestamp: now,
        });
        await importer.save();
      }
    }
  } catch (err) {
    console.error("[EmailTracker] Click logging error:", err.message);
  }
});

module.exports = router;
