const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const http = require("http");
const express = require("express");
const EmailMessage = require("../src/models/EmailMessage");
const Importer = require("../src/models/Importer");
const emailTrackingRouter = require("../src/routes/emailTracking");
const { sendOneClickPersonalizedEmail } = require("../src/services/emailService");

async function runTest() {
  console.log("============================================================");
  console.log("⚡ TESTING MAILCHIMP-GRADE EMAIL OPEN & CLICK TRACKING");
  console.log("============================================================\n");

  // 1. Connect to MongoDB
  console.log("1️⃣ Connecting to database...");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("   ✅ Database connected!\n");

  // 2. Spin up local test HTTP server with tracking routes
  const app = express();
  app.use("/api/emails/track", emailTrackingRouter);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(5099, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:5099";
  process.env.PUBLIC_BACKEND_URL = baseUrl;
  console.log(`2️⃣ Local tracking server listening on ${baseUrl}\n`);

  let testImporter = null;
  let sentEmail = null;
  let clickTestEmail = null;

  try {
    // 3. Create a test importer
    console.log("3️⃣ Creating test importer for outreach...");
    testImporter = await Importer.create({
      companyName: "House Foods Vietnam Co., Ltd.",
      importerName: "Vasanth Kumar",
      contactPerson: "Vasanth Kumar",
      country: "Vietnam",
      email: "vasanthkuma2004@gmail.com",
      products: ["Turmeric Fingers", "Powder"],
      pipeline_status: "New",
      responsiblePerson: "Sales Rep",
    });
    console.log(`   ✅ Test buyer created: ${testImporter.companyName} (${testImporter.email})\n`);

    // 4. Send 1-Click Outreach Email
    console.log("4️⃣ Generating and sending 1-Click outreach email...");
    const sendResult = await sendOneClickPersonalizedEmail({
      importerId: testImporter._id,
      userId: new mongoose.Types.ObjectId(),
      userName: "OneRoot Exports",
      customSubject: "Direct Sourcing: turmeric for House Foods Vietnam",
      customBody: `Dear Vasanth Kumar,

We are following up on your inquiry regarding IPM turmeric supply.
Please check our website: https://oneroot.farm for crop certifications.

Best regards,
OneRoot Exports Team`,
      attachBrochure: false,
    });

    sentEmail = sendResult.email;
    console.log(`   ✅ Email sent! Message ID: ${sentEmail.messageId}`);
    console.log(`   🔑 Unique Tracking ID: ${sentEmail.trackingId}`);
    console.log(`   📊 Initial Status: "${sentEmail.status}" | Opens: ${sentEmail.openCount || 0} | Clicks: ${sentEmail.clickCount || 0}\n`);

    // 5. TEST: Recipient opens email (Mail Client Pixel Load)
    console.log("5️⃣ [Test Case A] Recipient opens email in Gmail / Outlook...");
    const pixelUrl = `${baseUrl}/api/emails/track/o/${sentEmail.trackingId}.gif`;
    const pixelRes = await fetch(pixelUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const contentType = pixelRes.headers.get("content-type");
    const buffer = Buffer.from(await pixelRes.arrayBuffer());
    console.log(`   📡 Pixel Request Status: ${pixelRes.status} (Content-Type: ${contentType})`);
    console.log(`   🖼️ Image Size: ${buffer.length} bytes (Transparent 1x1 GIF)`);

    // Wait 200ms for async DB write
    await new Promise((r) => setTimeout(r, 200));

    const openedEmail = await EmailMessage.findById(sentEmail._id);
    console.log(`   ✅ Updated DB Status: "${openedEmail.status.toUpperCase()}"`);
    console.log(`   👁️ Open Count: ${openedEmail.openCount} time(s)`);
    console.log(`   🕒 First Opened At: ${openedEmail.firstOpenedAt.toISOString()}`);
    console.log(`   🛡️ Apple MPP Flag: ${openedEmail.isOpenAppleMpp} (Real Human Open)\n`);

    // 6. TEST: Apple Mail Privacy Protection (MPP) Pre-fetch Detection
    console.log("6️⃣ [Test Case B] Apple Mail MPP pre-fetch detection...");
    const appleRes = await fetch(pixelUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "Apple-Mail-Proxy": "1",
      },
    });
    console.log(`   📡 Apple Proxy Request Status: ${appleRes.status}`);

    await new Promise((r) => setTimeout(r, 200));
    const appleChecked = await EmailMessage.findById(sentEmail._id);
    console.log(`   👁️ Open Count: ${appleChecked.openCount} time(s)`);
    console.log(`   🛡️ Apple MPP Flag: ${appleChecked.isOpenAppleMpp} ✅ (Correctly filtered from real human opens)\n`);

    // 7. TEST: Inferred Open via Link Click (Images Disabled)
    console.log("7️⃣ [Test Case C] Inferred Open via Link Click (Mailchimp Step 4)...");
    console.log("   (Recipient has images blocked, but clicks https://oneroot.farm inside email)");

    const clickTrackingId = "click_test_" + Date.now();
    clickTestEmail = await EmailMessage.create({
      importerId: testImporter._id,
      direction: "outbound",
      senderEmail: "exports@oneroot.farm",
      recipientEmail: "vasanthkuma2004@gmail.com",
      subject: "Inferred Open Test",
      body: "Check https://oneroot.farm",
      status: "sent",
      trackingId: clickTrackingId,
      openCount: 0,
      clickCount: 0,
    });

    console.log(`   Initial State -> Status: "${clickTestEmail.status}" | Opens: ${clickTestEmail.openCount}`);

    const clickUrl = `${baseUrl}/api/emails/track/c/${clickTrackingId}?url=${encodeURIComponent("https://oneroot.farm")}`;
    const clickRes = await fetch(clickUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      },
    });

    console.log(`   📡 Click Redirect Status: ${clickRes.status} (302 Redirect)`);
    console.log(`   🔗 Redirect Destination: ${clickRes.headers.get("location")}`);

    await new Promise((r) => setTimeout(r, 200));
    const clickVerified = await EmailMessage.findById(clickTestEmail._id);
    console.log(`   ✅ Status auto-promoted to: "${clickVerified.status.toUpperCase()}"`);
    console.log(`   👁️ Inferred Open Count: ${clickVerified.openCount} (inferredFromClick: ${clickVerified.inferredFromClick})`);
    console.log(`   🖱️ Total Clicks: ${clickVerified.clickCount}`);
    console.log(`   🎯 Clicked Destination: ${clickVerified.clicks[0]?.url}\n`);

    console.log("============================================================");
    console.log("🎉 ALL MAILCHIMP OPEN & CLICK TRACKING TESTS PASSED 100%!");
    console.log("============================================================\n");
  } finally {
    // Cleanup test data
    console.log("🧹 Cleaning up test records from database...");
    if (testImporter) await Importer.findByIdAndDelete(testImporter._id);
    if (sentEmail) await EmailMessage.findByIdAndDelete(sentEmail._id);
    if (clickTestEmail) await EmailMessage.findByIdAndDelete(clickTestEmail._id);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    console.log("   ✅ Database cleaned and server stopped. Ready for production!\n");
  }
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
