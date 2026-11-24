/**
 * Find contact details for every named buyer (consignee) in a customs export file.
 *
 *   node scripts/findBuyerContacts.js <input.xlsx> [--out <file.xlsx>] [--budget 50] [--limit N] [--concurrency 3]
 *
 * - One row per buyer company: spelling variants of the same name in the same country
 *   are merged ("LULU HYPER MARKET LLC" = "LULU HYPERMARKET L.L.C").
 * - Every named buyer appears in the output — with contacts, or with the reason none were found.
 * - Contacts written in the file itself (consignee address) are used first (free).
 * - Others are searched busiest-first with AI web search (Gemini + Google Search, or Claude —
 *   CONTACT_SEARCH_PROVIDER); an email/phone/website is kept
 *   only if the CRM finds it on the page the AI cited (see src/services/claudeContactSearch.js).
 * - Progress is saved continuously; rerun the same command to resume where it stopped.
 * - --budget (USD, default 50) stops the AI search when the estimated spend reaches it.
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), override: true, quiet: true });
const XLSX = require("xlsx");
const { searchContactsWithClaude, claudeSearchStatus } = require("../src/services/claudeContactSearch");
const { extractSiteContacts } = require("../src/services/buyerExtractor");

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const input = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
if (!input) {
  console.error("Usage: node scripts/findBuyerContacts.js <input.xlsx> [--out file.xlsx] [--budget 50] [--limit N] [--concurrency 3]");
  process.exit(1);
}
const inputPath = path.resolve(input);
const outPath = path.resolve(opt("out", inputPath.replace(/\.xlsx?$/i, "") + "_contacts.xlsx"));
const progressPath = outPath.replace(/\.xlsx$/i, ".progress.json");
const BUDGET = Number(opt("budget", "50"));
const LIMIT = Number(opt("limit", "0")) || Infinity;
const CONCURRENCY = Math.max(1, Math.min(6, Number(opt("concurrency", "3"))));

// Spend estimate (USD). Claude Opus 5.5: $4 / $20 per M tokens + $10 per 1,000 searches.
// Gemini: rough defaults — override with GEMINI_PRICE_IN / GEMINI_PRICE_OUT (per M tokens)
// and GEMINI_PRICE_SEARCH (per search query) to match your Google billing page.
const PRICE = {
  claude: { in: 4 / 1e6, out: 20 / 1e6, cacheRead: 0.2 / 1e6, search: 0.01 },
  gemini: {
    in: Number(process.env.GEMINI_PRICE_IN || 0.5) / 1e6,
    out: Number(process.env.GEMINI_PRICE_OUT || 3) / 1e6,
    search: Number(process.env.GEMINI_PRICE_SEARCH || 0.014),
  },
};
const costOf = (u = {}) => {
  if (u.provider === "gemini") {
    const p = PRICE.gemini;
    return (u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.search_queries || 0) * p.search;
  }
  const p = PRICE.claude;
  return (
    (u.input_tokens || 0) * p.in +
    (u.cache_creation_input_tokens || 0) * p.in * 1.25 +
    (u.cache_read_input_tokens || 0) * p.cacheRead +
    (u.output_tokens || 0) * p.out +
    (u.server_tool_use?.web_search_requests || 0) * p.search
  );
};

// ------------------------------------------------------------------ read & group buyers
const ANON = /^(to order|to the order.*|order|n\/?a|na|nil|none|-+|\.+|same as above|)$/i;
const SUFFIXES =
  /\b(l\s?l\s?c|llc|inc|incorporated|ltd|limited|co|company|corp|corporation|gmbh|b\s?v|bv|n\s?v|pte|pvt|private|sdn|bhd|fze|fzco|fz\s?llc|llp|plc|sarl|s\s?a\s?r\s?l|srl|spa|s\s?p\s?a|sa|ag|ab|as|oy|kg|est|establishment|wll|w\s?l\s?l|trading|general trading|the)\b/g;

function groupKey(name, country) {
  const base = String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, "");
  return `${base}|${String(country).toLowerCase().trim()}`;
}

function readBuyers(file) {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: "" });
  const col = (r, ...names) => {
    for (const n of names) if (r[n] !== undefined && String(r[n]).trim()) return String(r[n]).trim();
    return "";
  };
  const groups = new Map();
  let anonymous = 0;
  for (const r of rows) {
    let name = col(r, "CONSINEE_NAME", "CONSIGNEE_NAME", "CONSIGNEE", "BUYER", "IMPORTER");
    const country = col(r, "FOREIGN_COUNTRY", "COUNTRY", "DESTINATION_COUNTRY");
    let address = col(r, "CONSINEE_ADDRESS", "CONSIGNEE_ADDRESS", "ADDRESS");
    let viaNotify = false;
    if (ANON.test(name)) {
      // "TO ORDER" shipments sometimes name the real buyer as the notify party in the address.
      const m = address.match(/notify(?:\s*party)?\s*[:;.-]?\s*([^,\d]{3,80})/i);
      let notifyName = m ? m[1].replace(/\s+/g, " ").trim() : "";
      // Stop where the address starts, and right after a legal suffix (LTD, LLC, INC…).
      notifyName = notifyName.split(/\b(?:P\.?\s?O\.?\s?BOX|SHO\s?P\b|SHOP\b|UNIT\b|SUITE\b|STREET\b|ROAD\b|BLDG\b|BUILDING\b|FLOOR\b)/i)[0];
      const suffix = notifyName.match(/^(.*?\b(?:L\.?\s?L\.?\s?C|LTD|LIMITED|INC|CORP(?:ORATION)?|GMBH|B\.?V|DMCC|FZE|FZCO|PTY|PTE|SDN\.?\s?BHD|CO))\b\.?/i);
      if (suffix) notifyName = suffix[1];
      notifyName = notifyName.replace(/[\s.&-]+$/, "").trim();
      if (!notifyName || notifyName.length < 3 || ANON.test(notifyName) || /^(same|as per|consignee|party|to order)\b/i.test(notifyName)) {
        anonymous++;
        continue;
      }
      name = notifyName;
      address = address.replace(/^.*?notify(?:\s*party)?\s*[:;.-]?\s*/i, "");
      viaNotify = true;
    }
    const k = groupKey(name, country);
    if (!groups.has(k)) groups.set(k, { key: k, names: new Map(), country, shipments: 0, addresses: new Set(), ports: new Set(), exporters: new Set(), products: new Set(), viaNotify: false });
    const g = groups.get(k);
    if (viaNotify) g.viaNotify = true;
    g.names.set(name, (g.names.get(name) || 0) + 1);
    g.shipments++;
    if (address) g.addresses.add(address);
    const port = col(r, "FOREIGN_PORT");
    if (port) g.ports.add(port);
    const exp = col(r, "EXPORTER_NAME");
    if (exp) g.exporters.add(exp);
    const prod = col(r, "PRODUCT_DESCRIPITION", "PRODUCT_DESCRIPTION");
    if (prod && g.products.size < 3) g.products.add(prod.slice(0, 80));
  }
  const buyers = [...groups.values()].map((g) => {
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0]; // most common spelling
    const addresses = [...g.addresses];
    // Contacts written in the file itself (consignee address lines).
    const allText = addresses.join("\n");
    const fileEmails = [...new Set((allText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((e) => e.toLowerCase().replace(/\.$/, "")))];
    const filePhone = extractSiteContacts(allText.replace(/\b(TEL|PH|PHONE|MOB|MOBILE|CONTACT NO)\b\.?\s*[:.]?/gi, "Tel: "), "").phone;
    return {
      key: g.key,
      name,
      variants: [...g.names.keys()].filter((n) => n !== name),
      viaNotify: g.viaNotify,
      country: g.country,
      shipments: g.shipments,
      address: addresses[0] || "",
      ports: [...g.ports].slice(0, 3).join(", "),
      exporters: [...g.exporters].slice(0, 3).join("; "),
      products: [...g.products].join(" | "),
      fileEmail: extractSiteContacts(fileEmails.join("\n"), "").email || fileEmails[0] || "",
      filePhone,
    };
  });
  buyers.sort((a, b) => b.shipments - a.shipments || a.name.localeCompare(b.name));
  return { buyers, totalRows: rows.length, anonymous };
}

