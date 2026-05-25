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
  loadEnv();

  const cloud_name = process.env.CLOUD_NAME?.trim();
  const api_key = process.env.CLOUD_API_KEY?.trim();
  const api_secret = process.env.CLOUD_API_SECRET?.trim();

  if (cloud_name && api_key && api_secret) {
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

  if (ready) return true;

  const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
  if (cloudinaryUrl) {
    cloudinary.config({ secure: true });
    ready = true;
    return true;
  }

  return false;
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
      resource_type: "image",
      folder: "sales-crm/leads",
      public_id: baseId,
      type: "upload",
      access_mode: "public",
    };
  }

  if (file.mimetype?.startsWith("image/")) {
    return {
      resource_type: "image",
      folder: "sales-crm/leads",
      public_id: baseId,
      type: "upload",
      access_mode: "public",
    };
  }

  return {
    resource_type: "raw",
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
  return "image";
}

function buildDeliveryUrl(doc) {
  if (doc.url && isCloudinaryUrl(doc.url)) {
    return attachmentUrl(doc.url);
  }
  if (!doc.publicId) return doc.url;

  const resourceType = resolveResourceType(doc);
  const publicId = normalizePublicId(doc);
  const options = {
    resource_type: resourceType,
    secure: true,
    flags: "attachment",
    type: "upload",
  };
  if (doc.version) options.version = doc.version;

  return cloudinary.url(publicId, options);
}

function normalizePublicId(doc) {
  if (!doc.publicId) return doc.publicId;
  if (doc.resourceType === "raw" && doc.publicId.endsWith(".pdf")) {
    return doc.publicId.replace(/\.pdf$/i, "");
  }
  return doc.publicId;
}

function buildViewUrl(doc) {
  if (!doc.publicId) return doc.url;

  const resourceType = resolveResourceType(doc);
  const options = {
    resource_type: resourceType,
    secure: true,
    type: "upload",
  };
  if (doc.version) options.version = doc.version;

  return cloudinary.url(normalizePublicId(doc), options);
}

function attachmentUrl(secureUrl) {
  if (!secureUrl || !isCloudinaryUrl(secureUrl)) return secureUrl;
  if (secureUrl.includes("/fl_attachment/")) return secureUrl;
  return secureUrl.replace("/upload/", "/upload/fl_attachment/");
}

function buildDocumentServeUrl(leadId, docId) {
  return `${getApiBaseUrl()}/api/leads/${leadId}/documents/${docId}/file`;
}

function isCloudinaryUrl(url) {
  return typeof url === "string" && /res\.cloudinary\.com/i.test(url);
}

/** Use secure_url from upload (frontend opens via Cloudinary or API proxy). */
function mapDocumentForClient(doc) {
  const d = doc.toObject ? doc.toObject() : { ...doc };

  if (d.url && isCloudinaryUrl(d.url)) {
    return {
      ...d,
      url: d.url,
      downloadUrl: attachmentUrl(d.url),
    };
  }

  if (configureCloudinary() && d.publicId) {
    const url = buildViewUrl(d);
    return {
      ...d,
      url,
      downloadUrl: buildDeliveryUrl({ ...d, url }),
    };
  }

  return d;
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

  if (doc.url && isCloudinaryUrl(doc.url)) {
    attempts.unshift(doc.url);
  } else if (doc.url) {
    attempts.push(doc.url);
  }

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
  mapDocumentForClient,
  fetchDocumentResponse,
  uploadBuffer,
  cloudinary,
};
