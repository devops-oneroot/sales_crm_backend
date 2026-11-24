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
 * Security scanners (Microsoft Defender / EOP, Mimecast, Proofpoint, Barracuda...)
 * fetch every image and link seconds after delivery. Any hit inside this window
 * after sending is treated as automated, not a human open/click.
 */
const SCANNER_WINDOW_MS = 60 * 1000;
// Hits from different IPs this close together = scanner fan-out
const BURST_WINDOW_MS = 5 * 1000;

const BOT_UA_PATTERNS = [
  /bot\b|crawler|spider|headless|phantom|python-requests|curl\/|wget|go-http-client|java\/|okhttp|axios|node-fetch/i,
  /barracuda|mimecast|proofpoint|ironport|symantec|messagelabs|forcepoint|trendmicro|sophos|fortinet|zscaler|cloudmark|safelinks/i,
];

/**
 * Detect Apple Mail Privacy Protection (MPP) proxy pre-fetches.
 * Apple MPP downloads images on delivery whether or not the mail is read.
 */
function detectAppleMailMpp(userAgent, headers = {}) {
  if (!userAgent) return false;
  const ua = String(userAgent).toLowerCase();

  if (headers["apple-mail-proxy"] || headers["x-apple-mail-proxy"]) {
    return true;
  }

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

// Gmail only fetches images through its proxy when the message is actually viewed
function isGoogleImageProxy(ua) {
  return /googleimageproxy|ggpht\.com/i.test(ua || "");
}

/**
 * Decide whether a pixel/link hit is automated. Returns { isBot, reason }.
 */
function classifyHit(email, { userAgent, ip, headers = {}, kind, now = Date.now() }) {
  const ua = String(userAgent || "");

  if (!ua.trim()) return { isBot: true, reason: "empty user-agent" };
  if (BOT_UA_PATTERNS.some((re) => re.test(ua))) {
    return { isBot: true, reason: "scanner user-agent" };
  }
  if (kind === "open" && detectAppleMailMpp(ua, headers)) {
    return { isBot: true, reason: "Apple Mail Privacy Protection prefetch" };
  }
  if (isGoogleImageProxy(ua)) return { isBot: false, reason: "" };

  const sentAt = email.sentAt || email.createdAt;
  if (sentAt) {
    const age = now - new Date(sentAt).getTime();
    if (age >= 0 && age < SCANNER_WINDOW_MS) {
      return {
        isBot: true,
        reason: `${kind} ${Math.round(age / 1000)}s after send (security scanner window)`,
      };
    }
  }

  const prior = kind === "open" ? email.opens || [] : email.clicks || [];
  const burst = prior.some(
    (o) =>
      o.ip &&
      o.ip !== ip &&
      Math.abs(now - new Date(o.timestamp).getTime()) < BURST_WINDOW_MS
  );
  if (burst) return { isBot: true, reason: "multi-IP burst (scanner fan-out)" };

  return { isBot: false, reason: "" };
}

function requestMeta(req) {
  return {
    userAgent: req.get("user-agent") || "",
    ip:
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "",
    headers: req.headers,
  };
}

/**
 * Record a human open atomically (no lost updates under concurrent hits)
 * and append it to the importer timeline.
 */
async function recordHumanOpen(email, { now, ip, userAgent, inferredFromClick }) {
  await EmailMessage.updateOne(
    { _id: email._id },
    {
      $inc: { openCount: 1 },
      $min: { firstOpenedAt: now },
      $set: {
        lastOpenedAt: now,
        ...(inferredFromClick ? { inferredFromClick: true } : {}),
      },
      $push: {
        opens: {
          timestamp: now,
          ip,
          userAgent: userAgent.slice(0, 300),
          isAppleMpp: false,
          inferredFromClick: !!inferredFromClick,
          isBot: false,
        },
      },
    }
  );

  await EmailMessage.updateOne(
    { _id: email._id, status: { $in: ["sent", "delivered"] } },
    { $set: { status: "opened" } }
  );

  if (email.importerId) {
    await Importer.updateOne(
      { _id: email.importerId },
      {
        $inc: { email_open_count: 1 },
        $min: { email_opened_at: now },
        $push: {
          timeline: {
            status: "Opened",
            note: inferredFromClick
              ? `Outreach email opened by ${email.recipientEmail} (inferred from link click)`
              : `Outreach email opened by ${email.recipientEmail}`,
            changed_by: "System Tracker",
            timestamp: now,
          },
        },
      }
    );
  }
}

/**
 * GET /api/emails/track/o/:trackingId.gif
 * GET /api/emails/track/open/:trackingId
 * Transparent 1x1 pixel. Only human opens are counted; scanner/prefetch hits are
 * logged with isBot=true for auditing but never mark the email as opened.
 */
async function handlePixelOpen(req, res) {
  const trackingId = String(req.params.trackingId || "")
    .replace(/\.gif$/i, "")
    .trim();

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

  if (!trackingId) return;

  try {
    const email = await EmailMessage.findOne({ trackingId });
    if (!email) return;

    const { userAgent, ip, headers } = requestMeta(req);
    const now = new Date();
    const { isBot, reason } = classifyHit(email, {
      userAgent,
      ip,
      headers,
      kind: "open",
      now: now.getTime(),
    });

    if (isBot) {
      const isAppleMpp = reason.startsWith("Apple");
      await EmailMessage.updateOne(
        { _id: email._id },
        {
          $inc: { botOpenCount: 1 },
          ...(isAppleMpp ? { $set: { isOpenAppleMpp: true } } : {}),
          $push: {
            opens: {
              timestamp: now,
              ip,
              userAgent: userAgent.slice(0, 300),
              isAppleMpp,
              inferredFromClick: false,
              isBot: true,
              botReason: reason,
            },
          },
        }
      );
      return;
    }

    await recordHumanOpen(email, { now, ip, userAgent, inferredFromClick: false });
  } catch (err) {
    console.error("[EmailTracker] Open logging error:", err.message);
  }
}

router.get("/o/:trackingId", handlePixelOpen);
router.get("/open/:trackingId", handlePixelOpen);

/**
 * GET /api/emails/track/c/:trackingId?url=...
 * Click redirect. Scanner clicks are logged but not counted; a human click on an
 * email with no recorded open infers an open (images-disabled clients).
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

  res.redirect(302, targetUrl);

  if (!trackingId) return;

  try {
    const email = await EmailMessage.findOne({ trackingId });
    if (!email) return;

    const { userAgent, ip, headers } = requestMeta(req);
    const now = new Date();
    const { isBot, reason } = classifyHit(email, {
      userAgent,
      ip,
      headers,
      kind: "click",
      now: now.getTime(),
    });

    const click = {
      url: targetUrl,
      timestamp: now,
      ip,
      userAgent: userAgent.slice(0, 300),
      isBot,
      ...(isBot ? { botReason: reason } : {}),
    };

    if (isBot) {
      await EmailMessage.updateOne({ _id: email._id }, { $push: { clicks: click } });
      return;
    }

    await EmailMessage.updateOne(
      { _id: email._id },
      {
        $inc: { clickCount: 1 },
        $min: { firstClickedAt: now },
        $set: { lastClickedAt: now },
        $push: { clicks: click },
      }
    );

    if (!email.openCount) {
      await recordHumanOpen(email, { now, ip, userAgent, inferredFromClick: true });
    }

    if (email.importerId) {
      await Importer.updateOne(
        { _id: email.importerId },
        {
          $push: {
            timeline: {
              status: "Clicked",
              note: `Link clicked by ${email.recipientEmail} -> ${targetUrl}`,
              changed_by: "System Tracker",
              timestamp: now,
            },
          },
        }
      );
    }
  } catch (err) {
    console.error("[EmailTracker] Click logging error:", err.message);
  }
});

module.exports = router;
module.exports.classifyHit = classifyHit;
