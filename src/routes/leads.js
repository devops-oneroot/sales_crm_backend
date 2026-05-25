const express = require("express");
const { Readable } = require("stream");
const Lead = require("../models/Lead");
const upload = require("../middleware/upload");
const {
  isCloudinaryReady,
  isPdfFile,
  isPdfDocument,
  getUploadOptions,
  resolveResourceType,
  mapDocumentForClient,
  fetchDocumentResponse,
  uploadBuffer,
  cloudinary,
  configureCloudinary,
} = require("../config/cloudinary");

const router = express.Router();

function guessDocumentContentType(doc, response) {
  if (isPdfDocument(doc)) return "application/pdf";
  const ext = (doc.format || doc.name?.split(".").pop() || "").toLowerCase();
  const byExt = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    tiff: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    avif: "image/avif",
    txt: "text/plain",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  if (byExt[ext]) return byExt[ext];
  const header = response.headers.get("content-type");
  if (header && !header.includes("application/octet-stream")) return header;
  return "application/octet-stream";
}

const STATUSES = [
  "identity",
  "contact_established",
  "in_progress",
  "deal",
  "junk",
];

function leadWithDocumentUrls(lead) {
  const obj = lead.toObject ? lead.toObject() : { ...lead };
  if (obj.documents?.length) {
    obj.documents = obj.documents.map((doc) => mapDocumentForClient(doc));
  }
  return obj;
}

router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status && STATUSES.includes(status) ? { status } : {};
    const leads = await Lead.find(filter).sort({ updatedAt: -1 });
    res.json(leads.map(leadWithDocumentUrls));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const lead = await Lead.create(req.body);
    res.status(201).json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/:id/documents/:docId/file", async (req, res) => {
  try {
    if (!isCloudinaryReady() && !configureCloudinary()) {
      return res.status(500).json({ message: "Cloudinary is not configured" });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const doc = lead.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ message: "Document not found" });

    const response = await fetchDocumentResponse(doc);

    if (!response) {
      return res.status(502).json({
        message:
          "Could not load this file. Delete it and upload again, or check Cloudinary settings in backend/.env.",
      });
    }

    const contentType = guessDocumentContentType(doc, response);
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(doc.name).replace(/"/g, "")}"`
    );
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    res.status(500).json({ message: err.message || "Could not load document" });
  }
});

router.post("/:id/documents", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!isCloudinaryReady() && !configureCloudinary()) {
      return res.status(500).json({
        message:
          "Cloudinary is not configured. Add CLOUD_NAME, CLOUD_API_KEY, CLOUD_API_SECRET to backend/.env and restart the server.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message:
          "No file uploaded. Use images, PDF, Office docs, text, or ZIP.",
      });
    }

    const uploadOptions = getUploadOptions(req.file, req.params.id);
    const result = await uploadBuffer(req.file.buffer, uploadOptions);

    const doc = {
      name: req.file.originalname,
      publicId: result.public_id,
      resourceType: result.resource_type || "image",
      format: result.format,
      bytes: result.bytes,
      version: result.version,
      url: result.secure_url,
    };

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $push: { documents: doc } },
      { new: true, runValidators: true }
    );

    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

router.delete("/:id/documents/:docId", async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const doc = lead.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ message: "Document not found" });

    if (isCloudinaryReady() && doc.publicId) {
      try {
        await cloudinary.uploader.destroy(doc.publicId, {
          resource_type: doc.resourceType || "image",
        });
      } catch {
        /* keep DB in sync even if Cloudinary delete fails */
      }
    }

    doc.deleteOne();
    await lead.save();
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/:id/remarks", async (req, res) => {
  try {
    const { text, author } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ message: "Remark text is required" });
    }
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $push: { remarks: { text: text.trim(), author: author || "" } } },
      { new: true, runValidators: true }
    );
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(leadWithDocumentUrls(lead));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ message: "Lead deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
