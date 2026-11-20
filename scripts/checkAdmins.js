const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../models/User");

async function main() {
  await connectDB();
  const target = await User.findOne({ phone: "8792006444" }).lean();
  const admins = await User.find({ role: "admin" }, { name: 1, phone: 1, role: 1 }).lean();
  console.log("8792006444:", target ? { name: target.name, phone: target.phone, role: target.role } : "NOT FOUND");
  console.log("All admins:", admins);
  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
