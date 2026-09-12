const dns = require("dns");
const mongoose = require("mongoose");

/** Public resolvers used only when the system's own list is unusable. */
const FALLBACK_DNS = ["1.1.1.1", "8.8.8.8"];

/**
 * mongodb+srv:// needs an SRV lookup, which Node does with its own resolver
 * rather than the OS one. On Windows that resolver sometimes fails to read
 * the adapter settings and falls back to 127.0.0.1, where nothing answers,
 * so the server dies on start with "querySrv ECONNREFUSED". Only step in
 * when the detected list is nothing but loopback; a real configuration is
 * left alone.
 */
function ensureUsableDnsServers() {
  const servers = dns.getServers();
  const isLoopback = (s) => s === "127.0.0.1" || s === "::1";
  if (servers.length && !servers.every(isLoopback)) return;

  dns.setServers(FALLBACK_DNS);
  console.warn(
    `DNS: system resolver reported ${JSON.stringify(servers)} — using ${FALLBACK_DNS.join(", ")} for SRV lookups`
  );
}

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
  if (uri.startsWith("mongodb+srv://")) ensureUsableDnsServers();
  await mongoose.connect(uri);
  console.log(`MongoDB connected (database: ${mongoose.connection.db.databaseName})`);
}

module.exports = connectDB;
