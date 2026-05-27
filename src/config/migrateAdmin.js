const bcrypt = require("bcryptjs");
const User = require("../models/User");

const PRIMARY_ADMIN = {
  phone: "9900768505",
  password: "9900768505",
  name: "Admin",
};

const ADDITIONAL_ADMINS = [
  { phone: "8792006444", password: "8792006444", name: "Admin" },
];

async function migratePrimaryAdmin() {
  const { phone, password, name } = PRIMARY_ADMIN;
  const passwordHash = await bcrypt.hash(password, 10);
  let user = await User.findOne({ phone }).select("+passwordHash");

  if (!user) {
    user = await User.create({
      name,
      phone,
      passwordHash,
      role: "admin",
    });
    console.log(`Created admin user ${user.name} (${phone})`);
    return;
  }

  user.name = name;
  user.role = "admin";
  user.passwordHash = passwordHash;
  await user.save();

  console.log(`Admin access enabled for ${user.name} (${phone})`);
}

async function migrateAdditionalAdmins() {
  for (const { phone, password, name } of ADDITIONAL_ADMINS) {
    let user = await User.findOne({ phone }).select("+passwordHash");

    if (!user) {
      const passwordHash = await bcrypt.hash(password, 10);
      user = await User.create({
        name,
        phone,
        passwordHash,
        role: "admin",
      });
      console.log(`Created admin user ${user.name} (${phone})`);
      continue;
    }

    user.role = "admin";
    await user.save();
    console.log(`Admin access enabled for ${user.name} (${phone})`);
  }
}

async function migrateAdmin() {
  await migratePrimaryAdmin();
  await migrateAdditionalAdmins();
}

module.exports = migrateAdmin;
