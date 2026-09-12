const mongoose = require("mongoose");
const {
  LEAD_STATUSES,
  LEGACY_STATUSES,
  DEFAULT_LEAD_STATUS,
} = require("../lib/leadStatuses");

const supplierSchema = new mongoose.Schema(
  {
    supplierName: { type: String, required: true, trim: true },
    supplierNumber: { type: String, required: true, trim: true },
    supplierType: { type: String, trim: true },
    materialType: { type: String, trim: true },
    polishLevel: { type: String, trim: true },
    region: { type: String, trim: true },
    variety: { type: String, trim: true },
    curcuminPercent: { type: Number, min: 0 },
    grade: { type: String, trim: true },
    price: { type: Number, min: 0 },
    quantityKg: { type: Number, min: 0 },
    freeKgsPerQuantity: { type: Number, min: 0 },
    kgPerBag: { type: Number, min: 0 },
    eachBagCost: { type: Number, min: 0 },
    loadingState: { type: String, trim: true },
    loadingDistrict: { type: String, trim: true },
    paymentDays: { type: Number, min: 0 },
    apmc: { type: String, enum: ["yes", "no"], trim: true },
    labourAndOtherExpenses: { type: Number, min: 0 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    responsiblePerson: { type: String, required: true, trim: true },
    followUpDate: { type: Date },
    status: {
      type: String,
      enum: [...LEAD_STATUSES, ...LEGACY_STATUSES],
      default: DEFAULT_LEAD_STATUS,
    },
    /** The status this supplier had before the pipeline was renamed. */
    legacyStatus: { type: String, trim: true },
  },
  { timestamps: true, collection: "suppliers" }
);

module.exports = mongoose.model("Supplier", supplierSchema);
