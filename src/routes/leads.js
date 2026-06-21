const express = require("express");
const { Readable } = require("stream");
const Lead = require("../models/Lead");
const User = require("../models/User");
const upload = require("../middleware/upload");
const {
  isCloudinaryReady,
  isPdfFile,
  isPdfDocument,
  getUploadOptions,
  resolveResourceType,
  mapDocumentForClient,
  fetchDocumentResponse,
  uploadBuffer,
  cloudinary,
  configureCloudinary,
} = require("../config/cloudinary");

const { enforceExportLeadBody } = require("../lib/adminScope");
const { applyResponsiblePersonPatch, findSalesUserByName } = require("../lib/leadAssign");
const { todayBusinessDate } = require("../lib/businessDate");
const { companyNamesMatch } = require("../lib/companyNameNormalize");
const { leadFilterForRequest, buyerLeadClause } = require("../lib/leadQuery");
const { logActivity } = require("../lib/logActivity");
const autoSaveToday = require("../lib/autoSaveToday");

const router = express.Router();

function guessDocumentContentType(doc, response) {
  if (isPdfDocument(doc)) return "application/pdf";
  const ext = (doc.format || doc.name?.split(".").pop() || "").toLowerCase();
  const byExt = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    tiff: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    avif: "image/avif",
    txt: "text/plain",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  if (byExt[ext]) return byExt[ext];
  const header = response.headers.get("content-type");
  if (header && !header.includes("application/octet-stream")) return header;
  return "application/octet-stream";
}

const STATUSES = [
  "identity",
  "contact_established",
  "in_progress",
  "deal",
  "junk",
];

function leadWithDocumentUrls(lead) {
  const obj = lead.toObject ? lead.toObject() : { ...lead };
  if (obj.documents?.length) {
    obj.documents = obj.documents.map((doc) => mapDocumentForClient(doc));
  }
  return obj;
}

function leadFilter(req, extra = {}) {
  return leadFilterForRequest(req, extra);
}

function findAccessibleLead(id, req) {
  return Lead.findOne(leadFilter(req, { _id: id }));
}

function normalizeStringList(value, legacySingle) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  const single = String(legacySingle || "").trim();
  return single ? [single] : [];
}

function normalizeContactsList(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .map((c) => ({
      name: String(c?.name || "").trim(),
      phone: String(c?.phone || "").trim(),
      email: String(c?.email || "").trim().toLowerCase(),
      designation: String(c?.designation || "").trim(),
      linkedIn: String(c?.linkedIn || "").trim(),
    }))
    .filter(
      (c) => c.name || c.phone || c.email || c.designation || c.linkedIn
    );
}

function normalizeLeadBody(body) {
  const data = { ...body };
  delete data.createdBy;
  const company = String(data.company || "").trim();

  let contacts = normalizeContactsList(data.contacts);
  if (!contacts.length) {
    const contactPersons = normalizeStringList(
      data.contactPersons,
      data.contactPerson
    );
    const emails = normalizeStringList(data.emails, data.email);
    const count = Math.max(contactPersons.length, emails.length, 1);
    contacts = Array.from({ length: count }, (_, i) => ({
      name: contactPersons[i] || "",
      phone: i === 0 ? String(data.phone || "").trim() : "",
      email: emails[i] || "",
      designation: i === 0 ? String(data.designation || "").trim() : "",
      linkedIn: i === 0 ? String(data.linkedIn || "").trim() : "",
    })).filter(
      (c) => c.name || c.phone || c.email || c.designation || c.linkedIn
    );
  }

  const contactPersons = contacts.map((c) => c.name).filter(Boolean);
  const emails = contacts.map((c) => c.email).filter(Boolean);
  const contactPerson = contactPersons[0] || "";

  data.contacts = contacts;
  data.contactPersons = contactPersons;
  data.emails = emails;
  data.contactPerson = contactPerson;
  data.email = emails[0] || "";
  data.phone = contacts[0]?.phone || "";
  data.designation = contacts[0]?.designation || "";
  data.linkedIn = contacts[0]?.linkedIn || "";

  if (!data.name?.trim()) {
    data.name = company || contactPerson || "—";
  }

  if (data.leadType === "export") {
    data.industry = "export";
  } else if (data.leadType === "domestic") {
    data.industry = data.industry || "domestic";
  } else if (!data.industry) {
    data.industry = "domestic";
  }

  if (Array.isArray(data.products) && data.products.length) {
    const names = data.products.map((p) => p.name).filter(Boolean);
    data.product = {
      name: names.join(", "),
      quantity: data.products[0]?.quantity ?? data.product?.quantity ?? 0,
      price: data.products[0]?.price ?? data.product?.price ?? 0,
    };
  } else if (data.product?.name) {
    const names = String(data.product.name)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    data.products = names.map((name) => ({
      name,
      quantity: data.product.quantity ?? 0,
      price: data.product.price ?? 0,
    }));
  }

  if (
    data.leadType !== "supplier" &&
    data.exportDetails &&
    (data.exportDetails.maxPrice == null ||
      data.exportDetails.maxPrice === "" ||
      Number(data.exportDetails.maxPrice) <= 0)
  ) {
    const productPrice = Number(
      data.product?.price ?? data.products?.[0]?.price
    );
    if (Number.isFinite(productPrice) && productPrice > 0) {
      data.exportDetails.maxPrice = productPrice;
    }
  }

  return data;
}

