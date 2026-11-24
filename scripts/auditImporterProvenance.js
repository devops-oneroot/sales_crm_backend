/**
 * READ-ONLY audit: reports existing importer records that fail the provenance rules
 * (missing source_url / fetched_at, placeholder data, ungrounded contacts).
 * It never modifies or deletes anything — decide what to do with the results yourself.
 *
 *   npm run audit:provenance            summary + up to 25 examples
 *   npm run audit:provenance -- --all   list every failing record
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), override: true });

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { validateImporterProvenance } = require("../src/lib/importerProvenance");

async function main() {
  const showAll = process.argv.includes("--all");
  await connectDB();

  const docs = await mongoose.connection
    .collection("importers")
    .find({}, { projection: { timeline: 0 } })
    .toArray();

  const failing = [];
  const reasonCounts = {};
  for (const doc of docs) {
    const { valid, errors } = validateImporterProvenance({
      ...doc,
      source_type: doc.source_type || "manual",
    });
    if (valid) continue;
    failing.push({ doc, errors });
    for (const e of errors) {
      const key = e.replace(/".*?"/g, '"…"');
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  }

  console.log(`\nImporters total: ${docs.length}`);
  console.log(`Pass provenance rules: ${docs.length - failing.length}`);
  console.log(`Fail provenance rules: ${failing.length}\n`);

  if (failing.length) {
    console.log("Failure reasons:");
    for (const [reason, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${reason}`);
    }
    const list = showAll ? failing : failing.slice(0, 25);
    console.log(`\n${showAll ? "All" : "First " + list.length} failing records:`);
    for (const { doc, errors } of list) {
      console.log(
        `  ${doc._id}  ${doc.importerName || doc.companyName || "(no name)"}  [${doc.source_type || "no source_type"}]  → ${errors[0]}`
      );
    }
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Audit failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
