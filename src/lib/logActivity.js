const Activity = require("../models/Activity");

function leadSnapshot(lead) {
  const o = lead.toObject ? lead.toObject() : lead;
  return {
    leadId: o._id,
    leadName: o.name?.trim() || o.company?.trim() || "—",
    contactPerson: o.contactPerson?.trim() || "",
    company: o.company?.trim() || "",
  };
}

async function logActivity({
  type,
  userId,
  userName,
  lead,
  fromStatus,
  toStatus,
  remarkText,
  dailyActivityType,
  fromResponsible,
  toResponsible,
  followUpDate,
}) {
  if (!userId || !lead?._id) return;

  const snap = leadSnapshot(lead);
  try {
    await Activity.create({
      type,
      userId,
      userName: userName?.trim() || "",
      ...snap,
      fromStatus,
      toStatus,
      remarkText: remarkText?.trim(),
      dailyActivityType: dailyActivityType?.trim(),
      fromResponsible: fromResponsible?.trim(),
      toResponsible: toResponsible?.trim(),
      followUpDate: followUpDate?.trim(),
    });
  } catch (err) {
    console.warn("Activity log failed:", err.message);
  }
}

module.exports = { logActivity, leadSnapshot };
