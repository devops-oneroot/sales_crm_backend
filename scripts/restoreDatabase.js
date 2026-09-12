/**
 * Puts documents from a backup folder back into the database.
 *
 *   npm run restore -- backups/<folder>                 full rewind
 *   npm run restore -- backups/<folder> --missing-only  only re-create what is gone
 *
 * Deliberately non-destructive. Nothing is ever deleted, and a document
 * created after the backup was taken is left alone.
 *
 *   default        every backed-up document is put back as it was in the
 *                  backup (existing ones are overwritten with that version)
 *   --missing-only only documents that no longer exist are re-created;
 *                  everything still present is not touched at all
 */
const path = require("path");
const fs = require("fs");
const dns = require("dns");

// DOTENV_PATH=.env.production npm run backup   -> another environment's database
require("dotenv").config({
  path: process.env.DOTENV_PATH
    ? path.resolve(process.cwd(), process.env.DOTENV_PATH)
    : path.join(__dirname, "..", ".env"),
  override: true,
});

if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

const mongoose = require("mongoose");
const { EJSON } = require("bson");

async function main() {
  const args = process.argv.slice(2);
  const missingOnly = args.includes("--missing-only");
  const folder = args.find((a) => !a.startsWith("--"));
  if (!folder) {
    console.error("Usage: npm run restore -- backups/<folder> [--missing-only]");
    process.exit(1);
  }
  const dir = path.resolve(process.cwd(), folder);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest.json in ${dir} — is this a backup folder?`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const uri = (process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sales-crm").trim();
  const dbName = process.env.MONGODB_DB_NAME?.trim();
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  const db = mongoose.connection.db;

  const connectedCluster = new URL(uri).host;
  if (manifest.cluster && manifest.cluster !== connectedCluster) {
    console.error(
      `Refusing: backup was taken from cluster "${manifest.cluster}" but you are connected to "${connectedCluster}".`
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  if (db.databaseName !== manifest.database) {
    console.error(
      `Refusing: backup is of "${manifest.database}" but you are connected to "${db.databaseName}".`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Restoring from backup taken ${manifest.takenAt} into "${db.databaseName}" on ${connectedCluster}`);
  console.log(missingOnly
    ? "(--missing-only: re-creating documents that are gone; nothing else is touched)\n"
    : "(full rewind: backed-up documents put back as they were; nothing is deleted)\n");

  for (const name of manifest.collections) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const docs = EJSON.parse(fs.readFileSync(file, "utf8"), { relaxed: false });
    if (!docs.length) continue;

    if (missingOnly) {
      const present = new Set(
        (await db.collection(name).find({ _id: { $in: docs.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray())
          .map((d) => String(d._id))
      );
      const gone = docs.filter((d) => !present.has(String(d._id)));
      if (!gone.length) {
        console.log(`  ${name.padEnd(20)} nothing missing`);
        continue;
      }
      const result = await db.collection(name).insertMany(gone, { ordered: false });
      console.log(`  ${name.padEnd(20)} re-created ${String(result.insertedCount).padStart(4)} missing document(s)`);
      continue;
    }

    const result = await db.collection(name).bulkWrite(
      docs.map((doc) => ({
        replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
      })),
      { ordered: false }
    );
    console.log(
      `  ${name.padEnd(20)} put back ${String(result.modifiedCount).padStart(4)}, re-created ${String(result.upsertedCount).padStart(4)}`
    );
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Restore failed:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
