const express = require("express");
const Importer = require("../models/Importer");
const Lead = require("../models/Lead");
const User = require("../models/User");
const { toCurrentStatus } = require("../lib/leadStatuses");
const {
  runTurmericImporterScraper,
  getScraperStatus,
} = require("../services/turmericScraperService");
const {
  PIPELINE_STATUSES,
  normalizeDomain,
  validateImporterProvenance,
  canEnrollInOutreach,
  validateFollowUpWaitHours,
  calculateLeadGrade,
  IMMUTABLE_PROVENANCE_FIELDS,
} = require("../lib/importerProvenance");
const discoveryRouter = require("./discovery");
const { enrichImporterContacts } = require("../services/contactEnrichment");
const { verifyImporters, verifierConfig } = require("../services/verificationService");
const outreachEngine = require("../services/outreachEngine");

const router = express.Router();
router.use("/discovery", discoveryRouter);

function pickImporterFields(body) {
  const importerName = String(
    body.importerName || body.name || body.companyName || ""
  ).trim();
  const importerNumber = String(body.importerNumber || body.phone || "").trim();

  let products = [];
  if (Array.isArray(body.products)) {
    products = body.products.map((p) => String(p).trim()).filter(Boolean);
  } else if (typeof body.products === "string" && body.products.trim()) {
    products = [body.products.trim()];
  }

  const website = body.website ? String(body.website).trim() : "";
  const website_domain = body.website_domain
    ? normalizeDomain(body.website_domain)
    : normalizeDomain(website);

  // Provenance fields are taken as given. Only POST fills them in, and only for
  // manual entry (see applyManualProvenance). Fetched records without them are rejected.
  const source_url = body.source_url ? String(body.source_url).trim() : "";
  const fetched_at = body.fetched_at ? new Date(body.fetched_at) : undefined;

  return {
    importerName: importerName || "—",
    companyName: body.companyName ? String(body.companyName).trim() : importerName,
    contactPerson: body.contactPerson ? String(body.contactPerson).trim() : "",
    importerNumber,
    email: body.email ? String(body.email).trim().toLowerCase() : "",
    website,
    website_domain,
    country: body.country ? String(body.country).trim() : "United States",
    state: body.state ? String(body.state).trim() : "",
    city: body.city ? String(body.city).trim() : "",
    address: body.address ? String(body.address).trim() : "",

    // Provenance
    source_url,
    fetched_at,
    source_type: body.source_type || "manual",
    raw_extracted_text: body.raw_extracted_text ? String(body.raw_extracted_text) : "",

    // Verification
    website_live: Boolean(body.website_live),
    website_status_code: body.website_status_code ? Number(body.website_status_code) : undefined,
    email_status: body.email_status || "unverified",
    verification_score: body.verification_score != null ? Number(body.verification_score) : 0,
    verification_grade: body.verification_grade || "Unrated",
    verification_checked_at: body.verification_checked_at ? new Date(body.verification_checked_at) : undefined,

    // Pipeline
    pipeline_status: PIPELINE_STATUSES.includes(body.pipeline_status) ? body.pipeline_status : "New",

    // Outreach
    outreach_enrolled: Boolean(body.outreach_enrolled),
    outreach_step: body.outreach_step != null ? Number(body.outreach_step) : 0,
    outreach_wait_hours: body.outreach_wait_hours != null ? Number(body.outreach_wait_hours) : 48,
    recipient_timezone: body.recipient_timezone || "UTC",
    unsubscribed: Boolean(body.unsubscribed),
    suppressed: Boolean(body.suppressed),

    // LinkedIn Queue
    linkedin_short_message: body.linkedin_short_message ? String(body.linkedin_short_message).trim() : "",
    linkedin_task_status: body.linkedin_task_status || "to_send",

    // Trade Specs
    taxIdOrIec: body.taxIdOrIec ? String(body.taxIdOrIec).trim() : "",
    importerType: body.importerType ? String(body.importerType).trim() : "",
    products,
    materialType: body.materialType ? String(body.materialType).trim() : "",
    polishLevel: body.polishLevel ? String(body.polishLevel).trim() : "",
    curcuminPercent:
      body.curcuminPercent != null && body.curcuminPercent !== ""
        ? Number(body.curcuminPercent)
        : undefined,
    grade: body.grade ? String(body.grade).trim() : "",
    price: body.price != null && body.price !== "" ? Number(body.price) : undefined,
    quantityKg:
      body.quantityKg != null && body.quantityKg !== ""
        ? Number(body.quantityKg)
        : undefined,
    incoterm: body.incoterm ? String(body.incoterm).trim() : "",
    portOfLoading: body.portOfLoading ? String(body.portOfLoading).trim() : "",
    portOfDischarge: body.portOfDischarge ? String(body.portOfDischarge).trim() : "",
    paymentTerms: body.paymentTerms ? String(body.paymentTerms).trim() : "",
    paymentDays:
      body.paymentDays != null && body.paymentDays !== ""
        ? Number(body.paymentDays)
        : undefined,
    remarks: body.remarks ? String(body.remarks).trim() : "",
    responsiblePerson: body.responsiblePerson ? String(body.responsiblePerson).trim() : "",
    followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
    status: body.pipeline_status || toCurrentStatus(body.status),
  };
}

