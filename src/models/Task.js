const mongoose = require("mongoose");
const { TASK_PRIORITIES, TASK_STATUSES } = require("../lib/taskConfig");

/** A progress note written by the assignee (or an admin) as work happens. */
const taskUpdateSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    author: { type: String, default: "" },
  },
  { timestamps: true }
);

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: "" },
    priority: {
      type: String,
      enum: TASK_PRIORITIES,
      default: "medium",
    },
    /** Business date (YYYY-MM-DD) the task must be completed by. */
    dueDate: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: "pending",
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedToName: { type: String, required: true, trim: true },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    assignedByName: { type: String, required: true, trim: true },
    completedAt: { type: Date },
    completedByName: { type: String, trim: true, default: "" },
    updates: [taskUpdateSchema],
  },
  { timestamps: true }
);

taskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });
taskSchema.index({ dueDate: 1 });

module.exports = mongoose.model("Task", taskSchema);
