const express = require("express");
const Importer = require("../models/Importer");
const Lead = require("../models/Lead");
const { isPlaceholderEmail } = require("../lib/importerProvenance");
const EmailMessage = require("../models/EmailMessage");
const Suppression = require("../models/Suppression");
const {
  EMAIL_TEMPLATES,
  getEmailsForImporter,
  sendEmailReply,
  sendOneClickPersonalizedEmail,
  simulateInboundEmail,
  markEmailAsRead,
} = require("../services/emailService");

const router = express.Router();

// GET all outreach sent and bounced emails with stats
router.get("/outreach-logs", async (req, res) => {
  try {
    const { status, search } = req.query;

    const query = {};
    if (status === "sent") {
      query.direction = "outbound";
      query.status = { $in: ["sent", "delivered"] };
    } else if (status === "opened") {
      query.$or = [{ status: "opened" }, { openCount: { $gt: 0 } }];
    } else if (status === "bounced") {
      query.$or = [
        { status: "bounced" },
        { classification: "bounce" },
        { status: "failed" },
      ];
    } else if (status === "delivered") {
      query.status = "delivered";
    }

    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim(), "i");
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { recipientEmail: regex },
          { recipientName: regex },
          { subject: regex },
          { senderEmail: regex },
        ],
      });
    }

    const [
      emails,
      totalSent,
      totalBounced,
      totalDelivered,
      totalReplies,
      totalOpened,
      humanOpens,
      appleMppOpens,
      totalClicked,
      bouncedSuppressions,
      bouncedImporters,
    ] = await Promise.all([
      EmailMessage.find(query)
        .populate(
          "importerId",
          "companyName importerName country email contactPerson verification_grade verification_score pipeline_status outreach_status"
        )
        .sort({ sentAt: -1, createdAt: -1 })
        .limit(200)
        .lean(),
      EmailMessage.countDocuments({
        direction: "outbound",
        status: { $nin: ["bounced", "failed"] },
      }),
      EmailMessage.countDocuments({
        $or: [
          { status: "bounced" },
          { classification: "bounce" },
          { status: "failed" },
        ],
      }),
      EmailMessage.countDocuments({ status: "delivered" }),
      EmailMessage.countDocuments({ direction: "inbound" }),
      EmailMessage.countDocuments({
        $or: [{ status: "opened" }, { openCount: { $gt: 0 } }],
      }),
      EmailMessage.countDocuments({
        $or: [{ status: "opened" }, { openCount: { $gt: 0 } }],
        isOpenAppleMpp: { $ne: true },
      }),
      EmailMessage.countDocuments({ isOpenAppleMpp: true }),
      EmailMessage.countDocuments({ clickCount: { $gt: 0 } }),
      Suppression.find({ reason: "bounced" }).lean(),
      Importer.find({ outreach_status: "bounced" })
        .select(
          "companyName importerName country email contactPerson outreach_status bounce_detected_at outreach_last_error"
        )
        .lean(),
    ]);

    res.json({
      success: true,
      stats: {
        totalSent,
        totalBounced: Math.max(
          totalBounced,
          bouncedSuppressions.length,
          bouncedImporters.length
        ),
        totalDelivered,
        totalReplies,
        totalOpened,
        humanOpens,
        appleMppOpens,
        totalClicked,
      },
      emails,
      bouncedSuppressions,
      bouncedImporters,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET templates (optionally populated with an importer's data)
router.get("/templates", async (req, res) => {
  try {
    const { importerId } = req.query;
    let importer = null;
    if (importerId) {
      importer = await Importer.findById(importerId);
    }

    const templates = EMAIL_TEMPLATES.map((t) => {
      if (importer) {
        const preview = t.generate(importer, req.userName || "OneRoot Sales");
        return {
          id: t.id,
          name: t.name,
          subject: preview.subject,
          body: preview.body,
        };
      }
      return {
        id: t.id,
        name: t.name,
        subject: t.subject,
      };
    });

    res.json(templates);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET all emails for an importer
router.get("/importer/:importerId", async (req, res) => {
  try {
    const emails = await getEmailsForImporter(req.params.importerId);
    res.json(emails);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST send an email reply
router.post("/importer/:importerId/reply", async (req, res) => {
  try {
    const { to, subject, body, inReplyTo } = req.body;
    const email = await sendEmailReply({
      importerId: req.params.importerId,
      to,
      subject,
      body,
      userId: req.userId,
      userName: req.userName,
      inReplyTo,
    });
    res.status(201).json(email);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * POST /api/emails/contacts { importerIds } →
 *   { [importerId]: { contacts: [{ name, email, emailedAt }], mainEmailedAt, replied } }
 *
 * For the "no reply → email the other contacts" follow-up in bulk email:
 *  - contacts: the other contact persons (from the linked lead), excluding the
 *    company's main email and placeholder addresses; emailedAt = already emailed
 *  - mainEmailedAt: when the company's main email was last emailed by us
 *  - replied: anyone at the company has written back
 */
router.post("/contacts", async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.importerIds) ? req.body.importerIds : []).slice(0, 2000);
    const importers = await Importer.find({ _id: { $in: ids } }).select("email linked_lead_id").lean();
    const leadIds = importers.map((i) => i.linked_lead_id).filter(Boolean);
    const leads = await Lead.find({ _id: { $in: leadIds } }).select("contacts contactPerson email emails").lean();
    const leadById = new Map(leads.map((l) => [String(l._id), l]));

    // Email history per company: our sends (by recipient) and any replies.
    const history = await EmailMessage.aggregate([
      { $match: { importerId: { $in: importers.map((i) => i._id) } } },
      {
        $group: {
          _id: { importerId: "$importerId", direction: "$direction", to: { $toLower: "$recipientEmail" } },
          last: { $max: "$createdAt" },
          okCount: { $sum: { $cond: [{ $in: ["$status", ["failed", "bounced"]] }, 0, 1] } },
        },
      },
    ]);
    const sentTo = new Map(); // `${importerId}|${email}` → last successful send
    const replied = new Set();
    for (const h of history) {
      const id = String(h._id.importerId);
      if (h._id.direction === "inbound") replied.add(id);
      else if (h.okCount > 0) sentTo.set(`${id}|${h._id.to}`, h.last);
    }

    const out = {};
    for (const imp of importers) {
      const id = String(imp._id);
      const main = String(imp.email || "").trim().toLowerCase();
      const entry = {
        contacts: [],
        mainEmailedAt: (main && sentTo.get(`${id}|${main}`)) || null,
        replied: replied.has(id),
      };
      out[id] = entry;
      const lead = imp.linked_lead_id && leadById.get(String(imp.linked_lead_id));
      if (!lead) continue;
      const seen = new Set([main]);
      const add = (name, email) => {
        const e = String(email || "").trim().toLowerCase();
        if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || seen.has(e) || isPlaceholderEmail(e)) return;
        seen.add(e);
        entry.contacts.push({ name: String(name || "").trim(), email: e, emailedAt: sentTo.get(`${id}|${e}`) || null });
      };
      for (const c of lead.contacts || []) add(c.name, c.email);
      add(lead.contactPerson, lead.email);
      for (const e of lead.emails || []) add("", e);
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST 1-click personalized email outreach directly mentioning buyer name, company, and products
router.post("/importer/:importerId/one-click-send", async (req, res) => {
  try {
    const { templateId, customSubject, customBody, toEmail, toName } = req.body;
    const result = await sendOneClickPersonalizedEmail({
      importerId: req.params.importerId,
      userId: req.userId,
      userName: req.userName,
      templateId,
      customSubject,
      customBody,
      toEmail,
      toName,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST simulate incoming email — DISABLED: it stored a made-up buyer reply as if it
// were real. Buyer replies now arrive through IMAP (Importers → Outreach).
router.post("/importer/:importerId/simulate", (_req, res) => {
  res.status(410).json({
    message: "Simulated buyer emails are disabled — real replies are read from the inbox (Importers → Outreach).",
  });
});

// PATCH mark email as read
router.patch("/:id/read", async (req, res) => {
  try {
    const email = await markEmailAsRead(req.params.id);
    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }
    res.json(email);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

