const mongoose = require("mongoose");
const { AGGREGATOR_PRODUCTS } = require("../config/productRegions");

const AGGREGATOR_TYPES = [
  "village_buyer",
  "mandi_buyer",
  "mandi_and_village_buyer",
  "trader",
  "stocker",
];

const AGGREGATOR_UNITS = ["kg", "quintal", "ton", "bag", "crate", "piece"];

const aggregatorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true },
    taluk: { type: String, trim: true },
    village: { type: String, trim: true },
    capacity: { type: Number, min: 0 },
    unit: { type: String, enum: AGGREGATOR_UNITS, trim: true },
    experience: { type: String, trim: true },
    aggregatorType: {
      type: String,
      enum: AGGREGATOR_TYPES,
      required: true,
    },
    product: {
      type: String,
      enum: AGGREGATOR_PRODUCTS,
      required: true,
    },
    hasStock: { type: Boolean, default: false },
    currentStock: { type: String, trim: true },
    stockRegion: { type: String, trim: true },
    stockVarieties: [{ type: String, trim: true }],
    stockType: {
      type: String,
      enum: ["finger", "bulk", "mother", "kocha"],
      trim: true,
    },
    stockPolish: {
      type: String,
      enum: ["single_polish", "unpolish", "double_polish"],
      trim: true,
    },
    notes: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    imagePublicId: { type: String, trim: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Aggregator", aggregatorSchema);
module.exports.AGGREGATOR_TYPES = AGGREGATOR_TYPES;
module.exports.AGGREGATOR_UNITS = AGGREGATOR_UNITS;
module.exports.AGGREGATOR_PRODUCTS = AGGREGATOR_PRODUCTS;
