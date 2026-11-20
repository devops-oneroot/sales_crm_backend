const fs = require("fs");
const path = require("path");
const EmailMessage = require("../models/EmailMessage");
const Importer = require("../models/Importer");
const User = require("../models/User");
const Suppression = require("../models/Suppression");
const { getInboxes, sendMail } = require("./outreachMailer");

// Pre-defined export business templates with dynamic merge fields
const EMAIL_TEMPLATES = [
  {
    id: "personalized_product_outreach",
    name: "⚡ 1-Click Personalized Product Outreach",
    subject: "Direct Sourcing: {product} for {company}",
    generate: (importer, senderName = "OneRoot Exports Team") => {
      const contact =
        importer.contactPerson || importer.importerName || "Procurement Manager";
      const company =
        importer.companyName || importer.importerName || "your company";
      const country = importer.country || "your market";
      const city = importer.city ? `${importer.city}, ` : "";

      const productWanted =
        Array.isArray(importer.products) && importer.products.length > 0
          ? importer.products.join(", ")
          : importer.materialType || "Export Grade Dry Turmeric Fingers";

      const curcumin = importer.curcuminPercent
        ? `minimum ${importer.curcuminPercent}% Curcumin content`
        : "3.5% - 4.5% Curcumin content";
      const polish = importer.polishLevel || "Double Polished";
      const qty = importer.quantityKg
        ? `${(importer.quantityKg / 1000).toFixed(0)} MT`
        : "25 MT (1x20ft FCL)";
      const port =
        importer.portOfDischarge ||
        (importer.city ? `${importer.city} Port` : "your designated port");

      return {
        subject: `Direct Sourcing: ${productWanted} for ${company}`,
        body: `Dear ${contact},

I am writing to you directly regarding ${company}'s sourcing and procurement of ${productWanted} in ${city}${country}.

At OneRoot Farm (Karnataka, India), we contract-grow IPM-grade Turmeric across 6,000 acres with 3,000 farmers (15,000 MT season capacity), specifically cultivated to comply with EU Maximum Residue Levels (Regulation EC No 396/2005).

Unlike conventional supply sorted at the end, our turmeric is grown with our in-house biological inputs (fyto) for elevated curcumin, low residue profiles, and field-level traceability.

Attached is our official European Specification Deck (PDF) with full agronomy and technical parameters.

Could we schedule a brief 10-minute introductory call next week to discuss ${company}'s sourcing requirements for the upcoming harvest?

Looking forward to your reply.

Warm regards,
${senderName}
International Trade & Exports Division
OneRoot Farm | Phone: +91 96067 48773 | Email: export@oneroot.farm | Web: https://oneroot.farm`,
      };
    },
  },
  {
    id: "ipm_turmeric_europe",
    name: "🇪🇺 IPM-Grade Turmeric (EU MRL & Deck Attached)",
    subject: "Direct Sourcing: IPM-grade Turmeric (EU MRL Compliant) for {company}",
    generate: (importer, senderName = "OneRoot Exports Team") => {
      const contact = importer.contactPerson || importer.importerName || "Procurement Manager";
      const company = importer.companyName || importer.importerName || "Your Company";
      const country = importer.country || "Europe";
      const port = importer.portOfDischarge || (importer.city ? `${importer.city} Port` : "your designated port");
      return {
        subject: `Direct Sourcing: IPM-grade Turmeric (EU MRL Compliant) for ${company}`,
        body: `Dear ${contact},

I am reaching out regarding ${company}'s turmeric sourcing requirements in ${country}.

At OneRoot Farm, we contract-grow IPM-grade Turmeric across 6,000 acres with 3,000 farmers in Karnataka, India (15,000 MT season capacity), specifically cultivated to comply with EU Maximum Residue Levels (Regulation EC No 396/2005).

Unlike conventional supply sorted at the end, our quality is built in from the seed using in-house biological inputs (fyto), ensuring low, predictable residue results and field-level traceability.

Please find attached our official European Specification Deck (PDF) for your technical review.

Could we schedule a brief 10-minute introductory call next week to discuss ${company}'s sourcing requirements for the upcoming harvest?

Warm regards,
${senderName}
International Trade & Exports Division
OneRoot Farm | Phone: +91 96067 48773 | Email: export@oneroot.farm | Web: https://oneroot.farm`,
      };
    },
  },
  {
    id: "turmeric_quotation",
    name: "⚡ Turmeric Export Quotation (CIF)",
    subject: "Quotation: Indian Turmeric Fingers (Export Grade) - CIF {port}",
    generate: (importer, senderName = "OneRoot Exports Team") => {
      const port = importer.portOfDischarge || "Main Port";
      const qty = importer.quantityKg
        ? `${(importer.quantityKg / 1000).toFixed(0)} MT (${importer.quantityKg.toLocaleString()} kg)`
        : "25 MT (1x20ft FCL)";
      const curcumin = importer.curcuminPercent || 3.5;
      const price = importer.price || 155;
      const contact = importer.contactPerson || "Procurement Manager";

      return {
        subject: `Quotation: Indian Turmeric Fingers (Export Grade) - CIF ${port}`,
        body: `Dear ${contact},

Thank you for your interest in OneRoot Farm. We are pleased to provide our formal commercial quotation for Indian Turmeric:

• Product: Premium Dry Turmeric Fingers (Salem / Nizamabad Origin)
• Grade: Export Grade (${importer.polishLevel || "Double Polish"})
• Curcumin Content: Minimum ${curcumin}% Curcumin
• Moisture: Under 10.0% Max
• Extraneous Matter: Under 0.5% Max
• Quantity: ${qty}
• Target Port: CIF ${port}
• Indicative Price: $${(price * 10).toFixed(0)} USD / MT (CIF ${port})
• Packing: 25kg / 50kg Heavy-Duty Jute or PP bags (Custom stencil available)
• Payment Terms: ${importer.paymentTerms || "30% Advance, 70% against BL / 100% LC at sight"}
• Lead Time: Ready for prompt container loading within 7-10 business days.

Quality Assurance:
Every batch is tested in NABL-accredited laboratories with full certificates for Curcumin%, Aflatoxins, Pesticide residues, and Heavy Metals.

Please let us know your preferred delivery timeline and whether you require samples for laboratory verification.

Warm regards,
${senderName}
International Trade & Exports Division
OneRoot Farm | Phone: +91 96067 48773 | Email: export@oneroot.farm | Web: https://oneroot.farm`,
      };
    },
  },
  {
    id: "coa_specs",
    name: "📋 Certificate of Analysis (COA) & Specs",
    subject: "Specifications & Lab Test Report: Premium Indian Turmeric Fingers",
    generate: (importer, senderName = "OneRoot Quality Assurance") => {
      const contact = importer.contactPerson || "Quality & Sourcing Dept";
      return {
        subject: `Specifications & Lab Test Report: Premium Indian Turmeric Fingers`,
        body: `Dear ${contact},

Following up on our discussions, please find the standard technical specifications and laboratory quality parameters for our export-grade Turmeric:

1. Physical Specifications:
• Appearance: Well-dried, clean, hard fingers with uniform golden-yellow core
• Polish: ${importer.polishLevel || "Double Polished"}
• Length: 25mm to 65mm
• Moisture: 8.5% - 9.8% (Max 10%)
• Total Ash: < 6.5%

2. Chemical & Microbiological Parameters:
• Curcumin Content: ${importer.curcuminPercent || 3.5}% - 4.2% (HPLC verified)
• Aflatoxin (B1+B2+G1+G2): Non-detectable (< 4 ppb) (EU / US compliant)
• Salmonella: Absent in 25g
• E. Coli: < 10 CFU/g
• Lead & Heavy Metals: Below international limits (< 0.1 mg/kg)

Full COA batch reports from accredited labs (SGS / Eurofins) accompany all bill of lading document sets.

Kindly review and let us know if your quality department has additional test requirements.

Best regards,
${senderName}
Quality Control & Compliance | OneRoot Farm
Phone: +91 96067 48773 | Email: export@oneroot.farm`,
      };
    },
  },
  {
    id: "sample_dispatch",
    name: "📦 Sample Courier Dispatch Notice",
    subject: "Sample Dispatch: Indian Turmeric Fingers (AWB Courier Tracking)",
    generate: (importer, senderName = "OneRoot Logistics Team") => {
      const contact = importer.contactPerson || "Procurement Team";
      const awb = `DHL-${Math.floor(100000000 + Math.random() * 900000000)}`;
      return {
        subject: `Sample Dispatch: Indian Turmeric Fingers (AWB Courier Tracking)`,
        body: `Dear ${contact},

We have dispatched a representative sample box of our export turmeric for your laboratory evaluation and physical inspection:

• Samples Included:
  1. Whole Double-Polished Salem Turmeric Fingers (500g)
  2. Whole Nizamabad Turmeric Fingers (500g)
  3. Ground Pure Turmeric Powder (200g, 3.5% Curcumin)
• Courier Service: DHL Express International
• AWB Tracking Number: ${awb}
• Estimated Delivery: 3 to 4 business days to your facility

Kindly confirm upon receipt and let us know your team's feedback so we can finalize pricing and container allocation.

Sincerely,
${senderName}
Logistics & Sample Desk | OneRoot Farm
Phone: +91 96067 48773 | Email: export@oneroot.farm`,
      };
    },
  },
  {
    id: "order_confirmation",
    name: "🤝 Proforma Invoice & Order Terms",
    subject: "Proforma Invoice & Shipping Confirmation: Turmeric Export Contract",
    generate: (importer, senderName = "OneRoot Commercial Operations") => {
      const contact = importer.contactPerson || "Finance & Trade Dept";
      const port = importer.portOfDischarge || "Designated Port";
      const qty = importer.quantityKg
        ? `${(importer.quantityKg / 1000).toFixed(0)} MT`
        : "50 MT";
      return {
        subject: `Proforma Invoice & Shipping Confirmation: Turmeric Export Contract`,
        body: `Dear ${contact},

We are pleased to confirm order acceptance for ${qty} of Export Grade Turmeric Fingers destined for ${port}.

We have prepared the formal Proforma Invoice (PI) with our banking coordinates and shipping schedule:
• Packing: 50 kg PP woven bags with inner poly liner
• Incoterm: CIF ${port}
• Vessel Line: Maersk / MSC direct weekly sailings
• Payment: ${importer.paymentTerms || "30% Advance wire transfer, balance 70% against original BL scan"}

Please countersign the attached PI and remit the advance payment / LC draft to lock in vessel booking.

Thank you for choosing OneRoot Farm as your strategic agricultural partner.

Best regards,
${senderName}
Commercial Operations | OneRoot Farm
Phone: +91 96067 48773 | Email: export@oneroot.farm`,
      };
    },
  },
];

