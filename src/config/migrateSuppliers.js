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

  // Only remove rows that now exist in `suppliers`. A row that could not be
  // copied (no createdBy) stays put rather than being deleted uncopied.
  const legacyIds = legacy.map((lead) => lead._id);
  const safeIds = (
    await Supplier.find({ _id: { $in: legacyIds } }).select("_id").lean()
  ).map((s) => s._id);
  const removed = safeIds.length
    ? await Lead.deleteMany({ _id: { $in: safeIds } })
    : { deletedCount: 0 };
  console.log(
    `Suppliers migration: ${migrated} moved to suppliers collection, ${removed.deletedCount} removed from leads`
  );

  return { migrated, removed: removed.deletedCount };
}

module.exports = migrateSuppliers;