// ------------------------------------------------------------------ progress
function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(progressPath, "utf8"));
  } catch {
    return { results: {}, spentUsd: 0 };
  }
}
function saveProgress(p) {
  fs.writeFileSync(progressPath, JSON.stringify(p, null, 1));
}

// ------------------------------------------------------------------ output
function writeOutput(buyers, progress, meta) {
  const rows = buyers.map((b, i) => {
    const r = progress.results[b.key] || {};
    const email = b.fileEmail || r.email || "";
    const phone = b.filePhone || r.phone || "";
    return {
      "#": i + 1,
      "Buyer company": b.name,
      Country: b.country,
      Shipments: b.shipments,
      Email: email,
      Phone: phone,
      Website: r.website || "",
      "Email source": b.fileEmail ? "In the customs file (consignee address)" : r.emailUrl || "",
      "Phone source": b.filePhone ? "In the customs file (consignee address)" : r.phoneUrl || "",
      Status: email || phone ? "Contact found" : r.status || "Not searched yet",
      Notes: r.note || "",
      "Address in file": b.address,
      "Other spellings in file": b.variants.join(" | "),
      "Named as": b.viaNotify ? "Notify party (shipment was TO ORDER)" : "Consignee",
      "Destination ports": b.ports,
      "Indian exporters (suppliers)": b.exporters,
      "Sample products": b.products,
    };
  });
  const found = rows.filter((r) => r.Status === "Contact found").length;
  const summary = [
    { Item: "Input file", Value: path.basename(inputPath) },
    { Item: "Shipment rows in file", Value: meta.totalRows },
    { Item: "Rows with no buyer named at all (TO ORDER, no notify party)", Value: meta.anonymous },
    { Item: "Buyers found only as notify party on TO ORDER shipments", Value: buyers.filter((b) => b.viaNotify).length },
    { Item: "Named buyer companies (spelling variants merged)", Value: buyers.length },
    { Item: "Buyers with an email or phone", Value: found },
    { Item: "  · from the customs file itself", Value: buyers.filter((b) => b.fileEmail || b.filePhone).length },
    { Item: `  · from ${claudeSearchStatus().label || "AI web search"} (verified on the cited page)`, Value: rows.filter((r) => r.Status === "Contact found" && !r["Email source"].startsWith("In the customs") && !r["Phone source"].startsWith("In the customs")).length },
    { Item: "Searched, nothing verifiable published", Value: rows.filter((r) => r.Status === "Searched — nothing verifiable").length },
    { Item: "Not searched yet", Value: rows.filter((r) => r.Status === "Not searched yet" || r.Status.startsWith("Pending")).length },
    { Item: "Estimated AI search spend so far (USD)", Value: Math.round(progress.spentUsd * 100) / 100 },
    { Item: "Last updated", Value: new Date().toISOString() },
    { Item: "Rule", Value: "No contact is guessed. Every email/phone from the web was found on the page listed in its Source column." },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [5, 40, 18, 9, 34, 22, 34, 45, 45, 26, 50, 50, 40, 30, 25, 40, 50].map((w) => ({ wch: w }));
  ws["!autofilter"] = { ref: ws["!ref"] };
  XLSX.utils.book_append_sheet(wb, ws, "Buyers");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");
  const tmp = outPath + ".tmp.xlsx";
  XLSX.writeFile(wb, tmp);
  fs.renameSync(tmp, outPath);
  return { found };
}

// ------------------------------------------------------------------ main
(async () => {
  const meta = readBuyers(inputPath);
  const { buyers } = meta;
  const progress = loadProgress();
  console.log(`${meta.totalRows} rows · ${meta.anonymous} "TO ORDER" · ${buyers.length} named buyers (variants merged)`);

  const todo = buyers.filter((b) => !b.fileEmail && !progress.results[b.key]?.done).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const status = claudeSearchStatus();
  console.log(`From file: ${buyers.filter((b) => b.fileEmail || b.filePhone).length} buyers already have contacts · to search: ${todo.length} · search: ${status.label || status.provider} — ${status.available ? "available" : status.reason}`);

  writeOutput(buyers, progress, meta);
  if (!status.available) {
    for (const b of todo) progress.results[b.key] = { ...(progress.results[b.key] || {}), status: `Pending — ${status.label || "AI web search"} unavailable (${status.reason})` };
    saveProgress(progress);
    writeOutput(buyers, progress, meta);
    console.log(`${status.label || "AI web search"} not available (${status.reason}). Wrote ${outPath} with every buyer listed; rerun this command once it's available.`);
    return;
  }

  let i = 0;
  let stopped = "";
  let sinceSave = 0;
  const worker = async () => {
    while (i < todo.length && !stopped) {
      const b = todo[i++];
      if (progress.spentUsd >= BUDGET) {
        stopped = `budget of $${BUDGET} reached`;
        break;
      }
      const r = await searchContactsWithClaude({ companyName: b.name, country: b.country });
      if (!r.ok) {
        // Account-level problem (no credit, bad key, rate limit) → stop and keep the rest pending.
        progress.results[b.key] = { status: `Pending — ${r.note}` };
        if (!claudeSearchStatus().available) stopped = r.note;
        continue;
      }
      progress.spentUsd += costOf(r.usage);
      progress.results[b.key] = {
        done: true,
        email: r.email,
        phone: r.phone,
        website: r.website,
        emailUrl: r.emailUrl,
        phoneUrl: r.phoneUrl,
        status: r.email || r.phone ? "Contact found" : "Searched — nothing verifiable",
        note: r.note,
        searchedAt: new Date().toISOString(),
      };
      const n = Object.values(progress.results).filter((x) => x.done).length;
      process.stdout.write(`\r${n} searched · ~$${progress.spentUsd.toFixed(2)} · last: ${b.name.slice(0, 40)} → ${r.email || r.phone || "none"}            `);
      if (++sinceSave >= 5) {
        sinceSave = 0;
        saveProgress(progress);
        writeOutput(buyers, progress, meta);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const b of todo) if (!progress.results[b.key]) progress.results[b.key] = { status: `Pending — ${stopped || "not reached"}` };
  saveProgress(progress);
  const { found } = writeOutput(buyers, progress, meta);
  console.log(`\nDone${stopped ? ` (stopped: ${stopped})` : ""}. ${found}/${buyers.length} buyers have contacts. Output: ${outPath}`);
})().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
