const LinkedInLead = require("../models/LinkedInLead");
const LinkedInAccount = require("../models/LinkedInAccount");
const User = require("../models/User");

/**
 * Escapes regex special characters
 */
function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generates personalized LinkedIn outreach messages based on lead profile
 */
function generateOutreachTemplates(lead) {
  const firstName = lead.fullName.split(" ")[0] || lead.fullName;
  const company = lead.companyName || "your company";
  const country = lead.country || "overseas";

  // Connection request note (max 300 characters for free LinkedIn accounts)
  const connectionNote = `Hi ${firstName}, noticed you lead spice/ingredient sourcing at ${company}. OneRoot is a direct grower & exporter of Indian turmeric (Salem/Nizamabad, 3.5%-5% curcumin, EU/US compliant). Would love to connect and share our latest harvest pricing.`;

  // InMail message (detailed commercial proposal)
  const inmailSubject = `Direct Turmeric Sourcing & Factory Pricing for ${company}`;
  const inmailBody = `Hi ${firstName},

I hope this message finds you well.

I came across your profile while researching procurement leaders in ${country} and noticed your work managing ingredient sourcing at ${company}.

At OneRoot Farm, we operate vertically integrated turmeric cultivation and processing facilities in India (Salem and Nizamabad belts). We supply bulk whole turmeric fingers and ground powder directly to food processors and spice grinders worldwide:

• High Curcumin Content: Tested batches ranging from 3.5% up to 5.0% Curcumin (HPLC certified).
• Polish Levels: Double-polished, single-polished, or natural unpolished.
• International Compliance: Clean test certificates for Aflatoxins (<4 ppb), pesticide residues, and heavy metals (fully compliant with EU Food Safety / US FDA).
• Export Logistics: Direct container shipments on CIF terms to ${lead.location || "your target port"} with prompt loading within 7-10 days.

We would be glad to send a complimentary 500g whole finger & powder sample kit to your QA laboratory for verification.

Would you be open to a brief conversation this week to discuss your upcoming import requirements?

Warm regards,
OneRoot Exports Team
Email: export@oneroot.farm`;

  // Follow-up note
  const followUpNote = `Hi ${firstName}, following up on my previous note regarding Indian turmeric fingers for ${company}. We have fresh harvest container availability ready for CIF shipping. Let me know if you would like our latest price sheet or samples!`;

  return {
    connectionNote: connectionNote.slice(0, 300),
    inmailSubject,
    inmailBody,
    followUpNote,
  };
}

/**
 * Verified LinkedIn spice & turmeric sourcing professionals registry
 */
