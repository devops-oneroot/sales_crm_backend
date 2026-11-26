const { smartCompanyKey } = require("./duplicateMatching");

function normalizeCompanyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Same company name? Compares the smart key used by the duplicate review, so
 * "Swastik Masala Pvt Ltd" = "Swastiks Masala" and "M/S. Hasan Impex" =
 * "Hasan Impex Ltd" — but "xyzgh" is NOT "XYZ" (one merely containing the
 * other is a different company). Very short names fall back to exact match.
 */
function companyNamesMatch(input, stored) {
  // Same cleanup as the duplicate review, but stricter because this BLOCKS:
  // short names count too, and no plural guessing ("refs" is not "ref").
  const a = smartCompanyKey(input, 2, { plurals: false });
  const b = smartCompanyKey(stored, 2, { plurals: false });
  return !!a && a === b;
}

module.exports = {
  normalizeCompanyName,
  companyNamesMatch,
};
