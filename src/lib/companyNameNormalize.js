function normalizeCompanyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function companyNamesMatch(input, stored) {
  const query = normalizeCompanyName(input);
  const candidate = normalizeCompanyName(stored);
  if (!query || query.length < 2 || !candidate) return false;
  if (query === candidate) return true;
  if (query.length >= 3 && candidate.includes(query)) return true;
  if (candidate.length >= 3 && query.includes(candidate)) return true;
  return false;
}

module.exports = {
  normalizeCompanyName,
  companyNamesMatch,
};