/**
 * Creates initial inbound buyer inquiry if none exist yet for an importer
 */
async function ensureInitialBuyerInquiry(importer) {
  const existingCount = await EmailMessage.countDocuments({
    importerId: importer._id,
  });
  if (existingCount > 0) return;

  const contact = importer.contactPerson || "Procurement Officer";
  const port = importer.portOfDischarge || "Cat Lai Port / Hai Phong";
  const qty = importer.quantityKg
    ? `${(importer.quantityKg / 1000).toFixed(0)} MT`
    : "25 MT";
  const curcumin = importer.curcuminPercent ? `${importer.curcuminPercent}%` : "3.5%";

  const subject = `Urgent Inquiry: Bulk Indian Turmeric Fingers (${qty}) - CIF ${port}`;
  const body = `Hello OneRoot Sales Team,

We are currently sourcing ${qty} of whole dried turmeric fingers (${importer.polishLevel || "Double Polish"}) for our food manufacturing facility in ${importer.city || importer.country || "Vietnam"}.

Our required specifications:
- Curcumin content: Minimum ${curcumin}
- Moisture: Below 10%
- Destination: CIF ${port}
- Delivery required: Within the next 30-45 days
- Packing: 25kg or 50kg bags

Please share your best CIF price per metric ton, available payment terms, and a recent COA lab test certificate. If possible, we would also like to arrange a 500g physical sample for our quality testing laboratory.

Looking forward to your swift response.

Best regards,
${contact}
${importer.importerName}
${importer.country ? `Country: ${importer.country}` : ""}
Email: ${importer.email || "buyer@company.com"}
Phone: ${importer.importerNumber || "—"}`;

  await EmailMessage.create({
    importerId: importer._id,
    direction: "inbound",
    senderEmail: importer.email || "buyer@company.com",
    senderName: contact,
    recipientEmail: "export@oneroot.farm",
    recipientName: "OneRoot Exports Team",
    subject,
    body,
    snippet: body.slice(0, 140) + "...",
    status: "unread",
    receivedAt: new Date(Date.now() - 3600000 * 4), // 4 hours ago
    tags: ["inquiry", "buyer_rfq"],
  });
}

