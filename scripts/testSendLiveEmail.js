const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { getInboxes, sendMail } = require("../src/services/outreachMailer");

async function main() {
  const inboxes = getInboxes();
  console.log("Detected inboxes:", inboxes.map((i) => i.email));

  if (!inboxes.length) {
    console.error("No inbox found in .env");
    return;
  }

  const inbox = inboxes[0];
  console.log(`Sending live test email from ${inbox.email} to vasanth@oneroot.farm...`);

  try {
    const result = await sendMail(inbox, {
      to: "vasanth@oneroot.farm",
      subject: "⚡ OneRoot CRM Test: Salem Turmeric Export Outreach",
      text: `Dear Vasanth,

Congratulations! Your automated email delivery system is now fully live and connected.

• Sender: ${inbox.name || "OneRoot Exports"} <${inbox.email}>
• SMTP Server: ${inbox.smtp.host}:${inbox.smtp.port}
• Lead Personalization: Active (Buyer name, company, products, and country)

When you click "⚡ Send Email" on any importer in your CRM dashboard, the email is delivered directly through this inbox and will appear in your Gmail Sent folder.

Warm regards,
OneRoot Sales CRM
https://oneroot.farm`,
    });

    console.log("✅ Email successfully delivered!", result);
  } catch (err) {
    console.error("❌ Send failed:", err.message);
  }
}

main();
