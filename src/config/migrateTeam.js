const Lead = require("../models/Lead");

const TEAM_MEMBERS = ["Rohan", "Rahul", "Tejas", "Shiva", "Aadarsh"];

async function migrateInvalidResponsiblePersons() {
  const result = await Lead.updateMany(
    { responsiblePerson: { $nin: TEAM_MEMBERS } },
    { $set: { responsiblePerson: "Rohan" } }
  );
  if (result.modifiedCount > 0) {
    console.log(
      `Updated ${result.modifiedCount} lead(s) to valid responsible person`
    );
  }
}

module.exports = migrateInvalidResponsiblePersons;
