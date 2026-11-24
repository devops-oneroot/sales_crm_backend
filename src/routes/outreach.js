const fs = require("fs");
const path = require("path");
const express = require("express");
const { ImapFlow } = require("imapflow");
const Importer = require("../models/Importer");
const OutreachSettings = require("../models/OutreachSettings");
const Suppression = require("../models/Suppression");
const EmailMessage = require("../models/EmailMessage");
const User = require("../models/User");
const R = require("../lib/outreachRules");
const { getInboxes, describeInbox, verifySmtp, sendMail } = require("../services/outreachMailer");
const engine = require("../services/outreachEngine");

const router = express.Router();
const fail = (res, err, code = 500) => res.status(err.status || code).json({ success: false, message: err.message });

const SETTINGS_FIELDS = [
  "email1_subject",
  "email1_body",
  "email2_body",
  "product_details",
  "signature",
  "sender_address",
];

// ------------------------------------------------------------------ status

router.get("/status", async (_req, res) => {
  try {
    const settings = await engine.getSettings();
    const inboxes = getInboxes();
    const since = new Date(new Date().setUTCHours(0, 0, 0, 0));
    const inboxRows = await Promise.all(
      inboxes.map(async (ib) => ({
        ...describeInbox(ib),
        dailyCap: ib.dailyCap || settings.default_daily_cap,
        sentToday: await EmailMessage.countDocuments({ inboxEmail: ib.email, direction: "outbound", outreachStep: { $exists: true }, sentAt: { $gte: since } }),
      }))
    );
    const byStatus = await Importer.aggregate([{ $match: { outreach_status: { $nin: ["", null] } } }, { $group: { _id: "$outreach_status", n: { $sum: 1 } } }]);
    const eligible = await Importer.countDocuments({
      email_status: "verified",
      verification_grade: { $in: ["A", "B"] },
      outreach_enrolled: { $ne: true },
      outreach_status: { $in: ["", null] },
      unsubscribed: { $ne: true },
      suppressed: { $ne: true },
    });
    res.json({
      settings,
      inboxes: inboxRows,
      publicUrl: engine.publicUrl(),
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
      eligibleNotEnrolled: eligible,
      suppressionCount: await Suppression.estimatedDocumentCount(),
      mergeFields: R.MERGE_FIELDS,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ settings

router.put("/settings", async (req, res) => {
  try {
    const b = req.body || {};
    const set = {};
    for (const k of SETTINGS_FIELDS) if (b[k] !== undefined) set[k] = String(b[k]);

    for (const k of ["email1_subject", "email1_body", "email2_body"]) {
      if (set[k] === undefined) continue;
      if (!set[k].trim()) return fail(res, new Error(`${k.replace("_", " ")} cannot be empty`), 400);
      const { unknown } = R.renderTemplate(set[k], {});
      if (unknown.length) return fail(res, new Error(`Unknown merge field(s) in ${k}: ${unknown.join(", ")}. Allowed: ${R.MERGE_FIELDS.join(", ")}`), 400);
    }
    if (b.wait_hours !== undefined) set.wait_hours = R.normalizeWaitHours(b.wait_hours);
    if (b.business_start_hour !== undefined || b.business_end_hour !== undefined) {
      const cur = await engine.getSettings();
      const start = Number(b.business_start_hour ?? cur.business_start_hour);
      const end = Number(b.business_end_hour ?? cur.business_end_hour);
      if (!(start >= 0 && end <= 24 && start < end)) return fail(res, new Error("Business hours: start must be before end (0–24)"), 400);
      set.business_start_hour = start;
      set.business_end_hour = end;
    }
    if (b.business_days !== undefined) {
      const days = [...new Set((b.business_days || []).map(Number))].filter((d) => d >= 0 && d <= 6);
      if (!days.length) return fail(res, new Error("Select at least one business day"), 400);
      set.business_days = days.sort();
    }
    if (b.default_daily_cap !== undefined) {
      const cap = Number(b.default_daily_cap);
      if (!(cap >= 1 && cap <= 500)) return fail(res, new Error("Daily cap must be 1–500"), 400);
      set.default_daily_cap = cap;
    }
    if (b.min_gap_seconds !== undefined) {
      const gap = Number(b.min_gap_seconds);
      if (!(gap >= 10 && gap <= 3600)) return fail(res, new Error("Gap between sends must be 10–3600 seconds"), 400);
      set.min_gap_seconds = gap;
    }
    if (b.sending_enabled !== undefined) {
      const on = Boolean(b.sending_enabled);
      if (on) {
        if (!getInboxes().length) return fail(res, new Error("Add a sending inbox (SMTP_* settings) to the backend .env first"), 400);
        if (!engine.publicUrl()) return fail(res, new Error("Set OUTREACH_PUBLIC_URL in the backend .env so unsubscribe links work"), 400);
        const s = await engine.getSettings();
        if (!String(set.product_details ?? s.product_details).trim()) {
          return fail(res, new Error("Fill in Product details before switching sending on (it's used in the emails)"), 400);
        }
      }
      set.sending_enabled = on;
    }
    await engine.getSettings();
    const settings = await OutreachSettings.findOneAndUpdate({}, { $set: set }, { new: true });
    res.json({ success: true, settings });
  } catch (err) {
    fail(res, err, 400);
  }
});

// ------------------------------------------------------------------ queue

router.get("/queue", async (_req, res) => {
  try {
    const rows = await Importer.find({ $or: [{ outreach_enrolled: true }, { outreach_status: { $nin: ["", null] } }] })
      .select(
        "companyName importerName contactPerson email country recipient_timezone verification_grade email_status outreach_enrolled outreach_status outreach_step outreach_next_send_at outreach_inbox outreach_last_error email_1_sent_at email_2_sent_at email_2_scheduled_at reply_detected_at bounce_detected_at outreach_wait_hours pipeline_status"
      )
      .sort({ outreach_next_send_at: 1, updatedAt: -1 })
      .lean();
    res.json(rows.map((r) => ({ ...r, timezone: R.resolveTimezone(r).tz })));
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ preview & test send

async function previewFor(importerId, step) {
  const settings = await engine.getSettings();
  const imp = importerId ? await Importer.findById(importerId).lean() : null;
  if (importerId && !imp) throw Object.assign(new Error("Importer not found"), { status: 404 });
  const sample = imp || { _id: "000000000000000000000000", companyName: "Example Spice Trading LLC", contactPerson: "Jan de Vries", country: "Netherlands" };
  const inbox = getInboxes()[0];
  const forStep = step === 2 ? { ...sample, outreach_subject: sample.outreach_subject || engine.composeEmail(sample, settings, 1, { inbox }).subject } : sample;
  const previous = step === 2 ? { sentAt: new Date(), body: engine.composeEmail(sample, settings, 1, { inbox }).text.split("\n\n--\n")[0] } : null;
  return { mail: engine.composeEmail(forStep, settings, step, { inbox, previous }), sample: !imp, inbox };
}

router.post("/preview", async (req, res) => {
  try {
    const step = Number(req.body?.step) === 2 ? 2 : 1;
    const { mail, sample } = await previewFor(req.body?.importerId, step);
    res.json({ success: true, sample, subject: mail.subject, text: mail.text, html: mail.html, problems: mail.problems });
  } catch (err) {
    fail(res, err);
  }
});

/** Send the rendered email to an address you control (subject prefixed [TEST]). Not logged as outreach. */
router.post("/test-send", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return fail(res, new Error("Enter a valid email address to send the test to"), 400);
    const step = Number(req.body?.step) === 2 ? 2 : 1;
    const { mail, inbox } = await previewFor(req.body?.importerId, step);
    if (!inbox) return fail(res, new Error("No sending inbox configured in the backend .env"), 400);
    const hardProblems = mail.problems.filter((p) => !/OUTREACH_PUBLIC_URL/.test(p));
    if (hardProblems.length) return fail(res, new Error(hardProblems.join("; ")), 400);

    const attachments = [];
    const deckPath = path.resolve(__dirname, "../../uploads/oneroot_IPM_Turmeric_Europe_v4.pdf");
    if (fs.existsSync(deckPath)) {
      attachments.push({
        filename: "OneRoot_IPM_Turmeric_Europe_Specifications.pdf",
        path: deckPath,
        contentType: "application/pdf",
      });
    }

    const r = await sendMail(inbox, { to, subject: `[TEST] ${mail.subject}`, text: mail.text, html: mail.html, attachments });
    res.json({ success: true, from: inbox.email, messageId: r.messageId, warnings: mail.problems, attachmentCount: attachments.length });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ inbox connection test

router.post("/inboxes/test", async (_req, res) => {
  try {
    const inboxes = getInboxes();
    if (!inboxes.length) return res.json({ success: true, inboxes: [], message: "No inbox configured" });
    const results = await Promise.all(
      inboxes.map(async (ib) => {
        const smtp = await verifySmtp(ib);
        let imap = { ok: false, error: "IMAP not configured" };
        if (ib.imap) {
          const client = new ImapFlow({
            host: ib.imap.host,
            port: ib.imap.port,
            secure: ib.imap.port === 993,
            auth: { user: ib.imap.user, pass: ib.imap.pass },
            logger: false,
          });
          try {
            await client.connect();
            await client.logout();
            imap = { ok: true };
          } catch (err) {
            imap = { ok: false, error: err.responseText || err.message };
          }
        }
        return { email: ib.email, smtp, imap };
      })
    );
    res.json({ success: true, inboxes: results });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/run-now", async (_req, res) => {
  try {
    res.json({ success: true, result: await engine.tick() });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/check-inbox-now", async (_req, res) => {
  try {
    res.json({ success: true, result: await engine.pollInboxes() });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ bulk stop sequences / follow-ups

router.post("/bulk-stop", async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("name");
    const userName = user?.name || "User";
    const { ids, allWaitingFollowup, allActive } = req.body || {};

    let query = {};
    if (allWaitingFollowup) {
      query = {
        outreach_enrolled: true,
        $or: [{ outreach_status: "waiting_followup" }, { outreach_step: 1 }],
      };
    } else if (allActive) {
      query = {
        $or: [
          { outreach_enrolled: true },
          { outreach_status: { $in: ["scheduled", "waiting_followup"] } },
        ],
      };
    } else if (Array.isArray(ids) && ids.length) {
      query = {
        _id: { $in: ids },
        $or: [
          { outreach_enrolled: true },
          { outreach_status: { $in: ["scheduled", "waiting_followup"] } },
        ],
      };
    } else {
      return fail(res, new Error("Provide an array of lead IDs, or allWaitingFollowup: true, or allActive: true"), 400);
    }

    const matches = await Importer.find(query).select("_id");
    let count = 0;
    for (const imp of matches) {
      await engine.stopSequence(imp._id, "stopped", "Follow-up email stopped in bulk", {}, userName);
      count++;
    }

    res.json({ success: true, count });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ suppression list

router.get("/suppressions", async (_req, res) => {
  try {
    res.json(await Suppression.find().sort({ createdAt: -1 }).limit(1000).lean());
  } catch (err) {
    fail(res, err);
  }
});

router.post("/suppressions", async (req, res) => {
  try {
    const raw = String(req.body?.email || "").trim().toLowerCase();
    const isDomain = /^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(raw) && !raw.includes("@", 1);
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw);
    if (!isEmail && !isDomain) return fail(res, new Error("Enter an email address (name@firm.com) or a domain (@firm.com)"), 400);
    const email = isEmail ? raw : raw.startsWith("@") ? raw : `@${raw}`;
    const user = await User.findById(req.userId).select("name");
    const doc = await Suppression.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, reason: "manual", note: String(req.body?.note || "").trim(), addedBy: user?.name || "User" } },
      { upsert: true, new: true }
    );
    // Stop any running sequence to this address/domain.
    const match = email.startsWith("@") ? { email: { $regex: `${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } } : { email };
    const affected = await Importer.find({ ...match, outreach_enrolled: true }).select("_id");
    for (const a of affected) await engine.stopSequence(a._id, "stopped", `Suppressed (${email}) by ${user?.name || "User"}`, {}, user?.name || "User");
    res.json({ success: true, suppression: doc, stoppedSequences: affected.length });
  } catch (err) {
    fail(res, err);
  }
});

router.delete("/suppressions/:id", async (req, res) => {
  try {
    const doc = await Suppression.findById(req.params.id);
    if (!doc) return fail(res, new Error("Not found"), 404);
    if (doc.reason === "unsubscribed") {
      return fail(res, new Error("This person unsubscribed — their request can't be removed from the list"), 400);
    }
    await doc.deleteOne();
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ public unsubscribe (no login)

const publicRouter = express.Router();
publicRouter.use(express.urlencoded({ extended: false }));

function page(title, message, form = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;color:#222;margin:0;padding:48px 16px}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{font-size:15px;line-height:1.5;color:#444}button{background:#5b21b6;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p>${form}</div></body></html>`;
}

async function doUnsubscribe(importerId, how) {
  const imp = await Importer.findById(importerId).select("email outreach_enrolled");
  if (!imp) return null;
  if (imp.email) await engine.suppress(imp.email, "unsubscribed", imp._id, how);
  await engine.stopSequence(imp._id, "unsubscribed", `Unsubscribed via ${how}`, { unsubscribed: true }, "Recipient");
  return imp;
}

publicRouter.get("/:token", async (req, res) => {
  const id = R.readUnsubscribeToken(req.params.token);
  if (!id) return res.status(400).send(page("Link not valid", "This unsubscribe link is not valid. Reply to the email with “unsubscribe” and we'll remove you."));
  // Confirmation step: link scanners in mail filters follow GET links; only a POST unsubscribes.
  res.send(
    page(
      "Unsubscribe",
      "Click the button to stop receiving emails from us.",
      `<form method="post"><button type="submit">Unsubscribe</button></form>`
    )
  );
});

publicRouter.post("/:token", async (req, res) => {
  try {
    const id = R.readUnsubscribeToken(req.params.token);
    if (!id) return res.status(400).send(page("Link not valid", "This unsubscribe link is not valid."));
    const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
    const imp = await doUnsubscribe(id, oneClick ? "one-click (mail client)" : "unsubscribe link");
    if (!imp) return res.status(404).send(page("Not found", "We couldn't find this subscription — you won't receive further emails."));
    res.send(page("You're unsubscribed", "You won't receive any more emails from us. Sorry for the interruption."));
  } catch (err) {
    res.status(500).send(page("Something went wrong", "Please reply to the email with “unsubscribe” and we'll remove you."));
  }
});

module.exports = { router, publicRouter };
