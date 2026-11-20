const Importer = require("../models/Importer");
const User = require("../models/User");
const vietnamImportersData = require("../data/vietnamTurmericImporters");

async function seedVietnamImporters() {
  try {
    let defaultUser = await User.findOne({ role: "admin" }).select("_id name");
    if (!defaultUser) {
      defaultUser = await User.findOne().select("_id name");
    }

    if (!defaultUser) {
      console.warn("Skipping Vietnam importers seed: No user found in database yet.");
      return;
    }

    let seededCount = 0;
    let updatedCount = 0;

    for (const item of vietnamImportersData) {
      const existing = await Importer.findOne({ importerName: item.importerName });
      if (!existing) {
        await Importer.create({
          ...item,
          createdBy: defaultUser._id,
          responsiblePerson: defaultUser.name || "Admin",
        });
        seededCount++;
      } else {
        // Update details if needed
        await Importer.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...item,
              updatedAt: new Date(),
            },
          }
        );
        updatedCount++;
      }
    }

    console.log(
      `Vietnam Turmeric Importers: ${seededCount} created, ${updatedCount} already present/updated in importers collection.`
    );
  } catch (err) {
    console.error("Error seeding Vietnam turmeric importers:", err.message);
  }
}

module.exports = seedVietnamImporters;

