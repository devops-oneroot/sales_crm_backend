const express = require("express");
const { getTeamMembers } = require("../lib/teamMembers");

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const members = await getTeamMembers();
    res.json(members);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
