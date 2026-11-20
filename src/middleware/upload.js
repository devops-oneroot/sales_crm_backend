const multer = require("multer");

const BLOCKED_MIME = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-sh",
  "application/x-bat",
  "application/vnd.microsoft.portable-executable",
]);

const ALLOWED_EXT = new Set([
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
  "txt",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
]);

function isAllowedUpload(mimetype, originalname) {
  if (mimetype && BLOCKED_MIME.has(mimetype)) return false;
  if (mimetype?.startsWith("image/")) return true;
  if (mimetype === "application/pdf") return true;
  if (mimetype?.startsWith("text/")) return true;
  if (mimetype?.startsWith("application/vnd.")) return true;
  if (mimetype?.startsWith("application/msword")) return true;
  if (mimetype === "application/zip") return true;
  const ext = originalname?.split(".").pop()?.toLowerCase();
  return ext ? ALLOWED_EXT.has(ext) : true;
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
          "File type not allowed. Upload images, PDF, Office docs, text, or ZIP (max 20 MB)."
        )
      );
    }
  },
});

module.exports = upload;
