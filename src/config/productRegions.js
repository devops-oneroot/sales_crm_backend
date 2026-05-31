const AGGREGATOR_PRODUCTS = ["turmeric", "maize", "chilli", "tender_coconut"];

const PRODUCT_LABELS = {
  turmeric: "Turmeric",
  maize: "Maize",
  chilli: "Red Chilli",
  tender_coconut: "Tender Coconut",
};

/** product -> region (state) -> variety / origin names */
const PRODUCT_REGION_VARIETIES = {
  turmeric: {
    Karnataka: [
      "Chamarajanagar",
      "Kolegal",
      "Gundlupete",
      "Talavadi",
      "Kolar",
      "Gundlupet",
      "Mysore",
      "Hunsur",
    ],
    "Tamil Nadu": ["Attur", "Annur", "Erode", "Salem", "Namakkal", "Dharmapuri"],
    "Andhra Pradesh": ["Nizamabad", "Armoor", "Khammam"],
    Maharashtra: ["Sangli", "Nanded", "Kolhapur", "Satara"],
    Telangana: ["Nizamabad", "Karimnagar"],
    Kerala: ["Wayanad", "Idukki"],
  },
  maize: {
    Karnataka: [
      "Chamarajanagar",
      "Kolegal",
      "Gundlupete",
      "Talavadi",
      "Haveri",
      "Davangere",
      "Ballari",
      "Belagavi",
      "Raichur",
    ],
    Maharashtra: ["Sangli", "Nanded", "Nashik", "Jalgaon", "Ahmednagar", "Pune"],
    "Andhra Pradesh": ["Kurnool", "Anantapur", "Krishna", "Guntur"],
    "Tamil Nadu": ["Attur", "Annur", "Erode", "Salem", "Dindigul", "Coimbatore", "Tiruchirappalli"],
    Telangana: ["Medak", "Nizamabad", "Karimnagar"],
  },
  chilli: {
    Karnataka: [
      "Chamarajanagar",
      "Kolegal",
      "Gundlupete",
      "Talavadi",
      "Byadgi",
      "Hubballi",
      "Ballari",
      "Raichur",
    ],
    "Andhra Pradesh": ["Guntur", "Khammam", "Prakasam", "Krishna"],
    Telangana: ["Khammam", "Warangal", "Nalgonda"],
    Maharashtra: ["Sangli", "Nanded", "Solapur", "Nashik"],
    "Tamil Nadu": ["Attur", "Annur", "Erode", "Salem", "Ramnad", "Tuticorin"],
  },
  tender_coconut: {
    Karnataka: [
      "Chamarajanagar",
      "Kolegal",
      "Gundlupete",
      "Talavadi",
      "Tumakuru",
      "Hassan",
      "Ramanagara",
      "Mandya",
      "Chikkamagaluru",
    ],
    "Tamil Nadu": ["Attur", "Annur", "Coimbatore", "Tiruppur", "Erode", "Salem"],
    Kerala: ["Thrissur", "Ernakulam", "Kozhikode", "Palakkad"],
    "Andhra Pradesh": ["East Godavari", "West Godavari", "Krishna"],
    Maharashtra: ["Sangli", "Nanded", "Ratnagiri", "Sindhudurg", "Kolhapur"],
  },
};

function getProductOptions() {
  return AGGREGATOR_PRODUCTS.map((id) => ({
    id,
    label: PRODUCT_LABELS[id] || id,
  }));
}

function getRegionsForProduct(product) {
  const regions = PRODUCT_REGION_VARIETIES[product];
  if (!regions) return [];
  return Object.keys(regions).sort((a, b) => a.localeCompare(b));
}

function getVarietiesForProductRegion(product, region) {
  const regions = PRODUCT_REGION_VARIETIES[product];
  if (!regions || !region) return [];

  const target = String(region).trim().toLowerCase();
  const match = Object.entries(regions).find(
    ([name]) => name.toLowerCase() === target
  );

  if (!match) return [];
  return [...match[1]].sort((a, b) => a.localeCompare(b));
}

function isValidProduct(product) {
  return AGGREGATOR_PRODUCTS.includes(product);
}

function isValidStockSelection(product, region, varieties) {
  if (!isValidProduct(product)) return false;
  const allowedRegions = getRegionsForProduct(product);
  if (!allowedRegions.some((r) => r.toLowerCase() === region.toLowerCase())) {
    return false;
  }

  const allowedVarieties = getVarietiesForProductRegion(product, region);
  const allowedSet = new Set(allowedVarieties.map((v) => v.toLowerCase()));

  return (
    Array.isArray(varieties) &&
    varieties.length > 0 &&
    varieties.every((v) => allowedSet.has(String(v).toLowerCase()))
  );
}

module.exports = {
  AGGREGATOR_PRODUCTS,
  PRODUCT_LABELS,
  PRODUCT_REGION_VARIETIES,
  getProductOptions,
  getRegionsForProduct,
  getVarietiesForProductRegion,
  isValidProduct,
  isValidStockSelection,
};
