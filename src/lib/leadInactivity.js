const Activity = require("../models/Activity");

const INACTIVITY_STATUSES = ["idle_critical", "missed_follow", "no_activity"];
/** Former In Progress column — kept in pipelineStatus so leads stay in No Activity */
const MERGED_IN_PROGRESS_PIPELINE = "in_progress";

function normalizePipelineStatus(status) {
  if (!status || status === MERGED_IN_PROGRESS_PIPELINE) return "identity";
  return status;
}

function getLeadLastTouchedAt(lead, activityAt) {
  const times = [
    lead.updatedAt ? new Date(lead.updatedAt).getTime() : 0,
    lead.createdAt ? new Date(lead.createdAt).getTime() : 0,
  ];

  for (const remark of lead.remarks ?? []) {
    if (remark.createdAt) {
      times.push(new Date(remark.createdAt).getTime());
    }
  }

  for (const doc of lead.documents ?? []) {
    if (doc.createdAt) {
      times.push(new Date(doc.createdAt).getTime());
    }
  }

  if (activityAt) {
    times.push(new Date(activityAt).getTime());
  }

  return Math.max(...times.filter((t) => Number.isFinite(t) && t > 0));
}

function daysSinceLastTouch(lastTouchedMs) {
  const diff = Date.now() - lastTouchedMs;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function inactivityStatusForDays(days) {
  if (days >= 15) return "no_activity";
  if (days >= 10) return "missed_follow";
  if (days >= 5) return "idle_critical";
  return null;
}

function computeInactivityTransition(lead, lastActivityAt) {
  if (lead.status === "deal" || lead.status === "junk") {
    return { status: lead.status, pipelineStatus: lead.pipelineStatus || null };
  }

  if (lead.status === "in_progress") {
    return {
      status: "no_activity",
      pipelineStatus: MERGED_IN_PROGRESS_PIPELINE,
    };
  }

  const pipeline = lead.pipelineStatus || null;
  if (pipeline === MERGED_IN_PROGRESS_PIPELINE) {
    return {
      status: "no_activity",
      pipelineStatus: MERGED_IN_PROGRESS_PIPELINE,
    };
  }

  const lastTouched = getLeadLastTouchedAt(lead, lastActivityAt);
  const days = daysSinceLastTouch(lastTouched);
  const target = inactivityStatusForDays(days);
  const current = lead.status;

  if (!target) {
    if (INACTIVITY_STATUSES.includes(current)) {
      if (pipeline === MERGED_IN_PROGRESS_PIPELINE) {
        return { status: current, pipelineStatus: pipeline };
      }
      if (pipeline) {
        return { status: pipeline, pipelineStatus: null };
      }
      return { status: "identity", pipelineStatus: null };
    }
    return { status: current, pipelineStatus: pipeline };
  }

  if (INACTIVITY_STATUSES.includes(current)) {
    if (current === target) {
      return { status: current, pipelineStatus: pipeline };
    }
    return { status: target, pipelineStatus: pipeline };
  }

  return {
    status: target,
    pipelineStatus: normalizePipelineStatus(pipeline || current),
  };
}

async function latestActivityAtForLeads(leadIds) {
  if (!leadIds.length) return {};
  const rows = await Activity.aggregate([
    { $match: { leadId: { $in: leadIds } } },
    { $group: { _id: "$leadId", at: { $max: "$createdAt" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.at]));
}

async function syncInactivityStatusesForRequest(req) {
  const Lead = require("../models/Lead");
  const { leadFilterForRequest } = require("./leadQuery");
  const filter = leadFilterForRequest(req);
  const leads = await Lead.find(filter).lean();
  if (!leads.length) return;

  const leadIds = leads.map((l) => l._id);
  const activityByLead = await latestActivityAtForLeads(leadIds);

  await Lead.updateMany(
    { ...filter, status: "in_progress" },
    {
      $set: {
        status: "no_activity",
        pipelineStatus: MERGED_IN_PROGRESS_PIPELINE,
      },
    }
  );

  for (const lead of leads) {
    if (lead.status === "in_progress") {
      lead.status = "no_activity";
      lead.pipelineStatus = MERGED_IN_PROGRESS_PIPELINE;
    }
  }

  const bulkOps = [];
  for (const lead of leads) {
    const activityAt = activityByLead[String(lead._id)];
    const next = computeInactivityTransition(lead, activityAt);
    const prevPipeline = lead.pipelineStatus || null;
    if (next.status !== lead.status || next.pipelineStatus !== prevPipeline) {
      bulkOps.push({
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              status: next.status,
              pipelineStatus: next.pipelineStatus,
            },
          },
        },
      });
    }
  }

  if (bulkOps.length) {
    await Lead.bulkWrite(bulkOps);
  }
}

async function restorePipelineOnActivity(leadId) {
  const Lead = require("../models/Lead");
  const lead = await Lead.findById(leadId);
  if (!lead || !INACTIVITY_STATUSES.includes(lead.status)) return;

  const pipeline = normalizePipelineStatus(lead.pipelineStatus?.trim());
  await Lead.findByIdAndUpdate(leadId, {
    status: pipeline,
    pipelineStatus: null,
  });
}

module.exports = {
  INACTIVITY_STATUSES,
  computeInactivityTransition,
  syncInactivityStatusesForRequest,
  restorePipelineOnActivity,
  daysSinceLastTouch,
  getLeadLastTouchedAt,
};
