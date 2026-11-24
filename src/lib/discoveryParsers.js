/**
 * Deterministic parsers used by Discovery: CSV trade-data rows and a regex contact
 * extractor. Both only copy values present in their input; nothing is filled in.
 */
const { normalizeDomain } = require("./importerProvenance");

/**
 * Extracts contacts strictly from fetched text without fabricating information.
 */
function extractContactsFromText(text, fallbackSourceUrl, defaultLocation = {}) {
  const contacts = [];
  if (!text || typeof text !== "string") return contacts;

  // Regex patterns to discover real phone numbers, emails, websites in fetched text
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const emails = Array.from(new Set(text.match(emailRegex) || [])).filter(
    (e) => !e.endsWith(".png") && !e.endsWith(".jpg") && !e.includes("example.com")
  );

  // Digit runs with common separators; keep 8–15 digits (E.164 range).
  const phoneRegex = /\+?\(?\d[\d\s().-]{6,20}\d/g;
  const phones = Array.from(new Set((text.match(phoneRegex) || []).map((p) => p.trim()))).filter(
    (p) => {
      const n = p.replace(/\D/g, "").length;
      return n >= 8 && n <= 15;
    }
  );

  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s"']*)?)/g;
  const urls = Array.from(new Set(text.match(urlRegex) || [])).filter(
    (u) =>
      !u.includes("google.com") &&
      !u.includes("schema.org") &&
      !u.includes("w3.org") &&
      !u.includes("cloudflare.com")
  );

  // If text contains turmeric or spice keyword, construct extracted entity
  const isSpiceRelevant =
    /turmeric|curcumin|spice|seasoning|botanical|herbal|condiment|ginger/i.test(
      text
    );

  if (isSpiceRelevant && (emails.length > 0 || phones.length > 0 || urls.length > 0)) {
    const rawWebsite = urls[0] ? (urls[0].startsWith("http") ? urls[0] : `https://${urls[0]}`) : "";
    const domain = normalizeDomain(rawWebsite);
    // Company name must be read from the text. No match → empty name, and the
    // record is rejected at ingest (visible in the run log) rather than guessed.
    const companyTitleMatch = text.match(/(?:Company|Exhibitor|Name):\s*([A-Za-z0-9 &.,'()-]{3,80}?)(?=\s{2,}|\r?\n|$)/im);
    const companyName = companyTitleMatch ? companyTitleMatch[1].trim() : "";

    contacts.push({
      companyName,
      importerName: companyName,
      contactPerson: "",
      importerNumber: phones[0] || "",
      email: emails[0] || "",
      website: rawWebsite,
      website_domain: domain,
      country: defaultLocation.country || "",
      city: defaultLocation.city || "",
      products: [],
      source_url: fallbackSourceUrl,
      source_type: "trade_fair",
      fetched_at: new Date(),
      // Keep the full fetched text: it is the evidence the grounding rule checks.
      raw_extracted_text: text.slice(0, 50000),
    });
  }

  return contacts;
}

// ------------------------------------------------------------------ CSV trade data

/**
 * Decode an uploaded file: UTF-8 (BOM stripped), falling back to Windows-1252 when the
 * bytes are not valid UTF-8 (typical of "CSV" saved from Excel on Windows).
 */
function decodeCsvBuffer(buffer) {
  if (typeof buffer === "string") return buffer.replace(/^﻿/, "");
  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buffer);
  return text.replace(/^﻿/, "");
}

/** Pick the delimiter (comma, semicolon, tab or pipe) used most in the header line. */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let count = 0;
    let inQuotes = false;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 CSV parser: quoted fields may contain delimiters, line breaks and "" escapes.
 * Returns [{ cells: string[], raw: string, line: number }] with the exact source text.
 */
function parseCsvRecords(text, delimiter) {
  const records = [];
  let cells = [];
  let field = "";
  let inQuotes = false;
  let start = 0;
  let line = 1;
  let recordLine = 1;
  const push = (end) => {
    cells.push(field);
    const raw = text.slice(start, end);
    if (cells.some((c) => c.trim() !== "")) records.push({ cells, raw, line: recordLine });
    cells = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"' && field.trim() === "") {
      field = "";
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      push(i);
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      start = i + 1;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== "" || cells.length) push(text.length);
  return records;
}

const normHeader = (h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/** Accepted header names per field (after lower-casing and removing spaces/punctuation). */
const CSV_COLUMNS = {
  companyName: ["companyname", "company", "importername", "importer", "buyername", "buyer", "consigneename", "consignee", "organisation", "organization", "name", "firmname"],
  contactPerson: ["contactperson", "contactname", "contact", "person", "representative", "keycontact"],
  importerNumber: ["phone", "phonenumber", "importernumber", "tel", "telephone", "telno", "mobile", "mobileno", "contactno", "contactnumber", "whatsapp"],
  email: ["email", "emailaddress", "emailid", "mail"],
  website: ["website", "web", "websiteurl", "site", "domain", "companywebsite", "url"],
  country: ["country", "importercountry", "buyercountry", "consigneecountry", "destinationcountry", "nation"],
  city: ["city", "town", "importercity", "consigneecity", "port", "portofdischarge"],
  address: ["address", "importeraddress", "consigneeaddress", "buyeraddress", "fulladdress"],
  products: ["products", "product", "productdescription", "goods", "items", "commodity"],
  sourceUrl: ["sourceurl", "sourcelink", "source", "provenance", "origin", "reference", "link"],
};

function buildColumnIndex(header) {
  const norm = header.map(normHeader);
  const index = {};
  const used = new Set();
  // Exact alias matches first, in priority order per field.
  for (const [field, aliases] of Object.entries(CSV_COLUMNS)) {
    for (const alias of aliases) {
      const i = norm.indexOf(alias);
      if (i !== -1 && !used.has(i)) {
        index[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return { index, unmatched: header.filter((_, i) => !used.has(i)).map((h) => h.trim()).filter(Boolean) };
}

/**
 * Parse CSV trade data into importer candidates.
 * Values are copied as-is; missing values stay empty (no defaults, no guesses).
 * source_url is the row's own http(s) link if it has one, otherwise csv://file#rowN.
 * A non-URL "source" value (e.g. "Gulfood 2026") is kept as the source label.
 * Returns an array of candidates; `.meta` carries delimiter / column mapping info.
 */
function parseCsvTradeData(csvContent, filename = "upload.csv", { rowRef = (line) => `row${line}`, label = `File: ${filename}` } = {}) {
  const rows = [];
  rows.meta = { delimiter: ",", columns: {}, unmatchedColumns: [], records: 0 };
  if (csvContent == null) return rows;
  const text = decodeCsvBuffer(csvContent);
  if (!text.trim()) return rows;

  const delimiter = detectDelimiter(text);
  const records = parseCsvRecords(text, delimiter);
  if (records.length < 2) return rows;

  const header = records[0].cells;
  const { index, unmatched } = buildColumnIndex(header);
  rows.meta = {
    delimiter: delimiter === "\t" ? "tab" : delimiter,
    columns: Object.fromEntries(Object.entries(index).map(([k, i]) => [k, header[i].trim()])),
    unmatchedColumns: unmatched,
    records: records.length - 1,
  };
  const safeName = encodeURIComponent(String(filename).replace(/[\/]/g, "_"));

  for (const rec of records.slice(1)) {
    const get = (field) => (index[field] !== undefined ? String(rec.cells[index[field]] ?? "").trim() : "");
    const companyName = get("companyName");
    const sourceValue = get("sourceUrl");
    const sourceIsUrl = /^https?:\/\/\S+$/i.test(sourceValue);
    const website = get("website");
    const products = get("products")
      .split(/[;|]/)
      .map((p) => p.trim())
      .filter(Boolean);

    // Evidence: the exact record text from the file, plus the decoded cell values
    // (quotes/escapes removed) under their headers, so grounding checks the real values.
    const decoded = header.map((h, i) => `${h.trim()}: ${String(rec.cells[i] ?? "").trim()}`).join("\n");

    rows.push({
      importerName: companyName,
      companyName,
      contactPerson: get("contactPerson"),
      importerNumber: get("importerNumber"),
      email: get("email").toLowerCase(),
      website,
      website_domain: normalizeDomain(website),
      country: get("country"),
      city: get("city"),
      address: get("address"),
      products,
      discovery_source_name: sourceValue && !sourceIsUrl ? `CSV ${filename}: ${sourceValue}` : `CSV ${filename}`,
      source_url: sourceIsUrl ? sourceValue : `csv://${safeName}#${rowRef(rec.line)}`,
      source_type: "csv_upload",
      fetched_at: new Date(),
      raw_extracted_text: `[${label}, ${rowRef(rec.line)}]\n${rec.raw}\n[Parsed]\n${decoded}`,
    });
  }
  return rows;
}

// ------------------------------------------------------------------ Excel (.xlsx / .xls)

const XLSX = require("xlsx");

/** True for .xlsx (zip) or legacy .xls (OLE2) content. */
function isExcelBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  return zip || ole;
}

const COMPANY_ALIASES = new Set(CSV_COLUMNS.companyName);

function toCsvLine(cells) {
  return cells
    .map((v) => {
      const s = String(v ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/**
 * Read an Excel workbook. Picks the first sheet whose header row (within the first 20
 * rows) has a company-name column, so title rows above the table are skipped.
 * Cell values are taken as displayed in Excel (formatted text), so phone numbers and
 * IDs keep their formatting. Returns the same shape as parseCsvTradeData, with
 * source_url = csv://file.xlsx#Sheet!rowN pointing at the real spreadsheet row.
 */
function parseExcelTradeData(buffer, filename = "upload.xlsx") {
  const wb = XLSX.read(buffer, { type: "buffer", cellFormula: false, cellHTML: false, cellDates: true });
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: true }),
  }));

  let chosen = null;
  for (const s of sheets) {
    const headerIdx = s.rows.slice(0, 20).findIndex((r) => r.some((c) => COMPANY_ALIASES.has(normHeader(c))));
    if (headerIdx !== -1) {
      chosen = { ...s, headerIdx };
      break;
    }
  }
  if (!chosen) {
    const first = sheets.find((s) => s.rows.some((r) => r.some((c) => String(c).trim()))) || sheets[0];
    if (!first) {
      const empty = [];
      empty.meta = { delimiter: "excel", columns: {}, unmatchedColumns: [], records: 0, sheet: "", sheets: wb.SheetNames };
      return empty;
    }
    const headerIdx = Math.max(0, first.rows.findIndex((r) => r.some((c) => String(c).trim())));
    chosen = { ...first, headerIdx };
  }

  // Spreadsheet row number (1-based) for each CSV line we generate.
  const table = chosen.rows.slice(chosen.headerIdx);
  const sheetRowOf = (csvLine) => chosen.headerIdx + csvLine; // csv line 1 = header row
  const csv = table.map(toCsvLine).join("\n");
  const sheetRef = chosen.name.replace(/[^\w.-]+/g, "_");
  const rows = parseCsvTradeData(csv, filename, {
    rowRef: (line) => `${sheetRef}!row${sheetRowOf(line)}`,
    label: `File: ${filename}, sheet "${chosen.name}"`,
  });
  rows.meta = { ...rows.meta, delimiter: "excel", sheet: chosen.name, sheets: wb.SheetNames, headerRow: chosen.headerIdx + 1 };
  return rows;
}

/** Entry point for uploads: Excel workbooks or CSV/TSV text. */
function parseTradeFile(buffer, filename = "upload") {
  return isExcelBuffer(buffer) ? parseExcelTradeData(buffer, filename) : parseCsvTradeData(buffer, filename);
}

module.exports = {
  parseCsvTradeData,
  parseExcelTradeData,
  parseTradeFile,
  isExcelBuffer,
  extractContactsFromText,
  decodeCsvBuffer,
  detectDelimiter,
  parseCsvRecords,
};
