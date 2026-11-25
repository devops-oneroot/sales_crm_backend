const express = require("express");
const dup = require("../services/duplicateService");

const router = express.Router();

const fail = (res, err) =>
  res.status(err.status || 500).json({ success: false, message: err.message || "Something went wrong" });

const adminOnly = (req, res, next) =>
  req.isAdmin
    ? next()
    : res.status(403).json({ success: false, message: "Only admins can merge, delete or restore leads" });

// GET /api/duplicates — open pairs waiting for a decision
router.get("/", async (_req, res) => {
  try {
    res.json({ success: true, data: await dup.listOpen() });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/duplicates/flagged — lead ids with an open flag (for row badges)
router.get("/flagged", async (_req, res) => {
  try {
    res.json({ success: true, data: await dup.flaggedLeadIds() });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/duplicates/scan — re-check every lead now
router.post("/scan", async (_req, res) => {
  try {
    res.json({ success: true, data: await dup.scanAll() });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/duplicates/:id/dismiss — "not a duplicate" (any user)
router.post("/:id/dismiss", async (req, res) => {
  try {
    res.json({ success: true, data: await dup.dismiss(req.params.id, req.userName) });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/duplicates/:id/merge { keepId } — keep one, fold the other into it
router.post("/:id/merge", adminOnly, async (req, res) => {
  try {
    if (!req.body?.keepId) return res.status(400).json({ success: false, message: "keepId is required" });
    res.json({ success: true, data: await dup.merge(req.params.id, req.body.keepId, req.userName) });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/duplicates/:id/delete { removeId } — delete one (archived first)
router.post("/:id/delete", adminOnly, async (req, res) => {
  try {
    if (!req.body?.removeId) return res.status(400).json({ success: false, message: "removeId is required" });
    res.json({ success: true, data: await dup.removeLead(req.params.id, req.body.removeId, req.userName) });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/duplicates/archived — merged-away / deleted leads that can be restored
router.get("/archived", async (_req, res) => {
  try {
    res.json({ success: true, data: await dup.listArchived() });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/duplicates/archived/:id/restore
router.post("/archived/:id/restore", adminOnly, async (req, res) => {
  try {
    res.json({ success: true, data: await dup.restore(req.params.id, req.userName) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
