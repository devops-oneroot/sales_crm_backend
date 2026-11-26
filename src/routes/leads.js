const express = require("express");
const { normalizeTags } = require("../lib/tags");
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
const { applyResponsiblePersonPatch, findAssignableUser } = require("../lib/leadAssign");
const { todayBusinessDate, BUSINESS_TZ } = require("../lib/businessDate");
const { applyFollowUpLog } = require("../lib/outreachTouch");
const { companyNamesMatch } = require("../lib/companyNameNormalize");
const { leadFilterForRequest, buyerLeadClause } = require("../lib/leadQuery");
const { logActivity } = require("../lib/logActivity");
const Activity = require("../models/Activity");
const autoSaveToday = require("../lib/autoSaveToday");
const { attachIdleInfo } = require("../lib/leadIdle");
const {
  normalizeContactPhones,
  contactDetailsLockedError,
  mentionsContactFields,
  dropUnmentionedFields,
  normalizeWhatsappNumbers,
  whatsappNumbersLockedError,
  mentionsWhatsappFields,
  dropUnmentionedWhatsappFields,
} = require("../lib/leadContactRules");
const {
  normalizeDailyActivitiesList,
  leadDailyActivities,
} = require("../lib/dailyActivityTypes");
const {
  LEAD_STATUSES,
  toCurrentStatus,
  isCurrentStatus,
  storedValuesForStatus,
} = require("../lib/leadStatuses");

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

const STATUSES = LEAD_STATUSES;

function leadWithDocumentUrls(lead) {
  const obj = lead.toObject ? lead.toObject() : { ...lead };
  if (obj.documents?.length) {
    obj.documents = obj.documents.map((doc) => mapDocumentForClient(doc));
  }
  // A row the startup migration has not reached still shows a current status.
  obj.status = toCurrentStatus(obj.status, obj.pipelineStatus);
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

function normalizeOtherDetails(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((d) => String(d || "").trim()).filter(Boolean);
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
        otherDetails: normalizeOtherDetails(c?.otherDetails),
      };
    })
    .filter(
      (c) =>
        c.name ||
        c.phone ||
        c.email ||
        c.designation ||
        c.linkedIn ||
        c.otherDetails.length > 0
    );
}

function normalizeLeadBody(body) {
  const data = { ...body };
  delete data.createdBy;
  if (data.status !== undefined) {
    data.status = toCurrentStatus(data.status, data.pipelineStatus);
  }
  delete data.pipelineStatus;
  delete data.legacyStatus;
  if (data.tags !== undefined) data.tags = normalizeTags(data.tags);
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

  const whatsappNumbers = normalizeWhatsappNumbers(
    data.whatsappNumbers,
    data.whatsappNumber
  );
  data.whatsappNumbers = whatsappNumbers;
  data.whatsappNumber = whatsappNumbers[0] || "";

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
      { stateProvince: rx },
      { city: rx },
      { postalCode: rx },
      { "exportDetails.deliveryState": rx },
      { "exportDetails.deliveryDistrict": rx },
      { "exportDetails.deliveryPincode": rx },
      { "contacts.name": rx },
      { "contacts.email": rx },
    ],
  };
}

const LOCATION_FIELDS = {
  state: ["stateProvince", "exportDetails.deliveryState"],
  city: ["city", "exportDetails.deliveryDistrict"],
  pincode: ["postalCode", "exportDetails.deliveryPincode"],
};

