const MARKHET_API_BASE =
  process.env.MARKHET_LOCATION_API_BASE?.trim() ||
  "https://markhet-internal-ngfs.onrender.com";

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .trim();
}

function normalizeList(items) {
  return [...new Set(items.map((item) => decodeHtml(item)).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
}

async function fetchMarkhetList(path, params = {}) {
  const url = new URL(`${MARKHET_API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, String(value).trim());
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Location lookup failed (${response.status})`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.data)) {
    return [];
  }

  return normalizeList(payload.data);
}

async function getStates() {
  return fetchMarkhetList("/newlocations/states");
}

async function getDistricts(stateName) {
  if (!stateName?.trim()) return [];
  return fetchMarkhetList("/newlocations/districts", { state: stateName });
}

async function getTaluks(stateName, districtName) {
  if (!stateName?.trim() || !districtName?.trim()) return [];
  return fetchMarkhetList("/newlocations/taluks", {
    state: stateName,
    district: districtName,
  });
}

async function getVillages(stateName, districtName, talukName) {
  if (!stateName?.trim() || !districtName?.trim() || !talukName?.trim()) {
    return [];
  }
  return fetchMarkhetList("/newlocations/villages", {
    state: stateName,
    district: districtName,
    taluk: talukName,
  });
}

async function lookupByPincode(pincode) {
  const normalized = String(pincode || "").replace(/\D/g, "");
  if (normalized.length !== 6) {
    throw new Error("Enter a valid 6-digit pincode");
  }

  const response = await fetch(
    `https://api.postalpincode.in/pincode/${normalized}`
  );
  if (!response.ok) {
    throw new Error("Pincode lookup failed");
  }

  const payload = await response.json();
  if (payload[0]?.Status !== "Success" || !payload[0]?.PostOffice?.length) {
    throw new Error("Pincode not found");
  }

  const office = payload[0].PostOffice[0];
  return {
    pincode: normalized,
    state: decodeHtml(office.State),
    district: decodeHtml(office.District),
    taluk: decodeHtml(office.Block || office.Division || office.Region || ""),
    village: decodeHtml(office.Name || ""),
  };
}

module.exports = {
  getStates,
  getDistricts,
  getTaluks,
  getVillages,
  lookupByPincode,
};