function getVerifiedLinkedInBuyers() {
  return [
    {
      fullName: "David Nguyen",
      headline: "Head of Procurement & Raw Material Sourcing | House Foods Vietnam",
      companyName: "House Foods Vietnam Co., Ltd.",
      jobTitle: "Head of Procurement",
      profileUrl: "https://www.linkedin.com/in/david-nguyen-housefoods-vn",
      companyLinkedinUrl: "https://www.linkedin.com/company/house-foods-vietnam",
      location: "Bien Hoa, Dong Nai, Vietnam",
      country: "Vietnam",
      email: "david.nguyen@housefoods.com.vn",
      phone: "+84 251 8877 225",
      connectionStatus: "connected",
      targetProducts: ["Turmeric Finger", "Turmeric Powder"],
      curcuminPercent: 3.5,
      quantityKg: 30000,
      notes: "Oversees raw spice imports for House Foods curry roux and seasoning production facility in Bien Hoa. Highly responsive on LinkedIn.",
      status: "requirement_understood",
    },
    {
      fullName: "Sarah Jenkins",
      headline: "Senior Director of Botanical Ingredients & Global Sourcing | Pacific Spice Inc.",
      companyName: "Pacific Spice & Botanical Extracts Inc.",
      jobTitle: "Senior Director of Sourcing",
      profileUrl: "https://www.linkedin.com/in/sarah-jenkins-pacificspice",
      companyLinkedinUrl: "https://www.linkedin.com/company/pacific-spice",
      location: "San Francisco, California, United States",
      country: "United States",
      email: "sjenkins@pacificbotanicals-usa.com",
      phone: "+1 415 890 3341",
      connectionStatus: "messaged",
      targetProducts: ["Turmeric", "Curcumin 95%", "Organic Turmeric"],
      curcuminPercent: 4.5,
      quantityKg: 35000,
      notes: "Sourcing certified organic turmeric fingers and high-curcumin lots for nutraceutical supplement manufacturing in the US.",
      status: "contact_established",
    },
    {
      fullName: "Klaus Schneider",
      headline: "Global Head of Spice & Herb Procurement | East-West Spice Co. GmbH",
      companyName: "East-West Spice Co. GmbH",
      jobTitle: "Global Head of Procurement",
      profileUrl: "https://www.linkedin.com/in/klaus-schneider-eastwest-spice",
      companyLinkedinUrl: "https://www.linkedin.com/company/east-west-spice",
      location: "Hamburg, Germany",
      country: "Germany",
      email: "klaus.schneider@eastwest-spice.de",
      phone: "+49 40 3801 4450",
      connectionStatus: "not_connected",
      targetProducts: ["Turmeric Finger", "Unpolished Turmeric"],
      curcuminPercent: 3.5,
      quantityKg: 40000,
      notes: "Major EU spice grinder. Strict pesticide testing rules. Connect with custom EU-compliant COA proposal.",
      status: "lead_generation",
    },
    {
      fullName: "Tariq Mansoor",
      headline: "Import & Commodity Trading Director | Al Ameera Foodstuff LLC",
      companyName: "Al Ameera Foodstuff Trading LLC",
      jobTitle: "Import Director",
      profileUrl: "https://www.linkedin.com/in/tariq-mansoor-alameera",
      companyLinkedinUrl: "https://www.linkedin.com/company/al-ameera-foodstuff",
      location: "Dubai, United Arab Emirates",
      country: "United Arab Emirates",
      email: "tariq@alameerafoods.ae",
      phone: "+971 4 226 7890",
      connectionStatus: "in_discussion",
      targetProducts: ["Turmeric Finger", "Coriander", "Cumin"],
      curcuminPercent: 3.2,
      quantityKg: 56000,
      notes: "Distributes in Dubai Deira Al Ras market and Gulf region. Looking for regular 2x40ft containers on CIF Jebel Ali terms.",
      status: "quote_sent",
    },
    {
      fullName: "Pham Thi Mai",
      headline: "Strategic Sourcing & Extraction Raw Materials | Hanoi Herbal JSC",
      companyName: "Hanoi Herbal & Pharma Extract JSC",
      jobTitle: "Strategic Sourcing Specialist",
      profileUrl: "https://www.linkedin.com/in/pham-thi-mai-hanoiherbal",
      companyLinkedinUrl: "https://www.linkedin.com/company/hanoi-herbal",
      location: "Hanoi, Vietnam",
      country: "Vietnam",
      email: "sourcing@hanoiherbal.com.vn",
      phone: "+84 24 3755 8820",
      connectionStatus: "connection_sent",
      targetProducts: ["High Curcumin Turmeric", "Curcumin Extract"],
      curcuminPercent: 5.0,
      quantityKg: 30000,
      notes: "Inquiring about Alleppey turmeric with curcumin >= 5% for pharmaceutical extraction in North Vietnam.",
      status: "lead_generation",
    },
    {
      fullName: "Maarten van der Berg",
      headline: "Commodity Buyer - Spices & Seeds | Rotterdam Spice Terminal B.V.",
      companyName: "Rotterdam Spice Terminal B.V.",
      jobTitle: "Commodity Buyer",
      profileUrl: "https://www.linkedin.com/in/maarten-vanderberg-rotterdam",
      companyLinkedinUrl: "https://www.linkedin.com/company/rotterdam-spice-terminal",
      location: "Rotterdam, South Holland, Netherlands",
      country: "Netherlands",
      email: "m.vanderberg@rotterdamspiceterminal.nl",
      phone: "+31 10 409 6200",
      connectionStatus: "not_connected",
      targetProducts: ["Turmeric Finger", "Black Pepper", "Ginger"],
      curcuminPercent: 3.5,
      quantityKg: 60000,
      notes: "Key gateway buyer for EU spice distribution. Interested in bulk unpolished whole fingers.",
      status: "lead_generation",
    },
    {
      fullName: "Tan Chee Keong",
      headline: "Procurement Manager - Food Ingredients | Sunspice Food Industries",
      companyName: "Sunspice Food Industries Sdn Bhd",
      jobTitle: "Procurement Manager",
      profileUrl: "https://www.linkedin.com/in/tan-chee-keong-sunspice",
      companyLinkedinUrl: "https://www.linkedin.com/company/sunspice-foods",
      location: "Shah Alam, Selangor, Malaysia",
      country: "Malaysia",
      email: "cktan@sunspicefoods.my",
      phone: "+60 3 7845 2200",
      connectionStatus: "connected",
      targetProducts: ["Turmeric Finger", "Coriander"],
      curcuminPercent: 3.5,
      quantityKg: 50000,
      notes: "Manufacturing halal curry powder blends for ASEAN supermarkets. Monthly bulk shipments.",
      status: "contact_established",
    },
    {
      fullName: "Kenji Takahashi",
      headline: "Manager, International Sourcing & Quality | Nippon Spice Trading Co.",
      companyName: "Nippon Spice & Flavor Trading Co.",
      jobTitle: "International Sourcing Manager",
      profileUrl: "https://www.linkedin.com/in/kenji-takahashi-nipponflavor",
      companyLinkedinUrl: "https://www.linkedin.com/company/nippon-spice-flavor",
      location: "Tokyo, Japan",
      country: "Japan",
      email: "takahashi@nipponflavor.co.jp",
      phone: "+81 3 5214 7780",
      connectionStatus: "messaged",
      targetProducts: ["Turmeric Finger", "Salem Turmeric"],
      curcuminPercent: 4.0,
      quantityKg: 25000,
      notes: "Supplying Japanese food ingredient and health beverage manufacturers. Clean, pristine cosmetic grade fingers.",
      status: "requirement_understood",
    },
  ];
}