router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const extra =
      status && STATUSES.includes(status) ? { status } : {};
    const leads = await Lead.find(leadFilter(req, extra)).sort({
      updatedAt: -1,
    });
    res.json(leads.map(leadWithDocumentUrls));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/check-duplicate", async (req, res) => {
  try {
    const company = String(req.query.company || "").trim();
    if (company.length < 2) {
      return res.json([]);
    }

    const allLeads = await Lead.find(leadFilter(req))
      .select("company name responsiblePerson createdBy createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const leads = allLeads
      .filter((l) => {
        const title = l.company?.trim() || l.name?.trim() || "";
        return companyNamesMatch(company, title);
      })
      .slice(0, 10);

    const creatorIds = [
      ...new Set(leads.map((l) => String(l.createdBy)).filter(Boolean)),
    ];
    const users = creatorIds.length
      ? await User.find({ _id: { $in: creatorIds } }).select("name").lean()
      : [];
    const nameById = Object.fromEntries(
      users.map((u) => [String(u._id), u.name?.trim() || ""])
    );

    res.json(
      leads.map((l) => ({
        _id: String(l._id),
        company: l.company?.trim() || "",
        name: l.name?.trim() || "",
        responsiblePerson: l.responsiblePerson?.trim() || "",
        createdBy: l.createdBy ? String(l.createdBy) : undefined,
        createdByName:
          (l.createdBy && nameById[String(l.createdBy)]) ||
          l.responsiblePerson?.trim() ||
          "",
        createdAt: l.createdAt,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const lead = await findAccessibleLead(req.params.id, req);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const creator = await User.findById(req.userId).select("name role");
    let data = normalizeLeadBody(req.body);
    data = enforceExportLeadBody(req, data);

    if (creator?.name) {
      const creatorName = creator.name.trim();
      if (!req.isAdmin) {
        data.responsiblePerson = creatorName;
      } else if (!String(data.responsiblePerson || "").trim()) {
        data.responsiblePerson = creatorName;
      }
    }

    let createdBy = req.userId;
    if (req.isAdmin && data.responsiblePerson) {
      const assignee = await findSalesUserByName(data.responsiblePerson);
      if (!assignee) {
        return res.status(400).json({
          message: "Select a valid team member to assign this lead",
        });
      }
      data.responsiblePerson = assignee.name.trim();
      if (
        assignee.name.trim().toLowerCase() !==
        String(creator?.name || "")
          .trim()
          .toLowerCase()
      ) {
        createdBy = assignee._id;
      }
    }

    const lead = await Lead.create({
      ...data,
      createdBy,
    });
    await logActivity({
      type: "lead_created",
      userId: req.userId,
      userName: req.userName || creator?.name,
      lead,
      toStatus: lead.status,
    });
    await autoSaveToday(req);
    res.status(201).json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await Lead.findOne(
      leadFilter(req, { _id: req.params.id })
    );
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    let data = normalizeLeadBody(req.body);
    data = enforceExportLeadBody(req, data);

    if (Array.isArray(data.contacts) && data.contacts.length) {
      const legacyLinkedIn = String(existing.linkedIn || "").trim();
      if (legacyLinkedIn && !data.contacts[0].linkedIn) {
        data.contacts[0].linkedIn = legacyLinkedIn;
        data.linkedIn = legacyLinkedIn;
      }
    }

    const today = todayBusinessDate();
    const prevDaily = String(existing.dailyActivity || "").trim();
    const nextDaily = String(data.dailyActivity || "").trim();
    const prevNote = String(existing.dailyActivityNote || "").trim();
    const nextNote = String(data.dailyActivityNote || "").trim();

    if (
      existing.dailyActivitySetOn === today &&
      prevDaily &&
      (nextDaily !== prevDaily || nextNote !== prevNote)
    ) {
      return res.status(400).json({
        message:
          "Daily activity was already saved today. You can change it tomorrow.",
      });
    }

    if (nextDaily && nextDaily !== prevDaily) {
      data.dailyActivitySetOn = today;
    } else if (!nextDaily) {
      data.dailyActivitySetOn = "";
      data.dailyActivityNote = "";
    }

    let reassigned = null;
    try {
      reassigned = await applyResponsiblePersonPatch(req, data, existing);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ message: err.message });
    }

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      data,
      {
        new: true,
        runValidators: true,
      }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    if (nextDaily && nextDaily !== prevDaily) {
      await logActivity({
        type: "daily_activity",
        userId: req.userId,
        userName: req.userName,
        lead,
        dailyActivityType: nextDaily,
        remarkText: nextNote || undefined,
      });
    }

    if (reassigned) {
      await logActivity({
        type: "lead_reassigned",
        userId: req.userId,
        userName: req.userName,
        lead,
        fromResponsible: reassigned.from,
        toResponsible: reassigned.to,
      });
    }

    await autoSaveToday(req);
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id/assign", async (req, res) => {
  try {
    if (!req.isAdmin) {
      return res.status(403).json({ message: "Only admin can reassign leads" });
    }

    const existing = await Lead.findOne(
      leadFilter(req, { _id: req.params.id })
    );
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    const patch = { responsiblePerson: req.body.responsiblePerson };
    const reassigned = await applyResponsiblePersonPatch(req, patch, existing);

    if (!reassigned) {
      return res.json(leadWithDocumentUrls(existing));
    }

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      {
        responsiblePerson: patch.responsiblePerson,
      },
      { new: true, runValidators: true }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    await logActivity({
      type: "lead_reassigned",
      userId: req.userId,
      userName: req.userName,
      lead,
      fromResponsible: reassigned.from,
      toResponsible: reassigned.to,
    });

    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const existing = await Lead.findOne(
      leadFilter(req, { _id: req.params.id })
    );
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      { status },
      { new: true, runValidators: true }
    );
    if (existing.status !== status) {
      await logActivity({
        type: "status_changed",
        userId: req.userId,
        userName: req.userName,
        lead,
        fromStatus: existing.status,
        toStatus: status,
      });
    }
    await autoSaveToday(req);
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/:id/documents/:docId/file", async (req, res) => {
  try {
    if (!isCloudinaryReady() && !configureCloudinary()) {
      return res.status(500).json({ message: "Cloudinary is not configured" });
    }

    const lead = await findAccessibleLead(req.params.id, req);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const doc = lead.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ message: "Document not found" });

    const response = await fetchDocumentResponse(doc);

    if (!response) {
      return res.status(502).json({
        message:
          "Could not load this file. Delete it and upload again, or check Cloudinary settings in backend/.env.",
      });
    }

    const contentType = guessDocumentContentType(doc, response);
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(doc.name).replace(/"/g, "")}"`
    );
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    res.status(500).json({ message: err.message || "Could not load document" });
  }
});

router.post("/:id/documents", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!isCloudinaryReady() && !configureCloudinary()) {
      return res.status(500).json({
        message:
          "Cloudinary is not configured. Add CLOUD_NAME, CLOUD_API_KEY, CLOUD_API_SECRET to backend/.env and restart the server.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message:
          "No file uploaded. Use images, PDF, Office docs, text, or ZIP.",
      });
    }

    const uploadOptions = getUploadOptions(req.file, req.params.id);
    const result = await uploadBuffer(req.file.buffer, uploadOptions);

    const doc = {
      name: req.file.originalname,
      publicId: result.public_id,
      resourceType: result.resource_type || "image",
      format: result.format,
      bytes: result.bytes,
      version: result.version,
      url: result.secure_url,
    };

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      { $push: { documents: doc } },
      { new: true, runValidators: true }
    );

    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

router.delete("/:id/documents/:docId", async (req, res) => {
  try {
    const lead = await findAccessibleLead(req.params.id, req);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const doc = lead.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ message: "Document not found" });

    if (isCloudinaryReady() && doc.publicId) {
      try {
        await cloudinary.uploader.destroy(doc.publicId, {
          resource_type: doc.resourceType || "image",
        });
      } catch {
        /* keep DB in sync even if Cloudinary delete fails */
      }
    }

    doc.deleteOne();
    await lead.save();
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/:id/remarks", async (req, res) => {
  try {
    const { text, author } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ message: "Remark text is required" });
    }
    const remarkAuthor = String(author || req.userName || "").trim();
    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      {
        $push: {
          remarks: { text: text.trim(), author: remarkAuthor },
        },
      },
      { new: true, runValidators: true }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    await autoSaveToday(req);
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const lead = await Lead.findOneAndDelete(
      leadFilter(req, { _id: req.params.id })
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ message: "Lead deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
