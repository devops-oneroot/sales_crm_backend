const express = require("express");
const LinkedInLead = require("../models/LinkedInLead");
const Importer = require("../models/Importer");
const User = require("../models/User");
const { toCurrentStatus } = require("../lib/leadStatuses");
const {
  syncLinkedInLeads,
  generateOutreachTemplates,
  getLinkedInAccountStatus,
  connectLinkedInAccount,
  disconnectLinkedInAccount,
  searchLiveLinkedInLeads,
} = require("../services/linkedInScraperService");

const router = express.Router();

function pickLeadFields(body) {
  let targetProducts = [];
  if (Array.isArray(body.targetProducts)) {
    targetProducts = body.targetProducts.map((p) => String(p).trim()).filter(Boolean);
  } else if (typeof body.targetProducts === "string" && body.targetProducts.trim()) {
    targetProducts = [body.targetProducts.trim()];
  } else if (Array.isArray(body.products)) {
    targetProducts = body.products.map((p) => String(p).trim()).filter(Boolean);
  }

  return {
    fullName: String(body.fullName || "").trim(),
    headline: String(body.headline || "").trim(),
    companyName: String(body.companyName || "").trim(),
    jobTitle: String(body.jobTitle || "").trim(),
    profileUrl: String(body.profileUrl || "").trim(),
    companyLinkedinUrl: String(body.companyLinkedinUrl || "").trim(),
    location: String(body.location || "").trim(),
    country: String(body.country || "United States").trim(),
    email: String(body.email || "").trim().toLowerCase(),
    phone: String(body.phone || "").trim(),
    connectionStatus: body.connectionStatus || "not_connected",
    targetProducts,
    curcuminPercent:
      body.curcuminPercent != null && body.curcuminPercent !== ""
        ? Number(body.curcuminPercent)
        : undefined,
    quantityKg:
      body.quantityKg != null && body.quantityKg !== ""
        ? Number(body.quantityKg)
        : undefined,
    notes: String(body.notes || "").trim(),
    responsiblePerson: String(body.responsiblePerson || "").trim(),
    status: toCurrentStatus(body.status),
  };
}

// GET all LinkedIn leads
router.get("/", async (req, res) => {
  try {
    const leads = await LinkedInLead.find().sort({ updatedAt: -1 });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST sync / fetch LinkedIn leads
router.post("/sync", async (req, res) => {
  try {
    const result = await syncLinkedInLeads({ triggerType: "manual" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET user's connected LinkedIn account status
router.get("/account", async (req, res) => {
  try {
    const status = await getLinkedInAccountStatus(req.userId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST connect LinkedIn account
router.post("/account/connect", async (req, res) => {
  try {
    const status = await connectLinkedInAccount(req.userId, req.body);
    res.json({
      success: true,
      message: `Successfully connected LinkedIn account "${status.accountName}"!`,
      account: status,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST disconnect LinkedIn account
router.post("/account/disconnect", async (req, res) => {
  try {
    const status = await disconnectLinkedInAccount(req.userId);
    res.json({
      success: true,
      message: "LinkedIn account disconnected.",
      account: status,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST search live leads via connected account
router.post("/search-live", async (req, res) => {
  try {
    const result = await searchLiveLinkedInLeads(req.userId, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET specific LinkedIn lead (includes outreach templates)
router.get("/:id", async (req, res) => {
  try {
    const lead = await LinkedInLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: "LinkedIn lead not found" });
    }
    const templates = generateOutreachTemplates(lead);
    res.json({
      ...lead.toObject(),
      templates,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create LinkedIn lead
router.post("/", async (req, res) => {
  try {
    const creator = await User.findById(req.userId).select("name role");
    const fields = pickLeadFields(req.body);

    if (!fields.fullName) {
      return res.status(400).json({ message: "Full name is required" });
    }
    if (!fields.companyName) {
      return res.status(400).json({ message: "Company name is required" });
    }
    if (!fields.profileUrl) {
      return res.status(400).json({ message: "LinkedIn profile URL is required" });
    }

    if (!fields.responsiblePerson) {
      fields.responsiblePerson = creator?.name || "Admin";
    }

    const lead = await LinkedInLead.create({
      ...fields,
      createdBy: req.userId,
    });

    res.status(201).json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH update LinkedIn lead
router.patch("/:id", async (req, res) => {
  try {
    const fields = pickLeadFields(req.body);
    delete fields.createdBy;

    const lead = await LinkedInLead.findByIdAndUpdate(
      req.params.id,
      fields,
      { new: true, runValidators: true }
    );
    if (!lead) {
      return res.status(404).json({ message: "LinkedIn lead not found" });
    }
    res.json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST record outreach message (InMail, connection request, etc.)
router.post("/:id/outreach", async (req, res) => {
  try {
    const { messageType, subject, text } = req.body;
    const lead = await LinkedInLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: "LinkedIn lead not found" });
    }

    lead.outreachMessages.push({
      sentAt: new Date(),
      messageType: messageType || "connection_request",
      subject: subject || "",
      text: text || "",
      status: "sent",
    });

    if (messageType === "connection_request" && lead.connectionStatus === "not_connected") {
      lead.connectionStatus = "connection_sent";
    } else if (messageType === "inmail" || messageType === "quote") {
      lead.connectionStatus = "messaged";
    }

    await lead.save();
    res.json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST convert LinkedIn lead into an Importer in the Importers table
router.post("/:id/convert-to-importer", async (req, res) => {
  try {
    const lead = await LinkedInLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: "LinkedIn lead not found" });
    }

    // Check if importer already exists
    let importer = await Importer.findOne({
      $or: [
        { importerName: lead.companyName },
        ...(lead.email ? [{ email: lead.email }] : []),
      ],
    });

    if (!importer) {
      importer = await Importer.create({
        importerName: lead.companyName,
        companyName: lead.companyName,
        contactPerson: lead.fullName,
        importerNumber: lead.phone || "+1 000 000 0000",
        email: lead.email || "",
        website: lead.companyLinkedinUrl || lead.profileUrl,
        country: lead.country || "United States",
        importerType: "LinkedIn Sourced Buyer",
        products: lead.targetProducts?.length ? lead.targetProducts : ["turmeric"],
        curcuminPercent: lead.curcuminPercent || 3.5,
        quantityKg: lead.quantityKg || 25000,
        remarks: `Converted from LinkedIn Lead (${lead.fullName} - ${lead.headline || lead.jobTitle}). Profile: ${lead.profileUrl}`,
        responsiblePerson: lead.responsiblePerson || "Admin",
        createdBy: req.userId,
        status: "requirement_understood",
      });
    }

    // Update LinkedIn lead connection status to converted
    lead.connectionStatus = "converted";
    await lead.save();

    res.json({
      success: true,
      message: `Successfully converted "${lead.fullName}" into Importer "${lead.companyName}"!`,
      importer,
      lead,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE LinkedIn lead
router.delete("/:id", async (req, res) => {
  try {
    const lead = await LinkedInLead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: "LinkedIn lead not found" });
    }
    res.json({ success: true, message: "LinkedIn lead deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

