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

// The external location service is optional: the built-in India directory is
// always the primary list. Never let a slow or hanging service block a form.
const MARKHET_TIMEOUT_MS = 4000;
const MARKHET_CACHE_MS = 30 * 60 * 1000; // good answers reused for 30 min
const MARKHET_DOWN_MS = 5 * 60 * 1000; // after a failure, skip it for 5 min
const markhetCache = new Map(); // url -> { at, list }
let markhetDownUntil = 0;

async function fetchMarkhetList(path, params = {}) {
  const url = new URL(`${MARKHET_API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, String(value).trim());
  }

  const key = url.toString();
  const cached = markhetCache.get(key);
  if (cached && Date.now() - cached.at < MARKHET_CACHE_MS) return cached.list;
  if (Date.now() < markhetDownUntil) {
    throw new Error("Location service unavailable (recent failure)");
  }

  let response;
  try {
    response = await fetch(key, { signal: AbortSignal.timeout(MARKHET_TIMEOUT_MS) });
  } catch (err) {
    markhetDownUntil = Date.now() + MARKHET_DOWN_MS;
    throw new Error(`Location service did not respond (${err.name})`);
  }
  if (!response.ok) {
    markhetDownUntil = Date.now() + MARKHET_DOWN_MS;
    throw new Error(`Location lookup failed (${response.status})`);
  }

  const payload = await response.json();
  const list = Array.isArray(payload.data) ? normalizeList(payload.data) : [];
  markhetCache.set(key, { at: Date.now(), list });
  return list;
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

// Renamed districts: India Post / new name -> also try these names.
const DISTRICT_ALIASES = {
  bengaluru: ["Bangalore Urban", "Bangalore"],
  bangalore: ["Bangalore Urban"],
  mysuru: ["Mysore"],
  belagavi: ["Belgaum"],
  kalaburagi: ["Gulbarga"],
  ballari: ["Bellary"],
  shivamogga: ["Shimoga"],
  tumkur: ["Tumakuru"],
  chikkamagaluru: ["Chikmagalur"],
  vijayapura: ["Bijapur"],
  bijapur: ["Vijayapura"],
  gurugram: ["Gurgaon"],
  prayagraj: ["Allahabad"],
};

/**
 * Match a district name (e.g. from India Post) to the spelling used in the
 * district dropdown, so selecting by pincode actually selects it.
 */
function resolveDistrictName(stateName, district) {
  const raw = String(district || "").trim();
  if (!raw) return raw;
  const list = getDistrictsFromDirectory(stateName);
  if (!list.length) return raw;
  const key = (v) => String(v).toLowerCase().replace(/[^a-z]/g, "");
  const byKey = new Map(list.map((d) => [key(d), d]));
  if (byKey.has(key(raw))) return byKey.get(key(raw));
  for (const alt of DISTRICT_ALIASES[key(raw)] || []) {
    if (byKey.has(key(alt))) return byKey.get(key(alt));
  }
  // "Bangalore" -> "Bangalore Urban", "Mumbai" -> "Mumbai City" (prefer the city/urban district)
  const starts = list.filter((d) => key(d).startsWith(key(raw)));
  if (starts.length) return starts.find((d) => /\b(city|urban)\b/i.test(d)) || starts[0];
  return raw;
}

/** India Post pincode API (free, widely used for official postal data). */
async function lookupByPincode(pincode) {
  const normalized = String(pincode || "").replace(/\D/g, "");
  if (normalized.length !== 6) {
    throw new Error("Enter a valid 6-digit pincode");
  }

  let response;
  try {
    response = await fetch(`https://api.postalpincode.in/pincode/${normalized}`, {
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new Error("Pincode service did not respond — enter state and district manually");
  }
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

  const resolvedState = resolveStateName(state) || state;
  return {
    pincode: normalized,
    state: resolvedState,
    district: resolveDistrictName(resolvedState, district),
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
