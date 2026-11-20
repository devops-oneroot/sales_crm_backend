const mongoose = require("mongoose");

/** Single settings document for the outreach sequence. Inbox credentials live in .env. */
const outreachSettingsSchema = new mongoose.Schema(
  {
    // Off by default: nothing is emailed until someone switches sending on.
    sending_enabled: { type: Boolean, default: false },

    email1_subject: {
      type: String,
      default: "🇪🇺 Direct Sourcing: IPM-Grade Turmeric for {{company}} [EU Spec Deck Attached]",
    },
    email1_body: {
      type: String,
      default:
        "Hi {{first_name|there}},\n\n" +
        "I am writing to you directly from OneRoot Farm in Karnataka, India regarding spice sourcing for {{company}} in {{country}}.\n\n" +
        "About OneRoot:\n" +
        "We are an integrated agribusiness working the entire supply chain from soil to shipment. We make our own crop inputs, advise every farmer directly in the field, monitor crop growth, and buy the harvest under single-roof accountability:\n" +
        "• Scale: 3,000 contracted farmers cultivating 6,000 committed acres across Karnataka (Belgaum in north-west Karnataka and Chamarajanagar in southern Karnataka, where OneRoot is the district's #1 turmeric buyer).\n" +
        "• Capacity: 15,000 tonnes committed season capacity.\n" +
        "• Direct Supply: We already supply leading food and nutraceutical brands season after season.\n\n" +
        "Our Products & European Specifications:\n" +
        "• Product: {{product_details}}\n" +
        "• Formats: Whole dried fingers (double polished) and powder milled with BRC-certified partners for European food safety compliance.\n" +
        "• Quality & Clean Residue: Grown with our proprietary in-house biological inputs (fyto), replacing synthetic chemicals to deliver high, consistent curcumin and a clean residue profile.\n" +
        "• Lab-Tested for EU: Formulated and grown to strictly meet EU Maximum Residue Levels (Regulation (EC) No 396/2005). Every lot is tested for pesticide residues by an accredited laboratory prior to dispatch, and the official residue report accompanies your shipment.\n" +
        "• Full Traceability & ESG: Field-level traceability down to the individual farm, plus an input-level application record. Each acre saves 400–700 kg of CO2 emissions for your Scope 3 / ESG reporting.\n" +
        "• Harvest Window: Our next harvest runs from January to March 2027. We are currently locking in contract volumes under Letter of Intent (LOI) with European partners.\n\n" +
        "I have attached our complete European Specification & Traceability Deck (OneRoot_IPM_Turmeric_Europe_Specifications.pdf) to this email for your review.\n\n" +
        "Could we schedule a brief 10-minute introductory call next week to discuss {{company}}'s sourcing requirements for {{country}}?\n\n" +
        "Best regards,",
    },
    email2_body: {
      type: String,
      default:
        "Hi {{first_name|there}},\n\n" +
        "Following up on my note below regarding IPM-grade turmeric supply for {{company}} in {{country}}.\n\n" +
        "In case it was buried, our full European Specification Deck is attached in the thread above covering our 3,000-farmer contract program in Karnataka, EU MRL lab protocols, and BRC-certified milling.\n\n" +
        "With our January–March harvest window approaching, we are currently finalizing allocations under Letters of Intent (LOI). Happy to send sample lots and recent third-party residue reports if helpful.\n\n" +
        "Best regards,",
    },
    product_details: {
      type: String,
      default: "IPM-Grade Turmeric (Whole Dried Fingers & BRC-Milled Powder, EU MRL Compliant)",
      trim: true,
    },
    signature: {
      type: String,
      default:
        "Vasanth | OneRoot Farm\n" +
        "International Exports Division\n" +
        "Bengaluru, Karnataka, India\n" +
        "+91 879 200 6444 · vasanth@oneroot.farm · oneroot.farm",
    }, // appended under "Best regards,"
    sender_address: {
      type: String,
      default: "OneRoot Farm, International Exports Division, Bengaluru, Karnataka 560001, India",
    }, // postal address in the footer (required by CAN-SPAM)

    wait_hours: { type: Number, default: 48, min: 24, max: 72 },
    business_start_hour: { type: Number, default: 9, min: 0, max: 23 },
    business_end_hour: { type: Number, default: 17, min: 1, max: 24 },
    business_days: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0=Sun … 6=Sat
    default_daily_cap: { type: Number, default: 30, min: 1, max: 500 },
    min_gap_seconds: { type: Number, default: 120, min: 10, max: 3600 }, // between sends from one inbox

    last_tick_at: { type: Date },
    last_poll_at: { type: Date },
    last_poll_result: { type: String, default: "" },
    last_tick_result: { type: String, default: "" },
    // Per-inbox IMAP cursor: { "<email>": { uidValidity, lastUid } }
    imap_state: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "outreach_settings" }
);

module.exports = mongoose.model("OutreachSettings", outreachSettingsSchema);
