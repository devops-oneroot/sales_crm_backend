const express = require("express");
const Aggregator = require("../models/Aggregator");
const upload = require("../middleware/upload");
const {
  configureCloudinary,
  isCloudinaryReady,
  isCloudinaryUrl,
  uploadBuffer,
} = require("../config/cloudinary");
const {
  AGGREGATOR_TYPES,
  AGGREGATOR_UNITS,
  AGGREGATOR_PRODUCTS,
} = require("../models/Aggregator");
const {
  getProductOptions,
  isValidProduct,
} = require("../config/productRegions");
const {
  isValidStockType,
  isValidStockPolish,
} = require("../config/stockOptions");

const router = express.Router();

function ownedFilter(userId, extra = {}) {
  return { ...extra, createdBy: userId };
}

function aggregatorFilter(req, extra = {}) {
  if (req.isAdmin) return { ...extra };
  return ownedFilter(req.userId, extra);
}

function normalizePhone(phone) {
  return String(phone || "")
    .replace(/\D/g, "")
    .trim();
}

function normalizeBody(body) {
  const data = { ...body };
  delete data.createdBy;

  data.name = String(data.name || "").trim();
  data.phone = normalizePhone(data.phone);
  data.state = String(data.state || "").trim();
  data.district = String(data.district || "").trim();
  data.taluk = String(data.taluk || "").trim();
  data.village = String(data.village || "").trim();
  data.unit = String(data.unit || "").trim();
  if (!data.unit) delete data.unit;
  data.experience = String(data.experience || "").trim();
  data.notes = String(data.notes || "").trim();

  if (data.capacity === "" || data.capacity === null || data.capacity === undefined) {
    delete data.capacity;
  } else {
    data.capacity = Number(data.capacity);
  }

  data.hasStock = Boolean(data.hasStock);
  data.currentStock = String(data.currentStock || "").trim();
  data.product = String(data.product || "").trim();
  data.stockRegion = String(data.stockRegion || "").trim();
  data.stockType = String(data.stockType || "").trim();
  data.stockPolish = String(data.stockPolish || "").trim();

  if (Array.isArray(data.stockVarieties)) {
    data.stockVarieties = data.stockVarieties
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  } else {
    data.stockVarieties = [];
  }

  if (!data.hasStock) {
    data.currentStock = "";
    data.stockRegion = "";
    data.stockVarieties = [];
    delete data.stockType;
    delete data.stockPolish;
  }

  data.imageUrl = String(data.imageUrl || "").trim();
  data.imagePublicId = String(data.imagePublicId || "").trim();
  if (!data.imageUrl) {
    delete data.imageUrl;
    delete data.imagePublicId;
  } else if (!data.imagePublicId) {
    delete data.imagePublicId;
  }

  return data;
}

router.get("/types", (_req, res) => {
  res.json({
    types: AGGREGATOR_TYPES,
    units: AGGREGATOR_UNITS,
    products: getProductOptions(),
  });
});

router.get("/", async (req, res) => {
  try {
    const aggregators = await Aggregator.find(aggregatorFilter(req)).sort({
      updatedAt: -1,
    });
    res.json(aggregators);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/upload-image", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
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
          "Cloudinary is not configured. Add CLOUD_NAME, CLOUD_API_KEY, CLOUD_API_SECRET to backend/.env.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    if (!req.file.mimetype?.startsWith("image/")) {
      return res.status(400).json({ message: "Only image files are allowed" });
    }

    const result = await uploadBuffer(req.file.buffer, {
      resource_type: "image",
      folder: "sales-crm/aggregators",
      public_id: `aggregator-${req.userId}-${Date.now()}`,
      type: "upload",
      access_mode: "public",
    });

    res.json({
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Image upload failed" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const aggregator = await Aggregator.findOne(
      aggregatorFilter(req, { _id: req.params.id })
    );
    if (!aggregator) {
      return res.status(404).json({ message: "Aggregator not found" });
    }
    res.json(aggregator);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const data = normalizeBody(req.body);

    if (!data.name) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!data.phone || data.phone.length < 10) {
      return res.status(400).json({ message: "Valid phone number is required" });
    }
    if (!data.state) {
      return res.status(400).json({ message: "State is required" });
    }
    if (!data.district) {
      return res.status(400).json({ message: "District is required" });
    }
    if (data.unit && !AGGREGATOR_UNITS.includes(data.unit)) {
      return res.status(400).json({ message: "Invalid unit" });
    }
    if (!AGGREGATOR_TYPES.includes(data.aggregatorType)) {
      return res.status(400).json({ message: "Invalid aggregator type" });
    }
    if (!isValidProduct(data.product)) {
      return res.status(400).json({ message: "Invalid product" });
    }
    if (data.hasStock) {
      if (!data.currentStock) {
        return res
          .status(400)
          .json({ message: "Current stock in tons is required" });
      }
      const stockTons = Number(data.currentStock);
      if (Number.isNaN(stockTons) || stockTons <= 0) {
        return res
          .status(400)
          .json({ message: "Enter a valid stock quantity in tons" });
      }
      data.currentStock = String(stockTons);
      if (!data.stockRegion) {
        return res.status(400).json({ message: "Stock region is required" });
      }
      if (!data.stockVarieties.length) {
        return res.status(400).json({ message: "Select at least one district" });
      }
      if (!isValidStockType(data.stockType)) {
        return res.status(400).json({ message: "Invalid stock type" });
      }
      if (!isValidStockPolish(data.stockPolish)) {
        return res.status(400).json({ message: "Invalid polish type" });
      }
    }

    if (data.imageUrl && !isCloudinaryUrl(data.imageUrl)) {
      return res.status(400).json({ message: "Invalid image URL" });
    }

    const aggregator = await Aggregator.create({
      ...data,
      createdBy: req.userId,
    });
    res.status(201).json(aggregator);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
