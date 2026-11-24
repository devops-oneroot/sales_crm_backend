const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  normalizeDomain,
  validateImporterProvenance,
  calculateLeadGrade,
  canEnrollInOutreach,
  validateFollowUpWaitHours,
  calculateNextEmailScheduledTime,
  isWithinBusinessHours,
  validateLinkedInMessage,
  PIPELINE_STATUSES,
} = require("../src/lib/importerProvenance");

const NOW = new Date("2026-11-17T10:00:00Z");
const PAGE_TEXT =
  "Exhibitor list. Company: Hanoi Spices JSC  Tel: +84 (24) 3826-1111  Email: sales@hanoispices.vn  Web: www.hanoispices.vn  Contact: Tran Minh";

function fetchedRecord(overrides = {}) {
  return {
    importerName: "Hanoi Spices JSC",
    companyName: "Hanoi Spices JSC",
    importerNumber: "+84-24-3826-1111",
    email: "sales@hanoispices.vn",
    website: "https://www.hanoispices.vn",
    contactPerson: "Tran Minh",
    source_url: "https://fair.example-expo.vn/exhibitors/hanoi-spices",
    fetched_at: "2026-11-17T09:30:00Z",
    source_type: "trade_fair",
    raw_extracted_text: PAGE_TEXT,
    ...overrides,
  };
}

