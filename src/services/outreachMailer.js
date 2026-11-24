/**
 * Sending inboxes: Supports both HTTP API (Resend, Brevo - Port 443, never blocked on Render/cloud)
 * and standard SMTP (Google Workspace/Gmail).
 */
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

function readInbox(get, label) {
  const email = (get("EMAIL") || get("SMTP_FROM") || get("SMTP_USER") || "").trim().toLowerCase();
  const smtpHost = (get("SMTP_HOST") || "").trim();
  if (!email && !smtpHost) return null;
  const resolvedEmail = email || "exports@oneroot.farm";
  const smtpUser = (get("SMTP_USER") || resolvedEmail).trim();
  const smtpPass = get("SMTP_PASS") || "";
  const imapHost = (get("IMAP_HOST") || "").trim();
  return {
    label,
    email: resolvedEmail,
    name: (get("NAME") || get("SMTP_FROM_NAME") || "").trim(),
    smtp: {
      host: smtpHost || "smtp.gmail.com",
      port: Number(get("SMTP_PORT")) || 465,
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
    dailyCap: Number(get("DAILY_CAP")) || 0,
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
  if (!inboxes.length && (env.RESEND_API_KEY || env.BREVO_API_KEY)) {
    inboxes.push({
      label: env.RESEND_API_KEY ? "Resend" : "Brevo",
      email: (env.SMTP_FROM || env.RESEND_FROM || "exports@oneroot.farm").trim().toLowerCase(),
      name: (env.SMTP_FROM_NAME || "Admin | OneRoot Farm").trim(),
      smtp: { host: "api.resend.com", port: 443, user: "", pass: "" },
      imap: null,
      dailyCap: Number(env.OUTREACH_DAILY_CAP) || 0,
    });
  }
  return inboxes;
}

/** Public view of an inbox (no passwords). */
function describeInbox(inbox) {
  return {
    email: inbox.email,
    name: inbox.name,
    smtpHost: process.env.RESEND_API_KEY ? "Resend (HTTPS Port 443)" : process.env.BREVO_API_KEY ? "Brevo (HTTPS Port 443)" : inbox.smtp.host,
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
  if (process.env.RESEND_API_KEY) {
    return { ok: true, provider: "Resend (HTTPS Port 443)" };
  }
  if (process.env.BREVO_API_KEY) {
    return { ok: true, provider: "Brevo (HTTPS Port 443)" };
  }
  try {
    await transportFor(inbox).verify();
    return { ok: true, provider: "SMTP" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send email via Resend HTTP API (Port 443 - never blocked on Render/cloud)
 */
async function sendViaResend(apiKey, inbox, { to, subject, text, html, inReplyTo, references, headers = {}, attachments }) {
  const fromName = inbox.name || "OneRoot Exports";
  const fromAddress = inbox.email || "exports@oneroot.farm";
  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text: text || undefined,
    html: html || undefined,
    headers: {
      ...headers,
      ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
      ...(references ? { References: Array.isArray(references) ? references.join(" ") : references } : {}),
    },
  };

  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachments = attachments.map((att) => {
      let content = att.content;
      if (!content && att.path && fs.existsSync(att.path)) {
        content = fs.readFileSync(att.path).toString("base64");
      } else if (Buffer.isBuffer(content)) {
        content = content.toString("base64");
      }
      return {
        filename: att.filename || "attachment.pdf",
        content,
      };
    });
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.message || `Resend HTTP error ${response.status}: ${response.statusText}`;
    throw new Error(`Resend delivery failed: ${errorMsg}`);
  }

  return {
    messageId: data.id ? `<${data.id}@resend.dev>` : `<${Date.now()}@oneroot.farm>`,
    accepted: Array.isArray(to) ? to : [to],
    rejected: [],
  };
}

/**
 * Send email via Brevo HTTP API (Port 443 - never blocked on Render/cloud)
 */
async function sendViaBrevo(apiKey, inbox, { to, subject, text, html, inReplyTo, references, headers = {}, attachments }) {
  const fromName = inbox.name || "OneRoot Exports";
  const fromAddress = inbox.email || "exports@oneroot.farm";

  const payload = {
    sender: { name: fromName, email: fromAddress },
    to: (Array.isArray(to) ? to : [to]).map((e) => ({ email: e })),
    subject,
    textContent: text || undefined,
    htmlContent: html || undefined,
    headers: {
      ...headers,
      ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
      ...(references ? { References: Array.isArray(references) ? references.join(" ") : references } : {}),
    },
  };

  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachment = attachments.map((att) => {
      let content = att.content;
      if (!content && att.path && fs.existsSync(att.path)) {
        content = fs.readFileSync(att.path).toString("base64");
      } else if (Buffer.isBuffer(content)) {
        content = content.toString("base64");
      }
      return {
        name: att.filename || "attachment.pdf",
        content,
      };
    });
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey.trim(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.message || `Brevo HTTP error ${response.status}: ${response.statusText}`;
    throw new Error(`Brevo delivery failed: ${errorMsg}`);
  }

  return {
    messageId: data.messageId || `<${Date.now()}@oneroot.farm>`,
    accepted: Array.isArray(to) ? to : [to],
    rejected: [],
  };
}

/**
 * Send one email. Automatically routes through Resend/Brevo HTTP API if API key exists,
 * or standard SMTP transporter.
 */
async function sendMail(inbox, options) {
  if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim()) {
    return await sendViaResend(process.env.RESEND_API_KEY, inbox, options);
  }
  if (process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim()) {
    return await sendViaBrevo(process.env.BREVO_API_KEY, inbox, options);
  }

  const { to, subject, text, html, inReplyTo, references, headers = {}, attachments } = options;
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