/** Builds the list query from the table's filters. Absent filters are ignored. */
function buildListQuery(req) {
  const extra = {};
  const and = [];

  const status = String(req.query.status || "").trim();
  if (status && STATUSES.includes(status)) {
    extra.status = { $in: storedValuesForStatus(status) };
  }

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

  // Location filters. Export leads keep location in stateProvince / city /
  // postalCode, domestic leads in exportDetails.delivery*; match either.
  for (const [param, fields] of Object.entries(LOCATION_FIELDS)) {
    const value = String(req.query[param] || "").trim();
    if (!value || value === "all") continue;
    const rx = new RegExp(`^${escapeForRegex(value)}$`, "i");
    and.push({ $or: fields.map((f) => ({ [f]: rx })) });
  }

  // Tag filter: "__none__" = leads without tags; otherwise exact tag, any case.
  const tag = String(req.query.tag || "").trim();
  if (tag === "__none__") {
    and.push({ $or: [{ tags: { $exists: false } }, { tags: { $size: 0 } }] });
  } else if (tag && tag !== "all") {
    extra.tags = new RegExp(`^${escapeForRegex(tag)}$`, "i");
  }

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

const MAX_PAGE_SIZE = 100;

/**
 * GET /api/leads
 * - Without `page`: the full filtered list as an array (Activity board,
 *   Importers pipeline, analytics, forms — unchanged).
 * - With `page` (and optional `pageSize`, 1-100, default 10): one page,
 *   as { items, total, page, pageSize, totalPages } — used by the Leads table.
 * - `duplicates=1` limits to leads with an open possible-duplicate flag.
 */
router.get("/", async (req, res) => {
  try {
    const { filter, sortBy } = buildListQuery(req);

    if (req.query.duplicates === "1") {
      const { ids } = await require("../services/duplicateService").flaggedLeadIds();
      filter.$and = [...(filter.$and || []), { _id: { $in: ids } }];
    }

    if (req.query.page === undefined) {
      const leads = await Lead.find(filter).sort(sortBy);
      return res.json(await attachIdleInfo(leads.map(leadWithDocumentUrls)));
    }

    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(req.query.pageSize, 10) || 10)
    );
    const total = await Lead.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    // Asking past the end (e.g. after a filter shrank the list) returns the last page.
    const page = Math.min(totalPages, Math.max(1, parseInt(req.query.page, 10) || 1));

    const leads = await Lead.find(filter)
      // _id tiebreak keeps the order stable, so no lead repeats or vanishes between pages
      .sort({ ...sortBy, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    res.json({
      items: await attachIdleInfo(leads.map(leadWithDocumentUrls)),
      total,
      page,
      pageSize,
      totalPages,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * Lead type (export / domestic). Company names are unique across both types;
 * phone numbers are only compared within the same type.
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
    ...(lead.whatsappNumbers || []),
    lead.whatsappNumber,
  ];
  return new Set(raw.map(phoneKey).filter(Boolean));
}

/**
 * Leads that already use this company name or phone number, across the whole
 * team — a duplicate belongs to nobody in particular, so this is not scoped to
 * the caller the way the lead lists are.
 */
function leadEmailKeys(lead) {
  const raw = [lead.email, ...(lead.emails || []), ...(lead.contacts || []).map((c) => c?.email)];
  return new Set(raw.map((e) => String(e || "").trim().toLowerCase()).filter((e) => e.includes("@")));
}

/**
 * Other leads already using this company name, any of these phone numbers,
 * or any of these emails. Company, phone and email are each unique across
 * ALL leads (export and domestic).
 */
async function findLeadDuplicates({
  company,
  phones = [],
  emails = [],
  excludeId,
}) {
  const name = String(company || "").trim();
  const wantedPhones = new Set(phones.map(phoneKey).filter(Boolean));
  const wantedEmails = new Set(
    emails.map((e) => String(e || "").trim().toLowerCase()).filter((e) => e.includes("@"))
  );

  if (name.length < 2 && wantedPhones.size === 0 && wantedEmails.size === 0) return [];

  const candidates = await Lead.find(buyerLeadClause())
    .select(
      "company name responsiblePerson createdBy createdAt contacts phone email emails whatsappNumbers whatsappNumber leadType industry exportDetails"
    )
    .sort({ createdAt: -1 })
    .lean();

  const matches = [];
  for (const lead of candidates) {
    if (excludeId && String(lead._id) === String(excludeId)) continue;

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

    let emailHit = "";
    if (wantedEmails.size) {
      for (const key of leadEmailKeys(lead)) {
        if (wantedEmails.has(key)) {
          emailHit = key;
          break;
        }
      }
    }

    const fields = [companyHit && "company", phoneHit && "phone", emailHit && "email"].filter(Boolean);
    if (!fields.length) continue;

    matches.push({
      lead,
      // Kept for older clients: "company" | "phone" | "email" | "both" (several)
      matchedOn: fields.length > 1 ? "both" : fields[0],
      matchedFields: fields,
      matchedPhone: phoneHit || "",
      matchedEmail: emailHit || "",
    });
    if (matches.length >= 10) break;
  }

  return matches;
}

/** "company name and phone number are" — for duplicate error messages. */
function describeClash(matches) {
  const fields = new Set(matches.flatMap((m) => m.matchedFields || [m.matchedOn]));
  const parts = [
    fields.has("company") && "company name",
    fields.has("phone") && "phone number",
    fields.has("email") && "email",
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `${list} ${parts.length > 1 ? "are" : "is"}`;
}

/** Phones and emails a lead body carries (for the duplicate check). */
function contactKeysOf(data) {
  return {
    phones: [
      ...(data.contacts || []).flatMap((c) => [...(c.phones || []), c.phone]),
      data.phone,
      ...(data.whatsappNumbers || []),
      data.whatsappNumber,
    ].filter(Boolean),
    emails: [
      ...(data.contacts || []).map((c) => c.email),
      data.email,
      ...(data.emails || []),
    ].filter(Boolean),
  };
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

  return matches.map(({ lead, matchedOn, matchedFields, matchedPhone, matchedEmail }) => ({
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
    matchedFields,
    matchedPhone,
    matchedEmail,
  }));
}

/**
 * GET /api/leads/tags — tags on the leads this user can see, with counts
 * (most used first). Feeds the Leads tag filter.
 */
router.get("/tags", async (req, res) => {
  try {
    const rows = await Lead.aggregate([
      { $match: leadFilter(req) },
      { $unwind: "$tags" },
      { $group: { _id: { $toLower: "$tags" }, tag: { $first: "$tags" }, count: { $sum: 1 } } },
      { $sort: { count: -1, tag: 1 } },
    ]);
    res.json(rows.map((r) => ({ tag: r.tag, count: r.count })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/leads/locations?country=&state=&city= — the states, cities and
 * pincodes actually used on leads the user can see, narrowed by the parent
 * choice (country -> states, state -> cities, city -> pincodes).
 */
router.get("/locations", async (req, res) => {
  try {
    const extra = {};
    const and = [];
    const country = String(req.query.country || "").trim();
    if (country && country !== "all" && country !== "__unset__") {
      extra.country = new RegExp(`^${escapeForRegex(country)}$`, "i");
    }
    for (const param of ["state", "city"]) {
      const value = String(req.query[param] || "").trim();
      if (!value || value === "all") continue;
      const rx = new RegExp(`^${escapeForRegex(value)}$`, "i");
      and.push({ $or: LOCATION_FIELDS[param].map((f) => ({ [f]: rx })) });
    }
    if (and.length) extra.$and = and;

    const leads = await Lead.find(leadFilter(req, extra))
      .select("stateProvince city postalCode exportDetails.deliveryState exportDetails.deliveryDistrict exportDetails.deliveryPincode")
      .lean();
    const collect = (pick) => {
      const byKey = new Map();
      for (const l of leads) {
        const v = String(pick(l) || "").trim();
        if (v && !byKey.has(v.toLowerCase())) byKey.set(v.toLowerCase(), v);
      }
      return [...byKey.values()].sort((a, b) => a.localeCompare(b));
    };
    res.json({
      states: collect((l) => l.stateProvince || l.exportDetails?.deliveryState),
      cities: collect((l) => l.city || l.exportDetails?.deliveryDistrict),
      pincodes: collect((l) => l.postalCode || l.exportDetails?.deliveryPincode),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/check-duplicate", async (req, res) => {
  try {
    const company = String(req.query.company || "").trim();
    const list = (v) =>
      String(v || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const phones = list(req.query.phones || req.query.phone);
    const emails = list(req.query.emails || req.query.email);

    const matches = await findLeadDuplicates({ company, phones, emails });
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

async function createLeadHandler(req, res) {
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
      const assignee = await findAssignableUser(data.responsiblePerson, req);
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

    // A company name, phone number or email already on another lead blocks the create.
    const duplicates = await findLeadDuplicates({
      company: data.company || data.name,
      ...contactKeysOf(data),
    });

    if (duplicates.length) {
      const described = await describeDuplicates(duplicates);
      const what = describeClash(duplicates);
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
}

/**
 * Creates are serialised: two identical requests arriving together (a
 * double-click on Create Lead) would otherwise both pass the duplicate
 * check before either row exists, and both be saved. Creates are rare, so
 * queueing them costs nothing; the second one now sees the first and is
 * refused with 409.
 */
let createQueue = Promise.resolve();
function serializedCreate(work) {
  const run = createQueue.then(work, work);
  createQueue = run.catch(() => {});
  return run;
}

router.post("/", (req, res) => serializedCreate(() => createLeadHandler(req, res)));

router.patch("/:id", async (req, res) => {
  try {
    const existing = await Lead.findOne(
      leadFilter(req, { _id: req.params.id })
    );
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    let data = normalizeLeadBody(req.body);
    data = enforceExportLeadBody(req, data);

    // Company name, phone numbers and emails are unique across all leads:
    // an edit may not take one another lead already uses (same as create).
    const newCompany = String(req.body.company ?? req.body.name ?? "").trim();
    const oldCompany = String(existing.company || existing.name || "").trim();
    const nameChanged = newCompany && !companyNamesMatch(newCompany, oldCompany);
    // Only values NEW in this edit are checked, so a lead that already shares
    // a number (an older duplicate) can still be saved without changes to it.
    const keys = contactKeysOf(data);
    const oldPhones = leadPhoneKeys(existing);
    const oldEmails = leadEmailKeys(existing);
    const newPhones = keys.phones.filter((p) => phoneKey(p) && !oldPhones.has(phoneKey(p)));
    const newEmails = keys.emails.filter(
      (e) => !oldEmails.has(String(e).trim().toLowerCase())
    );
    if (nameChanged || newPhones.length || newEmails.length) {
      const clashes = await findLeadDuplicates({
        company: nameChanged ? newCompany : "",
        phones: newPhones,
        emails: newEmails,
        excludeId: existing._id,
      });
      if (clashes.length) {
        const described = await describeDuplicates(clashes);
        return res.status(409).json({
          message: `This ${describeClash(clashes)} already used by another lead (${
            described[0].company || described[0].name || "another lead"
          }, added by ${described[0].createdByName || "another user"}). Use a different one.`,
          duplicates: described,
        });
      }
    }

    // A request that says nothing about contacts must not blank them.
    data = dropUnmentionedFields(req.body, data);
    if (mentionsContactFields(req.body) && !req.isAdmin) {
      const locked = contactDetailsLockedError(existing.contacts, data.contacts);
      if (locked) return res.status(403).json({ message: locked });
    }

    // WhatsApp numbers follow the same rule as a saved phone: once stored,
    // only an admin may change or remove one — everyone else may only add.
    data = dropUnmentionedWhatsappFields(req.body, data);
    if (mentionsWhatsappFields(req.body) && !req.isAdmin) {
      const existingWhatsapp = normalizeWhatsappNumbers(
        existing.whatsappNumbers,
        existing.whatsappNumber
      );
      const lockedWhatsapp = whatsappNumbersLockedError(
        existingWhatsapp,
        data.whatsappNumbers
      );
      if (lockedWhatsapp) return res.status(403).json({ message: lockedWhatsapp });
    }

    if (Array.isArray(data.contacts) && data.contacts.length) {
      const legacyLinkedIn = String(existing.linkedIn || "").trim();
      if (legacyLinkedIn && !data.contacts[0].linkedIn) {
        data.contacts[0].linkedIn = legacyLinkedIn;
        data.linkedIn = legacyLinkedIn;
      }
    }

    const today = todayBusinessDate();

    // Only touch the daily-activity snapshot when the request actually says
    // something about it — an unrelated edit (company name, status, a
    // reassignment) must not wipe or re-log it.
    const mentionsActivity =
      req.body.dailyActivities !== undefined ||
      req.body.dailyActivity !== undefined ||
      req.body.dailyActivityNote !== undefined;

    let nextActivities = [];
    let nextNote = "";

    if (mentionsActivity) {
      nextActivities = leadDailyActivities(data);
      nextNote = String(data.dailyActivityNote || "").trim();

      if (nextActivities.length && !nextNote) {
        return res.status(400).json({ message: "Activity note is required" });
      }
      if (nextNote && !nextActivities.length) {
        return res
          .status(400)
          .json({ message: "Tick the activity this note is about" });
      }

      data.dailyActivities = nextActivities;
      data.dailyActivity = nextActivities[0] || "";
      data.dailyActivityNote = nextNote;
      data.dailyActivitySetOn = nextActivities.length
        ? today
        : existing.dailyActivitySetOn;
    } else {
      // Nothing about activity was sent — leave the lead's stored snapshot
      // exactly as it is.
      delete data.dailyActivities;
      delete data.dailyActivity;
      delete data.dailyActivityNote;
      delete data.dailyActivitySetOn;
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

    // Every submission that ticks at least one activity becomes one new,
    // permanent row in this lead's activity history — there is no "already
    // saved today" limit, and no way to edit a past entry; the next save
    // always creates another one alongside it.
    if (mentionsActivity && nextActivities.length) {
      for (const activityType of nextActivities) {
        await logActivity({
          type: "daily_activity",
          userId: req.userId,
          userName: req.userName,
          lead,
          dailyActivityType: activityType,
          remarkText: nextNote || undefined,
        });
      }
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
    const status = String(req.body.status || "").trim();
    if (!isCurrentStatus(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const existing = await Lead.findOne(
      leadFilter(req, { _id: req.params.id })
    );
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    const update = { status, pipelineStatus: null };

    const lead = await Lead.findOneAndUpdate(
      leadFilter(req, { _id: req.params.id }),
      update,
      { new: true, runValidators: true }
    );
    if (toCurrentStatus(existing.status, existing.pipelineStatus) !== status) {
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
