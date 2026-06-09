const mongoose = require("mongoose");
const { scopeClauseForRequest } = require("./adminScope");

/** Rows that belong in the suppliers collection, not the leads list. */
const legacySupplierLeadFilter = {
  $or: [
    { leadType: "supplier" },
    {
      leadType: { $exists: false },
      "supplierDetails.supplierName": { $exists: true, $ne: "" },
    },
  ],
};

/** Buyer/export/domestic leads — includes legacy rows without leadType. */
function buyerLeadClause() {
  return { $nor: [legacySupplierLeadFilter] };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function missingCreatedByClause() {
  return {
    $or: [{ createdBy: { $exists: false } }, { createdBy: null }],
  };
}

function ownedByUserClause(userId, userName) {
  const idStr = String(userId);
  const id =
    userId instanceof mongoose.Types.ObjectId
      ? userId
      : new mongoose.Types.ObjectId(idStr);

  const clauses = [{ createdBy: { $in: [id, idStr] } }];

  const name = String(userName || "").trim();
  if (name) {
    clauses.push({
      ...missingCreatedByClause(),
      responsiblePerson: {
        $regex: new RegExp(`^${escapeRegex(name)}`, "i"),
      },
    });
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function leadFilterForRequest(req, extra = {}) {
  const base = { ...buyerLeadClause(), ...scopeClauseForRequest(req), ...extra };
  if (req.isAdmin) return base;
  return { ...base, ...ownedByUserClause(req.userId, req.userName) };
}

module.exports = {
  buyerLeadClause,
  legacySupplierLeadFilter,
  leadFilterForRequest,
  ownedByUserClause,
};
