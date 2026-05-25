const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { requireAuth, signToken } = require("../middleware/auth");

const router = express.Router();

function normalizePhone(phone) {
  return String(phone || "")
    .replace(/\D/g, "")
    .trim();
}

router.post("/users", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "").trim();

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (!phone || phone.length < 10) {
      return res
        .status(400)
        .json({ message: "Valid phone number is required (min 10 digits)" });
    }
    if (!password || password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password is required (min 6 characters)" });
    }

    const existing = await User.findOne({ phone });
    if (existing) {
      return res.status(409).json({ message: "Phone number already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, phone, passwordHash });

    res.status(201).json({
      message: "User created",
      user: user.toPublicJSON(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "").trim();

    if (!phone || !password) {
      return res
        .status(400)
        .json({ message: "Phone number and password are required" });
    }

    const user = await User.findOne({ phone }).select("+passwordHash");
    if (!user) {
      return res.status(401).json({ message: "Invalid phone or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid phone or password" });
    }

    const token = signToken(user._id.toString());

    res.json({
      token,
      user: user.toPublicJSON(),
    });
  } catch (err) {
    if (err.message === "JWT_SECRET is not configured") {
      return res.status(500).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    res.json({ user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
