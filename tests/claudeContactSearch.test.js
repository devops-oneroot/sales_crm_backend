/**
 * Claude contact search: Claude's answers are only kept if the CRM finds them on the
 * cited page itself. Claude and the web are both stubbed — no credit, no network.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");

const PAGES = {
  "https://www.gulfspice.ae/contact": `<html><body><h1>Gulf Spice Trading LLC</h1><p>Purchasing: buying@gulfspice.ae</p><p>Tel: +971 4 226 5544</p></body></html>`,
  "https://directory.example-expo.com/gulf-spice": `<html><body>Gulf Spice Trading LLC — Dubai. Contact info@gulfspice.ae</body></html>`,
  "https://www.other-company.com/about": `<html><body>Totally Different Foods Ltd. sales@other-company.com</body></html>`,
};

let saved;
let claudeAnswer;
let calls;

before(() => {
  saved = { fetch: global.fetch, key: process.env.ANTHROPIC_API_KEY, flag: process.env.CONTACT_SEARCH_LLM };
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CONTACT_SEARCH_LLM;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const body = PAGES[u];
    return body
      ? new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      : new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  };
  const { _setClientForTests } = require("../src/services/claudeContactSearch");
  _setClientForTests({
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify({ contacts: claudeAnswer }) }] };
        },
      },
    },
  });
});
after(() => {
  global.fetch = saved.fetch;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.flag !== undefined) process.env.CONTACT_SEARCH_LLM = saved.flag;
});
beforeEach(() => {
  calls = [];
  require("../src/services/claudeContactSearch").resetClaudeSearch();
});

describe("Claude contact search — verification of Claude's answer", () => {
  const { searchContactsWithClaude } = require("../src/services/claudeContactSearch");

  test("keeps values that are really on the cited page; prefers the purchasing address", async () => {
    claudeAnswer = [
      { email: "info@gulfspice.ae", phone: "", source_url: "https://directory.example-expo.com/gulf-spice" },
      { email: "buying@gulfspice.ae", phone: "+971 4 226 5544", source_url: "https://www.gulfspice.ae/contact" },
    ];
    const r = await searchContactsWithClaude({ companyName: "Gulf Spice Trading LLC", country: "United Arab Emirates", website: "https://www.gulfspice.ae" });
    assert.strictEqual(r.email, "buying@gulfspice.ae");
    assert.strictEqual(r.emailUrl, "https://www.gulfspice.ae/contact");
    assert.strictEqual(r.phone, "+971 4 226 5544");
    assert.match(r.evidence.join(" "), /verified on https:\/\/www\.gulfspice\.ae\/contact.*buying@gulfspice\.ae/);
    // Uses web search + fetch tools.
    assert.deepStrictEqual(calls[0].tools.map((t) => t.type), ["web_search_20260209", "web_fetch_20260209"]);
  });

  test("an email Claude made up (not on the cited page) is dropped", async () => {
    claudeAnswer = [{ email: "ceo@gulfspice.ae", phone: "", source_url: "https://www.gulfspice.ae/contact" }];
    const r = await searchContactsWithClaude({ companyName: "Gulf Spice Trading LLC", website: "gulfspice.ae" });
    assert.strictEqual(r.email, "");
    assert.match(r.note, /nothing verifiable.*1 value/);
    assert.strictEqual(r.checked[0].why, "not on the cited page");
  });

  test("a page about a different company is rejected even if the email is on it", async () => {
    claudeAnswer = [{ email: "sales@other-company.com", phone: "", source_url: "https://www.other-company.com/about" }];
    const r = await searchContactsWithClaude({ companyName: "Gulf Spice Trading LLC", website: "gulfspice.ae" });
    assert.strictEqual(r.email, "");
    assert.strictEqual(r.checked[0].why, "cited page doesn't mention the company");
  });

  test("no source URL or unreachable page → dropped", async () => {
    claudeAnswer = [
      { email: "info@gulfspice.ae", source_url: "" },
      { email: "info@gulfspice.ae", source_url: "https://www.gulfspice.ae/missing-page" },
    ];
    const r = await searchContactsWithClaude({ companyName: "Gulf Spice Trading LLC" });
    assert.strictEqual(r.email, "");
    assert.deepStrictEqual(r.checked.map((c) => c.why.split(" (")[0]), ["no source page given", "source page not reachable"]);
  });

  test("Claude finds nothing → empty, never a guessed address", async () => {
    claudeAnswer = [];
    const r = await searchContactsWithClaude({ companyName: "Quiet Foods Ltd", website: "quietfoods.co.uk" });
    assert.deepStrictEqual([r.email, r.phone], ["", ""]);
  });

  test("switched off with CONTACT_SEARCH_LLM=off", async () => {
    process.env.CONTACT_SEARCH_LLM = "off";
    try {
      const r = await searchContactsWithClaude({ companyName: "Gulf Spice Trading LLC" });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(calls.length, 0);
    } finally {
      delete process.env.CONTACT_SEARCH_LLM;
    }
  });
});

describe("Excel/CSV row without a website → Claude search → passes provenance", () => {
  test("found email is backed by the stored page excerpt", async () => {
    const { enrichRowFromWebsite } = require("../src/services/discoveryService");
    const { parseCsvTradeData } = require("../src/lib/discoveryParsers");
    const { validateImporterProvenance } = require("../src/lib/importerProvenance");
    claudeAnswer = [{ email: "buying@gulfspice.ae", phone: "+971 4 226 5544", source_url: "https://www.gulfspice.ae/contact" }];
    const [row] = parseCsvTradeData("Company,Country\nGulf Spice Trading LLC,United Arab Emirates\n", "buyers.csv");
    const { row: out, note } = await enrichRowFromWebsite(row);
    assert.strictEqual(out.email, "buying@gulfspice.ae");
    assert.strictEqual(out.contact_source_url, "https://www.gulfspice.ae/contact");
    assert.match(note, /Claude web search: verified/);
    const v = validateImporterProvenance(out);
    assert.strictEqual(v.valid, true, v.errors.join("; "));
  });
});
