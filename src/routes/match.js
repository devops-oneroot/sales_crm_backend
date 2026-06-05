const express = require("express");
const { getMatches, getLeadMatches } = require("../services/buysMatchService");

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

router.get("/leads", async (req, res) => {
  try {
    const minScore = req.query.min_score
      ? parseFloat(req.query.min_score)
      : 0;
    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const pageSize = req.query.page_size
      ? parseInt(req.query.page_size, 10)
      : 10;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 15;

    const result = await getLeadMatches(req, {
      minScore: Number.isFinite(minScore) ? minScore : 0,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 10,
      limit,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      message: err.message || "Failed to compute lead matches",
    });
  }
});

module.exports = router;
