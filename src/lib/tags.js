/** Shared tag rules for leads and importers (they sync both ways). */
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

/**
 * Clean a tags array: trim, collapse spaces, drop empties, dedupe
 * case-insensitively (first spelling wins), cap count and length.
 */
function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const tag = String(t ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Same tags, ignoring order and case. */
function sameTags(a, b) {
  const key = (list) => normalizeTags(list).map((t) => t.toLowerCase()).sort().join("|");
  return key(a || []) === key(b || []);
}

module.exports = { normalizeTags, sameTags, MAX_TAGS, MAX_TAG_LENGTH };
