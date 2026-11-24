const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const { extractContactLinks, deobfuscateEmails } = require("../src/lib/webFetch");

// ---- fake company websites (no network) ----
const SITES = {
  "https://www.nordicspice.se/": `<html><head><title>Nordic Spice AB | Importers of herbs and spices</title></head>
    <body><p>We import spices from 30 origins.</p>
    <a href="/kontakt">Kontakt</a> <a href="/about">About us</a>
    <a href="mailto:inkop@nordicspice.se">Email our buyers</a></body></html>`,
  "https://www.nordicspice.se/kontakt": `<html><body><h1>Kontakt</h1>
    <p>Telefon / Phone: +46 8 123 456 78</p><p>Sales: sales [at] nordicspice [dot] se</p></body></html>`,
  "https://www.nordicspice.se/about": `<html><body>About Nordic Spice</body></html>`,
  "https://www.pepperco.co.uk/": `<html><head><title>Pepper Co</title></head><body>Spice processors. <a href="/contact-us">Contact Us</a></body></html>`,
  "https://www.pepperco.co.uk/contact-us": `<html><head><script type="application/ld+json">{"@type":"Organization","email":"sales@pepperco.co.uk"}</script></head>
    <body><h1>Contact us</h1><form><label>Telephone Number *</label><input name="phone"></form>
    <p>Call <a href="tel:+441604766461">+44 (0) 1604 766461</a></p></body></html>`,
  "https://www.quietfoods.co.uk/":`<html><head><title>Quiet Foods</title></head><body>Distributor of ingredients. No contact info here.</body></html>`,
};

let realFetch;
before(() => {
  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const body = SITES[u] ?? SITES[u + "/"];
    if (!body) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
});
after(() => {
  global.fetch = realFetch;
});

describe("Contacts hidden from the visible text", () => {
  const { extractHiddenContacts, decodeCfEmail } = require("../src/lib/webFetch");
  // Cloudflare scheme: key byte, then each char XOR key, hex-encoded.
  const cf = (email, key = 0x5a) =>
    key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");

  test("schema.org JSON-LD email/telephone (as on britishpepper.co.uk)", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization",
      "address":{"addressRegion":"Northampton"},"email":"sales@britishpepper.co.uk",
      "contactPoint":[{"@type":"ContactPoint","telephone":"+44 1604 766461"}]}</script>`;
    const r = extractHiddenContacts(html);
    assert.deepStrictEqual(r.emails, ["sales@britishpepper.co.uk"]);
    assert.deepStrictEqual(r.phones, ["+44 1604 766461"]);
  });

  test("Cloudflare-protected emails are decoded", () => {
    assert.strictEqual(decodeCfEmail(cf("info@spicehouse.ae")), "info@spicehouse.ae");
    const html = `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cf("import@spicehouse.ae", 0x21)}">[email&#160;protected]</a>
      <a href="/cdn-cgi/l/email-protection#${cf("sales@spicehouse.ae", 0x33)}">Email</a>`;
    assert.deepStrictEqual(extractHiddenContacts(html).emails.sort(), ["import@spicehouse.ae", "sales@spicehouse.ae"]);
  });

  test("malformed JSON-LD and junk don't produce values", () => {
    const r = extractHiddenContacts(`<script type="application/ld+json">{not json</script><script>var v="axios@0.21.4"</script>`);
    assert.deepStrictEqual(r, { emails: [], phones: [] });
  });
});

describe("Contact extraction helpers", () => {
  test("reads mailto:/tel: links", () => {
    const c = extractContactLinks('<a href="mailto:Info@Firm.com?subject=hi">Email</a><a href="tel:+44%201603%20555123">Call</a><a href="mailto:bad">x</a>');
    assert.deepStrictEqual(c.emails, ["info@firm.com"]);
    assert.deepStrictEqual(c.phones, ["+44 1603 555123"]);
  });
  test("decodes [at]/[dot] addresses but leaves plain prose alone", () => {
    assert.match(deobfuscateEmails("Write to sales [at] firm [dot] com today"), /sales@firm\.com/);
    assert.strictEqual(deobfuscateEmails("Meet us at the fair"), "Meet us at the fair");
  });
});

describe("findContactsOnWebsite", () => {
  const { findContactsOnWebsite } = require("../src/services/contactFinder");

  test("finds the mailto email on the homepage and the phone on the contact page", async () => {
    const r = await findContactsOnWebsite("nordicspice.se");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.email, "inkop@nordicspice.se");
    assert.strictEqual(r.emailUrl.replace(/\/$/, ""), "https://www.nordicspice.se");
    assert.strictEqual(r.phone, "+46 8 123 456 78");
    assert.strictEqual(r.phoneUrl, "https://www.nordicspice.se/kontakt");
  });

  test("contact page with email only in structured data + phone in tel: link", async () => {
    const r = await findContactsOnWebsite("https://www.pepperco.co.uk/");
    assert.strictEqual(r.email, "sales@pepperco.co.uk");
    assert.match(r.emailUrl, /contact-us$/);
    assert.strictEqual(r.phone, "+44 (0) 1604 766461"); // as displayed on the page
  });

  test("site that publishes nothing → empty, never guessed (no info@domain)", async () => {
    const r = await findContactsOnWebsite("https://www.quietfoods.co.uk/");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.email, "");
    assert.strictEqual(r.phone, "");
  });

  test("unreachable site → ok:false", async () => {
    const r = await findContactsOnWebsite("https://www.does-not-exist.example/");
    assert.strictEqual(r.ok, false);
  });
});

describe("Excel/CSV rows: contacts from the company website", () => {
  const { enrichRowFromWebsite, fileRowRejection } = require("../src/services/discoveryService");
  const { parseCsvTradeData } = require("../src/lib/discoveryParsers");
  const { validateImporterProvenance } = require("../src/lib/importerProvenance");

  test("row with only a website gets email + phone from the site and passes provenance", async () => {
    const [row] = parseCsvTradeData("Company,Website,Country\nNordic Spice AB,www.nordicspice.se,Sweden\n", "list.xlsx");
    assert.match(fileRowRejection(row), /No contact details/);
    const { row: out, note } = await enrichRowFromWebsite(row);
    assert.strictEqual(out.email, "inkop@nordicspice.se");
    assert.strictEqual(out.importerNumber, "+46 8 123 456 78");
    assert.strictEqual(out.contact_source_url.replace(/\/$/, ""), "https://www.nordicspice.se");
    assert.match(note, /email \+ phone found on/);
    assert.strictEqual(fileRowRejection(out), "");
    const v = validateImporterProvenance(out);
    assert.strictEqual(v.valid, true, v.errors.join("; "));
  });

  test("existing values are never replaced", async () => {
    const [row] = parseCsvTradeData("Company,Website,Email,Country\nNordic Spice AB,www.nordicspice.se,ceo@nordicspice.se,Sweden\n");
    const { row: out } = await enrichRowFromWebsite(row);
    assert.strictEqual(out.email, "ceo@nordicspice.se");
    assert.strictEqual(out.importerNumber, "+46 8 123 456 78");
  });

  test("site without contacts → row unchanged and still rejected", async () => {
    const [row] = parseCsvTradeData("Company,Website,Country\nQuiet Foods,https://www.quietfoods.co.uk/,United Kingdom\n");
    const { row: out, note } = await enrichRowFromWebsite(row);
    assert.strictEqual(out, row);
    assert.match(note, /no email\/phone published/);
    assert.match(fileRowRejection(out), /No contact details/);
  });
});
