const mongoose = require("mongoose");

function resolveMongoUri() {
  const raw = (process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sales-crm").trim();
  const dbName = process.env.MONGODB_DB_NAME?.trim();
  if (!dbName) return raw;

  const [base, query = ""] = raw.split("?");
  const withoutTrailingSlash = base.replace(/\/+$/, "");
  const hasDbPath = /\/[^/]+$/.test(withoutTrailingSlash.replace(/^mongodb(\+srv)?:\/\/[^/]+/, ""));

  if (hasDbPath) return raw;

  const uri = `${withoutTrailingSlash}/${dbName}`;
  return query ? `${uri}?${query}` : uri;
}

async function connectDB() {
  const uri = resolveMongoUri();
  await mongoose.connect(uri);
  console.log(`MongoDB connected (database: ${mongoose.connection.db.databaseName})`);
}

module.exports = connectDB;
