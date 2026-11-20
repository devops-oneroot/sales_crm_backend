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

const locationMetaSchema = new mongoose.Schema(
  {
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    addedByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedByName: { type: String, trim: true, default: "" },
    approved: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedByName: { type: String, trim: true, default: "" },
    approvedAt: { type: Date },
    rejected: { type: Boolean, default: false },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedByName: { type: String, trim: true, default: "" },
    rejectedAt: { type: Date },
  },
  { _id: false }
);

const methodMetaSchema = new mongoose.Schema(
  {
    gundlupete: { type: locationMetaSchema, default: () => ({}) },
    erode: { type: locationMetaSchema, default: () => ({}) },
    salem: { type: locationMetaSchema, default: () => ({}) },
    sangli: { type: locationMetaSchema, default: () => ({}) },
    nizamabad: { type: locationMetaSchema, default: () => ({}) },
  },
  { _id: false }
);

const priceMetaByMethodSchema = new mongoose.Schema(
  {
    ipm: { type: methodMetaSchema, default: () => ({}) },
    conventional: { type: methodMetaSchema, default: () => ({}) },
    organic: { type: methodMetaSchema, default: () => ({}) },
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
    priceMeta: { type: priceMetaByMethodSchema, default: () => ({}) },
  },
  { timestamps: true }
);

dailyPriceSchema.index({ date: -1, createdAt: -1 });

module.exports = mongoose.model("DailyPrice", dailyPriceSchema);