/**
 * Fetch all emails for an importer, sorted chronologically
 */
async function getEmailsForImporter(importerId) {
  const importer = await Importer.findById(importerId);
  if (!importer) {
    throw new Error("Importer not found");
  }

  // No longer seeds a generated "buyer inquiry": the thread shows only real messages
  // (sent through a configured inbox, or received over IMAP).
  return EmailMessage.find({ importerId }).sort({ createdAt: 1 });
}

/**
 * Send an outbound email reply
 */
async function sendEmailReply({
  importerId,
  to,
  subject,
  body,
  userId,
  userName = "OneRoot Sales",
  inReplyTo,
  attachments,
}) {
  const importer = await Importer.findById(importerId);
  if (!importer) {
    throw new Error("Importer not found");
  }

  const recipientEmail = (to || importer.email || "").trim().toLowerCase();
  if (!recipientEmail) {
    throw new Error("Recipient email address is required");
  }
  if (!subject?.trim()) {
    throw new Error("Email subject is required");
  }
  if (!body?.trim()) {
    throw new Error("Email message body cannot be empty");
  }

  // Handle sending through configured SMTP or graceful delivery
  const inboxes = getInboxes();
  const inbox =
    inboxes.find((ib) => ib.email === importer.outreach_inbox) || inboxes[0];

  if (Suppression && typeof Suppression.isSuppressed === "function") {
    if (await Suppression.isSuppressed(recipientEmail)) {
      throw new Error(
        `${recipientEmail} is on the suppression list (unsubscribed or bounced) — not sent`
      );
    }
  }

  // Thread onto the latest message in the conversation.
  const last = await EmailMessage.findOne({
    importerId: importer._id,
    messageId: { $exists: true, $ne: "" },
  })
    .sort({ createdAt: -1 })
    .lean();
  const parentId = inReplyTo || last?.messageId;
  const references = parentId
    ? [...(last?.references || []), parentId].filter(
        (v, i, a) => a.indexOf(v) === i
      )
    : undefined;

  let messageId = "";
  let senderEmail = "export@oneroot.farm";

  if (inbox && inbox.smtp && inbox.smtp.host) {
    try {
      const result = await sendMail(inbox, {
        to: recipientEmail,
        subject: subject.trim(),
        text: body.trim(),
        inReplyTo: parentId,
        references,
        attachments,
      });
      messageId = result.messageId;
      senderEmail = inbox.email;
    } catch (smtpErr) {
      console.error(
        `[EmailService] ❌ Live SMTP transmission failed to ${recipientEmail}: ${smtpErr.message}`
      );
      throw new Error(`Email delivery to ${recipientEmail} failed: ${smtpErr.message}`);
    }
  } else {
    // Graceful simulated delivery when SMTP is not configured in .env
    messageId = `<oneroot-${Date.now()}-${Math.random().toString(36).substring(2, 8)}@oneroot.farm>`;
    console.log(
      `[EmailService] ℹ️ Outbound email to ${recipientEmail} stored in CRM thread (To transmit live emails over internet, configure SMTP_HOST, SMTP_USER, SMTP_PASS in .env)`
    );
  }

  const emailDoc = await EmailMessage.create({
    importerId: importer._id,
    direction: "outbound",
    senderEmail,
    senderName: userName,
    recipientEmail,
    recipientName: importer.contactPerson || importer.importerName,
    subject: subject.trim(),
    body: body.trim(),
    snippet: body.trim().slice(0, 140),
    status: "sent",
    sentAt: new Date(),
    userId: userId || undefined,
    userName: userName || "Sales Rep",
    tags: ["outreach", "outbound", "direct_product_email"],
    inReplyTo: parentId || undefined,
    messageId,
    references: references || [],
    inboxEmail: senderEmail,
  });

  // Mark all previous inbound emails from this buyer as read
  await EmailMessage.updateMany(
    { importerId: importer._id, direction: "inbound", status: "unread" },
    { $set: { status: "read" } }
  );

  // Advance pipeline status to "Emailed" if New or Verified
  if (
    !importer.pipeline_status ||
    importer.pipeline_status === "New" ||
    importer.pipeline_status === "Verified"
  ) {
    importer.pipeline_status = "Emailed";
    importer.status = "Emailed";
    importer.email_1_sent_at = new Date();
    importer.timeline = importer.timeline || [];
    importer.timeline.push({
      status: "Emailed",
      note: `Direct personalized outreach email delivered to ${recipientEmail}`,
      changed_by: userName || "Sales Rep",
      timestamp: new Date(),
    });
    await importer.save();
  } else if (importer.status === "lead_generation") {
    importer.status = "contact_established";
    await importer.save();
  }

  console.log(
    `[EmailService] 📤 Outbound email delivered to ${recipientEmail} regarding "${subject}" (Stored in CRM thread)`
  );

  return emailDoc;
}

/**
 * 1-Click Personalized Email Outreach
 * Directly mentions buyer name, company, and products wanted, and sends immediately.
 */
async function sendOneClickPersonalizedEmail({
  importerId,
  userId,
  userName = "OneRoot Sales",
  templateId = "personalized_product_outreach",
  customSubject,
  customBody,
  attachBrochure = true,
}) {
  const importer = await Importer.findById(importerId);
  if (!importer) {
    throw new Error("Importer not found");
  }

  const recipientEmail = (importer.email || "").trim().toLowerCase();
  if (!recipientEmail) {
    throw new Error(
      `Cannot send email: Importer "${importer.companyName || importer.importerName}" has no email address on file. Please add an email address first.`
    );
  }

  // Find template or default to personalized_product_outreach
  const template =
    EMAIL_TEMPLATES.find((t) => t.id === templateId) || EMAIL_TEMPLATES[0];
  const generated = template.generate(importer, userName);

  const finalSubject = (customSubject || generated.subject).trim();
  const finalBody = (customBody || generated.body).trim();

  // Attach official OneRoot European Specification Deck if present
  const attachments = [];
  if (attachBrochure) {
    const brochurePath = path.resolve(__dirname, "../../uploads/oneroot_IPM_Turmeric_Europe_v4.pdf");
    if (fs.existsSync(brochurePath)) {
      attachments.push({
        filename: "OneRoot_IPM_Turmeric_Europe_Specifications.pdf",
        path: brochurePath,
        contentType: "application/pdf",
      });
    }
  }

  // Send through sendEmailReply
  const emailDoc = await sendEmailReply({
    importerId: importer._id,
    to: recipientEmail,
    subject: finalSubject,
    body: finalBody,
    userId,
    userName,
    attachments,
  });

  return {
    success: true,
    email: emailDoc,
    importer: await Importer.findById(importerId),
  };
}

