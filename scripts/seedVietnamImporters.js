const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const seedVietnamImporters = require("../src/config/seedVietnamImporters");

async function run() {
  await connectDB();
  console.log("Seeding real-world Vietnam turmeric buyers/importers...");
  await seedVietnamImporters();
  console.log("Seeding complete.");
}

run()
  .catch((err) => {
    console.error("Seeding failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });

