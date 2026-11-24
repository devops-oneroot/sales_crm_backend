const express = require("express");
const multer = require("multer");
const {
  startDiscoveryRun,
  isRunActive,
  ensureDefaultSources,
  getDiscoveryLogs,
  getDiscoveryLog,
  getDiscoverySchedule,
} = require("../services/discoveryService");
const { llmStatus, MODEL } = require("../services/buyerExtractor");
const { reschedule } = require("../services/discoveryScheduler");
const { isExcelBuffer, parseExcelTradeData } = require("../lib/discoveryParsers");
const DiscoverySchedule = require("../models/DiscoverySchedule");
const DiscoverySource = require("../models/DiscoverySource");
const { SOURCE_KINDS } = require("../models/DiscoverySource");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const sendError = (res, err) => res.status(err.status || (err.name === "ValidationError" ? 400 : 500)).json({ success: false, message: err.message });

// GET /api/importers/discovery/status — extraction mode + whether a run is active
router.get("/status", (_req, res) => {
  const llm = llmStatus();
  res.json({ running: isRunActive(), llm: { ...llm, model: MODEL } });
});

// ---------------- runs

// POST /run — Web search discovery is disabled
router.post("/run", async (_req, res) => {
  return res.status(400).json({
    success: false,
    message: "Web search discovery is disabled. Buyers can only be imported via CSV/Excel file upload or manual entry.",
  });
});

// POST /upload-csv — CSV trade data, same provenance + dedupe rules
router.post("/upload-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ success: false, message: "No file uploaded (or the file is empty)" });
    // Workbooks are read with SheetJS; reject other binaries early with a clear message.
    if (!isExcelBuffer(req.file.buffer) && req.file.buffer.subarray(0, 1024).includes(0)) {
      return res.status(400).json({ success: false, message: "Unsupported file. Upload a .csv, .tsv, .xlsx or .xls file." });
    }
    if (isExcelBuffer(req.file.buffer)) {
      try {
        // Parse once up front so a corrupt or password-protected workbook fails fast.
        parseExcelTradeData(req.file.buffer, req.file.originalname);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `Could not read this Excel file (${e.message}). If it is password-protected, remove the password or save it as CSV.`,
        });
      }
    }
    const log = await startDiscoveryRun({
      csvContent: req.file.buffer, // raw bytes: the parser detects UTF-8 vs Windows-1252
      csvFilename: req.file.originalname || "trade-data.csv",
      triggerType: "manual",
      userId: req.userId,
    });
    res.status(202).json({ success: true, log });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/logs", async (req, res) => {
  try {
    res.json(await getDiscoveryLogs(Math.min(parseInt(req.query.limit || "15", 10) || 15, 50)));
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/logs/:id", async (req, res) => {
  try {
    const log = await getDiscoveryLog(req.params.id);
    if (!log) return res.status(404).json({ success: false, message: "Run not found" });
    res.json(log);
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------- sources

router.get("/sources", async (_req, res) => {
  try {
    await ensureDefaultSources();
    res.json(await DiscoverySource.find().sort({ kind: 1, name: 1 }));
  } catch (err) {
    sendError(res, err);
  }
});

function pickSource(body) {
  const out = {};
  for (const k of ["name", "url", "kind", "country", "notes"]) if (body[k] !== undefined) out[k] = String(body[k]).trim();
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  return out;
}

router.post("/sources", async (req, res) => {
  try {
    const fields = pickSource(req.body || {});
    if (!fields.name && fields.url) {
      try {
        fields.name = new URL(fields.url).host;
      } catch {
        /* validation below reports the bad URL */
      }
    }
    res.status(201).json(await DiscoverySource.create(fields));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: "That URL is already a source" });
    sendError(res, err);
  }
});

router.patch("/sources/:id", async (req, res) => {
  try {
    const src = await DiscoverySource.findByIdAndUpdate(req.params.id, { $set: pickSource(req.body || {}) }, { new: true, runValidators: true });
    if (!src) return res.status(404).json({ success: false, message: "Source not found" });
    res.json(src);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/sources/:id", async (req, res) => {
  try {
    const src = await DiscoverySource.findByIdAndDelete(req.params.id);
    if (!src) return res.status(404).json({ success: false, message: "Source not found" });
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------- schedule

router.get("/schedule", async (_req, res) => {
  try {
    res.json(await getDiscoverySchedule());
  } catch (err) {
    sendError(res, err);
  }
});

router.patch("/schedule", async (req, res) => {
  try {
    await getDiscoverySchedule(); // ensures doc + migration
    const { enabled, scheduledTime, kinds, filters } = req.body || {};
    const update = {};
    if (enabled !== undefined) update.enabled = Boolean(enabled);
    if (scheduledTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(scheduledTime))) {
        return res.status(400).json({ success: false, message: "scheduledTime must be HH:MM (UTC)" });
      }
      update.scheduledTime = String(scheduledTime);
    }
    if (kinds && typeof kinds === "object") {
      for (const k of SOURCE_KINDS) if (kinds[k] !== undefined) update[`kinds.${k}`] = Boolean(kinds[k]);
    }
    if (filters && typeof filters === "object") {
      for (const k of ["country", "city", "importerType"]) if (filters[k] !== undefined) update[`filters.${k}`] = String(filters[k]);
    }
    await DiscoverySchedule.updateOne({}, { $set: update });
    await reschedule();
    res.json(await DiscoverySchedule.findOne());
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
