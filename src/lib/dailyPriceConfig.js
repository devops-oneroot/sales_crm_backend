const PRICE_ROWS = [
  { id: "unpolish", label: "Unpolish" },
  { id: "singlePolish", label: "Single polish" },
  { id: "doublePolish", label: "Double polish" },
  { id: "unpolishBulb", label: "Unpolish bulb" },
  { id: "singlePolishBulb", label: "Single polish bulb" },
  { id: "doublePolishBulb", label: "Double polish bulb" },
];

const LOCATIONS = [
  { id: "gundlupete", label: "Gundlupete" },
  { id: "erode", label: "Erode" },
  { id: "salem", label: "Salem" },
  { id: "sangli", label: "Sangli" },
  { id: "nizamabad", label: "Nizamabad" },
];

const FARMING_METHODS = [
  { id: "ipm", label: "IPM price" },
  { id: "conventional", label: "Conventional price" },
  { id: "organic", label: "Organic price" },
];

const ROW_IDS = PRICE_ROWS.map((r) => r.id);
const LOCATION_IDS = LOCATIONS.map((l) => l.id);
const METHOD_IDS = FARMING_METHODS.map((m) => m.id);

function emptyPriceGrid() {
  const row = Object.fromEntries(LOCATION_IDS.map((id) => [id, undefined]));
  return Object.fromEntries(ROW_IDS.map((id) => [id, { ...row }]));
}

function emptyPricesByMethod() {
  return Object.fromEntries(
    METHOD_IDS.map((id) => [id, emptyPriceGrid()])
  );
}

function isLegacyPrices(raw) {
  if (!raw || typeof raw !== "object") return false;
  const hasMethod = METHOD_IDS.some((m) => raw[m] != null);
  if (hasMethod) return false;
  return ROW_IDS.some((id) => raw[id] != null);
}

function normalizeLocationPrices(raw = {}) {
  const out = {};
  for (const locId of LOCATION_IDS) {
    const value = raw[locId];
    if (value === "" || value === null || value === undefined) continue;
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) out[locId] = num;
  }
  return out;
}

function normalizeMethodGrid(raw = {}) {
  const grid = {};
  for (const rowId of ROW_IDS) {
    grid[rowId] = normalizeLocationPrices(raw[rowId]);
  }
  return grid;
}

function normalizePricesBody(raw = {}) {
  if (isLegacyPrices(raw)) {
    return {
      ipm: emptyPriceGrid(),
      conventional: normalizeMethodGrid(raw),
      organic: emptyPriceGrid(),
    };
  }

  const prices = {};
  for (const methodId of METHOD_IDS) {
    prices[methodId] = normalizeMethodGrid(raw[methodId] || {});
  }
  return prices;
}

function hasAnyPriceInMethod(methodGrid) {
  return ROW_IDS.some((rowId) =>
    LOCATION_IDS.some((locId) => methodGrid?.[rowId]?.[locId] != null)
  );
}

function hasAnyPrice(prices) {
  return METHOD_IDS.some((methodId) => hasAnyPriceInMethod(prices[methodId]));
}

function mergePricesBody(existingRaw, incomingRaw) {
  const existing = normalizePricesBody(existingRaw);
  const incoming = normalizePricesBody(incomingRaw);
  const merged = { ...existing };

  for (const methodId of METHOD_IDS) {
    if (hasAnyPriceInMethod(incoming[methodId])) {
      merged[methodId] = incoming[methodId];
    }
  }

  return merged;
}

module.exports = {
  PRICE_ROWS,
  LOCATIONS,
  FARMING_METHODS,
  ROW_IDS,
  LOCATION_IDS,
  METHOD_IDS,
  emptyPriceGrid,
  emptyPricesByMethod,
  isLegacyPrices,
  normalizePricesBody,
  mergePricesBody,
  hasAnyPriceInMethod,
  hasAnyPrice,
};