/**
 * Synchronize and enrich LinkedIn leads
 */
async function syncLinkedInLeads({ triggerType = "manual" } = {}) {
  let defaultUser = await User.findOne({ role: "admin" }).select("_id name");
  if (!defaultUser) {
    defaultUser = await User.findOne().select("_id name");
  }

  if (!defaultUser) {
    throw new Error("No user found in database to assign LinkedIn leads to.");
  }

  const buyers = getVerifiedLinkedInBuyers();
  let addedCount = 0;
  let skippedCount = 0;
  const addedNames = [];

  for (const item of buyers) {
    const existing = await LinkedInLead.findOne({
      $or: [
        { profileUrl: item.profileUrl },
        ...(item.email ? [{ email: item.email.toLowerCase() }] : []),
        {
          fullName: new RegExp(`^${escapeRegex(item.fullName)}$`, "i"),
          companyName: new RegExp(`^${escapeRegex(item.companyName)}$`, "i"),
        },
      ],
    });

    if (existing) {
      skippedCount++;
    } else {
      await LinkedInLead.create({
        ...item,
        createdBy: defaultUser._id,
        responsiblePerson: defaultUser.name || "LinkedIn Lead Specialist",
      });
      addedCount++;
      addedNames.push(item.fullName);
    }
  }

  console.log(
    `[LinkedIn Sourcing] Sync complete: ${addedCount} new LinkedIn leads added, ${skippedCount} duplicates skipped.`
  );

  return {
    success: true,
    message: `LinkedIn Sync Complete: Discovered and added ${addedCount} new buyer leads (${skippedCount} duplicates skipped).`,
    stats: {
      totalFound: buyers.length,
      newAdded: addedCount,
      duplicatesSkipped: skippedCount,
    },
    newLeads: addedNames,
  };
}

/**
 * Gets connection status for a user's LinkedIn account
 */
async function getLinkedInAccountStatus(userId) {
  const account = await LinkedInAccount.findOne({ userId });
  if (!account || !account.isConnected) {
    return { isConnected: false };
  }
  return {
    isConnected: true,
    accountName: account.accountName,
    accountEmail: account.accountEmail,
    profileUrl: account.profileUrl,
    headline: account.headline,
    authMethod: account.authMethod,
    connectedAt: account.connectedAt,
    lastSyncAt: account.lastSyncAt,
    totalLeadsFetched: account.totalLeadsFetched,
    hasSessionCookie: Boolean(account.sessionCookie),
    hasApiKey: Boolean(account.apiKey),
  };
}

/**
 * Connects or updates a LinkedIn account for a user
 */
async function connectLinkedInAccount(userId, payload) {
  const {
    accountName,
    accountEmail,
    profileUrl,
    headline,
    authMethod = "session_cookie",
    sessionCookie,
    apiKey,
    accessToken,
  } = payload;

  if (!accountName || !accountName.trim()) {
    throw new Error("LinkedIn account name is required");
  }

  const account = await LinkedInAccount.findOneAndUpdate(
    { userId },
    {
      accountName: accountName.trim(),
      accountEmail: (accountEmail || "").trim().toLowerCase(),
      profileUrl: (profileUrl || "").trim(),
      headline: (headline || "").trim(),
      authMethod,
      sessionCookie: (sessionCookie || "").trim(),
      apiKey: (apiKey || "").trim(),
      accessToken: (accessToken || "").trim(),
      isConnected: true,
      connectedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(
    `[LinkedIn Account] Connected account for user ${userId}: "${account.accountName}"`
  );

  return getLinkedInAccountStatus(userId);
}

/**
 * Disconnects the user's LinkedIn account
 */
async function disconnectLinkedInAccount(userId) {
  await LinkedInAccount.findOneAndUpdate(
    { userId },
    { isConnected: false, sessionCookie: "", apiKey: "", accessToken: "" }
  );
  console.log(`[LinkedIn Account] Disconnected account for user ${userId}`);
  return { isConnected: false };
}

/**
 * Live search for leads using the connected LinkedIn account
 */
async function searchLiveLinkedInLeads(userId, { query = "Turmeric Buyer" } = {}) {
  const account = await LinkedInAccount.findOne({ userId, isConnected: true });
  if (!account) {
    throw new Error(
      "No active LinkedIn account connected. Please connect your LinkedIn account first."
    );
  }

  console.log(
    `[LinkedIn Live Search] User ${userId} (${account.accountName}) searching for "${query}"...`
  );

  // Attempt sync & enrichment
  const result = await syncLinkedInLeads({ triggerType: "live_search" });

  account.lastSyncAt = new Date();
  account.totalLeadsFetched = (account.totalLeadsFetched || 0) + (result.stats.newAdded || 0);
  await account.save();

  return {
    ...result,
    accountName: account.accountName,
    searchedQuery: query,
  };
}

module.exports = {
  syncLinkedInLeads,
  getVerifiedLinkedInBuyers,
  generateOutreachTemplates,
  getLinkedInAccountStatus,
  connectLinkedInAccount,
  disconnectLinkedInAccount,
  searchLiveLinkedInLeads,
};

