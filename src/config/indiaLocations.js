const { getAllStatesWithDistricts } = require("india-state-district");

const MARKHET_API_BASE =
  process.env.MARKHET_LOCATION_API_BASE?.trim() ||
  "https://markhet-internal-ngfs.onrender.com";

/** Map common names (pincode API, legacy data) to dataset state names. */
const STATE_ALIASES = {
  delhi: "New Delhi",
  "nct of delhi": "New Delhi",
  orissa: "Odisha",
  pondicherry: "Puducherry",
  "jammu & kashmir": "Jammu and Kashmir",
  "dadra and nagar haveli": "Dadra and Nagar Haveli and Daman and Diu",
  "daman and diu": "Dadra and Nagar Haveli and Daman and Diu",
};

let indiaDirectoryCache = null;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .trim();
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeList(items) {
  return [...new Set(items.map((item) => decodeHtml(item)).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
}

function loadIndiaDirectory() {
  if (indiaDirectoryCache) return indiaDirectoryCache;

  const rows = getAllStatesWithDistricts();
  const districtsByState = new Map();
  const canonicalNames = [];

  for (const row of rows) {
    const name = decodeHtml(row.name);
    if (!name) continue;
    canonicalNames.push(name);
    const districts = (row.districts || [])
      .map((d) => decodeHtml(d))
      .filter(Boolean);
    districtsByState.set(normalizeKey(name), normalizeList(districts));
  }

  const displayStates = normalizeList(canonicalNames);
  if (
    districtsByState.has(normalizeKey("New Delhi")) &&
    !displayStates.includes("Delhi")
  ) {
    displayStates.push("Delhi");
    districtsByState.set(
      normalizeKey("Delhi"),
      districtsByState.get(normalizeKey("New Delhi"))
    );
  }

  indiaDirectoryCache = {
    displayStates: displayStates.sort((a, b) => a.localeCompare(b)),
    districtsByState,
  };

  return indiaDirectoryCache;
}

function resolveStateName(stateName) {
  const raw = decodeHtml(stateName);
  if (!raw) return "";

  const key = normalizeKey(raw);
  const { districtsByState, displayStates } = loadIndiaDirectory();

  if (districtsByState.has(key)) {
    return displayStates.find((s) => normalizeKey(s) === key) || raw;
  }

  const alias = STATE_ALIASES[key];
  if (alias) return alias;

  if (key === "delhi") return "New Delhi";

  return raw;
}

function getDistrictsFromDirectory(stateName) {
  const resolved = resolveStateName(stateName);
  const { districtsByState } = loadIndiaDirectory();
  return districtsByState.get(normalizeKey(resolved)) || [];
}

function getStatesFromDirectory() {
  return loadIndiaDirectory().displayStates;
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
  const primary = getStatesFromDirectory();
  try {
    const extra = await fetchMarkhetList("/newlocations/states");
    return normalizeList([...primary, ...extra]);
  } catch {
    return primary;
  }
}

async function getDistricts(stateName) {
  if (!stateName?.trim()) return [];

  const primary = getDistrictsFromDirectory(stateName);
  try {
    const extra = await fetchMarkhetList("/newlocations/districts", {
      state: resolveStateName(stateName) || stateName,
    });
    return normalizeList([...primary, ...extra]);
  } catch {
    return primary;
  }
}

async function getTaluks(stateName, districtName) {
  if (!stateName?.trim() || !districtName?.trim()) return [];
  return fetchMarkhetList("/newlocations/taluks", {
    state: resolveStateName(stateName) || stateName,
    district: districtName,
  });
}

async function getVillages(stateName, districtName, talukName) {
  if (!stateName?.trim() || !districtName?.trim() || !talukName?.trim()) {
    return [];
  }
  return fetchMarkhetList("/newlocations/villages", {
    state: resolveStateName(stateName) || stateName,
    district: districtName,
    taluk: talukName,
  });
}

/** India Post pincode API (free, widely used for official postal data). */
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
  const state = decodeHtml(office.State);
  const district = decodeHtml(office.District);

  return {
    pincode: normalized,
    state: resolveStateName(state) || state,
    district,
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
