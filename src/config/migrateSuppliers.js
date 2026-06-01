const Lead = require("../models/Lead");
const Supplier = require("../models/Supplier");
const { leadRowToSupplierFields } = require("../lib/supplierAdapter");
const { legacySupplierLeadFilter } = require("../lib/leadQuery");

/**
 * Move supplier rows from `leads` collection into `suppliers` collection.
 * Preserves _id so existing UI links keep working. Removes migrated lead docs.
 */
async function migrateSuppliers() {
  const legacy = await Lead.find(legacySupplierLeadFilter).lean();
  if (!legacy.length) {
    return { migrated: 0, removed: 0 };
  }

  let migrated = 0;
  for (const lead of legacy) {
    const fields = leadRowToSupplierFields(lead);
    if (!fields.createdBy) {
      console.warn(
        `Skipping supplier lead ${lead._id} — missing createdBy`
      );
      continue;
    }

    const exists = await Supplier.findById(lead._id).select("_id").lean();
    if (!exists) {
      await Supplier.create({
        _id: lead._id,
        ...fields,
      });
      migrated += 1;
    }
  }

  const removed = await Lead.deleteMany(legacySupplierLeadFilter);
  console.log(
    `Suppliers migration: ${migrated} moved to suppliers collection, ${removed.deletedCount} removed from leads`
  );

  return { migrated, removed: removed.deletedCount };
}

module.exports = migrateSuppliers;
