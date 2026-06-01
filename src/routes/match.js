const express = require("express");
const { getMatches } = require("../services/buysMatchService");

const router = express.Router();

router.get("/matches", async (req, res) => {
  try {
    const minScore = req.query.min_score
      ? parseFloat(req.query.min_score)
      : 0;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 15;

    const result = await getMatches(req, {
      minScore: Number.isFinite(minScore) ? minScore : 0,
      limit,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: err.message || "Failed to compute matches",
    });
  }
});

module.exports = router;
