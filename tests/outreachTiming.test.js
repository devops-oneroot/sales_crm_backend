const { test, describe } = require("node:test");
const assert = require("node:assert");
const R = require("../src/lib/outreachRules");

const iso = (d) => d.toISOString();

describe("Follow-up timing", () => {
  test("default wait is 48h; 24–72h allowed; outside range rejected", () => {
    assert.strictEqual(R.normalizeWaitHours(undefined), 48);
    assert.strictEqual(R.normalizeWaitHours(24), 24);
    assert.strictEqual(R.normalizeWaitHours(72), 72);
    assert.strictEqual(R.normalizeWaitHours("36"), 36);
    assert.throws(() => R.normalizeWaitHours(23), /between 24 and 72/);
    assert.throws(() => R.normalizeWaitHours(73), /between 24 and 72/);
    assert.throws(() => R.normalizeWaitHours("abc"), /between 24 and 72/);
  });

  test("Email #2 = Email #1 + wait when that lands inside business hours", () => {
    // Tue 17 Nov 2026 10:00 in Dubai (06:00Z) + 48h → Thu 10:00 Dubai, a working day.
    const sent = new Date("2026-11-17T06:00:00Z");
    assert.strictEqual(iso(R.scheduleFollowUp(sent, 48, "Asia/Dubai")), "2026-11-19T06:00:00.000Z");
  });

  test("never earlier than the wait, even by a minute", () => {
    const sent = new Date("2026-11-17T06:00:00Z");
    for (const h of [24, 36, 48, 60, 72]) {
      const due = R.scheduleFollowUp(sent, h, "Europe/Berlin");
      assert.ok(due.getTime() >= sent.getTime() + h * 3600e3, `wait ${h}h`);
    }
  });

  test("after-hours result moves to the next morning at opening time", () => {
    // Mon 16:30 London (GMT in Nov) + 24h = Tue 16:30 — inside hours (closes 17:00).
    assert.strictEqual(iso(R.scheduleFollowUp(new Date("2026-11-16T16:30:00Z"), 24, "Europe/London")), "2026-11-17T16:30:00.000Z");
    // Mon 18:00 London + 24h = Tue 18:00 → Wed 09:00 London.
    assert.strictEqual(iso(R.scheduleFollowUp(new Date("2026-11-16T18:00:00Z"), 24, "Europe/London")), "2026-11-18T09:00:00.000Z");
  });

  test("weekend result moves to Monday 09:00 local", () => {
    // Thu 19 Nov 2026 14:00 New York (19:00Z) + 48h = Sat → Mon 23 Nov 09:00 NY (14:00Z).
    assert.strictEqual(iso(R.scheduleFollowUp(new Date("2026-11-19T19:00:00Z"), 48, "America/New_York")), "2026-11-23T14:00:00.000Z");
  });

  test("uses the recipient's timezone, not the server's", () => {
    // Same instant: 08:00Z Tue = 09:00 Berlin (open) but 03:00 New York (closed).
    const t = new Date("2026-11-17T08:00:00Z");
    assert.strictEqual(R.isWithinHours(t, "Europe/Berlin"), true);
    assert.strictEqual(R.isWithinHours(t, "America/New_York"), false);
    assert.strictEqual(iso(R.nextBusinessSlot(t, "America/New_York")), "2026-11-17T14:00:00.000Z");
  });

  test("handles daylight-saving changes (Europe/London 29 Mar 2026)", () => {
    // Fri 27 Mar 17:30 GMT + 48h = Sun → Mon 30 Mar 09:00 BST = 08:00Z.
    assert.strictEqual(iso(R.scheduleFollowUp(new Date("2026-03-27T17:30:00Z"), 48, "Europe/London")), "2026-03-30T08:00:00.000Z");
  });

  test("custom business hours and working days (Sun–Thu, 08:00–16:00, e.g. some Gulf firms)", () => {
    const hours = { startHour: 8, endHour: 16, days: [0, 1, 2, 3, 4] };
    // Thu 19 Nov 15:00 Riyadh (12:00Z) + 24h = Fri → Sun 22 Nov 08:00 Riyadh (05:00Z).
    assert.strictEqual(iso(R.scheduleFollowUp(new Date("2026-11-19T12:00:00Z"), 24, "Asia/Riyadh", hours)), "2026-11-22T05:00:00.000Z");
  });

  test("half-hour timezone (India, Nepal) opens on the exact minute", () => {
    // 02:00Z = 07:45 Kathmandu → opens 09:00 local = 03:15Z.
    assert.strictEqual(iso(R.nextBusinessSlot(new Date("2026-11-17T02:00:00Z"), "Asia/Kathmandu")), "2026-11-17T03:15:00.000Z");
  });

  test("invalid Email #1 time is an error, not a silent default", () => {
    assert.throws(() => R.scheduleFollowUp("not a date", 48, "UTC"), /Invalid Email #1/);
  });
});

describe("Recipient timezone", () => {
  test("explicit importer timezone wins; else country; else UTC", () => {
    assert.deepStrictEqual(R.resolveTimezone({ recipient_timezone: "Asia/Tokyo", country: "Germany" }), { tz: "Asia/Tokyo", source: "importer" });
    assert.deepStrictEqual(R.resolveTimezone({ recipient_timezone: "UTC", country: "United Arab Emirates" }), { tz: "Asia/Dubai", source: "country" });
    assert.deepStrictEqual(R.resolveTimezone({ country: "UK" }), { tz: "Europe/London", source: "country" });
    assert.deepStrictEqual(R.resolveTimezone({ country: "Atlantis" }), { tz: "UTC", source: "default" });
    assert.deepStrictEqual(R.resolveTimezone({ recipient_timezone: "Mars/Olympus", country: "Kuwait" }), { tz: "Asia/Kuwait", source: "country" });
  });
  test("every mapped timezone is valid", () => {
    for (const [c, tz] of Object.entries(R.COUNTRY_TZ)) assert.ok(R.isValidTimezone(tz), `${c} → ${tz}`);
  });
});

describe("Merge fields", () => {
  test("first_name only from a real person's name", () => {
    assert.strictEqual(R.firstNameFrom("Jan de Vries"), "Jan");
    assert.strictEqual(R.firstNameFrom("Mr. Tariq Al-Mansoor"), "Tariq");
    assert.strictEqual(R.firstNameFrom("nguyen van binh (Head of Sourcing)"), "Nguyen");
    assert.strictEqual(R.firstNameFrom("Procurement Manager"), "");
    assert.strictEqual(R.firstNameFrom("International Procurement Desk"), "");
    assert.strictEqual(R.firstNameFrom("sales@firm.com"), "");
    assert.strictEqual(R.firstNameFrom(""), "");
  });

  test("renders fields, uses fallbacks, and reports missing values", () => {
    const fields = R.buildMergeFields(
      { contactPerson: "Jan de Vries", companyName: "Rotterdam Spices BV", country: "Netherlands" },
      { product_details: "Salem turmeric fingers, 3.5%+ curcumin" }
    );
    const r = R.renderTemplate("Hi {{first_name|there}}, {{company}} in {{country}} — {{product_details}}.", fields);
    assert.strictEqual(r.text, "Hi Jan, Rotterdam Spices BV in Netherlands — Salem turmeric fingers, 3.5%+ curcumin.");
    assert.deepStrictEqual(r.missing, []);

    const noName = R.renderTemplate("Hi {{first_name|there}},", R.buildMergeFields({ contactPerson: "Sales Team" }));
    assert.strictEqual(noName.text, "Hi there,");

    const missing = R.renderTemplate("Hi {{first_name}} at {{company}}", R.buildMergeFields({ companyName: "X Ltd" }));
    assert.deepStrictEqual(missing.missing, ["first_name"]);

    const unknown = R.renderTemplate("Price {{price}}", {});
    assert.deepStrictEqual(unknown.unknown, ["price"]);
  });
});

describe("Unsubscribe tokens", () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  test("round-trips and rejects tampering", () => {
    const t = R.makeUnsubscribeToken("64f0c0ffee1234567890abcd");
    assert.strictEqual(R.readUnsubscribeToken(t), "64f0c0ffee1234567890abcd");
    const other = R.makeUnsubscribeToken("64f0c0ffee1234567890abce");
    assert.strictEqual(R.readUnsubscribeToken(t.split(".")[0] + "." + other.split(".")[1]), null);
    assert.strictEqual(R.readUnsubscribeToken("garbage"), null);
  });
});

