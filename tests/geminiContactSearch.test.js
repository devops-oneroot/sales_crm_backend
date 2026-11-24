/** Gemini + Google Search contact search — Google API and web pages stubbed. */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");

const PAGES = {
  "https://www.rajafoods.com/contact": `<html><body><h1>Raja Foods Houston LLC</h1><p>Email: orders@rajafoods.com</p><p>Phone: +1 713 555 0142 ext 2</p></body></html>`,
};
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";

let saved;
let geminiReply; // { status, body }
let geminiCalls;

before(() => {
  saved = { fetch: global.fetch, env: { ...process.env } };
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.CONTACT_SEARCH_PROVIDER = "gemini";
  delete process.env.CONTACT_SEARCH_LLM;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      geminiCalls.push(JSON.parse(opts.body));
      return new Response(JSON.stringify(geminiReply.body), { status: geminiReply.status, headers: { "content-type": "application/json" } });
    }
    if (u === REDIRECT) return new Response(null, { status: 302, headers: { location: "https://www.rajafoods.com/contact" } });
    if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
    const body = PAGES[u];
    return body
      ? new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      : new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  };
});
after(() => {
  global.fetch = saved.fetch;
  process.env = saved.env;
});
beforeEach(() => {
  geminiCalls = [];
  require("../src/services/claudeContactSearch").resetClaudeSearch();
});

const ok = (json, queries = ["raja foods houston contact"]) => ({
  status: 200,
  body: {
    candidates: [{ content: { parts: [{ text: "Found it.\n" + JSON.stringify(json) }] }, groundingMetadata: { webSearchQueries: queries, groundingChunks: [{ web: { uri: REDIRECT, title: "rajafoods.com" } }] } }],
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150 },
  },
});

describe("Gemini contact search", () => {
  const { searchContactsWithClaude, claudeSearchStatus } = require("../src/services/claudeContactSearch");

  test("uses Gemini with Google Search + URL reading when selected", () => {
    const s = claudeSearchStatus();
    assert.strictEqual(s.provider, "gemini");
    assert.strictEqual(s.available, true);
  });

  test("verified on the real page behind Google's redirect link", async () => {
    geminiReply = ok({ website: "https://www.rajafoods.com", contacts: [{ email: "orders@rajafoods.com", phone: "+1 713 555 0142", source_url: REDIRECT }] });
    const r = await searchContactsWithClaude({ companyName: "Raja Foods Houston LLC", country: "United States" });
    assert.deepStrictEqual(geminiCalls[0].tools, [{ google_search: {} }, { url_context: {} }]);
    assert.strictEqual(r.email, "orders@rajafoods.com");
    assert.strictEqual(r.emailUrl, "https://www.rajafoods.com/contact");
    assert.strictEqual(r.phone, "+1 713 555 0142");
    assert.match(r.note, /^Gemini web search: verified on https:\/\/www\.rajafoods\.com\/contact/);
    assert.strictEqual(r.usage.provider, "gemini");
    assert.strictEqual(r.usage.search_queries, 1);
  });

  test("an email Gemini invented is dropped", async () => {
    geminiReply = ok({ contacts: [{ email: "ceo@rajafoods.com", source_url: "https://www.rajafoods.com/contact" }] });
    const r = await searchContactsWithClaude({ companyName: "Raja Foods Houston LLC" });
    assert.strictEqual(r.email, "");
    assert.strictEqual(r.checked[0].why, "not on the cited page");
  });

  test("free-tier quota error stops the search with a clear reason", async () => {
    geminiReply = { status: 429, body: { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details." } } };
    const r = await searchContactsWithClaude({ companyName: "Raja Foods Houston LLC" });
    assert.strictEqual(r.ok, false);
    assert.match(r.note, /Gemini quota exceeded.*enable billing/);
    assert.strictEqual(claudeSearchStatus().available, false);
  });
});
