/**
 * Sending inboxes (SMTP) and their IMAP access, configured in .env — never in the DB.
 *
 * One inbox:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (address), SMTP_FROM_NAME,
 *   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, OUTREACH_DAILY_CAP
 * Several inboxes (n = 1..10), each with its own daily cap:
 *   OUTREACH_INBOX_1_EMAIL, OUTREACH_INBOX_1_NAME, OUTREACH_INBOX_1_SMTP_HOST/PORT/USER/PASS,
 *   OUTREACH_INBOX_1_IMAP_HOST/PORT/USER/PASS, OUTREACH_INBOX_1_DAILY_CAP
 * IMAP user/pass default to the SMTP ones; ports default to 587 (SMTP) and 993 (IMAP).
 */
const nodemailer = require("nodemailer");

function readInbox(get, label) {
  const email = (get("EMAIL") || get("SMTP_FROM") || get("SMTP_USER") || "").trim().toLowerCase();
  const smtpHost = (get("SMTP_HOST") || "").trim();
  if (!email || !smtpHost) return null;
  const smtpUser = (get("SMTP_USER") || email).trim();
  const smtpPass = get("SMTP_PASS") || "";
  const imapHost = (get("IMAP_HOST") || "").trim();
  return {
    label,
    email,
    name: (get("NAME") || get("SMTP_FROM_NAME") || "").trim(),
    smtp: {
      host: smtpHost,
      port: Number(get("SMTP_PORT")) || 587,
      user: smtpUser,
      pass: smtpPass,
    },
    imap: imapHost
      ? {
          host: imapHost,
          port: Number(get("IMAP_PORT")) || 993,
          user: (get("IMAP_USER") || smtpUser).trim(),
          pass: get("IMAP_PASS") || smtpPass,
        }
      : null,
    dailyCap: Number(get("DAILY_CAP")) || 0, // 0 → use the settings default
  };
}

function getInboxes(env = process.env) {
  const inboxes = [];
  for (let n = 1; n <= 10; n++) {
    const inbox = readInbox((k) => env[`OUTREACH_INBOX_${n}_${k}`], `OUTREACH_INBOX_${n}`);
    if (inbox) inboxes.push(inbox);
  }
  if (!inboxes.length) {
    const single = readInbox(
      (k) =>
        ({
          EMAIL: env.SMTP_FROM,
          NAME: env.SMTP_FROM_NAME,
          DAILY_CAP: env.OUTREACH_DAILY_CAP,
        })[k] ?? env[k],
      "SMTP"
    );
    if (single) inboxes.push(single);
  }
  return inboxes;
}

/** Public view of an inbox (no passwords). */
function describeInbox(inbox) {
  return {
    email: inbox.email,
    name: inbox.name,
    smtpHost: inbox.smtp.host,
    imapHost: inbox.imap?.host || "",
    hasImap: Boolean(inbox.imap),
    dailyCap: inbox.dailyCap,
    label: inbox.label,
  };
}

const transports = new Map();
function transportFor(inbox) {
  const key = `${inbox.email}|${inbox.smtp.host}|${inbox.smtp.port}|${inbox.smtp.user}`;
  if (!transports.has(key)) {
    transports.set(
      key,
      nodemailer.createTransport({
        host: inbox.smtp.host,
        port: inbox.smtp.port,
        secure: inbox.smtp.port === 465,
        auth: inbox.smtp.user ? { user: inbox.smtp.user, pass: inbox.smtp.pass } : undefined,
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 60_000,
      })
    );
  }
  return transports.get(key);
}

async function verifySmtp(inbox) {
  try {
    await transportFor(inbox).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send one email. Returns { messageId, accepted, rejected }.
 * Threading: pass inReplyTo + references to keep Email #2 in the same thread.
 */
async function sendMail(inbox, { to, subject, text, html, inReplyTo, references, headers = {}, attachments }) {
  const mailOptions = {
    from: inbox.name ? { name: inbox.name, address: inbox.email } : inbox.email,
    to,
    subject,
    text,
    html,
    inReplyTo,
    references,
    headers,
  };
  if (Array.isArray(attachments) && attachments.length > 0) {
    mailOptions.attachments = attachments;
  }
  const info = await transportFor(inbox).sendMail(mailOptions);
  return { messageId: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
}

module.exports = { getInboxes, describeInbox, verifySmtp, sendMail };
