const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const OutreachSettings = require("../src/models/OutreachSettings");

const email1_subject = "🇪🇺 Direct Sourcing: IPM-Grade Turmeric for {{company}} [EU Spec Deck Attached]";

const email1_body =
`Hi {{first_name|there}},

I am writing to you directly from OneRoot Farm in Karnataka, India regarding spice sourcing for {{company}} in {{country}}.

About OneRoot:
We are an integrated agribusiness working the entire supply chain from soil to shipment. We make our own crop inputs, advise every farmer directly in the field, monitor crop growth, and buy the harvest under single-roof accountability:
• Scale: 3,000 contracted farmers cultivating 6,000 committed acres across Karnataka (Belgaum in north-west Karnataka and Chamarajanagar in southern Karnataka, where OneRoot is the district's #1 turmeric buyer).
• Capacity: 15,000 tonnes committed season capacity.
• Proven Reliability: We already supply leading food and nutraceutical brands season after season.

Our Products & European Specifications:
• Product: {{product_details}}
• Formats: Whole dried fingers (double polished) and powder milled with BRC-certified partners for European food safety compliance.
• Quality & Clean Residue: Grown with our proprietary in-house biological inputs (fyto), replacing synthetic chemicals to deliver high, consistent curcumin and a clean residue profile.
• Lab-Tested for EU: Formulated and grown to strictly meet EU Maximum Residue Levels (Regulation (EC) No 396/2005). Every lot is tested for pesticide residues by an accredited laboratory prior to dispatch, and the official residue report accompanies your shipment.
• Full Traceability & ESG: Field-level traceability down to the individual farm, plus an input-level application record. Each acre saves 400–700 kg of CO2 emissions for your Scope 3 / ESG reporting.
• Harvest Window: Our next harvest runs from January to March 2027. We are currently locking in contract volumes under Letter of Intent (LOI) with European partners.

I have attached our complete European Specification & Traceability Deck (OneRoot_IPM_Turmeric_Europe_Specifications.pdf) to this email for your review.

Could we schedule a brief 10-minute introductory call next week to discuss {{company}}'s sourcing requirements for {{country}}?

Best regards,`;

const email2_body =
`Hi {{first_name|there}},

Following up on my note below regarding IPM-grade turmeric supply for {{company}} in {{country}}.

In case it was buried, our full European Specification Deck is attached in the thread above covering our 3,000-farmer contract program in Karnataka, EU MRL lab protocols, and BRC-certified milling.

With our January–March harvest window approaching, we are currently finalizing allocations under Letters of Intent (LOI). Happy to send sample lots and recent third-party residue reports if helpful.

Best regards,`;

const product_details = "IPM-Grade Turmeric (Whole Dried Fingers & BRC-Milled Powder, EU MRL Compliant)";
const signature =
`Vasanth | OneRoot Farm
International Exports Division
Bengaluru, Karnataka, India
+91 879 200 6444 · vasanth@oneroot.farm · oneroot.farm`;
const sender_address = "OneRoot Farm, International Exports Division, Bengaluru, Karnataka 560001, India";

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const updated = await OutreachSettings.findOneAndUpdate(
    {},
    {
      $set: {
        email1_subject,
        email1_body,
        email2_body,
        product_details,
        signature,
        sender_address,
      },
    },
    { new: true, upsert: true }
  );
  console.log("Successfully updated OutreachSettings in MongoDB:");
  console.log("Subject:", updated.email1_subject);
  console.log("Product details:", updated.product_details);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed to update OutreachSettings:", err);
  process.exit(1);
});
