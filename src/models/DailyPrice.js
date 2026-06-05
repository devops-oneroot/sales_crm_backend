const mongoose = require("mongoose");

const locationPriceSchema = new mongoose.Schema(
  {
    gundlupete: { type: Number, min: 0 },
    erode: { type: Number, min: 0 },
    salem: { type: Number, min: 0 },
    sangli: { type: Number, min: 0 },
    nizamabad: { type: Number, min: 0 },
  },
  { _id: false }
);

const methodPricesSchema = new mongoose.Schema(
  {
    unpolish: { type: locationPriceSchema, default: () => ({}) },
    singlePolish: { type: locationPriceSchema, default: () => ({}) },
    doublePolish: { type: locationPriceSchema, default: () => ({}) },
    unpolishBulb: { type: locationPriceSchema, default: () => ({}) },
    singlePolishBulb: { type: locationPriceSchema, default: () => ({}) },
    doublePolishBulb: { type: locationPriceSchema, default: () => ({}) },
  },
  { _id: false }
);

const pricesByMethodSchema = new mongoose.Schema(
  {
    ipm: { type: methodPricesSchema, default: () => ({}) },
    conventional: { type: methodPricesSchema, default: () => ({}) },
    organic: { type: methodPricesSchema, default: () => ({}) },
  },
  { _id: false }
);

const dailyPriceSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, trim: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    addedByName: { type: String, required: true, trim: true },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    updatedByName: { type: String, trim: true },
    prices: { type: pricesByMethodSchema, default: () => ({}) },
  },
  { timestamps: true }
);

dailyPriceSchema.index({ date: -1, createdAt: -1 });

module.exports = mongoose.model("DailyPrice", dailyPriceSchema);
