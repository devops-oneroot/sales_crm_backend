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

function normalizePricesForClient(raw) {
  return normalizePricesBody(raw);
}

const router = express.Router();

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

module.exports = router;