describe("Inbound mail classification", () => {
  test("real reply stops the sequence", () => {
    assert.strictEqual(R.classifyInbound({ from: "jan@rotterdamspices.nl", subject: "Re: Turmeric supply", text: "Please send prices." }), "reply");
  });
  test("bounces (mailer-daemon, DSN report)", () => {
    assert.strictEqual(R.classifyInbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)" }), "bounce");
    assert.strictEqual(R.classifyInbound({ from: "postmaster@outlook.com", subject: "Undeliverable: Turmeric" }), "bounce");
    assert.strictEqual(R.classifyInbound({ from: "x@y.com", subject: "hi", contentType: 'multipart/report; report-type="delivery-status"' }), "bounce");
  });
  test("out-of-office / auto-replies don't stop the sequence", () => {
    assert.strictEqual(R.classifyInbound({ from: "jan@x.nl", subject: "Automatic reply: Turmeric", headers: { "auto-submitted": "auto-replied" } }), "auto_reply");
    assert.strictEqual(R.classifyInbound({ from: "jan@x.nl", subject: "Out of Office: back Monday" }), "auto_reply");
    assert.strictEqual(R.classifyInbound({ from: "jan@x.nl", subject: "Re: hi", headers: { precedence: "auto_reply" } }), "auto_reply");
    assert.strictEqual(R.classifyInbound({ from: "jan@x.nl", subject: "Re: hi", headers: { "auto-submitted": "no" }, text: "Interested" }), "reply");
  });
  test("unsubscribe requests by email", () => {
    assert.strictEqual(R.classifyInbound({ from: "jan@x.nl", subject: "unsubscribe" }), "unsubscribe");
    assert.strictEqual(R.classifyInbound({ from: "jan@x.nl", subject: "Re: Turmeric", text: "Please remove me from your list" }), "unsubscribe");
  });
  test("bounced recipient is read from the DSN", () => {
    const dsn = "Reporting-MTA: dns; mx.google.com\nFinal-Recipient: rfc822; jan@rotterdamspices.nl\nAction: failed\nStatus: 5.1.1";
    assert.strictEqual(R.bouncedRecipient(dsn, ["export@oneroot.farm"]), "jan@rotterdamspices.nl");
    assert.strictEqual(R.bouncedRecipient("Your message to sales@x.com couldn't be delivered. From export@oneroot.farm", ["export@oneroot.farm"]), "sales@x.com");
  });
});
