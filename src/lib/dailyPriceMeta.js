const { ROW_IDS, METHOD_IDS, emptyPriceGrid, LOCATION_IDS } = require("./dailyPriceConfig");

function emptyLocationMeta() {
  return {
    addedBy: undefined,
    addedByName: "",
    updatedBy: undefined,
    updatedByName: "",
    approved: false,
    approvedBy: undefined,
    approvedByName: "",
    approvedAt: undefined,
    rejected: false,
    rejectedBy: undefined,
    rejectedByName: "",
    rejectedAt: undefined,
  };
}

function emptyMethodMeta() {
  return Object.fromEntries(LOCATION_IDS.map((id) => [id, emptyLocationMeta()]));
}

function emptyPriceMetaByMethod() {
  return Object.fromEntries(METHOD_IDS.map((id) => [id, emptyMethodMeta()]));
}

function locationHasAnyPrice(methodGrid, locationId) {
  return ROW_IDS.some((rowId) => methodGrid?.[rowId]?.[locationId] != null);
}

function locationGridFingerprint(methodGrid, locationId) {
  const pairs = ROW_IDS.map((rowId) => [
    rowId,
    methodGrid?.[rowId]?.[locationId] ?? null,
  ]);
  return JSON.stringify(pairs);
}

function normalizeLocationMetaEntry(entry) {
  if (!entry || typeof entry !== "object") return emptyLocationMeta();
  return {
    addedBy: entry.addedBy,
    addedByName: entry.addedByName || "",
    updatedBy: entry.updatedBy,
    updatedByName: entry.updatedByName || "",
    approved: Boolean(entry.approved),
    approvedBy: entry.approvedBy,
    approvedByName: entry.approvedByName || "",
    approvedAt: entry.approvedAt,
    rejected: Boolean(entry.rejected),
    rejectedBy: entry.rejectedBy,
    rejectedByName: entry.rejectedByName || "",
    rejectedAt: entry.rejectedAt,
  };
}

function normalizeMethodMeta(raw = {}) {
  const meta = emptyMethodMeta();
  for (const locId of LOCATION_IDS) {
    meta[locId] = normalizeLocationMetaEntry(raw[locId]);
  }
  return meta;
}

function normalizePriceMetaForClient(raw) {
  const meta = emptyPriceMetaByMethod();
  if (!raw || typeof raw !== "object") return meta;
  for (const methodId of METHOD_IDS) {
    meta[methodId] = normalizeMethodMeta(raw[methodId]);
  }
  return meta;
}

function toClientLocationMeta(entry) {
  if (!entry) return emptyLocationMeta();
  return {
    addedBy: entry.addedBy ? String(entry.addedBy) : undefined,
    addedByName: entry.addedByName || "",
    updatedBy: entry.updatedBy ? String(entry.updatedBy) : undefined,
    updatedByName: entry.updatedByName || "",
    approved: Boolean(entry.approved),
    approvedBy: entry.approvedBy ? String(entry.approvedBy) : undefined,
    approvedByName: entry.approvedByName || "",
    approvedAt: entry.approvedAt,
    rejected: Boolean(entry.rejected),
    rejectedBy: entry.rejectedBy ? String(entry.rejectedBy) : undefined,
    rejectedByName: entry.rejectedByName || "",
    rejectedAt: entry.rejectedAt,
  };
}

function toClientPriceMeta(raw) {
  const normalized = normalizePriceMetaForClient(raw);
  const out = {};
  for (const methodId of METHOD_IDS) {
    out[methodId] = {};
    for (const locId of LOCATION_IDS) {
      out[methodId][locId] = toClientLocationMeta(normalized[methodId][locId]);
    }
  }
  return out;
}

function updateMetaForMethodPrices(
  existingMethodMeta = {},
  oldGrid,
  newGrid,
  userId,
  userName
) {
  const meta = normalizeMethodMeta(existingMethodMeta);

  for (const locId of LOCATION_IDS) {
    if (!locationHasAnyPrice(newGrid, locId)) continue;

    const oldFp = locationGridFingerprint(oldGrid, locId);
    const newFp = locationGridFingerprint(newGrid, locId);
    if (oldFp === newFp) continue;

    const prev = meta[locId] || emptyLocationMeta();
    meta[locId] = {
      addedBy: prev.addedBy || userId,
      addedByName: prev.addedByName || userName,
      updatedBy: userId,
      updatedByName: userName,
      approved: false,
      approvedBy: undefined,
      approvedByName: "",
      approvedAt: undefined,
      rejected: false,
      rejectedBy: undefined,
      rejectedByName: "",
      rejectedAt: undefined,
    };
  }

  return meta;
}

function buildMetaForAllPrices(prices, userId, userName) {
  const meta = emptyPriceMetaByMethod();
  for (const methodId of METHOD_IDS) {
    meta[methodId] = updateMetaForMethodPrices(
      {},
      emptyPriceGrid(),
      prices[methodId] || emptyPriceGrid(),
      userId,
      userName
    );
  }
  return meta;
}

function mergePriceMetaOnUpdate(
  existingMeta,
  existingPrices,
  mergedPrices,
  incomingPrices,
  userId,
  userName
) {
  const meta = normalizePriceMetaForClient(existingMeta);
  const normalizedExisting = require("./dailyPriceConfig").normalizePricesBody(
    existingPrices
  );
  const normalizedIncoming = require("./dailyPriceConfig").normalizePricesBody(
    incomingPrices
  );

  for (const methodId of METHOD_IDS) {
    if (
      !require("./dailyPriceConfig").hasAnyPriceInMethod(
        normalizedIncoming[methodId]
      )
    ) {
      continue;
    }
    meta[methodId] = updateMetaForMethodPrices(
      meta[methodId],
      normalizedExisting[methodId],
      mergedPrices[methodId],
      userId,
      userName
    );
  }

  return meta;
}

function isValidMethodId(id) {
  return METHOD_IDS.includes(id);
}

function isValidLocationId(id) {
  return LOCATION_IDS.includes(id);
}

module.exports = {
  emptyPriceMetaByMethod,
  normalizePriceMetaForClient,
  toClientPriceMeta,
  buildMetaForAllPrices,
  mergePriceMetaOnUpdate,
  updateMetaForMethodPrices,
  locationHasAnyPrice,
  isValidMethodId,
  isValidLocationId,
};