/**
 * Manual entry is a legitimate source: the user is the source. Stamp who entered it
 * and when. Any other source_type must arrive with its own source_url + fetched_at.
 */
function applyManualProvenance(fields, userId) {
  if (fields.source_type !== "manual") return fields;
  return {
    ...fields,
    source_url: fields.source_url || `manual://user/${userId}`,
    fetched_at: fields.fetched_at || new Date(),
  };
}

/**
 * Set only by the server (Verification service / enrol endpoint), never by a client
 * create or edit — otherwise anyone could mark an email "verified" or skip the gate.
 */
const SERVER_ONLY_FIELDS = [
  "website_live",
  "website_status_code",
  "email_status",
  "verification_score",
  "verification_grade",
  "verification_checked_at",
  "outreach_enrolled",
  "outreach_step",
];
const UNVERIFIED_DEFAULTS = {
  website_live: false,
  email_status: "unverified",
  verification_score: 0,
  verification_grade: "Unrated",
  outreach_enrolled: false,
  outreach_step: 0,
};

/** Body keys (incl. aliases) that map to each picked field, for partial PATCH. */
const PATCH_ALIASES = {
  importerName: ["importerName", "name", "companyName"],
  importerNumber: ["importerNumber", "phone"],
  status: ["status", "pipeline_status"],
};

/** Keep only fields the client actually sent, and never provenance fields. */
function pickPatchFields(body) {
  const all = pickImporterFields(body);
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (IMMUTABLE_PROVENANCE_FIELDS.includes(key) || SERVER_ONLY_FIELDS.includes(key)) continue;
    const keys = PATCH_ALIASES[key] || [key];
    if (keys.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
      out[key] = value;
    }
  }
  if (out.website !== undefined && body.website_domain === undefined) {
    out.website_domain = all.website_domain;
  }
  return out;
}

function importerToResponse(doc) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  return {
    ...o,
    status: o.pipeline_status || toCurrentStatus(o.status, o.pipelineStatus),
    pipeline_status: o.pipeline_status || "New",
  };
}

