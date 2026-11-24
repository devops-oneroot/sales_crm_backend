const { test, describe } = require("node:test");
const assert = require("node:assert");
const { parseRobots, robotsAllows, htmlToText, extractLinks } = require("../src/lib/webFetch");
const {
  keepIfPresent,
  classifyByRules,
  extractListingByRules,
  extractSiteContacts,
  nameFromSite,
  BUYER_TYPES,
} = require("../src/services/buyerExtractor");
const { msUntil } = require("../src/services/discoveryScheduler");

describe("robots.txt handling", () => {
  const rules = parseRobots(`
User-agent: AhrefsBot
Disallow: /

User-agent: *
Disallow: /checkout/
Disallow: /inquiries/send
Allow: /checkout/public
`);
  test("applies the * group, not other bots' groups", () => {
    assert.strictEqual(robotsAllows(rules, "/find?searchText=turmeric&_type=buyers"), true);
    assert.strictEqual(robotsAllows(rules, "/checkout/payment"), false);
    assert.strictEqual(robotsAllows(rules, "/inquiries/send"), false);
  });
  test("longest matching rule wins (Allow overrides broader Disallow)", () => {
    assert.strictEqual(robotsAllows(rules, "/checkout/public/x"), true);
  });
  test("empty Disallow allows everything", () => {
    assert.strictEqual(robotsAllows(parseRobots("User-agent: *\nDisallow:"), "/anything"), true);
  });
});

describe("LLM output is copy-only", () => {
  const page = "Members: Condimentum Ltd, Norwich NR9 5FG. Website: https://www.condimentum.co.uk/ Tel: +44 (1603) 555 123";
  test("keeps values that appear verbatim", () => {
    assert.strictEqual(keepIfPresent("Condimentum Ltd", page), "Condimentum Ltd");
    assert.strictEqual(keepIfPresent("https://condimentum.co.uk", page, "domain"), "https://condimentum.co.uk");
    assert.strictEqual(keepIfPresent("+44 1603 555-123", page, "phone"), "+44 1603 555-123");
  });
  test("drops values the model invented", () => {
    assert.strictEqual(keepIfPresent("sales@condimentum.co.uk", page), "");
    assert.strictEqual(keepIfPresent("Condimentum Foods Group", page), "");
    assert.strictEqual(keepIfPresent("https://condimentum.com", page, "domain"), "");
    assert.strictEqual(keepIfPresent("+44 1603 999 000", page, "phone"), "");
  });
});

describe("Rule-based listing extraction", () => {
  test("takes outbound company links, skipping own site, social and duplicates", () => {
    const html = `
      <a href="/about">About us</a>
      <a href="https://www.seasoningandspice.org.uk/join">Join</a>
      <a href="http://www.camstaringredients.co.uk/">http://www.camstaringredients.co.uk/</a>
      <a href="https://www.condimentum.co.uk/">Condimentum Ltd</a>
      <a href="https://condimentum.co.uk/contact">Contact</a>
      <a href="https://twitter.com/ssa">Twitter</a>`;
    const page = { finalUrl: "https://www.seasoningandspice.org.uk/members/", links: extractLinks(html, "https://www.seasoningandspice.org.uk/members/") };
    const out = extractListingByRules(page);
    assert.deepStrictEqual(out.map((c) => c.website), ["http://www.camstaringredients.co.uk/", "https://www.condimentum.co.uk/"]);
    assert.strictEqual(out[0].companyName, ""); // URL-as-text is not a name
    assert.strictEqual(out[1].companyName, "Condimentum Ltd");
    for (const c of out) assert.strictEqual(c.email + c.phone, ""); // nothing filled in
  });
});

