const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const Lead = require("../src/models/Lead");
const User = require("../src/models/User");

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function firstToken(value) {
  return normalizeName(value).split(" ")[0] || "";
}

function addToMultiMap(map, key, value) {
  if (!key) return;
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

function resolveUserForResponsiblePerson(name, usersByExact, usersByFirst) {
  const normalized = normalizeName(name);
  if (!normalized) return null;

  const exact = usersByExact.get(normalized);
  if (exact) return exact;

  const first = firstToken(normalized);
  const firstMatches = usersByFirst.get(first) || [];
  if (firstMatches.length === 1) return firstMatches[0];

  // Fallback for minor spelling differences (e.g. Aadarsh vs Adarsh).
  const similar = [];
  for (const [candidate, user] of usersByExact.entries()) {
    if (levenshtein(normalized, candidate) <= 2) {
      similar.push(user);
    }
  }
  if (similar.length === 1) return similar[0];

  return null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}

async function backfillCreatedBy() {
  await connectDB();

  const users = await User.find({}, { _id: 1, name: 1 }).lean();
  if (!users.length) {
    console.log("No users found. Nothing to update.");
    return;
  }

  const usersByExact = new Map();
  const usersByFirst = new Map();
  for (const user of users) {
    const normalized = normalizeName(user.name);
    if (!normalized) continue;
    if (!usersByExact.has(normalized)) {
      usersByExact.set(normalized, user);
    }
    addToMultiMap(usersByFirst, firstToken(normalized), user);
  }

  const leads = await Lead.find(
    { $or: [{ createdBy: { $exists: false } }, { createdBy: null }] },
    { _id: 1, responsiblePerson: 1 }
  ).lean();

  let updatedCount = 0;
  for (const lead of leads) {
    const user = resolveUserForResponsiblePerson(
      lead.responsiblePerson,
      usersByExact,
      usersByFirst
    );
    if (!user) continue;

    const result = await Lead.collection.updateOne(
      {
        _id: new mongoose.Types.ObjectId(lead._id),
        $or: [{ createdBy: { $exists: false } }, { createdBy: null }],
      },
      { $set: { createdBy: new mongoose.Types.ObjectId(user._id) } }
    );
    updatedCount += result.modifiedCount || 0;
  }

  console.log(`Backfill complete. Updated ${updatedCount} lead(s).`);

  const remaining = await Lead.find(
    { $or: [{ createdBy: { $exists: false } }, { createdBy: null }] },
    { responsiblePerson: 1 }
  ).lean();

  const remainingNames = Array.from(
    new Set(
      remaining
        .map((lead) => String(lead.responsiblePerson || "").trim())
        .filter(Boolean)
    )
  );

  if (remainingNames.length) {
    console.log(
      "Still missing createdBy because responsiblePerson did not match any user:"
    );
    for (const name of remainingNames) {
      console.log(`- ${name}`);
    }
  }
}

backfillCreatedBy()
  .catch((err) => {
    console.error("Backfill failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