describe("Importer Provenance & Ingestion Rules", () => {
  test("allows a fetched record whose every field appears in the fetched text", () => {
    const result = validateImporterProvenance(fetchedRecord(), { now: NOW });
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.valid, true);
  });

  test("rejects fetched record with no raw_extracted_text (no evidence)", () => {
    const result = validateImporterProvenance(
      fetchedRecord({ raw_extracted_text: "" }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /raw_extracted_text is required/);
  });

  test("rejects an email that is not in the fetched text (invented contact)", () => {
    const result = validateImporterProvenance(
      fetchedRecord({ email: "procurement@hanoispices.vn" }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(" "), /Email "procurement@hanoispices\.vn" not found/);
  });

  test("rejects a phone number that is not in the fetched text", () => {
    const result = validateImporterProvenance(
      fetchedRecord({ importerNumber: "+84 24 9999 0000" }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(" "), /Phone .* not found/);
  });

  test("phone grounding ignores punctuation differences", () => {
    // Page has "+84 (24) 3826-1111"; extractor normalised it to dashes.
    const result = validateImporterProvenance(
      fetchedRecord({ importerNumber: "+84 24 3826 1111" }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, true, result.errors.join("; "));
  });

  test("rejects a company name or contact person not in the fetched text", () => {
    const r1 = validateImporterProvenance(
      fetchedRecord({ importerName: "Hanoi Global Spice Corp", companyName: "Hanoi Global Spice Corp" }),
      { now: NOW }
    );
    assert.strictEqual(r1.valid, false);
    assert.match(r1.errors.join(" "), /Company name .* not found/);

    const r2 = validateImporterProvenance(
      fetchedRecord({ contactPerson: "Head of Sourcing" }),
      { now: NOW }
    );
    assert.strictEqual(r2.valid, false);
    assert.match(r2.errors.join(" "), /Contact person .* not found/);
  });

  test("rejects a website domain not in the fetched text", () => {
    const result = validateImporterProvenance(
      fetchedRecord({ website: "https://hanoi-spices.com", website_domain: undefined }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(" "), /domain "hanoi-spices\.com" not found/);
  });

  test("grounding applies to Google Places and CSV rows too", () => {
    const places = validateImporterProvenance(
      fetchedRecord({
        source_type: "google_places",
        source_url: "https://www.google.com/maps/place/?q=place_id:abc",
        raw_extracted_text: JSON.stringify({ name: "Hanoi Spices JSC" }),
      }),
      { now: NOW }
    );
    assert.strictEqual(places.valid, false);
    assert.match(places.errors.join(" "), /not found in fetched source text/);

    const csv = validateImporterProvenance(
      {
        importerName: "Rotterdam Spices BV",
        email: "jan@rotterdamspices.nl",
        source_type: "csv_upload",
        source_url: "csv://manifest.csv#row2",
        fetched_at: NOW,
        raw_extracted_text: "Rotterdam Spices BV,jan@rotterdamspices.nl,Netherlands",
      },
      { now: NOW }
    );
    assert.strictEqual(csv.valid, true, csv.errors.join("; "));
  });

  test("manual entry is not grounding-checked (the user is the source)", () => {
    const result = validateImporterProvenance(
      {
        importerName: "Direct Buyer Inc",
        email: "buyer@directbuyer.com",
        source_url: "manual://user/64f0c0ffee",
        fetched_at: NOW,
        source_type: "manual",
      },
      { now: NOW }
    );
    assert.strictEqual(result.valid, true, result.errors.join("; "));
  });

  test("rejects fetched_at in the future", () => {
    const result = validateImporterProvenance(
      fetchedRecord({ fetched_at: "2026-11-18T10:00:00Z" }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /cannot be in the future/);
  });

  test("source_url scheme must match source_type", () => {
    const tradeFairWithManual = validateImporterProvenance(
      fetchedRecord({ source_url: "manual://user/1" }),
      { now: NOW }
    );
    assert.strictEqual(tradeFairWithManual.valid, false);
    assert.match(tradeFairWithManual.errors[0], /not allowed for source_type "trade_fair"/);

    const placesOverHttp = validateImporterProvenance(
      fetchedRecord({ source_type: "google_places", source_url: "http://maps.google.com/x" }),
      { now: NOW }
    );
    assert.strictEqual(placesOverHttp.valid, false);

    const manualWithCsv = validateImporterProvenance(
      { importerName: "X Trading", source_type: "manual", source_url: "csv://f.csv#row2", fetched_at: NOW },
      { now: NOW }
    );
    assert.strictEqual(manualWithCsv.valid, false);
  });

  test("rejects unknown source_type", () => {
    const result = validateImporterProvenance(
      fetchedRecord({ source_type: "llm_generated" }),
      { now: NOW }
    );
    assert.strictEqual(result.valid, false);
    assert.match(result.errors.join(" "), /Unknown source_type/);
  });

  test("rejects placeholder names, phones and emails used to pad records", () => {
    const base = { source_type: "manual", source_url: "manual://user/1", fetched_at: NOW };
    for (const importerName of ["CSV Imported Buyer", "Extracted Spice Importer", "Unknown", "—"]) {
      const r = validateImporterProvenance({ ...base, importerName }, { now: NOW });
      assert.strictEqual(r.valid, false, importerName);
      assert.match(r.errors[0], /placeholder/);
    }
    for (const importerNumber of ["+1-000-000-0000", "+1-800-555-0199", "123", "0000000"]) {
      const r = validateImporterProvenance({ ...base, importerName: "Real Co", importerNumber }, { now: NOW });
      assert.strictEqual(r.valid, false, importerNumber);
      assert.match(r.errors[0], /placeholder/);
    }
    const email = validateImporterProvenance(
      { ...base, importerName: "Real Co", email: "buyer@example.com" },
      { now: NOW }
    );
    assert.strictEqual(email.valid, false);
    assert.match(email.errors[0], /placeholder/);

    // Empty phone is fine: absent, not padded.
    assert.strictEqual(
      validateImporterProvenance({ ...base, importerName: "Real Co", importerNumber: "" }, { now: NOW }).valid,
      true
    );
  });

  test("allows manual entry with manual:// protocol", () => {
    const payload = {
      importerName: "Direct Buyer Inc",
      source_url: "manual://admin-entry",
      fetched_at: new Date(),
      source_type: "manual",
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, true);
  });

  test("allows manual entry with manual:// protocol", () => {
    const payload = {
      importerName: "Direct Buyer Inc",
      source_url: "manual://admin-entry",
      fetched_at: new Date(),
      source_type: "manual",
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, true);
  });

  test("rejects record missing source_url", () => {
    const payload = {
      importerName: "Fabricated Lead",
      fetched_at: new Date(),
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /Missing required provenance field: source_url/);
  });

  test("rejects record with empty/blank source_url", () => {
    const payload = {
      importerName: "Ghost Buyer",
      source_url: "   ",
      fetched_at: new Date(),
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /Missing required provenance field: source_url/);
  });

  test("rejects record with invalid source_url protocol", () => {
    const payload = {
      importerName: "Bad Protocol Buyer",
      source_url: "ftp://files.example.com/lead.txt",
      fetched_at: new Date(),
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /Invalid source_url protocol/);
  });

  test("rejects record missing fetched_at", () => {
    const payload = {
      importerName: "Dateless Buyer",
      source_url: "https://example.com/trade-directory",
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /Missing required provenance field: fetched_at/);
  });

  test("rejects record with invalid fetched_at timestamp", () => {
    const payload = {
      importerName: "Bad Date Buyer",
      source_url: "https://example.com",
      fetched_at: "not-a-valid-date",
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /Invalid fetched_at date value/);
  });

  test("rejects record missing importer or company name", () => {
    const payload = {
      source_url: "https://example.com/exhibitor/123",
      fetched_at: new Date(),
    };
    const result = validateImporterProvenance(payload);
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /Importer or Company name is required/);
  });
});

describe("Website Domain Normalization & Deduplication", () => {
  test("normalizes complex URLs to clean base domain", () => {
    assert.strictEqual(
      normalizeDomain("https://www.turmeric-vietnam.vn/products/turmeric?ref=google#top"),
      "turmeric-vietnam.vn"
    );
    assert.strictEqual(
      normalizeDomain("http://sub.domain.spices.com:8080/path/"),
      "sub.domain.spices.com"
    );
    assert.strictEqual(normalizeDomain("WWW.SPICES-EXPORT.CO.UK"), "spices-export.co.uk");
  });

  test("handles empty and malformed inputs gracefully", () => {
    assert.strictEqual(normalizeDomain(null), "");
    assert.strictEqual(normalizeDomain(""), "");
    assert.strictEqual(normalizeDomain(123), "");
  });
});

describe("Verification Scoring & Outreach Enrollment Gate", () => {
  test("calculates Grade A for live website and verified email", () => {
    const { score, grade } = calculateLeadGrade({
      websiteLive: true,
      emailStatus: "verified",
      hasPhone: true,
      hasContactPerson: true,
    });
    assert.strictEqual(grade, "A");
    assert.strictEqual(score, 100);
  });

  test("calculates Grade C for down website or unverified email", () => {
    const { grade } = calculateLeadGrade({
      websiteLive: false,
      emailStatus: "unverified",
    });
    assert.strictEqual(grade, "C");
  });

  test("allows enrollment ONLY for verified email and Grade A or B", () => {
    // Valid Grade A verified
    const leadA = {
      email_status: "verified",
      verification_grade: "A",
      unsubscribed: false,
      suppressed: false,
    };
    assert.strictEqual(canEnrollInOutreach(leadA).allowed, true);

    // Valid Grade B verified
    const leadB = {
      email_status: "verified",
      verification_grade: "B",
      unsubscribed: false,
      suppressed: false,
    };
    assert.strictEqual(canEnrollInOutreach(leadB).allowed, true);
  });

  test("rejects enrollment if email is unverified or risky", () => {
    const riskyLead = {
      email_status: "risky",
      verification_grade: "B",
    };
    const result = canEnrollInOutreach(riskyLead);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Only leads with "verified" email/);
  });

  test("rejects enrollment if lead is Grade C", () => {
    const gradeCLead = {
      email_status: "verified",
      verification_grade: "C",
    };
    const result = canEnrollInOutreach(gradeCLead);
    assert.strictEqual(result.allowed, false);
    assert.match(result.reason, /Only Grade A or B leads can be enrolled/);
  });

  test("rejects enrollment if lead is unsubscribed or suppressed", () => {
    const unsubscribedLead = {
      email_status: "verified",
      verification_grade: "A",
      unsubscribed: true,
    };
    assert.strictEqual(canEnrollInOutreach(unsubscribedLead).allowed, false);

    const suppressedLead = {
      email_status: "verified",
      verification_grade: "A",
      suppressed: true,
    };
    assert.strictEqual(canEnrollInOutreach(suppressedLead).allowed, false);
  });
});

describe("Outreach Timing & Follow-Up Calculation", () => {
  test("validates default 48h wait time and allows 24h to 72h range", () => {
    assert.strictEqual(validateFollowUpWaitHours(48).valid, true);
    assert.strictEqual(validateFollowUpWaitHours(24).valid, true);
    assert.strictEqual(validateFollowUpWaitHours(72).valid, true);

    // Out of bounds
    assert.strictEqual(validateFollowUpWaitHours(12).valid, false);
    assert.strictEqual(validateFollowUpWaitHours(96).valid, false);
  });

  test("calculates Email #2 scheduled timestamp based on wait hours", () => {
    const now = new Date("2026-11-17T10:00:00Z");
    const scheduled = calculateNextEmailScheduledTime(now, 48);
    const expected = new Date("2026-11-19T10:00:00Z");
    assert.strictEqual(scheduled.toISOString(), expected.toISOString());
  });

  test("checks recipient local business hours (09:00 - 18:00 Mon-Fri)", () => {
    // Tuesday 14:00 UTC in UTC is a weekday business hour
    const businessTime = new Date("2026-11-17T14:00:00Z");
    assert.strictEqual(isWithinBusinessHours(businessTime, "UTC"), true);

    // Tuesday 02:00 UTC is outside business hours
    const nightTime = new Date("2026-11-17T02:00:00Z");
    assert.strictEqual(isWithinBusinessHours(nightTime, "UTC"), false);

    // Sunday 14:00 UTC is weekend
    const weekend = new Date("2026-11-22T14:00:00Z");
    assert.strictEqual(isWithinBusinessHours(weekend, "UTC"), false);
  });
});

describe("LinkedIn Message Rules", () => {
  test("accepts messages under 300 characters", () => {
    const shortMsg = "Hi Linh, I noticed your turmeric procurement at Vietnam Foodcorp. We supply direct Salem finger turmeric with 3.5%+ curcumin. Would love to send a sample.";
    const result = validateLinkedInMessage(shortMsg);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.length < 300, true);
  });

  test("rejects messages exceeding 300 characters", () => {
    const longMsg = "A".repeat(305);
    const result = validateLinkedInMessage(longMsg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /exceeds 300 character limit/);
  });
});

describe("Pipeline Status Definitions", () => {
  test("includes all 10 required pipeline statuses in order", () => {
    const expected = [
      "New",
      "Verified",
      "Emailed",
      "Followed up",
      "LinkedIn sent",
      "Replied",
      "Sample sent",
      "Negotiation",
      "Order",
      "Lost",
    ];
    assert.deepStrictEqual(PIPELINE_STATUSES, expected);
  });
});
