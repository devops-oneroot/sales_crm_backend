const express = require("express");
const Lead = require("../models/Lead");
const { leadFilterForRequest } = require("../lib/leadQuery");
const { isConfigured, findPeople, revealPerson } = require("../services/apolloService");

const router = express.Router();

const findLead = (id, req) => Lead.findOne(leadFilterForRequest(req, { _id: id }));

function requireApollo(res) {
  if (isConfigured()) return true;
  res.status(503).json({ message: "Apollo isn't connected (APOLLO_API_KEY missing on the server)" });
  return false;
}

/** GET /api/people-finder/lead/:leadId?page=&refresh=1 — people at this lead's company (free). */
router.get("/lead/:leadId", async (req, res) => {
  try {
    if (!requireApollo(res)) return;
    const lead = await findLead(req.params.leadId, req);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const result = await findPeople({
      website: lead.website,
      company: lead.company,
      page: Math.max(1, Number(req.query.page) || 1),
      refresh: req.query.refresh === "1",
    });
    res.json(result);
  } catch (err) {
    res.status(err.status === 429 ? 429 : 400).json({ message: err.message });
  }
});

/** POST /api/people-finder/reveal { apolloId } — LinkedIn + email (1 credit, cached). */
router.post("/reveal", async (req, res) => {
  try {
    if (!requireApollo(res)) return;
    res.json(await revealPerson(req.body?.apolloId, req.userName));
  } catch (err) {
    res.status(err.status === 429 ? 429 : 400).json({ message: err.message });
  }
});

/**
 * POST /api/people-finder/lead/:leadId/contacts { apolloId }
 * Adds a revealed person to the lead's contacts (name, title, email, LinkedIn).
 */
router.post("/lead/:leadId/contacts", async (req, res) => {
  try {
    if (!requireApollo(res)) return;
    const lead = await findLead(req.params.leadId, req);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const { person } = await revealPerson(req.body?.apolloId, req.userName);

    const contacts = lead.contacts || [];
    // Older leads keep their first contact in top-level fields; keep it as contact 1.
    if (!contacts.length && (lead.contactPerson || lead.email || lead.phone)) {
      contacts.push({
        name: lead.contactPerson,
        email: lead.email,
        phone: lead.phone,
        phones: lead.phone ? [lead.phone] : [],
        designation: lead.designation,
        linkedIn: lead.linkedIn,
      });
    }
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    const exists = contacts.some(
      (c) =>
        (person.linkedinUrl && norm(c.linkedIn) === norm(person.linkedinUrl)) ||
        (person.email && norm(c.email) === norm(person.email))
    );
    if (exists) return res.status(409).json({ message: `${person.name} is already a contact on this lead` });

    contacts.push({
      name: person.name,
      designation: person.title,
      email: person.email || undefined,
      linkedIn: person.linkedinUrl || undefined,
      otherDetails: ["Found via Apollo"],
    });
    lead.contacts = contacts;
    await lead.save();
    res.json({ lead, person });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
