const Lead = require("../models/Lead");
const Supplier = require("../models/Supplier");
const {
  LEGACY_STATUSES,
  toCurrentStatus,
} = require("../lib/leadStatuses");

/**
 * Moves every lead and supplier from the old pipeline names to the new ones.
 *
 * Runs on every start and only ever touches rows still holding a legacy
 * status, so once converted a row is never rewritten. Each converted row
 * keeps its previous value in `legacyStatus` — that is the backup: nothing
 * about the old state is thrown away, and a row can always be put back.
 *
 * Rows are updated one at a time by _id, each carrying the exact value it
 * was read with, so a row that changes between read and write is skipped
 * rather than clobbered.
 */
async function migrateCollection(Model, label) {
  const rows = await Model.find({ status: { $in: LEGACY_STATUSES } })
    .select("_id status pipelineStatus legacyStatus")
    .lean();

  if (!rows.length) return { checked: 0, moved: 0 };

  const ops = rows.map((row) => ({
    updateOne: {
      // Match the status we read, so a concurrent change is left alone.
      filter: { _id: row._id, status: row.status },
      update: {
        $set: {
          status: toCurrentStatus(row.status, row.pipelineStatus),
          pipelineStatus: null,
          // Only the very first migration records the backup.
          ...(row.legacyStatus ? {} : { legacyStatus: row.status }),
        },
      },
    },
  }));

  // timestamps:false — a rename is not an edit. updatedAt must keep showing
  // when a person last changed the lead, not when this migration ran.
  const result = await Model.bulkWrite(ops, { ordered: false, timestamps: false });
  const moved = result.modifiedCount ?? 0;

  const summary = {};
  for (const row of rows) {
    const to = toCurrentStatus(row.status, row.pipelineStatus);
    const key = `${row.status} -> ${to}`;
    summary[key] = (summary[key] || 0) + 1;
  }
  for (const [key, n] of Object.entries(summary)) {
    console.log(`  ${label}: ${key} (${n})`);
  }

  return { checked: rows.length, moved };
}

async function migrateLeadStatuses() {
  const leads = await migrateCollection(Lead, "leads");
  const suppliers = await migrateCollection(Supplier, "suppliers");

  const total = leads.moved + suppliers.moved;
  if (total > 0) {
    console.log(
      `Pipeline rename: moved ${leads.moved} lead(s) and ${suppliers.moved} supplier(s) to the new statuses (old values kept in legacyStatus)`
    );
  }
}

module.exports = migrateLeadStatuses;
