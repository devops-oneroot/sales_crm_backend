const { test, describe, before } = require("node:test");
const assert = require("node:assert");

before(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.OUTREACH_PUBLIC_URL = "https://crm.example-test.com/";
});

const settings = {
  email1_subject: "{{product_details}} for {{company}}",
  email1_body: "Hi {{first_name|there}},\n\nWe supply {{product_details}} to buyers in {{country}}.\n\nBest regards,",
  email2_body: "Hi {{first_name|there}},\n\nFollowing up on my note below.\n\nBest regards,",
  product_details: "Salem turmeric fingers",
  signature: "Asha\nOneRoot Farm",
  sender_address: "OneRoot Farm, Erode, Tamil Nadu, India",
};
const importer = { _id: "64f0c0ffee1234567890abcd", companyName: "Rotterdam Spices BV", contactPerson: "Jan de Vries", country: "Netherlands" };
const inbox = { email: "export@oneroot.farm", name: "Asha at OneRoot" };

describe("Composing outreach emails", () => {
  const { composeEmail } = require("../src/services/outreachEngine");
  const { readUnsubscribeToken } = require("../src/lib/outreachRules");

  test("Email #1: merge fields, signature, postal address and unsubscribe link", () => {
    const m = composeEmail(importer, settings, 1, { inbox });
    assert.deepStrictEqual(m.problems, []);
    assert.strictEqual(m.subject, "Salem turmeric fingers for Rotterdam Spices BV");
    assert.match(m.text, /^Hi Jan,/);
    assert.match(m.text, /buyers in Netherlands/);
    assert.match(m.text, /Asha\nOneRoot Farm/);
    assert.match(m.text, /Erode, Tamil Nadu/);
    const url = m.text.match(/unsubscribe here: (\S+)/)[1];
    assert.match(url, /^https:\/\/crm\.example-test\.com\/api\/outreach\/unsubscribe\//);
    assert.strictEqual(readUnsubscribeToken(url.split("/").pop()), importer._id);
    assert.match(m.html, /<a href="https:\/\/crm\.example-test\.com\/api\/outreach\/unsubscribe\/[^"]+">unsubscribe here<\/a>/);
  });

  test("Email #2: 'Re:' + Email #1 subject (same thread) and quotes Email #1", () => {
    const sent = { ...importer, outreach_subject: "Salem turmeric fingers for Rotterdam Spices BV" };
    const m = composeEmail(sent, settings, 2, { inbox, previous: { sentAt: new Date("2026-11-17T09:00:00Z"), body: "Hi Jan,\nWe supply turmeric." } });
    assert.deepStrictEqual(m.problems, []);
    assert.strictEqual(m.subject, "Re: Salem turmeric fingers for Rotterdam Spices BV");
    assert.match(m.text, /wrote:\n> Hi Jan,\n> We supply turmeric\./);
    assert.match(m.text, /unsubscribe here:/);
  });

  test("missing merge field without fallback blocks the send", () => {
    const m = composeEmail(importer, { ...settings, email1_body: "Hi {{first_name}}," }, 1, { inbox });
    assert.strictEqual(composeEmail({ ...importer, contactPerson: "Purchasing Dept" }, { ...settings, email1_body: "Hi {{first_name}}," }, 1, { inbox }).problems.length, 1);
    assert.deepStrictEqual(m.problems, []);
  });

  test("empty product details blocks the send instead of sending a gap", () => {
    const m = composeEmail(importer, { ...settings, product_details: "" }, 1, { inbox });
    assert.match(m.problems.join(" "), /Missing merge field.*product_details/);
  });

  test("no public URL → no unsubscribe link → blocked", () => {
    const saved = process.env.OUTREACH_PUBLIC_URL;
    delete process.env.OUTREACH_PUBLIC_URL;
    const savedApi = process.env.API_PUBLIC_URL;
    delete process.env.API_PUBLIC_URL;
    try {
      const m = composeEmail(importer, settings, 1, { inbox });
      assert.match(m.problems.join(" "), /OUTREACH_PUBLIC_URL/);
    } finally {
      process.env.OUTREACH_PUBLIC_URL = saved;
      if (savedApi !== undefined) process.env.API_PUBLIC_URL = savedApi;
    }
  });

  test("Email #2 can't be composed without the recorded Email #1 subject", () => {
    const m = composeEmail(importer, settings, 2, { inbox });
    assert.match(m.problems.join(" "), /cannot thread Email #2/);
  });

  test("HTML escapes merge values (no markup injection from scraped names)", () => {
    const m = composeEmail({ ...importer, companyName: "<b>Evil</b> & Co" }, { ...settings, email1_body: "Hello {{company}}," }, 1, { inbox });
    assert.ok(!m.html.includes("<b>Evil</b>"));
    assert.match(m.html, /&lt;b&gt;Evil&lt;\/b&gt; &amp; Co/);
  });
});

describe("Inbox configuration from .env", () => {
  const { getInboxes } = require("../src/services/outreachMailer");
  test("single inbox from SMTP_* / IMAP_*; IMAP login defaults to SMTP login", () => {
    const [ib] = getInboxes({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
      SMTP_USER: "export@oneroot.farm",
      SMTP_PASS: "app-pass",
      SMTP_FROM: "export@oneroot.farm",
      SMTP_FROM_NAME: "OneRoot Exports",
      IMAP_HOST: "imap.gmail.com",
      OUTREACH_DAILY_CAP: "40",
    });
    assert.strictEqual(ib.email, "export@oneroot.farm");
    assert.deepStrictEqual(ib.imap, { host: "imap.gmail.com", port: 993, user: "export@oneroot.farm", pass: "app-pass" });
    assert.strictEqual(ib.dailyCap, 40);
  });
  test("several inboxes with their own caps", () => {
    const list = getInboxes({
      OUTREACH_INBOX_1_EMAIL: "a@oneroot.farm",
      OUTREACH_INBOX_1_SMTP_HOST: "smtp.x.com",
      OUTREACH_INBOX_1_DAILY_CAP: "25",
      OUTREACH_INBOX_2_EMAIL: "b@oneroot.farm",
      OUTREACH_INBOX_2_SMTP_HOST: "smtp.x.com",
    });
    assert.deepStrictEqual(list.map((i) => [i.email, i.dailyCap]), [["a@oneroot.farm", 25], ["b@oneroot.farm", 0]]);
  });
  test("nothing configured → no inboxes (nothing is sent)", () => {
    assert.deepStrictEqual(getInboxes({}), []);
  });
});
