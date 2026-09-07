const express = require("express");
const mongoose = require("mongoose");
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
const { todayBusinessDate, BUSINESS_TZ } = require("../lib/businessDate");
const { applyFollowUpLog } = require("../lib/outreachTouch");
const { companyNamesMatch } = require("../lib/companyNameNormalize");
const { leadFilterForRequest, buyerLeadClause } = require("../lib/leadQuery");
const { logActivity } = require("../lib/logActivity");
const Activity = require("../models/Activity");
const autoSaveToday = require("../lib/autoSaveToday");
const {
  normalizeDailyActivitiesList,
  leadDailyActivities,
  dailyActivitiesEqual,
} = require("../lib/dailyActivityTypes");
const {
  INACTIVITY_STATUSES,
  restorePipelineOnActivity,
  syncInactivityStatusesForRequest,
} = require("../lib/leadInactivity");

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
  "idle_critical",
  "missed_follow",
  "no_activity",
];

function leadWithDocumentUrls(lead) {
  const obj = lead.toObject ? lead.toObject() : { ...lead };
  if (obj.documents?.length) {
    obj.documents = obj.documents.map((doc) => mapDocumentForClient(doc));
  }
  return obj;
}

/** The business day (YYYY-MM-DD) a timestamp falls on. */
function businessDateOf(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(date);
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

/** One person can have several numbers — keep them all, de-duplicated. */
function normalizeContactPhones(contact) {
  const raw = Array.isArray(contact?.phones)
    ? contact.phones
    : [contact?.phones];
  const all = [...raw, contact?.phone].map((p) => String(p || "").trim());
  return [...new Set(all.filter(Boolean))];
}

function normalizeContactsList(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .map((c) => {
      const phones = normalizeContactPhones(c);
      return {
        name: String(c?.name || "").trim(),
        phones,
        // Kept in step with phones[0] so existing readers keep working.
        phone: phones[0] || "",
        email: String(c?.email || "").trim().toLowerCase(),
        designation: String(c?.designation || "").trim(),
        linkedIn: String(c?.linkedIn || "").trim(),
      };
    })
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
      phones:
        i === 0 && String(data.phone || "").trim()
          ? [String(data.phone).trim()]
          : [],
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

  if (
    data.dailyActivities !== undefined ||
    data.dailyActivity !== undefined
  ) {
    const nextActivities =
      data.dailyActivities !== undefined
        ? normalizeDailyActivitiesList(data.dailyActivities)
        : normalizeDailyActivitiesList(data.dailyActivity);
    data.dailyActivities = nextActivities;
    data.dailyActivity = nextActivities[0] || "";
  }

  return data;
}

const LIST_DATE_FIELDS = ["createdAt", "updatedAt"];

/**
 * A YYYY-MM-DD day boundary in business time. India has no DST, so the fixed
 * +05:30 offset is exact and avoids the server's own timezone leaking in.
 */
function businessDayBoundary(day, edge) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || "").trim())) return null;
  const suffix = edge === "end" ? "T23:59:59.999+05:30" : "T00:00:00.000+05:30";
  const date = new Date(`${day}${suffix}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Free-text search across the fields the leads table displays. */
function searchClause(term) {
  const q = String(term || "").trim();
  if (q.length < 1) return null;
  const rx = new RegExp(escapeForRegex(q), "i");
  return {
    $or: [
      { company: rx },
      { name: rx },
      { contactPerson: rx },
      { contactPersons: rx },
      { email: rx },
      { emails: rx },
      { responsiblePerson: rx },
      { country: rx },
      { "contacts.name": rx },
      { "contacts.email": rx },
    ],
  };
}

/** Builds the list query from the table's filters. Absent filters are ignored. */
function buildListQuery(req) {
  const extra = {};
  const and = [];

  const status = String(req.query.status || "").trim();
  if (status && STATUSES.includes(status)) extra.status = status;

  const responsible = String(req.query.responsible || "").trim();
  if (responsible && responsible !== "all") {
    extra.responsiblePerson = new RegExp(
      `^${escapeForRegex(responsible)}$`,
      "i"
    );
  }

  const country = String(req.query.country || "").trim();
  if (country === "__unset__") {
    and.push({ $or: [{ country: { $exists: false } }, { country: "" }] });
  } else if (country && country !== "all") {
    extra.country = new RegExp(`^${escapeForRegex(country)}$`, "i");
  }

  const search = searchClause(req.query.search);
  if (search) and.push(search);

  const dateField = LIST_DATE_FIELDS.includes(req.query.dateField)
    ? req.query.dateField
    : "createdAt";
  const from = businessDayBoundary(req.query.from, "start");
  const to = businessDayBoundary(req.query.to, "end");
  if (from || to) {
    extra[dateField] = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    };
  }

  if (and.length) extra.$and = and;

  const sortOrder = req.query.sort === "asc" ? 1 : -1;
  const sortBy = req.query.sort || req.query.from || req.query.to || req.query.dateField
    ? { [dateField]: sortOrder }
    : { updatedAt: -1 };

  return { filter: leadFilter(req, extra), sortBy };
}

router.get("/", async (req, res) => {
  try {
    await syncInactivityStatusesForRequest(req);

    const { filter, sortBy } = buildListQuery(req);
    const leads = await Lead.find(filter).sort(sortBy);
    res.json(leads.map(leadWithDocumentUrls));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Export and domestic are separate books: the same company may legitimately
 * exist once as each, so a duplicate only counts within one type.
 */
function normalizeLeadTypeForDuplicates(value) {
  return String(value || "").trim() === "export" ? "export" : "domestic";
}

function leadTypeOf(lead) {
  if (lead.leadType === "export" || lead.leadType === "domestic") {
    return lead.leadType;
  }
  return lead.industry === "export" || lead.exportDetails
    ? "export"
    : "domestic";
}

/** Digits only, compared on the last 10 so +91 / 0 prefixes still match. */
function phoneKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 6) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function leadPhoneKeys(lead) {
  const raw = [
    ...(lead.contacts || []).flatMap((c) => [...(c.phones || []), c.phone]),
    lead.phone,
    lead.whatsappNumber,
  ];
  return new Set(raw.map(phoneKey).filter(Boolean));
}

/**
 * Leads that already use this company name or phone number, across the whole
 * team — a duplicate belongs to nobody in particular, so this is not scoped to
 * the caller the way the lead lists are.
 */
async function findLeadDuplicates({
  company,
  phones = [],
  leadType,
  excludeId,
}) {
  const name = String(company || "").trim();
  const wantedPhones = new Set(phones.map(phoneKey).filter(Boolean));
  const wantedType = normalizeLeadTypeForDuplicates(leadType);

  if (name.length < 2 && wantedPhones.size === 0) return [];

  const query = buyerLeadClause();
  const candidates = await Lead.find(query)
    .select(
      "company name responsiblePerson createdBy createdAt contacts phone whatsappNumber leadType industry exportDetails"
    )
    .sort({ createdAt: -1 })
    .lean();

  const matches = [];
  for (const lead of candidates) {
    if (excludeId && String(lead._id) === String(excludeId)) continue;
    if (leadTypeOf(lead) !== wantedType) continue;

    const title = lead.company?.trim() || lead.name?.trim() || "";
    const companyHit = name.length >= 2 && companyNamesMatch(name, title);

    let phoneHit = "";
    if (wantedPhones.size) {
      for (const key of leadPhoneKeys(lead)) {
        if (wantedPhones.has(key)) {
          phoneHit = key;
          break;
        }
      }
    }

    if (!companyHit && !phoneHit) continue;

    matches.push({
      lead,
      matchedOn: companyHit && phoneHit ? "both" : companyHit ? "company" : "phone",
      matchedPhone: phoneHit || "",
    });
    if (matches.length >= 10) break;
  }

  return matches;
}

async function describeDuplicates(matches) {
  const creatorIds = [
    ...new Set(matches.map((m) => String(m.lead.createdBy)).filter(Boolean)),
  ];
  const users = creatorIds.length
    ? await User.find({ _id: { $in: creatorIds } }).select("name").lean()
    : [];
  const nameById = Object.fromEntries(
    users.map((u) => [String(u._id), u.name?.trim() || ""])
  );

  return matches.map(({ lead, matchedOn, matchedPhone }) => ({
    _id: String(lead._id),
    company: lead.company?.trim() || "",
    name: lead.name?.trim() || "",
    responsiblePerson: lead.responsiblePerson?.trim() || "",
    createdBy: lead.createdBy ? String(lead.createdBy) : undefined,
    createdByName:
      (lead.createdBy && nameById[String(lead.createdBy)]) ||
      lead.responsiblePerson?.trim() ||
      "",
    createdAt: lead.createdAt,
    matchedOn,
    matchedPhone,
  }));
}

router.get("/check-duplicate", async (req, res) => {
  try {
    const company = String(req.query.company || "").trim();
    const phones = String(req.query.phones || req.query.phone || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const matches = await findLeadDuplicates({
      company,
      phones,
      leadType: req.query.leadType,
    });
    res.json(await describeDuplicates(matches));
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

    // A company name or phone number already on another lead blocks the create.
    const duplicates = await findLeadDuplicates({
      leadType: data.leadType,
      company: data.company || data.name,
      phones: [
        ...(data.contacts || []).flatMap((c) => [...(c.phones || []), c.phone]),
        data.phone,
      ].filter(Boolean),
    });

    if (duplicates.length) {
      const described = await describeDuplicates(duplicates);
      const onPhone = described.some((d) => d.matchedOn !== "company");
      const onCompany = described.some((d) => d.matchedOn !== "phone");
      const what =
        onCompany && onPhone
          ? "company name and phone number are"
          : onPhone
            ? "phone number is"
            : "company name is";
      const owner = described[0].createdByName || "another user";
      return res.status(409).json({
        message: `This ${what} already in the database (added by ${owner}). This lead was not created.`,
        duplicates: described,
      });
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
    const prevActivities = leadDailyActivities(existing);
    const nextActivities = leadDailyActivities(data);
    const prevNote = String(existing.dailyActivityNote || "").trim();
    const nextNote = String(data.dailyActivityNote || "").trim();
    const activitiesChanged = !dailyActivitiesEqual(prevActivities, nextActivities);
    const noteChanged = nextNote !== prevNote;

    if (
      !req.isAdmin &&
      existing.dailyActivitySetOn === today &&
      prevActivities.length &&
      (activitiesChanged || noteChanged)
    ) {
      return res.status(400).json({
        message:
          "Today's activity is already saved and kept in this lead's activity history. You can add a new activity tomorrow.",
      });
    }

    data.dailyActivities = nextActivities;
    data.dailyActivity = nextActivities[0] || "";

    if (nextActivities.length) {
      data.dailyActivitySetOn = today;
    } else {
      data.dailyActivitySetOn = "";
      data.dailyActivityNote = "";
    }

    let reassigned = null;
    try {
      reassigned = await applyResponsiblePersonPatch(req, data, existing);
    } catch (err) {
      return res.status(err.statusCode || 400).json({ message: err.message });
    }

    delete data.followUpLog;

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      data,
      {
        new: true,
        runValidators: true,
      }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const followUpResult = await applyFollowUpLog(
      req,
      existing,
      req.body.followUpDate,
      lead
    );
    if (
      followUpResult.followUpLog.logged !== lead.followUpLog?.logged ||
      followUpResult.followUpLog.date !== lead.followUpLog?.date
    ) {
      lead.followUpLog = followUpResult.followUpLog;
      await lead.save();
    }

    // A fresh entry for the day logs everything picked, even a type already
    // used on an earlier day. Within the same day only newly ticked types are
    // logged, so re-saving today's entry does not duplicate history rows.
    const isNewDayEntry = existing.dailyActivitySetOn !== today;
    const newTypes = isNewDayEntry
      ? nextActivities
      : nextActivities.filter((type) => !prevActivities.includes(type));

    // If only the wording changed, still record it. The lead keeps just the
    // latest note and that field is cleared when a new day's entry replaces
    // it, so an unlogged correction would be lost for good.
    const addedActivities =
      newTypes.length || !noteChanged || !nextNote ? newTypes : nextActivities;

    for (const activityType of addedActivities) {
      await logActivity({
        type: "daily_activity",
        userId: req.userId,
        userName: req.userName,
        lead,
        dailyActivityType: activityType,
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

    await restorePipelineOnActivity(lead._id);
    const refreshed = await Lead.findById(lead._id);
    await autoSaveToday(req);
    res.json(leadWithDocumentUrls(refreshed || lead));
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

    const update = { status };
    if (!INACTIVITY_STATUSES.includes(status)) {
      update.pipelineStatus = null;
    }

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      update,
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

/**
 * Daily-activity history for one lead, newest first.
 * Selecting several activities in one save writes one Activity row each, so
 * rows saved together are regrouped back into a single entry.
 */
router.get("/:id/activity-log", async (req, res) => {
  try {
    const lead = await Lead.findOne(
      leadFilter(req, { _id: req.params.id })
    ).select("_id");
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const rows = await Activity.find({
      leadId: lead._id,
      type: "daily_activity",
    })
      .sort({ createdAt: -1 })
      .lean();

    // One save = one entry. Grouping on (business day, author, note) keeps that
    // stable no matter how far apart the individual rows were written, which a
    // time window could not.
    const entries = [];
    const byKey = new Map();

    for (const row of rows) {
      const activityType = String(row.dailyActivityType || "").trim();
      const note = String(row.remarkText || "").trim();
      const userName = String(row.userName || "").trim();
      const day = businessDateOf(row.createdAt);
      const key = `${day}|${userName}|${note}`;
      const existingEntry = byKey.get(key);

      if (existingEntry) {
        if (activityType && !existingEntry.activities.includes(activityType)) {
          existingEntry.activities.push(activityType);
        }
        continue;
      }

      const entry = {
        _id: String(row._id),
        activities: activityType ? [activityType] : [],
        note,
        userName,
        createdAt: row.createdAt,
      };
      byKey.set(key, entry);
      entries.push(entry);
    }

    res.json(entries);
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
    await restorePipelineOnActivity(lead._id);
    const refreshed = await Lead.findById(lead._id);
    await autoSaveToday(req);
    res.json(leadWithDocumentUrls(refreshed || lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/** Best effort — the lead is gone either way, this just avoids orphan files. */
async function removeLeadDocuments(lead) {
  const docs = (lead.documents || []).filter((doc) => doc.publicId);
  if (!docs.length || !isCloudinaryReady()) return 0;

  let removed = 0;
  for (const doc of docs) {
    try {
      await cloudinary.uploader.destroy(doc.publicId, {
        resource_type: resolveResourceType(doc),
        invalidate: true,
      });
      removed += 1;
    } catch (err) {
      console.warn(
        `Cloudinary cleanup failed for ${doc.publicId}: ${err.message}`
      );
    }
  }
  return removed;
}

/**
 * Permanently deletes a lead. Admins only, and the delete is irreversible, so
 * the caller must pass the lead's own name back as confirmation.
 *
 * The lead's rows in the activity log are deliberately kept: they are the
 * record of work people actually did, and removing them would silently rewrite
 * past Outreach and My Days reports.
 */
router.delete("/:id", async (req, res) => {
  try {
    if (!req.isAdmin) {
      return res.status(403).json({ message: "Only admins can delete leads" });
    }

    // A malformed id is a missing lead, not a server error.
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: "Lead not found" });
    }

    // leadFilter also stops an export-scoped admin deleting a domestic lead.
    const lead = await Lead.findOne(leadFilter(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const title = lead.company?.trim() || lead.name?.trim() || "";
    const confirm = String(req.body?.confirmName ?? req.query.confirmName ?? "").trim();
    if (!confirm || !companyNamesMatch(confirm, title)) {
      return res.status(400).json({
        message: `Type the lead name "${title}" to confirm deletion`,
      });
    }

    // Written while the lead still exists, so the audit row keeps its details.
    await logActivity({
      type: "lead_deleted",
      userId: req.userId,
      userName: req.userName,
      lead,
      fromStatus: lead.status,
    });

    const result = await Lead.deleteOne({ _id: lead._id });
    if (!result.deletedCount) {
      return res.status(404).json({ message: "Lead not found" });
    }

    const removedDocuments = await removeLeadDocuments(lead);

    res.json({
      message: "Lead deleted",
      deleted: { _id: String(lead._id), name: title },
      removedDocuments,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
