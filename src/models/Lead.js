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

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    company: { type: String, trim: true },
    website: { type: String, trim: true },
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
      required: true,
    },
    responsiblePerson: { type: String, required: true, trim: true },
    followUpDate: { type: Date },
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
