const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  parseCsvTradeData,
  extractContactsFromText,
} = require("../src/services/discoveryService");
const {
  normalizeDomain,
  validateImporterProvenance,
} = require("../src/lib/importerProvenance");

describe("CSV Trade Data Parsing & Provenance", () => {
  test("parses valid CSV rows with provenance tags", () => {
    const csv = `companyName,contactPerson,phone,email,website,country,city,products,source_url
Rotterdam Spices BV,Jan de Vries,+31-10-555-1234,jan@rotterdamspices.nl,https://www.rotterdamspices.nl,Netherlands,Rotterdam,Turmeric Whole;Curcumin,https://portofrotterdam.com/manifest/1029
Hamburg Gewürze GmbH,Klaus Weber,+49-40-777-8899,weber@hamburg-gewuerze.de,https://hamburg-gewuerze.de,Germany,Hamburg,Salem Turmeric,`;

    const parsed = parseCsvTradeData(csv, "customs-manifest-2026.csv");
    assert.strictEqual(parsed.length, 2);

    // First row uses explicit source_url from CSV
    assert.strictEqual(parsed[0].companyName, "Rotterdam Spices BV");
    assert.strictEqual(parsed[0].country, "Netherlands");
    assert.strictEqual(parsed[0].website_domain, "rotterdamspices.nl");
    assert.strictEqual(
      parsed[0].source_url,
      "https://portofrotterdam.com/manifest/1029"
    );
    assert.strictEqual(parsed[0].source_type, "csv_upload");
    assert.ok(parsed[0].fetched_at);

    // Second row auto-generates deterministic provenance URL tag
    assert.strictEqual(parsed[1].companyName, "Hamburg Gewürze GmbH");
    assert.strictEqual(
      parsed[1].source_url,
      "csv://customs-manifest-2026.csv#row3"
    );
    assert.strictEqual(parsed[1].website_domain, "hamburg-gewuerze.de");

    // Both pass provenance validation
    assert.strictEqual(validateImporterProvenance(parsed[0]).valid, true);
    assert.strictEqual(validateImporterProvenance(parsed[1]).valid, true);
  });

  test("never pads missing CSV values; nameless rows are rejected by provenance", () => {
    const csv = `companyName,phone,email,country\n,+31-10-555-1234,jan@rotterdamspices.nl,`;
    const [row] = parseCsvTradeData(csv, "manifest.csv");
    assert.strictEqual(row.companyName, "");
    assert.strictEqual(row.country, "");
    assert.deepStrictEqual(row.products, []);
    const result = validateImporterProvenance(row);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(" "), /Importer or Company name is required/);
  });

  test("extracted record with no readable company name is rejected, not guessed", () => {
    const text = "Turmeric buyers. Email: buy@spicehouse.ae Tel: +971-4-226-5544";
    const [rec] = extractContactsFromText(text, "https://fair.example-expo.ae/list");
    assert.strictEqual(rec.companyName, "");
    assert.strictEqual(validateImporterProvenance(rec).valid, false);
  });

  test("skips malformed and empty CSV rows", () => {
    const emptyCsv = `companyName,phone,email\n\n,,,`;
    const parsed = parseCsvTradeData(emptyCsv);
    assert.strictEqual(parsed.length, 0);
  });
});

describe("Entity Extraction from Fetched Real Page Content", () => {
  test("extracts real emails, phones, and websites strictly from fetched text", () => {
    const samplePageText = `
      Gulfood 2026 Directory: Exhibitor Details
      Company: Al Baraka Foodstuff Trading LLC
      Leading bulk importer of Indian turmeric fingers, coriander, and black pepper.
      Office Location: Al Ras Spice Souk, Deira, Dubai, UAE.
      Telephone: +971-4-226-5544
      Direct Purchasing Email: procurement@albarakaspices.ae
      Website: https://www.albarakaspices.ae
    `;

    const extracted = extractContactsFromText(
      samplePageText,
      "https://www.gulfood.com/directory/al-baraka",
      { country: "United Arab Emirates", city: "Dubai" }
    );

    assert.strictEqual(extracted.length, 1);
    assert.strictEqual(extracted[0].importerNumber, "+971-4-226-5544");
    assert.strictEqual(extracted[0].email, "procurement@albarakaspices.ae");
    assert.strictEqual(extracted[0].website_domain, "albarakaspices.ae");
    assert.strictEqual(
      extracted[0].source_url,
      "https://www.gulfood.com/directory/al-baraka"
    );
    assert.strictEqual(extracted[0].country, "United Arab Emirates");
  });

  test("does not fabricate contacts if page text has no spice relevance or contacts", () => {
    const irrelevantText = `
      Privacy Policy and Terms of Use. All rights reserved.
      Cookie preferences can be updated anytime in your browser settings.
    `;
    const extracted = extractContactsFromText(
      irrelevantText,
      "https://randomsite.com/privacy"
    );
    assert.strictEqual(extracted.length, 0);
  });
});
