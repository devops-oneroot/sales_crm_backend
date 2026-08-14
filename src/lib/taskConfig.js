const { todayBusinessDate } = require("./businessDate");

const TASK_PRIORITIES = ["low", "medium", "high", "urgent"];
const TASK_STATUSES = ["pending", "in_progress", "completed"];
const TASK_ALERTS = ["overdue", "due_soon", "on_track", "completed"];

/** A task turns "Due Soon" this many days before its due date. */
const DUE_SOON_WINDOW_DAYS = 2;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizePriority(value) {
  const priority = String(value || "")
    .trim()
    .toLowerCase();
  return TASK_PRIORITIES.includes(priority) ? priority : "medium";
}

function normalizeStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  return TASK_STATUSES.includes(status) ? status : "pending";
}

/** Returns a YYYY-MM-DD string, or null when the value is not a valid date. */
function normalizeDueDate(value) {
  const date = String(value || "").trim();
  if (!DATE_PATTERN.test(date)) return null;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

/** Negative when the due date has already passed, 0 when it is today. */
function daysUntilDue(dueDate, today = todayBusinessDate()) {
  const due = normalizeDueDate(dueDate);
  if (!due) return null;
  const dueMs = Date.parse(`${due}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(todayMs)) return null;
  return Math.round((dueMs - todayMs) / 86400000);
}

/** The Alert colour every task carries: completed / overdue / due_soon / on_track. */
function taskAlert(task, today = todayBusinessDate()) {
  if (normalizeStatus(task.status) === "completed") return "completed";

  const days = daysUntilDue(task.dueDate, today);
  if (days === null) return "on_track";
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "on_track";
}

function isValidAlert(value) {
  return TASK_ALERTS.includes(String(value || "").trim());
}

module.exports = {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_ALERTS,
  DUE_SOON_WINDOW_DAYS,
  normalizePriority,
  normalizeStatus,
  normalizeDueDate,
  daysUntilDue,
  taskAlert,
  isValidAlert,
};
