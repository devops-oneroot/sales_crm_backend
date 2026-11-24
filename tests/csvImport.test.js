const { test, describe } = require("node:test");
const assert = require("node:assert");
const { parseCsvTradeData, detectDelimiter, decodeCsvBuffer } = require("../src/lib/discoveryParsers");
const { validateImporterProvenance } = require("../src/lib/importerProvenance");

const valid = (row) => validateImporterProvenance(row);

describe("CSV import — file formats", () => {
  test("Excel UTF-8 export: BOM, CRLF, quoted comma in name", () => {
    const csv = "﻿Company Name,Email,Country\r\n\"Rotterdam Spices, B.V.\",jan@rotterdamspices.nl,Netherlands\r\n";
    const [row] = parseCsvTradeData(csv, "x.csv");
    assert.strictEqual(row.companyName, "Rotterdam Spices, B.V.");
    assert.strictEqual(row.country, "Netherlands");
    assert.strictEqual(valid(row).valid, true, valid(row).errors.join("; "));
  });

  test("semicolon-separated (European Excel)", () => {
    const rows = parseCsvTradeData("Company;Email;Country\nHamburg Gewürze GmbH;weber@hamburg-gewuerze.de;Germany\n");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows.meta.delimiter, ";");
    assert.strictEqual(rows[0].companyName, "Hamburg Gewürze GmbH");
    assert.strictEqual(valid(rows[0]).valid, true);
  });

  test("tab-separated", () => {
    assert.strictEqual(detectDelimiter("Company\tEmail\tCountry\nA\tb@c.com\tX"), "\t");
    const [row] = parseCsvTradeData("Company\tCountry\nNordic Spice AB\tSweden\n");
    assert.strictEqual(row.country, "Sweden");
  });

  test("quoted line break inside a cell stays in that cell", () => {
    const rows = parseCsvTradeData('companyName,address,country\n"Acme Foods Ltd","Unit 4\nIndustrial Park",United Kingdom\nBeta Ltd,Main St,Ireland\n');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].companyName, "Acme Foods Ltd");
    assert.strictEqual(rows[0].address, "Unit 4\nIndustrial Park");
    assert.strictEqual(rows[1].companyName, "Beta Ltd");
    assert.strictEqual(rows[1].source_url, "csv://upload.csv#row4"); // real file line number
  });

  test('escaped quotes ("") are unescaped and still pass grounding', () => {
    const [row] = parseCsvTradeData('companyName,country\n"The ""Spice"" House",USA\n');
    assert.strictEqual(row.companyName, 'The "Spice" House');
    assert.strictEqual(valid(row).valid, true, valid(row).errors.join("; "));
  });

  test("Windows-1252 bytes (Excel 'CSV' on Windows) decode correctly", () => {
    const bytes = Buffer.from([...Buffer.from("Company,Country\nM"), 0xfc, ...Buffer.from("ller Gew"), 0xfc, ...Buffer.from("rze,Germany\n")]);
    assert.match(decodeCsvBuffer(bytes), /Müller Gewürze/);
    const [row] = parseCsvTradeData(bytes, "win.csv");
    assert.strictEqual(row.companyName, "Müller Gewürze");
  });
});

describe("File import — contact-detail filter", () => {
  const { fileRowRejection } = require("../src/services/discoveryService");
  const rows = parseCsvTradeData(
    [
      "Company,Email,Phone,Country",
      "Email Only Ltd,buy@emailonly.co.uk,,United Kingdom",
      "Phone Only GmbH,,+49 40 1234567,Germany",
      "Both BV,info@both.nl,+31 10 555 1234,Netherlands",
      "Nothing LLC,,,United Arab Emirates",
      "Bad Values Co,not-an-email,123,Kuwait",
      "Mumbai Traders,sales@mumbaitraders.in,,India",
    ].join("\n")
  );
  const verdict = Object.fromEntries(rows.map((r) => [r.companyName, fileRowRejection(r)]));

  test("rows with an email, a phone, or both are kept", () => {
    assert.strictEqual(verdict["Email Only Ltd"], "");
    assert.strictEqual(verdict["Phone Only GmbH"], "");
    assert.strictEqual(verdict["Both BV"], "");
  });
  test("rows with neither email nor phone are rejected", () => {
    assert.match(verdict["Nothing LLC"], /No contact details/);
  });
  test("malformed email and too-short phone don't count as contact details", () => {
    assert.match(verdict["Bad Values Co"], /No contact details.*not valid.*too short/);
  });
  test("domestic buyers are still rejected even with contacts", () => {
    assert.match(verdict["Mumbai Traders"], /Domestic buyer/);
  });
});

describe("CSV import — columns and provenance", () => {
  test("customs-style headers (Consignee, Destination Country, Telephone)", () => {
    const rows = parseCsvTradeData(
      "Consignee Name,Consignee Address,Destination Country,Telephone,Product Description,HS Code\nGulf Spice Trading LLC,Deira Dubai,United Arab Emirates,+971 4 226 5544,Dried turmeric fingers,091030\n"
    );
    assert.strictEqual(rows[0].companyName, "Gulf Spice Trading LLC");
    assert.strictEqual(rows[0].country, "United Arab Emirates");
    assert.strictEqual(rows[0].importerNumber, "+971 4 226 5544");
    assert.deepStrictEqual(rows[0].products, ["Dried turmeric fingers"]);
    assert.deepStrictEqual(rows.meta.unmatchedColumns, ["HS Code"]);
    assert.strictEqual(valid(rows[0]).valid, true, valid(rows[0]).errors.join("; "));
  });

  test("text in a 'source' column becomes the label, not the source_url", () => {
    const [row] = parseCsvTradeData("companyName,country,source\nDubai Spice LLC,UAE,Gulfood 2026 exhibitor list\n", "fair.csv");
    assert.strictEqual(row.source_url, "csv://fair.csv#row2");
    assert.match(row.discovery_source_name, /Gulfood 2026/);
    assert.strictEqual(valid(row).valid, true);
  });

  test("an http(s) 'source_url' column is used as the record's source_url", () => {
    const [row] = parseCsvTradeData("companyName,source_url\nX Foods Ltd,https://fair.example-expo.com/x\n");
    assert.strictEqual(row.source_url, "https://fair.example-expo.com/x");
    assert.strictEqual(valid(row).valid, true);
  });

  test("blank lines and blank rows are skipped; header-only file → no rows", () => {
    assert.strictEqual(parseCsvTradeData("companyName,country\n\n,,\n\n").length, 0);
    assert.strictEqual(parseCsvTradeData("companyName,country\n").length, 0);
    assert.strictEqual(parseCsvTradeData("").length, 0);
  });

  test("missing values stay empty — nothing is filled in", () => {
    const [row] = parseCsvTradeData("companyName,email,phone,country,products\nSolo Foods Ltd,,,,\n");
    assert.strictEqual(row.email + row.importerNumber + row.country, "");
    assert.deepStrictEqual(row.products, []);
  });
});