describe("Rule-based buyer classification", () => {
  test("trade signals → buyer", () => {
    const r = classifyByRules("We are a leading importer and distributor of herbs and spices across Europe.");
    assert.ok(BUYER_TYPES.includes(r.buyer_type));
    assert.match(r.evidence, /importer/);
  });
  test("consumer shop without trade signals → not a buyer", () => {
    assert.strictEqual(classifyByRules("Turmeric latte mix. Add to cart. Free delivery on orders over £20").buyer_type, "retailer");
  });
  test("restaurant → not a buyer", () => {
    assert.strictEqual(classifyByRules("Authentic curry house. See our menu and book a table.").buyer_type, "restaurant_foodservice");
  });
  test("no signal → other (rejected), never assumed to be a buyer", () => {
    assert.strictEqual(classifyByRules("Welcome to our website.").buyer_type, "other");
  });
});

describe("Company site parsing", () => {
  test("prefers same-domain trade emails and ignores noreply", () => {
    const text = "Contact noreply@condimentum.co.uk or sales@condimentum.co.uk. Agency: hello@webagency.com Tel: +44 1603 555 123";
    const c = extractSiteContacts(text, "condimentum.co.uk");
    assert.strictEqual(c.email, "sales@condimentum.co.uk");
    assert.strictEqual(c.phone, "+44 1603 555 123");
  });
  test("recruitment / press / privacy addresses are never chosen", () => {
    const c = extractSiteContacts("Jobs: abwf-recruitment@abworldfoods.com Press: media@abworldfoods.com Privacy: dpo@abworldfoods.com", "abworldfoods.com");
    assert.strictEqual(c.email, "");
    const d = extractSiteContacts("abwf-recruitment@abworldfoods.com or customer.care@abworldfoods.com", "abworldfoods.com");
    assert.strictEqual(d.email, "customer.care@abworldfoods.com");
  });
  test("phone formats seen on real contact pages", () => {
    assert.strictEqual(extractSiteContacts("t: +44 (0) 1264 343 300 | info@x.com", "x.com").phone, "+44 (0) 1264 343 300");
    assert.strictEqual(extractSiteContacts("email us or call +1 (708) 371-0900.", "x.com").phone, "+1 (708) 371-0900");
    assert.strictEqual(extractSiteContacts("Milan office\n+39 039 51 69 601\nBrussels", "x.com").phone, "+39 039 51 69 601");
    assert.strictEqual(extractSiteContacts("Antwerp 0032 3 641 95 00", "x.com").phone, "0032 3 641 95 00");
  });
  test("dates, timestamps and order numbers are not phones", () => {
    assert.strictEqual(extractSiteContacts("Updated 2026-08-14T11:11:12+01:00 order 1234567890", "x.com").phone, "");
  });
  test("year ranges are not phone numbers", () => {
    assert.strictEqual(extractSiteContacts("Market forecast 2021-2036 report", "x.com").phone, "");
  });
  test("no contacts → empty, not placeholders", () => {
    assert.deepStrictEqual(extractSiteContacts("About our company", "x.com"), { email: "", phone: "" });
  });
  test("name from og:site_name or title, not generic titles", () => {
    assert.strictEqual(nameFromSite({ siteName: "Condimentum", title: "Home | Condimentum" }), "Condimentum");
    assert.strictEqual(nameFromSite({ siteName: "", title: "Jardox Ltd - Stocks and Concentrates" }), "Jardox Ltd");
    assert.strictEqual(nameFromSite({ siteName: "", title: "Home" }), "");
  });
  test("htmlToText keeps <title> text so names from it stay grounded", () => {
    assert.match(htmlToText("<html><head><title>Jardox Ltd</title></head><body><p>Hi</p></body></html>"), /Jardox Ltd/);
  });
});

describe("Daily schedule timing (UTC)", () => {
  test("later today", () => {
    assert.strictEqual(msUntil("05:00", new Date("2026-11-17T04:30:00Z")), 30 * 60 * 1000);
  });
  test("already passed → tomorrow", () => {
    assert.strictEqual(msUntil("05:00", new Date("2026-11-17T05:00:00Z")), 24 * 3600 * 1000);
  });
});
