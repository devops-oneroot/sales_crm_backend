const express = require("express");
const { getDailySummary } = require("../services/dailyActivityService");
const {
  saveDayForUser,
  listSavedDays,
  getSavedDayById,
} = require("../services/savedDayService");

const router = express.Router();

router.get("/daily", async (req, res) => {
  try {
    const { date, responsible } = req.query;
    if (responsible && !req.isAdmin) {
      return res.status(403).json({
        message: "Only admins can view another team member's daily report",
      });
    }
    const report = await getDailySummary(req, {
      date: date ? String(date) : undefined,
      responsible: responsible ? String(responsible) : undefined,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/days", async (req, res) => {
  try {
    const { userId, userName } = req.query;
    if ((userId || userName) && !req.isAdmin) {
      return res.status(403).json({
        message: "Only admins can filter another user's saved days",
      });
    }
    const days = await listSavedDays(req, {
      userId: userId ? String(userId) : undefined,
      userName: userName ? String(userName) : undefined,
    });
    res.json(days);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/days", async (req, res) => {
  try {
    if (req.isAdmin) {
      return res.status(403).json({
        message: "Daily reports are only saved for sales users, not admins",
      });
    }
    const { date } = req.body || {};
    const saved = await saveDayForUser(req, {
      date: date ? String(date) : undefined,
    });
    if (!saved) {
      return res.status(403).json({
        message: "Daily reports are only saved for sales users",
      });
    }
    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/days/:id", async (req, res) => {
  try {
    const doc = await getSavedDayById(req, req.params.id);
    if (!doc) {
      return res.status(404).json({ message: "Saved day not found" });
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
