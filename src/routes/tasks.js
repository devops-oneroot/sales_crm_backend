const express = require("express");
const Task = require("../models/Task");
const User = require("../models/User");
const { todayBusinessDate } = require("../lib/businessDate");
const {
  TASK_ALERTS,
  normalizePriority,
  normalizeStatus,
  normalizeDueDate,
  daysUntilDue,
  taskAlert,
  isValidAlert,
} = require("../lib/taskConfig");

const router = express.Router();

/** Alert order used everywhere a task list is shown — act on red first. */
const ALERT_SORT_ORDER = {
  overdue: 0,
  due_soon: 1,
  on_track: 2,
  completed: 3,
};

function toClient(doc, today = todayBusinessDate()) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    _id: String(o._id),
    title: o.title,
    description: o.description || "",
    priority: o.priority || "medium",
    dueDate: o.dueDate,
    status: o.status || "pending",
    assignedTo: String(o.assignedTo),
    assignedToName: o.assignedToName,
    assignedBy: String(o.assignedBy),
    assignedByName: o.assignedByName,
    completedAt: o.completedAt,
    completedByName: o.completedByName || "",
    updates: (o.updates || []).map((update) => ({
      _id: String(update._id),
      text: update.text,
      author: update.author || "",
      createdAt: update.createdAt,
    })),
    alert: taskAlert(o, today),
    daysUntilDue: daysUntilDue(o.dueDate, today),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function sortByAlertThenDue(a, b) {
  const order = ALERT_SORT_ORDER[a.alert] - ALERT_SORT_ORDER[b.alert];
  if (order !== 0) return order;
  return String(a.dueDate).localeCompare(String(b.dueDate));
}

/** The assignee works the task; an admin can act on anyone's. */
function canWorkOnTask(req, task) {
  return req.isAdmin || String(task.assignedTo) === String(req.userId);
}

/** Status fields for a move — set on completion, cleared when reopened. */
function statusUpdates(status, userName) {
  if (status === "completed") {
    return {
      status,
      completedAt: new Date(),
      completedByName: userName || "User",
    };
  }
  return { status, completedAt: null, completedByName: "" };
}

/** Non-admins only ever see the tasks assigned to them. */
function scopeFilter(req) {
  if (!req.isAdmin) return { assignedTo: req.userId };

  const assignedTo = String(req.query.assignedTo || "").trim();
  return assignedTo ? { assignedTo } : {};
}

router.get("/", async (req, res) => {
  try {
    const filter = scopeFilter(req);

    const status = String(req.query.status || "").trim();
    if (status) filter.status = normalizeStatus(status);

    const docs = await Task.find(filter).sort({ dueDate: 1, createdAt: -1 });
    const today = todayBusinessDate();
    let tasks = docs.map((doc) => toClient(doc, today));

    const alert = String(req.query.alert || "").trim();
    if (isValidAlert(alert)) {
      tasks = tasks.filter((task) => task.alert === alert);
    }

    res.json(tasks.sort(sortByAlertThenDue));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** Counts per alert colour — powers the nav badge and the filter chips. */
router.get("/summary", async (req, res) => {
  try {
    const docs = await Task.find(scopeFilter(req)).select(
      "status dueDate assignedTo"
    );
    const today = todayBusinessDate();

    const counts = Object.fromEntries(TASK_ALERTS.map((id) => [id, 0]));
    for (const doc of docs) {
      counts[taskAlert(doc, today)] += 1;
    }

    res.json({
      ...counts,
      total: docs.length,
      /** Everything still open that needs attention now. */
      needsAttention: counts.overdue + counts.due_soon,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    if (!req.isAdmin) {
      return res.status(403).json({ message: "Only admins can assign tasks" });
    }

    const title = String(req.body.title || "").trim();
    if (!title) {
      return res.status(400).json({ message: "Task title is required" });
    }

    const dueDate = normalizeDueDate(req.body.dueDate);
    if (!dueDate) {
      return res
        .status(400)
        .json({ message: "A due date (YYYY-MM-DD) is required" });
    }

    const assignedTo = String(req.body.assignedTo || "").trim();
    const assignee = assignedTo
      ? await User.findById(assignedTo).select("name").catch(() => null)
      : null;
    if (!assignee) {
      return res
        .status(400)
        .json({ message: "Select the team member this task is for" });
    }

    const task = await Task.create({
      title,
      description: String(req.body.description || "").trim(),
      priority: normalizePriority(req.body.priority),
      dueDate,
      status: "pending",
      assignedTo: assignee._id,
      assignedToName: assignee.name?.trim() || "User",
      assignedBy: req.userId,
      assignedByName: req.userName || "Admin",
    });

    res.status(201).json(toClient(task));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await Task.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!canWorkOnTask(req, existing)) {
      return res.status(403).json({ message: "This task is not yours" });
    }

    const updates = {};

    // The assignee can only move a task along; admins can edit everything.
    if (req.isAdmin) {
      if (req.body.title !== undefined) {
        const title = String(req.body.title).trim();
        if (!title) {
          return res.status(400).json({ message: "Task title is required" });
        }
        updates.title = title;
      }
      if (req.body.description !== undefined) {
        updates.description = String(req.body.description).trim();
      }
      if (req.body.priority !== undefined) {
        updates.priority = normalizePriority(req.body.priority);
      }
      if (req.body.dueDate !== undefined) {
        const dueDate = normalizeDueDate(req.body.dueDate);
        if (!dueDate) {
          return res
            .status(400)
            .json({ message: "A due date (YYYY-MM-DD) is required" });
        }
        updates.dueDate = dueDate;
      }
      if (req.body.assignedTo !== undefined) {
        const assignee = await User.findById(String(req.body.assignedTo))
          .select("name")
          .catch(() => null);
        if (!assignee) {
          return res
            .status(400)
            .json({ message: "Select the team member this task is for" });
        }
        updates.assignedTo = assignee._id;
        updates.assignedToName = assignee.name?.trim() || "User";
      }
    }

    if (req.body.status !== undefined) {
      Object.assign(
        updates,
        statusUpdates(normalizeStatus(req.body.status), req.userName)
      );
    }

    if (Object.keys(updates).length === 0) {
      return res.json(toClient(existing));
    }

    const task = await Task.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    res.json(toClient(task));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const existing = await Task.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!canWorkOnTask(req, existing)) {
      return res.status(403).json({ message: "This task is not yours" });
    }

    const task = await Task.findByIdAndUpdate(
      req.params.id,
      statusUpdates(normalizeStatus(req.body.status), req.userName),
      { new: true, runValidators: true }
    );

    res.json(toClient(task));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * The assignee writes what is happening on the task, optionally moving the
 * status in the same action.
 */
router.post("/:id/updates", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) {
      return res
        .status(400)
        .json({ message: "Write what is happening on this task" });
    }

    const existing = await Task.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!canWorkOnTask(req, existing)) {
      return res.status(403).json({ message: "This task is not yours" });
    }

    const payload = {
      $push: { updates: { text, author: req.userName || "User" } },
    };
    if (req.body.status !== undefined) {
      payload.$set = statusUpdates(
        normalizeStatus(req.body.status),
        req.userName
      );
    }

    const task = await Task.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    res.json(toClient(task));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!req.isAdmin) {
      return res.status(403).json({ message: "Only admins can delete tasks" });
    }

    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json({ message: "Task deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
