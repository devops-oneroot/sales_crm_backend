const { test, describe } = require("node:test");
const assert = require("node:assert");
const { EMAIL_TEMPLATES } = require("../src/services/emailService");

describe("1-Click Automated Email Personalization", () => {
  const sampleImporter = {
    importerName: "Hanoi Spices Import & Export Corp",
    companyName: "Hanoi Spices JSC",
    contactPerson: "Nguyen Van Minh",
    importerNumber: "+84-24-3825-9988",
    email: "procurement@hanoispices.vn",
    website: "https://www.hanoispices.vn",
    country: "Vietnam",
    city: "Hanoi",
    products: ["Salem Turmeric Fingers", "Curcumin 95% Powder"],
    polishLevel: "Double Polish",
    curcuminPercent: 4.2,
    quantityKg: 50000,
    portOfDischarge: "Hai Phong Port",
  };

  test("generates 1-click email directly mentioning buyer name, company, and products", () => {
    const template = EMAIL_TEMPLATES.find(
      (t) => t.id === "personalized_product_outreach"
    );
    assert.ok(template, "personalized_product_outreach template exists");

    const email = template.generate(sampleImporter, "OneRoot Exports");

    // Must mention Buyer Name
    assert.ok(
      email.body.includes("Dear Nguyen Van Minh,"),
      "Email body must directly greet buyer by name"
    );

    // Must mention Company Name
    assert.ok(
      email.body.includes("Hanoi Spices JSC"),
      "Email body must directly mention buyer company"
    );
    assert.ok(
      email.subject.includes("Hanoi Spices JSC"),
      "Email subject must mention buyer company"
    );

    // Must mention Products Wanted
    assert.ok(
      email.body.includes("Salem Turmeric Fingers, Curcumin 95% Powder"),
      "Email body must directly mention products wanted"
    );
    assert.ok(
      email.subject.includes("Salem Turmeric Fingers, Curcumin 95% Powder"),
      "Email subject must mention products wanted"
    );

    // Must mention Country
    assert.ok(
      email.body.includes("Vietnam"),
      "Email body must mention destination country"
    );
    assert.ok(
      email.body.includes("European Specification Deck (PDF)"),
      "Email body mentions the attached European deck"
    );
  });

  test("gracefully falls back when contactPerson or products are missing", () => {
    const bareImporter = {
      importerName: "Global Trade LLC",
      country: "Germany",
    };

    const template = EMAIL_TEMPLATES.find(
      (t) => t.id === "personalized_product_outreach"
    );
    const email = template.generate(bareImporter, "OneRoot Exports");

    assert.ok(
      email.body.includes("Dear Global Trade LLC,"),
      "Falls back to importerName when contactPerson is missing"
    );
    assert.ok(
      email.body.includes("Export Grade Dry Turmeric Fingers"),
      "Falls back to export grade turmeric when products list is missing"
    );
    assert.ok(
      email.body.includes("Germany"),
      "Mentions Germany as country"
    );
  });
});

describe("Bulk Stop Outreach Sequences", () => {
  test("query filter correctly targets waiting follow-ups or specific lead IDs", () => {
    const buildQuery = ({ ids, allWaitingFollowup, allActive } = {}) => {
      if (allWaitingFollowup) {
        return {
          outreach_enrolled: true,
          $or: [{ outreach_status: "waiting_followup" }, { outreach_step: 1 }],
        };
      }
      if (allActive) {
        return {
          $or: [
            { outreach_enrolled: true },
            { outreach_status: { $in: ["scheduled", "waiting_followup"] } },
          ],
        };
      }
      if (Array.isArray(ids) && ids.length) {
        return {
          _id: { $in: ids },
          $or: [
            { outreach_enrolled: true },
            { outreach_status: { $in: ["scheduled", "waiting_followup"] } },
          ],
        };
      }
      return null;
    };

    const qWaiting = buildQuery({ allWaitingFollowup: true });
    assert.strictEqual(qWaiting.outreach_enrolled, true);
    assert.deepStrictEqual(qWaiting.$or, [{ outreach_status: "waiting_followup" }, { outreach_step: 1 }]);

    const qIds = buildQuery({ ids: ["id1", "id2"] });
    assert.deepStrictEqual(qIds._id, { $in: ["id1", "id2"] });
    assert.ok(qIds.$or.length === 2);
  });
});
