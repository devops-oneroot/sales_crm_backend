/**
 * The pipeline a lead moves through. Order here is the order of the columns
 * on the Activity board.
 */
const LEAD_STATUSES = [
  "lead_generation",
  "contact_established",
  "requirement_understood",
  "quotation_sent",
  "closed_won",
  "closed_lost",
];

const DEFAULT_LEAD_STATUS = "lead_generation";

/** Columns of the previous board and where each one lands now. */
const LEGACY_STATUS_MAP = {
  identity: "lead_generation",
  in_progress: "requirement_understood",
  deal: "closed_won",
  junk: "closed_lost",
};

/**
 * The old board also parked quiet leads in these three columns automatically,
 * remembering the real column in pipelineStatus. They are retired: a lead in
 * one of them goes back to the column it was parked from.
 */
const LEGACY_INACTIVITY_STATUSES = ["idle_critical", "missed_follow", "no_activity"];

const LEGACY_STATUSES = [
  ...Object.keys(LEGACY_STATUS_MAP),
  ...LEGACY_INACTIVITY_STATUSES,
];

function isCurrentStatus(value) {
  return LEAD_STATUSES.includes(String(value || "").trim());
}

function isLegacyStatus(value) {
  return LEGACY_STATUSES.includes(String(value || "").trim());
}

/**
 * Resolves any status ever stored — current or legacy — to a current one.
 * Unknown values become the default rather than throwing, so a bad row can
 * never take the list down.
 */
function toCurrentStatus(status, pipelineStatus) {
  const raw = String(status || "").trim();
  if (isCurrentStatus(raw)) return raw;

  if (LEGACY_INACTIVITY_STATUSES.includes(raw)) {
    // Restore from the column it was parked from, which may itself be legacy.
    return toCurrentStatus(pipelineStatus, null);
  }

  return LEGACY_STATUS_MAP[raw] || DEFAULT_LEAD_STATUS;
}

/**
 * Stored values that should match when filtering by a current status — the
 * status itself plus any legacy name that maps to it.
 */
function storedValuesForStatus(status) {
  const legacy = Object.entries(LEGACY_STATUS_MAP)
    .filter(([, current]) => current === status)
    .map(([old]) => old);
  return [status, ...legacy];
}

module.exports = {
  storedValuesForStatus,
  LEAD_STATUSES,
  DEFAULT_LEAD_STATUS,
  LEGACY_STATUS_MAP,
  LEGACY_INACTIVITY_STATUSES,
  LEGACY_STATUSES,
  isCurrentStatus,
  isLegacyStatus,
  toCurrentStatus,
};