// GET all importers (Supports sub-view filters)
router.get("/", async (req, res) => {
  try {
    const { pipeline_status, email_status, verification_grade, search, country } = req.query;
    const filter = {};

    if (pipeline_status) {
      filter.pipeline_status = pipeline_status;
    }
    if (email_status) {
      filter.email_status = email_status;
    }
    if (verification_grade) {
      filter.verification_grade = verification_grade;
    }
    if (country) {
      filter.country = new RegExp(`^${country.trim()}$`, "i");
    }
    if (search) {
      const q = String(search).trim();
      filter.$or = [
        { importerName: new RegExp(q, "i") },
        { companyName: new RegExp(q, "i") },
        { email: new RegExp(q, "i") },
        { country: new RegExp(q, "i") },
        { website_domain: new RegExp(q, "i") },
      ];
    }

    const importers = await Importer.find(filter).sort({ updatedAt: -1 });
    res.json(importers.map(importerToResponse));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET scraper status & schedule
router.get("/scraper-status", async (_req, res) => {
  try {
    const status = await getScraperStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST trigger turmeric importers scraper — DISABLED.
// The legacy scraper generated contact data (random phone numbers, guessed emails,
// a hard-coded buyer list), which violates the "never invent lead data" rule.
// Importers → Discovery replaces it.
router.post("/scrape", (_req, res) => {
  res.status(410).json({
    success: false,
    message:
      "The legacy importer scraper is disabled because it generated contact data. Use Importers → Discovery instead.",
  });
});

// GET verification overview: verifier setup + counts by email status and grade
router.get("/verification/status", async (_req, res) => {
  try {
    const cfg = verifierConfig();
    const [byEmail, byGrade, pending, ready] = await Promise.all([
      Importer.aggregate([{ $group: { _id: "$email_status", n: { $sum: 1 } } }]),
      Importer.aggregate([{ $group: { _id: "$verification_grade", n: { $sum: 1 } } }]),
      Importer.countDocuments({ verification_checked_at: { $exists: false } }),
      Importer.countDocuments({
        email_status: "verified",
        verification_grade: { $in: ["A", "B"] },
        unsubscribed: { $ne: true },
        suppressed: { $ne: true },
      }),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id || "none", r.n]));
    res.json({
      provider: cfg.provider,
      verifierConfigured: cfg.configured,
      verifierNote: cfg.reason,
      byEmailStatus: toMap(byEmail),
      byGrade: toMap(byGrade),
      neverChecked: pending,
      readyForOutreach: ready,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST sync export leads from Leads tab into Importers pipeline
router.post("/sync-leads", async (req, res) => {
  try {
    const creator = await User.findById(req.userId).select("name role");
    const adminUser = await User.findOne({ role: "admin" }).select("_id name");
    const fallbackUserId = req.userId || adminUser?._id;
    const fallbackUserName = creator?.name || adminUser?.name || "System";

    // Find export leads (or any leads explicitly marked as export)
    const leads = await Lead.find({ leadType: "export" }).lean();
    if (!leads.length) {
      return res.json({
        success: true,
        message: "No export leads found to sync.",
        stats: { totalFound: 0, created: 0, updated: 0, skipped: 0 },
      });
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const lead of leads) {
      const compName = String(lead.company || lead.name || "").trim();
      if (!compName) {
        skipped++;
        continue;
      }

      const contactPerson = String(
        lead.contactPerson ||
        lead.contacts?.[0]?.name ||
        ""
      ).trim();

      const email = String(
        lead.email ||
        lead.emails?.[0] ||
        lead.contacts?.find((c) => c.email)?.email ||
        ""
      ).trim().toLowerCase();

      const phone = String(
        lead.phone ||
        lead.whatsappNumber ||
        lead.whatsappNumbers?.[0] ||
        lead.contacts?.[0]?.phone ||
        lead.contacts?.[0]?.phones?.[0] ||
        ""
      ).trim();

      const website = lead.website ? String(lead.website).trim() : "";
      const website_domain = website ? normalizeDomain(website) : "";

      // Deduplication: Match by company name OR email OR website_domain OR source_url
      const orConditions = [
        { importerName: new RegExp(`^${compName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
        { source_url: `manual://lead/${lead._id}` },
      ];
      if (email) orConditions.push({ email });
      if (website_domain) orConditions.push({ website_domain });

      const existing = await Importer.findOne({ $or: orConditions });

      if (existing) {
        let modified = false;
        if (!existing.email && email) {
          existing.email = email;
          modified = true;
        }
        if (!existing.importerNumber && phone) {
          existing.importerNumber = phone;
          modified = true;
        }
        if (!existing.contactPerson && contactPerson) {
          existing.contactPerson = contactPerson;
          modified = true;
        }
        if (!existing.country && lead.country) {
          existing.country = lead.country;
          modified = true;
        }
        if (modified) {
          await existing.save();
          updated++;
        } else {
          skipped++;
        }
      } else {
        let products = [];
        if (Array.isArray(lead.products) && lead.products.length) {
          products = lead.products.map((p) => (typeof p === "string" ? p : p.name)).filter(Boolean);
        }
        if (!products.length && lead.exportDetails?.materialType) {
          products = [lead.exportDetails.materialType];
        }
        if (!products.length) {
          products = ["Turmeric"];
        }

        let pipeline_status = "New";
        const st = String(lead.status || "").toLowerCase();
        if (st.includes("contact") || st.includes("established")) {
          pipeline_status = "Verified";
        } else if (st.includes("quotation") || st.includes("sample")) {
          pipeline_status = "Sample sent";
        } else if (st.includes("order")) {
          pipeline_status = "Order";
        } else if (st.includes("lost")) {
          pipeline_status = "Lost";
        }

        await Importer.create({
          importerName: compName,
          companyName: compName,
          contactPerson,
          importerNumber: phone,
          email,
          website,
          website_domain,
          country: lead.country || "Global",
          state: lead.exportDetails?.deliveryState || "",
          city: lead.exportDetails?.deliveryDistrict || "",
          address: lead.address || "",
          products,
          materialType: lead.exportDetails?.materialType || "Export Grade Turmeric",
          curcuminPercent: Number(lead.exportDetails?.minCurcumin) || 3.5,
          polishLevel: lead.exportDetails?.polishLevel || "Double Polished",
          quantityKg: Number(lead.exportDetails?.quantityNeededKg) || 25000,
          price: Number(lead.exportDetails?.maxPrice) || 155,
          incoterm: lead.exportDetails?.incoterm || "CIF",
          portOfDischarge: lead.exportDetails?.portDelivery || "",
          paymentTerms: lead.exportDetails?.paymentDays ? `${lead.exportDetails.paymentDays} days credit` : "30% Advance, 70% BL scan",
          pipeline_status,
          source_type: "manual",
          source_url: `manual://lead/${lead._id}`,
          fetched_at: lead.createdAt || new Date(),
          createdBy: lead.createdBy || fallbackUserId,
          responsiblePerson: lead.responsiblePerson || fallbackUserName,
          timeline: [
            {
              status: "Created",
              note: `Synced from Export Leads database (Lead ID: ${lead._id})`,
              changed_by: fallbackUserName,
              timestamp: new Date(),
            },
          ],
        });
        created++;
      }
    }

    res.json({
      success: true,
      message: `Sync complete: ${created} new buyers added, ${updated} enriched, ${skipped} already up to date.`,
      stats: {
        totalFound: leads.length,
        created,
        updated,
        skipped,
      },
    });
  } catch (err) {
    console.error("[SyncLeads] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST run verification (body: { ids?: string[] } — default: never-checked or >30 days old)
router.post("/verify", async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("name");
    const result = await verifyImporters({
      ids: Array.isArray(req.body?.ids) ? req.body.ids : null,
      userName: user?.name || "User",
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// POST enrol in outreach — the gate: only verified Grade A/B, not unsubscribed/suppressed
router.post("/:id/enroll", async (req, res) => {
  try {
    const imp = await Importer.findById(req.params.id);
    if (!imp) return res.status(404).json({ success: false, message: "Importer not found" });
    if (!imp.outreach_enrolled) {
      if (imp.outreach_step > 0 || ["completed", "replied", "bounced", "unsubscribed"].includes(imp.outreach_status)) {
        return res.status(422).json({ success: false, message: `This lead's sequence already ran (${imp.outreach_status || "sent"}); it can't be restarted` });
      }
      const user = await User.findById(req.userId).select("name");
      await outreachEngine.enrollImporter(imp, user?.name || "User");
    }
    res.json({ success: true, importer: importerToResponse(imp) });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post("/:id/unenroll", async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("name");
    const exists = await Importer.exists({ _id: req.params.id });
    if (!exists) return res.status(404).json({ success: false, message: "Importer not found" });
    await outreachEngine.stopSequence(req.params.id, "stopped", "Removed from email outreach", {}, user?.name || "User");
    const imp = await Importer.findById(req.params.id);
    res.json({ success: true, importer: importerToResponse(imp) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST find missing email/phone on importers' own websites — DISABLED
router.post("/find-contacts", async (_req, res) => {
  return res.status(400).json({
    success: false,
    message: "Web searching for contacts is disabled. Buyer details should come strictly from CSV/Excel import or manual entry.",
  });
});

// GET importer by ID
router.get("/:id", async (req, res) => {
  try {
    const importer = await Importer.findById(req.params.id);
    if (!importer) {
      return res.status(404).json({ message: "Importer not found" });
    }
    res.json(importerToResponse(importer));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST new importer (Strict Provenance & Deduplication)
router.post("/", async (req, res) => {
  try {
    const creator = await User.findById(req.userId).select("name role");
    const fields = { ...applyManualProvenance(pickImporterFields(req.body), req.userId), ...UNVERIFIED_DEFAULTS };
    delete fields.verification_checked_at;
    delete fields.website_status_code;

    if (!fields.importerName || fields.importerName === "—") {
      return res.status(400).json({ message: "Importer name is required" });
    }

    // STRICT PROVENANCE VALIDATION:
    // Reject records without source_url and fetched_at
    const provenance = validateImporterProvenance(fields);
    if (!provenance.valid) {
      return res.status(400).json({
        message: "Provenance validation failed. Every importer must store source_url and fetched_at.",
        errors: provenance.errors,
      });
    }

    // DEDUPLICATION BY WEBSITE DOMAIN
    if (fields.website_domain) {
      const existing = await Importer.findOne({
        website_domain: fields.website_domain,
      });
      if (existing) {
        return res.status(409).json({
          message: `Duplicate lead: Importer with website domain "${fields.website_domain}" already exists (${existing.companyName || existing.importerName}).`,
          duplicateId: existing._id,
        });
      }
    }

    if (creator?.name) {
      const creatorName = creator.name.trim();
      if (!req.isAdmin) {
        fields.responsiblePerson = creatorName;
      } else if (!fields.responsiblePerson) {
        fields.responsiblePerson = creatorName;
      }
    }

    // Initialize lead timeline
    const timeline = [
      {
        status: fields.pipeline_status || "New",
        note: `Lead ingested from ${fields.source_type} (${fields.source_url})`,
        changed_by: creator?.name || "System",
        timestamp: new Date(),
      },
    ];

    const importer = await Importer.create({
      ...fields,
      timeline,
      createdBy: req.userId,
    });
    res.status(201).json(importerToResponse(importer));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH update importer
router.patch("/:id", async (req, res) => {
  try {
    const fields = pickPatchFields(req.body);
    delete fields.createdBy;

    // Check if website_domain changed and conflicts with another record
    if (fields.website_domain) {
      const existing = await Importer.findOne({
        _id: { $ne: req.params.id },
        website_domain: fields.website_domain,
      });
      if (existing) {
        return res.status(409).json({
          message: `Duplicate lead: Importer with website domain "${fields.website_domain}" already exists.`,
          duplicateId: existing._id,
        });
      }
    }

    const currentDoc = await Importer.findById(req.params.id);
    if (!currentDoc) {
      return res.status(404).json({ message: "Importer not found" });
    }

    const creator = await User.findById(req.userId).select("name");
    const pushes = [];

    // Changing the email or website invalidates the previous verification.
    const emailChanged = fields.email !== undefined && fields.email !== (currentDoc.email || "");
    const websiteChanged = fields.website !== undefined && fields.website !== (currentDoc.website || "");
    if (emailChanged || websiteChanged) {
      Object.assign(fields, UNVERIFIED_DEFAULTS);
      pushes.push({
        status: "Verification reset",
        note: `${emailChanged ? "Email" : "Website"} changed — needs re-verification`,
        changed_by: creator?.name || "User",
        timestamp: new Date(),
      });
    }

    // Append to timeline if pipeline status changed
    const updateOps = { $set: fields };
    if (fields.pipeline_status && fields.pipeline_status !== currentDoc.pipeline_status) {
      pushes.push({
        status: fields.pipeline_status,
        note: req.body.statusChangeNote || `Pipeline status changed to ${fields.pipeline_status}`,
        changed_by: creator?.name || "User",
        timestamp: new Date(),
      });
    }
    if (pushes.length) updateOps.$push = { timeline: { $each: pushes } };
    if (emailChanged || websiteChanged) updateOps.$unset = { verification_checked_at: 1, email_check_detail: 1, website_check_detail: 1 };

    const importer = await Importer.findByIdAndUpdate(req.params.id, updateOps, {
      new: true,
      runValidators: true,
    });

    res.json(importerToResponse(importer));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE importer
router.delete("/:id", async (req, res) => {
  try {
    const importer = await Importer.findByIdAndDelete(req.params.id);
    if (!importer) {
      return res.status(404).json({ message: "Importer not found" });
    }
    res.json({ success: true, message: "Importer deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
