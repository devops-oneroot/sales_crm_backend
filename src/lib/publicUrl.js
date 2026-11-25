/**
 * Public base URL of this backend, used in every link that goes out in an email
 * (tracking logo, click redirects, unsubscribe links).
 *
 * Temporary tunnel and local addresses (ngrok, localhost) are skipped: they stop
 * working when the tunnel closes, and spam filters treat free tunnel domains as
 * high risk.
 */
const DEFAULT_PUBLIC_URL = "https://oneroot-crm-backend.onrender.com";

const UNSUITABLE = /localhost|127\.0\.0\.1|0\.0\.0\.0|ngrok|\.loca\.lt|trycloudflare\.com/i;

function getPublicBaseUrl() {
  // Explicit override for local testing (e.g. an ngrok tunnel to this machine).
  // Never set this in production.
  const testOverride = String(process.env.EMAIL_LINK_BASE_URL_OVERRIDE || "").trim();
  if (testOverride) return testOverride.replace(/\/+$/, "");

  const candidates = [
    process.env.PUBLIC_BACKEND_URL,
    process.env.OUTREACH_PUBLIC_URL,
    process.env.API_PUBLIC_URL,
    process.env.BACKEND_URL,
  ]
    .map((v) => String(v || "").trim().replace(/\/+$/, ""))
    .filter(Boolean);

  return candidates.find((u) => !UNSUITABLE.test(u)) || DEFAULT_PUBLIC_URL;
}

module.exports = { getPublicBaseUrl };
