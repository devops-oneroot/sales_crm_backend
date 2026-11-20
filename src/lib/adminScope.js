/** Leads visible to export-scoped admins. */
function exportOnlyLeadClause() {
  return {
    $or: [
      { leadType: "export" },
      {
        leadType: { $exists: false },
        industry: "export",
      },
    ],
  };
}

function isExportOnlyAdmin(req) {
  return req.isAdmin && req.adminScope === "export";
}

function scopeClauseForRequest(req) {
  if (isExportOnlyAdmin(req)) return exportOnlyLeadClause();
  return {};
}

function enforceExportLeadBody(req, data) {
  if (!isExportOnlyAdmin(req)) return data;
  data.leadType = "export";
  data.industry = "export";
  return data;
}

module.exports = {
  exportOnlyLeadClause,
  isExportOnlyAdmin,
  scopeClauseForRequest,
  enforceExportLeadBody,
};
