/**
 * States/provinces and cities for any country (export leads), from the
 * offline `country-state-city` dataset (GPL-3.0).
 */
const { Country, State, City } = require("country-state-city");

const norm = (v) =>
  String(v || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Names used in the CRM / other lists -> dataset names
const COUNTRY_ALIASES = {
  vietnam: "Vietnam",
  vietnam_: "Vietnam",
  usa: "United States",
  us: "United States",
  unitedstatesofamerica: "United States",
  uk: "United Kingdom",
  greatbritain: "United Kingdom",
  england: "United Kingdom",
  uae: "United Arab Emirates",
  russianfederation: "Russia",
  southkorea: "South Korea",
  republicofkorea: "South Korea",
  korearepublicof: "South Korea",
  iranislamicrepublicof: "Iran",
  turkiye: "Turkey",
  czechia: "Czech Republic",
  laopeoplesdemocraticrepublic: "Laos",
  bruneidarussalam: "Brunei",
  syrianarabrepublic: "Syria",
  tanzaniaunitedrepublicof: "Tanzania",
};

let byName = null;
function countryIndex() {
  if (!byName) {
    byName = new Map();
    for (const c of Country.getAllCountries()) {
      byName.set(norm(c.name), c);
      byName.set(norm(c.isoCode), c);
    }
    byName.set(norm("Viet Nam"), byName.get(norm("Vietnam")));
  }
  return byName;
}

/** Find the dataset country for a name or ISO code. */
function findCountry(name) {
  const idx = countryIndex();
  const key = norm(name);
  if (!key) return null;
  return idx.get(key) || (COUNTRY_ALIASES[key] && idx.get(norm(COUNTRY_ALIASES[key]))) || null;
}

/** States / provinces of a country, sorted by name. */
function getWorldStates(countryName) {
  const country = findCountry(countryName);
  if (!country) return [];
  return State.getStatesOfCountry(country.isoCode)
    .map((s) => ({ name: s.name, code: s.isoCode }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Cities of a state (by name or code), sorted and de-duplicated. */
function getWorldCities(countryName, stateName) {
  const country = findCountry(countryName);
  if (!country || !String(stateName || "").trim()) return [];
  const states = State.getStatesOfCountry(country.isoCode);
  const key = norm(stateName);
  const state = states.find((s) => norm(s.name) === key || norm(s.isoCode) === key);
  if (!state) return [];
  const names = City.getCitiesOfState(country.isoCode, state.isoCode).map((c) => c.name);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

module.exports = { findCountry, getWorldStates, getWorldCities };
