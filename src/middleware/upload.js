const multer = require("multer");

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

function isAllowedUpload(mimetype, originalname) {
  if (mimetype && ALLOWED_MIME_TYPES.has(mimetype)) return true;
  if (mimetype?.startsWith("image/")) return true;
  const ext = originalname?.split(".").pop()?.toLowerCase();
  const allowedExt = [
    "pdf",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "bmp",
    "tiff",
    "tif",
    "svg",
    "heic",
    "heif",
    "avif",
    "ico",
  ];
  return ext ? allowedExt.includes(ext) : false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedUpload(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only photos (JPG, PNG, GIF, WEBP, HEIC, etc.) and PDF files are allowed"
        )
      );
    }
  },
});

module.exports = upload;
