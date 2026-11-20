/**
 * Read-only snapshot of every collection into backups/<timestamp>/*.json.
 *
 *   npm run backup
 *
 * Never writes to the database. Restore with `npm run restore -- <folder>`,
 * which only ever inserts or updates documents — it deletes nothing.
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

// Same guard as src/config/db.js: Node's resolver can mis-detect DNS on Windows.
if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

const mongoose = require("mongoose");
const { EJSON } = require("bson");

async function main() {
  const uri = (process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sales-crm").trim();
  const dbName = process.env.MONGODB_DB_NAME?.trim();
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  const db = mongoose.connection.db;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Dev and production are both called "test" — the cluster tells them apart.
  const cluster = new URL(uri).host.split(".")[0] + "." + (new URL(uri).host.split(".")[1] || "");
  const dir = path.join(__dirname, "..", "backups", `${cluster}__${db.databaseName}__${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((name) => !name.startsWith("system."))
    .sort();

  console.log(`Backing up database "${db.databaseName}" to ${dir}\n`);
  let total = 0;
  for (const name of collections) {
    const docs = await db.collection(name).find({}).toArray();
    // EJSON keeps ObjectIds and Dates intact so a restore is exact.
    fs.writeFileSync(path.join(dir, `${name}.json`), EJSON.stringify(docs, { relaxed: false }, 2));
    console.log(`  ${name.padEnd(20)} ${String(docs.length).padStart(5)} documents`);
    total += docs.length;
  }

  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ database: db.databaseName, cluster: new URL(uri).host, takenAt: new Date().toISOString(), collections, totalDocuments: total }, null, 2)
  );

  console.log(`\nDone: ${total} documents across ${collections.length} collections.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Backup failed:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
