const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { dnsClient: dnsPromises } = require("../src/services/verificationService");
const { calculateLeadGrade, canEnrollInOutreach } = require("../src/lib/importerProvenance");
const { verifyEmail, verifierConfig, NEVERBOUNCE_MAP, ZEROBOUNCE_MAP } = require("../src/services/verificationService");

describe("Grading", () => {
  const g = (websiteLive, emailStatus, extra = {}) => calculateLeadGrade({ websiteLive, emailStatus, ...extra }).grade;

  test("A = verified email + live website", () => {
    assert.strictEqual(g(true, "verified"), "A");
  });
  test("B = verified email with site down, or risky email with live site", () => {
    assert.strictEqual(g(false, "verified"), "B");
    assert.strictEqual(g(true, "risky"), "B");
  });
  test("C = unverified / invalid email, or risky without a live site", () => {
    assert.strictEqual(g(true, "unverified", { hasPhone: true, hasContactPerson: true }), "C");
    assert.strictEqual(g(true, "invalid"), "C");
    assert.strictEqual(g(false, "risky"), "C");
  });
  test("score adds website 35, verified 45 / risky 15, phone 10, contact person 10", () => {
    assert.strictEqual(calculateLeadGrade({ websiteLive: true, emailStatus: "verified", hasPhone: true, hasContactPerson: true }).score, 100);
    assert.strictEqual(calculateLeadGrade({ websiteLive: true, emailStatus: "risky" }).score, 50);
  });
  test("only verified A/B pass the outreach gate — risky B does not", () => {
    assert.strictEqual(canEnrollInOutreach({ email_status: "verified", verification_grade: "A" }).allowed, true);
    assert.strictEqual(canEnrollInOutreach({ email_status: "verified", verification_grade: "B" }).allowed, true);
    assert.strictEqual(canEnrollInOutreach({ email_status: "risky", verification_grade: "B" }).allowed, false);
    assert.strictEqual(canEnrollInOutreach({ email_status: "verified", verification_grade: "C" }).allowed, false);
    assert.strictEqual(canEnrollInOutreach({ email_status: "verified", verification_grade: "A", suppressed: true }).allowed, false);
  });
});

describe("Email verification", () => {
  let saved;
  beforeEach(() => {
    saved = {
      fetch: global.fetch,
      mx: dnsPromises.resolveMx,
      a: dnsPromises.resolve4,
      provider: process.env.EMAIL_VERIFIER_PROVIDER,
      key: process.env.EMAIL_VERIFIER_API_KEY,
    };
    dnsPromises.resolveMx = async (d) => {
      if (d === "nomail.example-test") throw Object.assign(new Error("no"), { code: "ENOTFOUND" });
      return [{ exchange: `mx.${d}`, priority: 10 }];
    };
    dnsPromises.resolve4 = async () => {
      throw Object.assign(new Error("no"), { code: "ENOTFOUND" });
    };
  });
  afterEach(() => {
    global.fetch = saved.fetch;
    dnsPromises.resolveMx = saved.mx;
    dnsPromises.resolve4 = saved.a;
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("EMAIL_VERIFIER_PROVIDER", saved.provider);
    restore("EMAIL_VERIFIER_API_KEY", saved.key);
  });

  const setVerifier = (provider, key = "test-key") => {
    process.env.EMAIL_VERIFIER_PROVIDER = provider;
    process.env.EMAIL_VERIFIER_API_KEY = key;
  };

  test("without a verifier key an email is never marked verified", async () => {
    delete process.env.EMAIL_VERIFIER_API_KEY;
    global.fetch = async () => assert.fail("must not call a verifier without a key");
    const r = await verifyEmail("info@spicehouse.ae");
    assert.strictEqual(r.status, "unverified");
    assert.match(r.detail, /mailbox not checked/);
  });

  test("domain with no mail server → invalid (no API needed)", async () => {
    const r = await verifyEmail("info@nomail.example-test");
    assert.strictEqual(r.status, "invalid");
  });

  test("malformed address → invalid", async () => {
    assert.strictEqual((await verifyEmail("not-an-email")).status, "invalid");
  });

  test("NeverBounce results map to verified / risky / invalid", async () => {
    setVerifier("neverbounce");
    for (const [result, expected] of Object.entries(NEVERBOUNCE_MAP)) {
      global.fetch = async (url) => {
        assert.match(String(url), /api\.neverbounce\.com\/v4\/single\/check/);
        return new Response(JSON.stringify({ status: "success", result }));
      };
      assert.strictEqual((await verifyEmail("buyer@spicehouse.ae", verifierConfig())).status, expected, result);
    }
  });

  test("ZeroBounce results map to verified / risky / invalid", async () => {
    setVerifier("zerobounce");
    for (const [status, expected] of Object.entries(ZEROBOUNCE_MAP)) {
      global.fetch = async (url) => {
        assert.match(String(url), /api\.zerobounce\.net\/v2\/validate/);
        return new Response(JSON.stringify({ status, sub_status: "" }));
      };
      assert.strictEqual((await verifyEmail("buyer@spicehouse.ae", verifierConfig())).status, expected, status);
    }
  });

  test("verifier error (bad key / no credits) never upgrades to verified", async () => {
    setVerifier("neverbounce");
    global.fetch = async () => new Response(JSON.stringify({ status: "auth_failure", message: "Invalid API key" }));
    const r = await verifyEmail("buyer@spicehouse.ae", verifierConfig());
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.error, true);
    assert.match(r.detail, /Invalid API key/);
  });

  test("unknown provider name is reported, not silently ignored", () => {
    setVerifier("mailcheckr");
    const cfg = verifierConfig();
    assert.strictEqual(cfg.configured, false);
    assert.match(cfg.reason, /must be neverbounce or zerobounce/);
  });
});
