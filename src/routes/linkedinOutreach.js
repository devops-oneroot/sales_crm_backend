const express = require("express");
const Lead = require("../models/Lead");
const LinkedInMessage = require("../models/LinkedInMessage");
const { getStatus, isLinkedInProfileUrl, sendNow, setAutoSend } = require("../services/unipileService");

const router = express.Router();

/** GET /api/linkedin-outreach/status — connected account and today's numbers. */
router.get("/status", async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** GET /api/linkedin-outreach/messages?leadId= — queue and history. */
router.get("/messages", async (req, res) => {
  try {
    const filter = {};
    if (req.query.leadId) filter.leadId = req.query.leadId;
    const items = await LinkedInMessage.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/linkedin-outreach/messages
 * { leadId, contactName, profileUrl, text } — adds one message to the queue.
 */
router.post("/messages", async (req, res) => {
  try {
    const { leadId, contactName, profileUrl, text, note } = req.body || {};
    const url = String(profileUrl || "").trim();
    const body = String(text || "").trim();
    if (!isLinkedInProfileUrl(url)) {
      return res.status(400).json({ message: "Enter a LinkedIn profile link (linkedin.com/in/…)" });
    }
    if (!body) return res.status(400).json({ message: "Write a message first" });
    if (body.length > 1900) return res.status(400).json({ message: "Message is too long (max 1900 characters)" });

    const lead = leadId ? await Lead.findById(leadId).select("company").lean() : null;
    if (leadId && !lead) return res.status(404).json({ message: "Lead not found" });

    const already = await LinkedInMessage.findOne({
      profileUrl: url,
      status: { $in: ["queued", "sent", "invited", "accepted"] },
    }).lean();
    if (already) {
      return res.status(409).json({
        message:
          already.status === "queued"
            ? "This person is already in the LinkedIn queue"
            : "This person was already contacted on LinkedIn",
      });
    }

    const msg = await LinkedInMessage.create({
      leadId: lead?._id,
      company: lead?.company || String(req.body?.company || "").trim(),
      contactName: String(contactName || "").trim(),
      profileUrl: url,
      text: body,
      note: String(note || "").trim().slice(0, 300) || undefined,
      queuedBy: req.userName || "",
    });
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PATCH /api/linkedin-outreach/settings { autoSend } — admins switch automatic sending on/off. */
router.patch("/settings", async (req, res) => {
  try {
    if (!req.isAdmin) return res.status(403).json({ message: "Only admins can change this" });
    if (typeof req.body?.autoSend !== "boolean") return res.status(400).json({ message: "autoSend must be true or false" });
    await setAutoSend(req.body.autoSend, req.userName);
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** POST /api/linkedin-outreach/messages/:id/send — send this one now (or retry a failed one). */
router.post("/messages/:id/send", async (req, res) => {
  try {
    const msg = await sendNow(req.params.id);
    if (msg.status === "failed") return res.status(502).json({ message: msg.error, item: msg });
    res.json(msg);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

/** DELETE /api/linkedin-outreach/messages/:id — cancel a message still in the queue. */
router.delete("/messages/:id", async (req, res) => {
  try {
    const msg = await LinkedInMessage.findOneAndUpdate(
      { _id: req.params.id, status: "queued" },
      { status: "cancelled" },
      { new: true }
    );
    if (!msg) return res.status(404).json({ message: "Only queued messages can be cancelled" });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
