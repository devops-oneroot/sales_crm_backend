const Lead = require("../models/Lead");
const User = require("../models/User");
const { getAllUserNames } = require("../lib/teamMembers");

async function migrateInvalidResponsiblePersons() {
  const users = await User.find({}, { _id: 1, name: 1 }).lean();
  const validNames = await getAllUserNames();
  if (!validNames.length) return;

  const invalidLeads = await Lead.find(
    { responsiblePerson: { $nin: validNames } },
    { _id: 1, createdBy: 1 }
  ).lean();

  let updatedCount = 0;
  for (const lead of invalidLeads) {
    const creator = users.find(
      (u) => u._id.toString() === String(lead.createdBy)
    );
    if (!creator?.name?.trim()) continue;

    const result = await Lead.updateOne(
      { _id: lead._id },
      { $set: { responsiblePerson: creator.name.trim() } }
    );
    updatedCount += result.modifiedCount || 0;
  }

  if (updatedCount > 0) {
    console.log(
      `Updated ${updatedCount} lead(s) with responsible person from User model`
    );
  }
}

module.exports = migrateInvalidResponsiblePersons;
