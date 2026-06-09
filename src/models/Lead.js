const mongoose = require("mongoose");

const remarkSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    author: { type: String, default: "" },
  },
  { timestamps: true }
);

const documentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true },
    publicId: { type: String },
    resourceType: { type: String, enum: ["image", "raw"], default: "image" },
    format: { type: String },
    version: { type: Number },
    bytes: { type: Number },
  },
  { timestamps: true }
);

const contactEntrySchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    designation: { type: String, trim: true },
  },
  { _id: false }
);

const exportDetailsSchema = new mongoose.Schema(
  {
    exportIndustryType: { type: String, trim: true },
    materialType: { type: String, trim: true },
    polishLevel: { type: String, trim: true },
    minCurcumin: { type: Number, min: 0 },
    moistureLevel: { type: Number, min: 0 },
    minOilContent: { type: Number, min: 0 },
    acceptGrade: { type: String, trim: true },
    preferredOrigin: { type: String, trim: true },
    quantityNeededKg: { type: Number, min: 0 },
    kgPerBag: { type: Number, min: 0 },
    maxPrice: { type: Number, min: 0 },
    paymentDays: { type: Number, min: 0 },
    deliveryState: { type: String, trim: true },
    deliveryDistrict: { type: String, trim: true },
    incoterm: { type: String, trim: true },
    portDelivery: { type: String, trim: true },
    paymentDaysAfterSailing: { type: Number, min: 0 },
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    leadType: {
      type: String,
      enum: ["export", "domestic"],
      default: "domestic",
    },
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    contactPersons: [{ type: String, trim: true }],
    contacts: [contactEntrySchema],
    designation: { type: String, trim: true },
    phone: { type: String, trim: true },
    whatsappNumber: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    emails: [{ type: String, trim: true, lowercase: true }],
    company: { type: String, trim: true },
    website: { type: String, trim: true },
    linkedIn: { type: String, trim: true },
    leadSource: { type: String, trim: true },
    address: { type: String, trim: true },
    country: { type: String, trim: true },
    industryType: {
      type: String,
      enum: [
        "extraction",
        "masala",
        "feed",
        "ethanol",
        "starch",
        "TRADING",
        "FMCG",
      ],
      trim: true,
    },
    creditRating: { type: String, trim: true },
    companyTurnover: { type: Number, min: 0 },
    sourcingRegion: { type: String, trim: true },
    products: [
      {
        name: { type: String, trim: true },
        quantity: { type: Number, min: 0, default: 0 },
        price: { type: Number, min: 0, default: 0 },
      },
    ],
    product: {
      name: { type: String, trim: true },
      quantity: { type: Number, min: 0, default: 0 },
      price: { type: Number, min: 0, default: 0 },
    },
    industry: {
      type: String,
      enum: ["export", "domestic"],
    },
    exportDetails: exportDetailsSchema,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    responsiblePerson: { type: String, required: true, trim: true },
    followUpDate: { type: Date },
    dailyActivity: { type: String, trim: true },
    dailyActivityNote: { type: String, trim: true },
    dailyActivitySetOn: { type: String, trim: true },
    leadStatus: { type: String, trim: true },
    status: {
      type: String,
      enum: [
        "identity",
        "contact_established",
        "in_progress",
        "deal",
        "junk",
      ],
      default: "identity",
    },
    remarks: [remarkSchema],
    documents: [documentSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Lead", leadSchema);
