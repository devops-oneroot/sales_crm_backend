const express = require("express");
const {
  getStates,
  getDistricts,
  getTaluks,
  getVillages,
  lookupByPincode,
} = require("../config/indiaLocations");

const router = express.Router();

router.get("/states", async (_req, res) => {
  try {
    const states = await getStates();
    res.json(states);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/districts", async (req, res) => {
  try {
    const state = String(req.query.state || "").trim();
    if (!state) {
      return res.status(400).json({ message: "State is required" });
    }
    const districts = await getDistricts(state);
    res.json(districts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/taluks", async (req, res) => {
  try {
    const state = String(req.query.state || "").trim();
    const district = String(req.query.district || "").trim();
    if (!state || !district) {
      return res
        .status(400)
        .json({ message: "State and district are required" });
    }
    const taluks = await getTaluks(state, district);
    res.json(taluks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/villages", async (req, res) => {
  try {
    const state = String(req.query.state || "").trim();
    const district = String(req.query.district || "").trim();
    const taluk = String(req.query.taluk || "").trim();
    if (!state || !district || !taluk) {
      return res
        .status(400)
        .json({ message: "State, district, and taluk are required" });
    }
    const villages = await getVillages(state, district, taluk);
    res.json(villages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/pincode/:pincode", async (req, res) => {
  try {
    const result = await lookupByPincode(req.params.pincode);
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
