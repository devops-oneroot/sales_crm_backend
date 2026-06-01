/** Map Supplier documents ↔ legacy Lead-shaped API responses for the frontend. */

function pickSupplierFields(body) {
  const sd = body.supplierDetails || {};
  const supplierName = String(
    sd.supplierName || body.supplierName || body.name || ""
  ).trim();

  return {
    supplierName: supplierName || "—",
    supplierType: sd.supplierType || body.supplierType,
    materialType: sd.materialType || body.materialType,
    polishLevel: sd.polishLevel || body.polishLevel,
    region: sd.region || body.region,
    variety: sd.variety || body.variety,
    curcuminPercent: sd.curcuminPercent ?? body.curcuminPercent,
    grade: sd.grade || body.grade,
    price: sd.price ?? body.price,
    quantityKg: sd.quantityKg ?? body.quantityKg,
    freeKgsPerQuantity: sd.freeKgsPerQuantity ?? body.freeKgsPerQuantity,
    kgPerBag: sd.kgPerBag ?? body.kgPerBag,
    eachBagCost: sd.eachBagCost ?? body.eachBagCost,
    loadingState: sd.loadingState || body.loadingState,
    loadingDistrict: sd.loadingDistrict || body.loadingDistrict,
    paymentDays: sd.paymentDays ?? body.paymentDays,
    apmc: sd.apmc || body.apmc,
    labourAndOtherExpenses:
      sd.labourAndOtherExpenses ?? body.labourAndOtherExpenses,
    responsiblePerson: body.responsiblePerson,
    followUpDate: body.followUpDate,
    status: body.status || "identity",
  };
}

function supplierDocToDetails(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    supplierName: o.supplierName,
    supplierType: o.supplierType,
    materialType: o.materialType,
    polishLevel: o.polishLevel,
    region: o.region,
    variety: o.variety,
    curcuminPercent: o.curcuminPercent,
    grade: o.grade,
    price: o.price,
    quantityKg: o.quantityKg,
    freeKgsPerQuantity: o.freeKgsPerQuantity,
    kgPerBag: o.kgPerBag,
    eachBagCost: o.eachBagCost,
    loadingState: o.loadingState,
    loadingDistrict: o.loadingDistrict,
    paymentDays: o.paymentDays,
    apmc: o.apmc,
    labourAndOtherExpenses: o.labourAndOtherExpenses,
  };
}

function supplierToClientResponse(doc) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  const details = supplierDocToDetails(o);
  const name = details.supplierName || "—";

  return {
    _id: o._id,
    leadType: "supplier",
    name,
    company: name,
    industry: "domestic",
    supplierDetails: details,
    product: {
      name: "turmeric",
      quantity: details.quantityKg ?? 0,
      price: details.price ?? 0,
    },
    products: [
      {
        name: "turmeric",
        quantity: details.quantityKg ?? 0,
        price: details.price ?? 0,
      },
    ],
    responsiblePerson: o.responsiblePerson,
    followUpDate: o.followUpDate,
    status: o.status,
    createdBy: o.createdBy,
    remarks: [],
    documents: [],
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** Build Supplier document fields from a legacy Lead row (migration). */
function leadRowToSupplierFields(lead) {
  const sd = lead.supplierDetails || {};
  const supplierName = String(
    sd.supplierName || lead.name || lead.company || ""
  ).trim();

  return {
    supplierName: supplierName || "—",
    supplierType: sd.supplierType,
    materialType: sd.materialType,
    polishLevel: sd.polishLevel,
    region: sd.region,
    variety: sd.variety,
    curcuminPercent: sd.curcuminPercent,
    grade: sd.grade,
    price: sd.price ?? lead.product?.price,
    quantityKg: sd.quantityKg ?? lead.product?.quantity,
    freeKgsPerQuantity: sd.freeKgsPerQuantity,
    kgPerBag: sd.kgPerBag,
    eachBagCost: sd.eachBagCost,
    loadingState: sd.loadingState,
    loadingDistrict: sd.loadingDistrict,
    paymentDays: sd.paymentDays,
    apmc: sd.apmc,
    labourAndOtherExpenses: sd.labourAndOtherExpenses,
    responsiblePerson: lead.responsiblePerson,
    followUpDate: lead.followUpDate,
    status: lead.status || "identity",
    createdBy: lead.createdBy,
  };
}

function extractSupplierForMatch(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    name: o.supplierName?.trim() || "Unnamed supplier",
    polishLevel: o.polishLevel,
    materialType: o.materialType,
    curcuminPercent: o.curcuminPercent,
    price: o.price,
    region: o.region,
    variety: o.variety,
    grade: o.grade,
    quantityKg: o.quantityKg,
  };
}

module.exports = {
  pickSupplierFields,
  supplierToClientResponse,
  leadRowToSupplierFields,
  extractSupplierForMatch,
};
