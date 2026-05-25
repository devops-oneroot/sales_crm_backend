const path = require("path");
const cloudinary = require("cloudinary").v2;

let ready = false;

function loadEnv() {
  require("dotenv").config({
    path: path.join(__dirname, "../../.env"),
    override: true,
  });
}

function getApiBaseUrl() {
  const port = process.env.PORT || 5000;
  const base = process.env.API_PUBLIC_URL || `http://localhost:${port}`;
  return base.replace(/\/api\/?$/, "").replace(/\/$/, "");
}

function isPdfDocument(doc) {
  return (
    doc.resourceType === "raw" ||
    doc.format === "pdf" ||
    /\.pdf$/i.test(doc.name || "")
  );
}

function publicIdVariants(publicId) {
  if (!publicId) return [];
  const ids = [publicId];
  if (/\.pdf$/i.test(publicId)) {
    ids.push(publicId.replace(/\.pdf$/i, ""));
  } else {
    ids.push(`${publicId}.pdf`);
  }
  return [...new Set(ids)];
}

function resourceTypesForDoc(doc) {
  if (doc.resourceType === "raw" || doc.resourceType === "image") {
    return [doc.resourceType];
  }
  if (isPdfDocument(doc)) {
    return ["raw", "image"];
  }
  return ["image"];
}

function configureCloudinary() {
  if (ready) return true;

  loadEnv();

  const cloud_name = process.env.CLOUD_NAME?.trim();
  const api_key = process.env.CLOUD_API_KEY?.trim();
  const api_secret = process.env.CLOUD_API_SECRET?.trim();

  if (!cloud_name || !api_key || !api_secret) {
    const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
    if (cloudinaryUrl) {
      cloudinary.config({ secure: true });
      ready = true;
      return true;
    }
    return false;
  }

  // Prevent a system-wide CLOUDINARY_URL from pointing at a different account.
  delete process.env.CLOUDINARY_URL;

  cloudinary.config({
    cloud_name,
    api_key,
    api_secret,
    secure: true,
  });

  ready = true;
  return true;
}

function getCloudName() {
  return cloudinary.config().cloud_name;
}

function isCloudinaryReady() {
  return ready;
}

function isPdfFile(file) {
  return (
    file.mimetype === "application/pdf" ||
    /\.pdf$/i.test(file.originalname || "")
  );
}

function getUploadOptions(file, leadId) {
  const baseId = `lead-${leadId}-${Date.now()}`;

  if (isPdfFile(file)) {
    return {
      resource_type: "raw",
      folder: "sales-crm/leads",
      public_id: baseId,
      format: "pdf",
      type: "upload",
      access_mode: "public",
    };
  }

  return {
    resource_type: "image",
    folder: "sales-crm/leads",
    public_id: baseId,
    type: "upload",
    access_mode: "public",
  };
}

function resolveResourceType(doc) {
  if (doc.resourceType === "raw" || doc.resourceType === "image") {
    return doc.resourceType;
  }
  // Legacy PDFs were uploaded as image; new PDFs use raw.
  return "image";
}

function buildDeliveryUrl(doc) {
  if (!doc.publicId) return doc.url;

  const resourceType = resolveResourceType(doc);

  if (resourceType === "raw") {
    return cloudinary.url(doc.publicId, {
      resource_type: "raw",
      secure: true,
      flags: "attachment",
    });
  }

  return cloudinary.url(doc.publicId, {
    resource_type: "image",
    secure: true,
    flags: "attachment",
  });
}

function buildViewUrl(doc) {
  if (!doc.publicId) return doc.url;

  const resourceType = resolveResourceType(doc);

  return cloudinary.url(doc.publicId, {
    resource_type: resourceType,
    secure: true,
    sign_url: true,
    type: "upload",
  });
}

function buildDocumentServeUrl(leadId, docId) {
  return `${getApiBaseUrl()}/api/leads/${leadId}/documents/${docId}/file`;
}

async function fetchDocumentResponse(doc) {
  const attempts = [];

  if (doc.publicId && ready) {
    for (const resourceType of resourceTypesForDoc(doc)) {
      for (const publicId of publicIdVariants(doc.publicId)) {
        try {
          const meta = await cloudinary.api.resource(publicId, {
            resource_type: resourceType,
          });
          if (meta?.secure_url) {
            attempts.push(
              cloudinary.url(meta.public_id, {
                resource_type: resourceType,
                secure: true,
                sign_url: true,
                type: "upload",
                version: meta.version,
              })
            );
            attempts.push(meta.secure_url);
          }
        } catch {
          /* try other variants */
        }
      }
    }
  }

  if (doc.publicId) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    for (const publicId of publicIdVariants(doc.publicId)) {
      for (const resourceType of resourceTypesForDoc(doc)) {
        attempts.push(
          cloudinary.utils.private_download_url(
            publicId,
            doc.format || (resourceType === "raw" ? "pdf" : ""),
            {
              resource_type: resourceType,
              type: "upload",
              expires_at: expiresAt,
            }
          )
        );
        attempts.push(
          cloudinary.url(publicId, {
            resource_type: resourceType,
            secure: true,
            sign_url: true,
            type: "upload",
          })
        );
        attempts.push(
          cloudinary.url(publicId, {
            resource_type: resourceType,
            secure: true,
            type: "upload",
          })
        );
      }
    }
  }

  if (doc.url) attempts.push(doc.url);

  for (const url of attempts) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* try next */
    }
  }

  return null;
}

function uploadBuffer(buffer, options = {}) {
  if (!ready) {
    throw new Error("Cloudinary is not configured");
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

module.exports = {
  configureCloudinary,
  isCloudinaryReady,
  getCloudName,
  getApiBaseUrl,
  isPdfFile,
  isPdfDocument,
  getUploadOptions,
  resolveResourceType,
  buildDeliveryUrl,
  buildViewUrl,
  buildDocumentServeUrl,
  fetchDocumentResponse,
  uploadBuffer,
  cloudinary,
};
