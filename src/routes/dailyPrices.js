const express = require("express");
const DailyPrice = require("../models/DailyPrice");
const User = require("../models/User");
const {
  METHOD_IDS,
  normalizePricesBody,
  mergePricesBody,
  hasAnyPrice,
  hasAnyPriceInMethod,
} = require("../lib/dailyPriceConfig");
const {
  toClientPriceMeta,
  buildMetaForAllPrices,
  mergePriceMetaOnUpdate,
  isValidMethodId,
  isValidLocationId,
  locationHasAnyPrice,
} = require("../lib/dailyPriceMeta");

function normalizePricesForClient(raw) {
  return normalizePricesBody(raw);
}

const router = express.Router();

const DAILY_PRICE_APPROVER_NAME = "Deelep sir";

async function resolveApproverUserId() {
  const deelep = await User.findOne({
    name: { $regex: /deelep/i },
    role: "admin",
  })
    .select("_id")
    .lean();
  if (deelep?._id) return deelep._id;

  const admin = await User.findOne({ role: "admin" }).select("_id").lean();
  return admin?._id || null;
}

function toClient(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    _id: String(o._id),
    date: o.date,
    createdBy: String(o.createdBy),
    addedByName: o.addedByName,
    updatedBy: o.updatedBy ? String(o.updatedBy) : undefined,
    updatedByName: o.updatedByName || o.addedByName,
    prices: normalizePricesForClient(o.prices),
    priceMeta: toClientPriceMeta(o.priceMeta),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return todayDateString();
  return date;
}

router.get("/", async (_req, res) => {
  try {
    const entries = await DailyPrice.find().sort({ date: -1, updatedAt: -1 });
    res.json(entries.map(toClient));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const entry = await DailyPrice.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: "Daily price entry not found" });
    }
    res.json(toClient(entry));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const creator = await User.findById(req.userId).select("name");
    const prices = normalizePricesBody(req.body.prices);

    if (!hasAnyPrice(prices)) {
      return res.status(400).json({
        message: "Enter at least one price",
      });
    }

    const userName = creator?.name?.trim() || req.userName || "User";
    const entry = await DailyPrice.create({
      date: normalizeDate(req.body.date),
      createdBy: req.userId,
      addedByName: userName,
      updatedBy: req.userId,
      updatedByName: userName,
      prices,
      priceMeta: buildMetaForAllPrices(prices, req.userId, userName),
    });

    res.status(201).json(toClient(entry));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await DailyPrice.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Daily price entry not found" });
    }

    const editor = await User.findById(req.userId).select("name");
    const editorName = editor?.name?.trim() || req.userName || "User";

    const updates = {
      updatedBy: req.userId,
      updatedByName: editorName,
    };
    if (req.body.date) updates.date = normalizeDate(req.body.date);
    if (req.body.prices) {
      const merged = mergePricesBody(existing.prices, req.body.prices);
      const incoming = normalizePricesBody(req.body.prices);
      const methodsWithPrices = METHOD_IDS.filter((id) =>
        hasAnyPriceInMethod(incoming[id])
      );
      const editingOneMethod = methodsWithPrices.length === 1;

      if (editingOneMethod) {
        const methodId = methodsWithPrices[0];
        if (!hasAnyPriceInMethod(incoming[methodId])) {
          return res.status(400).json({
            message: "Enter at least one price for this farming method",
          });
        }
      } else if (!hasAnyPrice(merged)) {
        return res.status(400).json({
          message: "Enter at least one price",
        });
      }

      updates.prices = merged;
      updates.priceMeta = mergePriceMetaOnUpdate(
        existing.priceMeta,
        existing.prices,
        merged,
        req.body.prices,
        req.userId,
        editorName
      );
    }

    const entry = await DailyPrice.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    res.json(toClient(entry));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/:id/approve", async (req, res) => {
  try {
    const method = String(req.body.method || "").trim();
    const location = String(req.body.location || "").trim();

    if (!isValidMethodId(method) || !isValidLocationId(location)) {
      return res.status(400).json({
        message: "Invalid farming method or location",
      });
    }

    const existing = await DailyPrice.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Daily price entry not found" });
    }

    const prices = normalizePricesBody(existing.prices);
    if (!locationHasAnyPrice(prices[method], location)) {
      return res.status(400).json({
        message: "No prices to approve for this location",
      });
    }

    const approverId = (await resolveApproverUserId()) || req.userId;

    const entry = await DailyPrice.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          [`priceMeta.${method}.${location}.approved`]: true,
          [`priceMeta.${method}.${location}.approvedBy`]: approverId,
          [`priceMeta.${method}.${location}.approvedByName`]: DAILY_PRICE_APPROVER_NAME,
          [`priceMeta.${method}.${location}.approvedAt`]: new Date(),
          [`priceMeta.${method}.${location}.rejected`]: false,
          [`priceMeta.${method}.${location}.rejectedBy`]: null,
          [`priceMeta.${method}.${location}.rejectedByName`]: "",
          [`priceMeta.${method}.${location}.rejectedAt`]: null,
        },
      },
      { new: true, runValidators: true }
    );

    res.json(toClient(entry));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/:id/reject", async (req, res) => {
  try {
    const method = String(req.body.method || "").trim();
    const location = String(req.body.location || "").trim();

    if (!isValidMethodId(method) || !isValidLocationId(location)) {
      return res.status(400).json({
        message: "Invalid farming method or location",
      });
    }

    const existing = await DailyPrice.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Daily price entry not found" });
    }

    const prices = normalizePricesBody(existing.prices);
    if (!locationHasAnyPrice(prices[method], location)) {
      return res.status(400).json({
        message: "No prices to reject for this location",
      });
    }

    const editor = await User.findById(req.userId).select("name");
    const editorName = editor?.name?.trim() || req.userName || "Admin";

    const entry = await DailyPrice.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          [`priceMeta.${method}.${location}.rejected`]: true,
          [`priceMeta.${method}.${location}.rejectedBy`]: req.userId,
          [`priceMeta.${method}.${location}.rejectedByName`]: editorName,
          [`priceMeta.${method}.${location}.rejectedAt`]: new Date(),
          [`priceMeta.${method}.${location}.approved`]: false,
          [`priceMeta.${method}.${location}.approvedBy`]: null,
          [`priceMeta.${method}.${location}.approvedByName`]: "",
          [`priceMeta.${method}.${location}.approvedAt`]: null,
        },
      },
      { new: true, runValidators: true }
    );

    res.json(toClient(entry));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
