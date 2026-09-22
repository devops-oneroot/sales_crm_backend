/** Fields in a lead request that describe how to reach the customer. */
const CONTACT_FIELDS = [
  "contacts",
  "contactPersons",
  "contactPerson",
  "emails",
  "email",
  "phone",
  "designation",
  "linkedIn",
];

/** One person can have several numbers — keep them all, de-duplicated. */
function normalizeContactPhones(contact) {
  const raw = Array.isArray(contact?.phones)
    ? contact.phones
    : [contact?.phones];
  const all = [...raw, contact?.phone].map((p) => String(p || "").trim());
  return [...new Set(all.filter(Boolean))];
}

function collectPhonesAndEmails(contacts) {
  const phones = new Set();
  const emails = new Set();
  for (const c of contacts || []) {
    for (const p of normalizeContactPhones(c)) phones.add(p);
    const e = String(c?.email || "").trim().toLowerCase();
    if (e) emails.add(e);
  }
  return { phones, emails };
}

/**
 * Saved phone numbers and emails are the record of how to reach a customer.
 * Once stored, only an admin may change or remove one; everyone else may
 * only add. Returns a message describing the first violation, or null.
 */
function contactDetailsLockedError(existingContacts, nextContacts) {
  const before = collectPhonesAndEmails(existingContacts);
  if (!before.phones.size && !before.emails.size) return null;

  const after = collectPhonesAndEmails(nextContacts);

  const lostPhone = [...before.phones].find((p) => !after.phones.has(p));
  if (lostPhone) {
    return `Phone number ${lostPhone} is already saved on this lead. Only an admin can change or remove it — you can add another number.`;
  }
  const lostEmail = [...before.emails].find((e) => !after.emails.has(e));
  if (lostEmail) {
    return `Email ${lostEmail} is already saved on this lead. Only an admin can change or remove it.`;
  }
  return null;
}

/** True when the request body says anything at all about contact details. */
function mentionsContactFields(body) {
  return CONTACT_FIELDS.some((f) => body?.[f] !== undefined);
}

/**
 * A request that says nothing about contacts must not blank them, and one
 * that says nothing about the name must not rename the lead to "—". Strips
 * the derived fields so the update leaves the stored values alone.
 */
function dropUnmentionedFields(body, data) {
  if (!mentionsContactFields(body)) {
    for (const f of CONTACT_FIELDS) delete data[f];
    if (body?.name === undefined && body?.company === undefined) {
      delete data.name;
    }
  }
  return data;
}

/**
 * WhatsApp numbers live on the lead itself, not per contact, but follow the
 * exact same rule as a saved phone number: once stored, only an admin may
 * change or remove it; everyone else may only add another. Kept as its own
 * field group so a request that only touches WhatsApp never affects the
 * separate guard around `contacts`, and vice versa.
 */
const WHATSAPP_FIELDS = ["whatsappNumbers", "whatsappNumber"];

/** `whatsappNumber` mirrors the first entry, same pattern as phone/phones. */
function normalizeWhatsappNumbers(numbers, legacySingle) {
  const raw = Array.isArray(numbers) ? numbers : [];
  const all = [...raw, legacySingle].map((n) => String(n || "").trim());
  return [...new Set(all.filter(Boolean))];
}

function whatsappNumbersLockedError(existingNumbers, nextNumbers) {
  const before = new Set(existingNumbers || []);
  if (!before.size) return null;

  const after = new Set(nextNumbers || []);
  const lost = [...before].find((n) => !after.has(n));
  if (lost) {
    return `WhatsApp number ${lost} is already saved on this lead. Only an admin can change or remove it — you can add another number.`;
  }
  return null;
}

function mentionsWhatsappFields(body) {
  return WHATSAPP_FIELDS.some((f) => body?.[f] !== undefined);
}

/** A request that says nothing about WhatsApp must not blank it either. */
function dropUnmentionedWhatsappFields(body, data) {
  if (!mentionsWhatsappFields(body)) {
    for (const f of WHATSAPP_FIELDS) delete data[f];
  }
  return data;
}

module.exports = {
  CONTACT_FIELDS,
  normalizeContactPhones,
  contactDetailsLockedError,
  mentionsContactFields,
  dropUnmentionedFields,
  WHATSAPP_FIELDS,
  normalizeWhatsappNumbers,
  whatsappNumbersLockedError,
  mentionsWhatsappFields,
  dropUnmentionedWhatsappFields,
};
