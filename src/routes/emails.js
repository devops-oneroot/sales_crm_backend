const express = require("express");
const Importer = require("../models/Importer");
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

// POST 1-click personalized email outreach directly mentioning buyer name, company, and products
router.post("/importer/:importerId/one-click-send", async (req, res) => {
  try {
    const { templateId, customSubject, customBody } = req.body;
    const result = await sendOneClickPersonalizedEmail({
      importerId: req.params.importerId,
      userId: req.userId,
      userName: req.userName,
      templateId,
      customSubject,
      customBody,
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

