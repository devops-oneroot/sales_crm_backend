const { test, describe } = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");
const { parseTradeFile, parseExcelTradeData, isExcelBuffer } = require("../src/lib/discoveryParsers");
const { validateImporterProvenance } = require("../src/lib/importerProvenance");

function workbook(sheets, bookType = "xlsx") {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.write(wb, { type: "buffer", bookType });
}

describe("Excel import", () => {
  const buyers = [
    ["Company Name", "Contact Person", "Phone", "Email", "Website", "Country", "Products"],
    ["Rotterdam Spices, B.V.", "Jan de Vries", "+31 10 555 1234", "jan@rotterdamspices.nl", "www.rotterdamspices.nl", "Netherlands", "Turmeric; Ginger"],
    ['The "Spice" House', "", "", "", "", "USA", ""],
  ];

  test("detects .xlsx and .xls, not CSV text", () => {
    assert.strictEqual(isExcelBuffer(workbook({ Buyers: buyers })), true);
    assert.strictEqual(isExcelBuffer(workbook({ Buyers: buyers }, "biff8")), true);
    assert.strictEqual(isExcelBuffer(Buffer.from("Company,Country\nA,B")), false);
  });

  test(".xlsx rows parse with provenance pointing at sheet + row", () => {
    const rows = parseTradeFile(workbook({ Buyers: buyers }), "buyers.xlsx");
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.meta.sheet, "Buyers");
    assert.strictEqual(rows[0].companyName, "Rotterdam Spices, B.V.");
    assert.strictEqual(rows[0].website_domain, "rotterdamspices.nl");
    assert.deepStrictEqual(rows[0].products, ["Turmeric", "Ginger"]);
    assert.strictEqual(rows[0].source_url, "csv://buyers.xlsx#Buyers!row2");
    assert.strictEqual(rows[1].companyName, 'The "Spice" House');
    assert.strictEqual(rows[1].source_url, "csv://buyers.xlsx#Buyers!row3");
    for (const r of rows) {
      const v = validateImporterProvenance(r);
      assert.strictEqual(v.valid, true, v.errors.join("; "));
    }
  });

  test("legacy .xls (BIFF8) works too", () => {
    const rows = parseTradeFile(workbook({ Buyers: buyers }, "biff8"), "old.xls");
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].country, "Netherlands");
  });

  test("skips title rows above the table and picks the sheet that has buyer data", () => {
    const buf = workbook({
      Notes: [["Exported from trade portal"], ["Do not edit"]],
      Data: [["Turmeric importers 2026"], [], ["Importer", "Destination Country", "Telephone"], ["Gulf Spice Trading LLC", "United Arab Emirates", "+971 4 226 5544"]],
    });
    const rows = parseExcelTradeData(buf, "export.xlsx");
    assert.strictEqual(rows.meta.sheet, "Data");
    assert.strictEqual(rows.meta.headerRow, 3);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].companyName, "Gulf Spice Trading LLC");
    assert.strictEqual(rows[0].source_url, "csv://export.xlsx#Data!row4");
    assert.strictEqual(validateImporterProvenance(rows[0]).valid, true);
  });

  test("numeric phone cells keep their digits; date cells don't break parsing", () => {
    const buf = workbook({
      S: [
        ["Company", "Phone", "Last shipment", "Country"],
        ["Nordic Spice AB", 46812345678, new Date("2026-03-01T00:00:00Z"), "Sweden"],
      ],
    });
    const [row] = parseTradeFile(buf, "n.xlsx");
    assert.strictEqual(row.importerNumber, "46812345678");
    assert.strictEqual(row.country, "Sweden");
    assert.match(row.raw_extracted_text, /Last shipment: /);
    assert.strictEqual(validateImporterProvenance(row).valid, true);
  });

  test("empty workbook → no rows, no crash", () => {
    const rows = parseTradeFile(workbook({ Empty: [[]] }), "e.xlsx");
    assert.strictEqual(rows.length, 0);
  });

  test("CSV still goes through the CSV path", () => {
    const rows = parseTradeFile(Buffer.from("Company;Country\nHamburg Gewürze GmbH;Germany\n"), "x.csv");
    assert.strictEqual(rows.meta.delimiter, ";");
    assert.strictEqual(rows[0].companyName, "Hamburg Gewürze GmbH");
  });
});
