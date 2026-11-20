const User = require("../models/User");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findSalesUserByName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;

  return User.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
    role: "sales",
  })
    .select("_id name")
    .lean();
}

/**
 * Non-admins cannot change responsiblePerson.
 * Admins must pick a sales user. Ownership is tracked via responsiblePerson only;
 * createdBy stays as the original creator for history.
 */
async function applyResponsiblePersonPatch(req, data, existing) {
  const prevName = String(existing.responsiblePerson || "").trim();

  if (!req.isAdmin) {
    delete data.responsiblePerson;
    return null;
  }

  if (data.responsiblePerson === undefined) {
    return null;
  }

  const nextName = String(data.responsiblePerson || "").trim();
  if (!nextName) {
    delete data.responsiblePerson;
    return null;
  }

  if (nextName.toLowerCase() === prevName.toLowerCase()) {
    data.responsiblePerson = prevName;
    return null;
  }

  const assignee = await findSalesUserByName(nextName);
  if (!assignee) {
    const err = new Error("Select a valid team member to assign this lead");
    err.statusCode = 400;
    throw err;
  }

  data.responsiblePerson = assignee.name.trim();
  delete data.createdBy;

  return {
    from: prevName,
    to: data.responsiblePerson,
  };
}

module.exports = {
  applyResponsiblePersonPatch,
  findSalesUserByName,
};
