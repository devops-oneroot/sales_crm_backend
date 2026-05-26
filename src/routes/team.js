const express = require("express");

const router = express.Router();

const TEAM_MEMBERS = ["Rohan", "Rahul", "Tejas", "Shiva", "Aadarsh"];

router.get("/", (_req, res) => {
  res.json(TEAM_MEMBERS);
});

module.exports = router;