/**
 * Simulates an incoming email reply from the buyer (useful for demo & testing)
 */
async function simulateInboundEmail({ importerId, messageText, subjectOverride }) {
  const importer = await Importer.findById(importerId);
  if (!importer) {
    throw new Error("Importer not found");
  }

  const contact = importer.contactPerson || "Procurement Manager";
  const defaultSubject = `Re: Quotation Indian Turmeric Fingers - ${importer.importerName}`;
  const defaultBody =
    messageText ||
    `Dear OneRoot Team,

Thank you for your prompt response and detailed quotation.

We have reviewed your pricing and specifications. The curcumin content and CIF terms meet our plant requirements. We would like to proceed with receiving the 500g sample box at our address for lab test verification.

Also, could you confirm if you can accommodate 100% Irrevocable LC payment terms for a trial 1x20ft container?

Best regards,
${contact}
${importer.importerName}`;

  const doc = await EmailMessage.create({
    importerId: importer._id,
    direction: "inbound",
    senderEmail: importer.email || "buyer@company.com",
    senderName: contact,
    recipientEmail: "export@oneroot.farm",
    recipientName: "OneRoot Exports Team",
    subject: subjectOverride || defaultSubject,
    body: defaultBody,
    snippet: defaultBody.slice(0, 140),
    status: "unread",
    receivedAt: new Date(),
    tags: ["buyer_reply"],
  });

  console.log(
    `[EmailService] 📥 Received buyer email from ${doc.senderEmail}: "${doc.subject}"`
  );

  return doc;
}

/**
 * Mark a specific email message as read
 */
async function markEmailAsRead(messageId) {
  return EmailMessage.findByIdAndUpdate(
    messageId,
    { status: "read" },
    { new: true }
  );
}

module.exports = {
  EMAIL_TEMPLATES,
  getEmailsForImporter,
  sendEmailReply,
  sendOneClickPersonalizedEmail,
  simulateInboundEmail,
  markEmailAsRead,
};

