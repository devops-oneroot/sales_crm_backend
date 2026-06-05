const User = require("../models/User");

/** Sales users who can own leads — loaded from the database, not a hardcoded list. */
async function getTeamMembers() {
  const users = await User.find({ role: "sales" }, { name: 1 })
    .sort({ name: 1 })
    .lean();
  return users
    .filter((u) => u.name?.trim())
    .map((u) => ({ id: u._id.toString(), name: u.name.trim() }));
}

async function getTeamMemberNames() {
  const members = await getTeamMembers();
  return members.map((m) => m.name);
}

async function getAllUserNames() {
  const users = await User.find({}, { name: 1 }).sort({ name: 1 }).lean();
  return users.map((u) => u.name.trim()).filter(Boolean);
}

module.exports = { getTeamMembers, getTeamMemberNames, getAllUserNames };
