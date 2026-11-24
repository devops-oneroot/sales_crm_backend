/**
 * Schema-level provenance gate. These run Mongoose validation without a database,
 * proving the rules hold for every write path (routes, discovery, scripts), not just
 * callers that remember to call validateImporterProvenance().
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const Importer = require("../src/models/Importer");

const owner = {
  createdBy: new mongoose.Types.ObjectId(),
  responsiblePerson: "Test User",
};

const PAGE = "Company: Nedspice Processing  Email: info@nedspice.com  Web: www.nedspice.com";

function fetched(overrides = {}) {
  return new Importer({
    ...owner,
    importerName: "Nedspice Processing",
    companyName: "Nedspice Processing",
    email: "info@nedspice.com",
    website: "https://www.nedspice.com/contact",
    source_type: "trade_fair",
    source_url: "https://fair.example-expo.com/exhibitors/nedspice",
    fetched_at: new Date(Date.now() - 60_000),
    raw_extracted_text: PAGE,
    ...overrides,
  });
}

async function validationError(doc) {
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err;
  }
}

describe("Importer model provenance gate", () => {
  test("accepts a grounded fetched record and derives website_domain", async () => {
    const doc = fetched();
    assert.strictEqual(await validationError(doc), null);
    assert.strictEqual(doc.website_domain, "nedspice.com");
  });

  test("phone is optional (no placeholder needed)", async () => {
    const doc = fetched();
    assert.strictEqual(doc.importerNumber, "");
    assert.strictEqual(await validationError(doc), null);
  });

  test("rejects a record with no source_url", async () => {
    const err = await validationError(fetched({ source_url: undefined }));
    assert.ok(err);
    assert.ok(err.errors.source_url);
  });

  test("rejects a record with no fetched_at — it is NOT back-filled with now()", async () => {
    const doc = fetched({ fetched_at: undefined });
    const err = await validationError(doc);
    assert.ok(err);
    assert.ok(err.errors.fetched_at);
    assert.strictEqual(doc.fetched_at, undefined);
  });

  test("rejects a record with no source_type", async () => {
    const doc = fetched();
    doc.source_type = undefined;
    const err = await validationError(doc);
    assert.ok(err);
    assert.ok(err.errors.source_type || err.errors.source_url);
  });

  test("rejects a fetched record whose email was not in the fetched page", async () => {
    const err = await validationError(fetched({ email: "ceo@nedspice.com" }));
    assert.ok(err);
    assert.match(err.errors.source_url.message, /Provenance rejected: .*not found in fetched source text/);
  });

  test("rejects placeholder padding at the schema level", async () => {
    const err = await validationError(
      new Importer({
        ...owner,
        importerName: "Real Co",
        importerNumber: "+1-000-000-0000",
        source_type: "manual",
        source_url: "manual://user/1",
        fetched_at: new Date(),
      })
    );
    assert.ok(err);
    assert.match(err.errors.source_url.message, /placeholder/);
  });

  test("provenance fields are immutable once the record exists", () => {
    const doc = fetched();
    doc.isNew = false; // simulate a persisted document
    const original = doc.source_url;
    const originalFetchedAt = doc.fetched_at;
    doc.source_url = "https://somewhere-else.com";
    doc.fetched_at = new Date();
    doc.raw_extracted_text = "rewritten";
    assert.strictEqual(doc.source_url, original);
    assert.strictEqual(doc.fetched_at, originalFetchedAt);
    assert.strictEqual(doc.raw_extracted_text, PAGE);
  });

  test("declares a unique partial index on website_domain for dedupe", () => {
    const idx = Importer.schema
      .indexes()
      .find(([fields, opts]) => fields.website_domain === 1 && opts.unique);
    assert.ok(idx, "unique website_domain index missing");
    assert.deepStrictEqual(idx[1].partialFilterExpression, {
      website_domain: { $type: "string", $gt: "" },
    });
  });
});
