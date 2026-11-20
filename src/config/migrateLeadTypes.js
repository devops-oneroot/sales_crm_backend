const Lead = require("../models/Lead");
const { legacySupplierLeadFilter } = require("../lib/leadQuery");

const VALID_TYPES = ["export", "domestic"];

function notSupplierFilter() {
  return { $nor: [legacySupplierLeadFilter] };
}

/**
 * Backfill leadType on production rows created before leadType was required.
 */
async function migrateLeadTypes() {
  const base = notSupplierFilter();

  const fromIndustryExport = await Lead.updateMany(
    {
      ...base,
      industry: "export",
      $or: [
        { leadType: { $exists: false } },
        { leadType: null },
        { leadType: "" },
        { leadType: { $nin: VALID_TYPES } },
      ],
    },
    { $set: { leadType: "export" } }
  );

  const fromIndustryDomestic = await Lead.updateMany(
    {
      ...base,
      industry: "domestic",
      $or: [
        { leadType: { $exists: false } },
        { leadType: null },
        { leadType: "" },
        { leadType: { $nin: VALID_TYPES } },
      ],
    },
    { $set: { leadType: "domestic" } }
  );

  const fromExportDetails = await Lead.updateMany(
    {
      ...base,
      exportDetails: { $exists: true, $ne: null },
      $or: [
        { leadType: { $exists: false } },
        { leadType: null },
        { leadType: "" },
        { leadType: { $nin: VALID_TYPES } },
      ],
    },
    { $set: { leadType: "export" } }
  );

  const defaultDomestic = await Lead.updateMany(
    {
      ...base,
      $or: [
        { leadType: { $exists: false } },
        { leadType: null },
        { leadType: "" },
        { leadType: { $nin: VALID_TYPES } },
      ],
    },
    { $set: { leadType: "domestic" } }
  );

  const updated =
    (fromIndustryExport.modifiedCount || 0) +
    (fromIndustryDomestic.modifiedCount || 0) +
    (fromExportDetails.modifiedCount || 0) +
    (defaultDomestic.modifiedCount || 0);

  if (updated > 0) {
    console.log(`Backfilled leadType on ${updated} lead(s)`);
  }

  return { updated };
}

module.exports = migrateLeadTypes;
