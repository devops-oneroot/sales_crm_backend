const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const migrateInvalidResponsiblePersons = require("../src/config/migrateTeam");
const migrateLeadCreators = require("../src/config/migrateLeadCreators");
const migrateAdmin = require("../src/config/migrateAdmin");
const migrateSuppliers = require("../src/config/migrateSuppliers");
const migrateLeadTypes = require("../src/config/migrateLeadTypes");
const Lead = require("../src/models/Lead");

async function runMigrations() {
  await connectDB();

  console.log("Running migrateInvalidResponsiblePersons...");
  await migrateInvalidResponsiblePersons();

  console.log("Running migrateLeadCreators (createdBy)...");
  await migrateLeadCreators();

  console.log("Running migrateAdmin...");
  await migrateAdmin();

  console.log("Running migrateSuppliers...");
  await migrateSuppliers();

  console.log("Running migrateLeadTypes...");
  await migrateLeadTypes();

  const total = await Lead.countDocuments();
  const missing = await Lead.countDocuments({
    $or: [{ createdBy: { $exists: false } }, { createdBy: null }],
  });
  console.log(`Done. Leads: ${total}, still missing createdBy: ${missing}`);
}

runMigrations()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
