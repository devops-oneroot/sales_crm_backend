/**
 * Outreach sequence engine.
 *
 *   enrol (verified A/B only) → Email #1 in the recipient's business hours
 *   → wait 24–72h (default 48h) → Email #2 in the same thread, in business hours.
 *
 * Every send re-checks the gate (verified A/B, not unsubscribed/suppressed, no reply or
 * bounce). Per-inbox daily caps and a minimum gap between sends are enforced. Inboxes
 * are read over IMAP: replies, bounces and unsubscribe requests stop the sequence;
 * out-of-office auto-replies are recorded but don't.
 */
const fs = require("fs");
const path = require("path");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const Importer = require("../models/Importer");
const EmailMessage = require("../models/EmailMessage");
const OutreachSettings = require("../models/OutreachSettings");
const Suppression = require("../models/Suppression");
const { canEnrollInOutreach } = require("../lib/importerProvenance");
const R = require("../lib/outreachRules");
const { getInboxes, sendMail } = require("./outreachMailer");

const TICK_MS = 2 * 60 * 1000;
const POLL_MS = 5 * 60 * 1000;
const MAX_DUE_PER_TICK = 50;
const RETRY_AFTER_MS = 15 * 60 * 1000;

// ------------------------------------------------------------------ settings

async function getSettings() {
  let s = await OutreachSettings.findOne();
  if (!s) s = await OutreachSettings.create({});
  if (!s.sender_address || !s.sender_address.trim()) {
    s.sender_address = "OneRoot Farm, International Exports Division, Bengaluru, Karnataka 560001, India";
    await s.save();
  }
  return s;
}

function hoursOf(s) {
  return {
    startHour: s.business_start_hour ?? 9,
    endHour: s.business_end_hour ?? 17,
    days: s.business_days?.length ? s.business_days : [1, 2, 3, 4, 5],
  };
}

function publicUrl() {
  return (process.env.OUTREACH_PUBLIC_URL || process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "");
}

function unsubscribeUrl(importerId) {
  const base = publicUrl();
  return base ? `${base}/api/outreach/unsubscribe/${R.makeUnsubscribeToken(importerId)}` : "";
}

// ------------------------------------------------------------------ composing

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Build Email #1 or #2 for an importer. Returns { subject, text, html, problems[] };
 * if problems is non-empty the email must not be sent.
 */
function composeEmail(importer, settings, step, { inbox, previous } = {}) {
  const problems = [];
  const fields = R.buildMergeFields(importer, settings);
  const subjectSrc = step === 1 ? settings.email1_subject : `Re: ${importer.outreach_subject || ""}`;
  const bodySrc = step === 1 ? settings.email1_body : settings.email2_body;

  const subject = step === 1 ? R.renderTemplate(subjectSrc, fields) : { text: subjectSrc, missing: [], unknown: [] };
  const body = R.renderTemplate(bodySrc, fields);
  const missing = [...new Set([...subject.missing, ...body.missing])];
  const unknown = [...new Set([...subject.unknown, ...body.unknown])];
  if (missing.length) {
    problems.push(
      `Missing merge field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} — fill it in on the importer or add a fallback like {{${missing[0]}|…}}`
    );
  }
  if (unknown.length) problems.push(`Unknown merge field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  if (step === 2 && !importer.outreach_subject) problems.push("Email #1 subject not recorded — cannot thread Email #2");
  if (!subject.text.trim()) problems.push("Subject is empty");

  const unsub = unsubscribeUrl(importer._id);
  if (!unsub) problems.push("OUTREACH_PUBLIC_URL is not set — every email needs a working unsubscribe link");

  const signature = String(settings.signature || "").trim();
  const address = String(settings.sender_address || "").trim();
  const footer = [address, unsub ? `If you'd prefer not to hear from us, unsubscribe here: ${unsub}` : ""].filter(Boolean).join("\n");

  let text = body.text.trim();
  if (signature) text += `\n${signature}`;
  if (step === 2 && previous) {
    const when = new Date(previous.sentAt).toUTCString();
    const quoted = String(previous.body).split("\n").map((l) => `> ${l}`).join("\n");
    text += `\n\nOn ${when}, ${inbox?.name || inbox?.email || "we"} wrote:\n${quoted}`;
  }
  text += `\n\n--\n${footer}`;

  const htmlBody = escapeHtml(text.slice(0, text.lastIndexOf("\n\n--\n")))
    .replace(/\n/g, "<br>")
    .replace(/(^|<br>)&gt; ?/g, "$1<span style=\"color:#666\">&gt; </span>");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${htmlBody}` +
    `<hr style="border:none;border-top:1px solid #ddd;margin:20px 0 8px">` +
    `<p style="font-size:12px;color:#777">${address ? escapeHtml(address).replace(/\n/g, "<br>") + "<br>" : ""}` +
    (unsub ? `If you'd prefer not to hear from us, <a href="${escapeHtml(unsub)}">unsubscribe here</a>.` : "") +
    `</p></div>`;

  return { subject: subject.text.trim(), text, html, problems, unsubscribeUrl: unsub };
}

// ------------------------------------------------------------------ gate

/** Reason this importer must not be emailed now, or "". */
async function sendBlocker(imp) {
  if (!imp.email) return "No email address";
  if (imp.reply_detected_at) return "Buyer already replied";
  if (imp.bounce_detected_at) return "Email bounced";
  const gate = canEnrollInOutreach(imp);
  if (!gate.allowed) return gate.reason;
  if (await Suppression.isSuppressed(imp.email)) return "Email is on the suppression list";
  return "";
}

// ------------------------------------------------------------------ enrol / stop

async function enrollImporter(imp, userName = "User") {
  const blocker = await sendBlocker(imp);
  if (blocker) {
    const err = new Error(blocker);
    err.status = 422;
    throw err;
  }
  const settings = await getSettings();
  const { tz } = R.resolveTimezone(imp);
  const next = R.nextBusinessSlot(new Date(), tz, hoursOf(settings));
  imp.set({
    outreach_enrolled: true,
    outreach_enrolled_at: new Date(),
    outreach_status: "scheduled",
    outreach_step: 0,
    outreach_wait_hours: settings.wait_hours,
    outreach_next_send_at: next,
    outreach_last_error: "",
    recipient_timezone: imp.recipient_timezone && imp.recipient_timezone !== "UTC" ? imp.recipient_timezone : tz,
  });
  imp.timeline.push({
    status: "Enrolled",
    note: `Enrolled in outreach. Email #1 scheduled for ${next.toISOString()} (${tz} business hours)`,
    changed_by: userName,
    timestamp: new Date(),
  });
  await imp.save({ validateBeforeSave: false });
  return imp;
}

async function stopSequence(importerId, status, note, extra = {}, changedBy = "System") {
  await Importer.updateOne(
    { _id: importerId },
    {
      $set: { outreach_enrolled: false, outreach_status: status, ...extra },
      $unset: { outreach_next_send_at: 1, email_2_scheduled_at: 1 },
      $push: { timeline: { status: status === "replied" ? "Replied" : `Outreach ${status}`, note, changed_by: changedBy, timestamp: new Date() } },
    }
  );
}

async function suppress(email, reason, importerId, note = "", addedBy = "System") {
  if (!email) return;
  await Suppression.updateOne(
    { email: email.toLowerCase() },
    { $setOnInsert: { email: email.toLowerCase(), reason, importerId, note, addedBy } },
    { upsert: true }
  );
}

// ------------------------------------------------------------------ sending (tick)

function utcMidnight(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function inboxUsage(inboxes) {
  const since = utcMidnight();
  const usage = {};
  for (const inbox of inboxes) {
    const [sentToday, last] = await Promise.all([
      EmailMessage.countDocuments({ inboxEmail: inbox.email, direction: "outbound", outreachStep: { $exists: true }, sentAt: { $gte: since } }),
      EmailMessage.findOne({ inboxEmail: inbox.email, direction: "outbound" }).sort({ sentAt: -1 }).select("sentAt").lean(),
    ]);
    usage[inbox.email] = { sentToday, lastSentAt: last?.sentAt ? new Date(last.sentAt) : null };
  }
  return usage;
}

let ticking = false;

/** Send everything that is due. Returns a summary. */
async function tick({ now = new Date() } = {}) {
  if (ticking) return { skipped: "already running" };
  ticking = true;
  const summary = { sent: 0, deferred: 0, blocked: 0, errors: 0, details: [] };
  try {
    const settings = await getSettings();
    if (!settings.sending_enabled) return { ...summary, skipped: "sending is switched off" };
    const inboxes = getInboxes();
    if (!inboxes.length) return { ...summary, skipped: "no sending inbox configured" };

    const hours = hoursOf(settings);
    const usage = await inboxUsage(inboxes);
    const capOf = (ib) => ib.dailyCap || settings.default_daily_cap;
    const gapMs = settings.min_gap_seconds * 1000;
    const canSend = (ib) =>
      usage[ib.email].sentToday < capOf(ib) && (!usage[ib.email].lastSentAt || now - usage[ib.email].lastSentAt >= gapMs);

    const due = await Importer.find({
      outreach_enrolled: true,
      outreach_status: { $in: ["scheduled", "waiting_followup"] },
      outreach_next_send_at: { $lte: now },
    })
      .sort({ outreach_next_send_at: 1 })
      .limit(MAX_DUE_PER_TICK);

    for (const imp of due) {
      const name = imp.companyName || imp.importerName;
      const step = imp.outreach_status === "scheduled" ? 1 : 2;

      const blocker = await sendBlocker(imp);
      if (blocker) {
        const status = /suppression/i.test(blocker) ? "stopped" : /replied/i.test(blocker) ? "replied" : /bounced/i.test(blocker) ? "bounced" : "blocked";
        await stopSequence(imp._id, status, `Not sent: ${blocker}`, { outreach_last_error: blocker });
        summary.blocked++;
        summary.details.push(`${name}: blocked — ${blocker}`);
        continue;
      }

      const { tz } = R.resolveTimezone(imp);
      if (!R.isWithinHours(now, tz, hours)) {
        const next = R.nextBusinessSlot(now, tz, hours);
        await Importer.updateOne({ _id: imp._id }, { $set: { outreach_next_send_at: next } });
        summary.deferred++;
        continue;
      }

      // Email #2 must go from the same inbox to stay in the thread.
      const inbox =
        step === 2
          ? inboxes.find((ib) => ib.email === imp.outreach_inbox && canSend(ib))
          : inboxes.filter(canSend).sort((a, b) => usage[a.email].sentToday - usage[b.email].sentToday)[0];
      if (!inbox) {
        if (step === 2 && !inboxes.some((ib) => ib.email === imp.outreach_inbox)) {
          await stopSequence(imp._id, "blocked", `Inbox ${imp.outreach_inbox} is no longer configured`, { outreach_last_error: "Original inbox removed" });
          summary.blocked++;
        } else {
          summary.deferred++; // cap reached or spacing — try again next tick
        }
        continue;
      }

      const previous =
        step === 2
          ? await EmailMessage.findOne({ importerId: imp._id, outreachStep: 1, direction: "outbound" }).sort({ sentAt: 1 }).lean()
          : null;
      const mail = composeEmail(imp, settings, step, { inbox, previous });
      if (mail.problems.length) {
        await stopSequence(imp._id, "blocked", `Not sent: ${mail.problems.join("; ")}`, { outreach_last_error: mail.problems.join("; ") });
        summary.blocked++;
        summary.details.push(`${name}: blocked — ${mail.problems[0]}`);
        continue;
      }

      const threadIds = imp.outreach_message_ids || [];
      const attachments = [];
      const deckPath = path.resolve(__dirname, "../../uploads/oneroot_IPM_Turmeric_Europe_v4.pdf");
      if (fs.existsSync(deckPath)) {
        attachments.push({
          filename: "OneRoot_IPM_Turmeric_Europe_Specifications.pdf",
          path: deckPath,
          contentType: "application/pdf",
        });
      }

      try {
        const res = await sendMail(inbox, {
          to: imp.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          inReplyTo: step === 2 ? threadIds[threadIds.length - 1] : undefined,
          references: step === 2 ? threadIds : undefined,
          headers: {
            "List-Unsubscribe": `<${mail.unsubscribeUrl}>, <mailto:${inbox.email}?subject=unsubscribe>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
          attachments,
        });
        const sentAt = new Date();
        usage[inbox.email].sentToday++;
        usage[inbox.email].lastSentAt = sentAt;

        await EmailMessage.create({
          importerId: imp._id,
          direction: "outbound",
          senderEmail: inbox.email,
          senderName: inbox.name,
          recipientEmail: imp.email,
          recipientName: imp.contactPerson || name,
          subject: mail.subject,
          body: mail.text,
          snippet: mail.text.slice(0, 140),
          status: "sent",
          sentAt,
          userName: "Outreach sequence",
          tags: ["outreach", `email${step}`],
          messageId: res.messageId,
          inReplyTo: step === 2 ? threadIds[threadIds.length - 1] : undefined,
          references: step === 2 ? threadIds : [],
          inboxEmail: inbox.email,
          outreachStep: step,
        });

        if (step === 1) {
          const followUp = R.scheduleFollowUp(sentAt, imp.outreach_wait_hours || settings.wait_hours, tz, hours);
          const pipelineMove = ["New", "Verified"].includes(imp.pipeline_status) ? { pipeline_status: "Emailed", status: "Emailed" } : {};
          await Importer.updateOne(
            { _id: imp._id },
            {
              $set: {
                outreach_step: 1,
                outreach_status: "waiting_followup",
                outreach_inbox: inbox.email,
                outreach_subject: mail.subject,
                thread_message_id: res.messageId,
                email_1_sent_at: sentAt,
                email_2_scheduled_at: followUp,
                outreach_next_send_at: followUp,
                outreach_last_error: "",
                ...pipelineMove,
              },
              $push: {
                outreach_message_ids: res.messageId,
                timeline: {
                  status: "Emailed",
                  note: `Email #1 sent from ${inbox.email}. Follow-up scheduled ${followUp.toISOString()} (${tz})`,
                  changed_by: "Outreach sequence",
                  timestamp: sentAt,
                },
              },
            }
          );
        } else {
          const pipelineMove = ["New", "Verified", "Emailed"].includes(imp.pipeline_status) ? { pipeline_status: "Followed up", status: "Followed up" } : {};
          await Importer.updateOne(
            { _id: imp._id },
            {
              $set: { outreach_step: 2, outreach_status: "completed", email_2_sent_at: sentAt, outreach_last_error: "", ...pipelineMove },
              $unset: { outreach_next_send_at: 1 },
              $push: {
                outreach_message_ids: res.messageId,
                timeline: { status: "Followed up", note: `Email #2 sent in the same thread from ${inbox.email}`, changed_by: "Outreach sequence", timestamp: sentAt },
              },
            }
          );
        }
        summary.sent++;
        summary.details.push(`${name}: Email #${step} sent`);
      } catch (err) {
        // Permanent rejection of the recipient (5xx) = bounce; anything else = retry later.
        const permanent = err.responseCode >= 500 && err.responseCode < 600 && /recipient|mailbox|user|address|5\.1\./i.test(err.response || err.message);
        if (permanent) {
          await suppress(imp.email, "bounced", imp._id, `SMTP: ${err.response || err.message}`);
          await stopSequence(imp._id, "bounced", `Email #${step} rejected by recipient server: ${err.response || err.message}`, {
            bounce_detected_at: new Date(),
            email_status: "invalid",
            outreach_last_error: err.message,
          });
        } else {
          await Importer.updateOne(
            { _id: imp._id },
            { $set: { outreach_last_error: `Send failed (will retry): ${err.message}`, outreach_next_send_at: new Date(now.getTime() + RETRY_AFTER_MS) } }
          );
        }
        summary.errors++;
        summary.details.push(`${name}: ${permanent ? "bounced" : "send error"} — ${err.message}`);
      }
    }
    return summary;
  } finally {
    ticking = false;
    const text = summary.skipped ? `Skipped: ${summary.skipped}` : `sent ${summary.sent}, deferred ${summary.deferred}, blocked ${summary.blocked}, errors ${summary.errors}`;
    await OutreachSettings.updateOne({}, { $set: { last_tick_at: new Date(), last_tick_result: text } }).catch(() => {});
  }
}

// ------------------------------------------------------------------ reading inboxes (IMAP)

const addrOf = (a) => (a?.value?.[0]?.address || "").toLowerCase();

async function findImporterForMessage(parsed, kind, ownAddresses) {
  const ids = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])]
    .filter(Boolean)
    .map((s) => String(s).trim());
  if (ids.length) {
    const byThread = await Importer.findOne({ outreach_message_ids: { $in: ids } });
    if (byThread) return byThread;
  }
  if (kind === "bounce") {
    // Bounce reports quote our original Message-ID and/or the failed recipient.
    const body = `${parsed.text || ""}\n${(parsed.attachments || []).map((a) => a.content?.toString?.("utf8") || "").join("\n")}`;
    const quotedIds = body.match(/<[^<>\s]+@[^<>\s]+>/g) || [];
    if (quotedIds.length) {
      const byQuoted = await Importer.findOne({ outreach_message_ids: { $in: quotedIds } });
      if (byQuoted) return byQuoted;
    }
    const rcpt = R.bouncedRecipient(body, ownAddresses);
    if (rcpt) return Importer.findOne({ email: rcpt });
    return null;
  }
  const from = addrOf(parsed.from);
  return from ? Importer.findOne({ email: from, outreach_message_ids: { $exists: true, $ne: [] } }) : null;
}

async function handleInbound(parsed, inbox, ownAddresses, summary) {
  const from = addrOf(parsed.from);
  if (ownAddresses.includes(from)) return;
  const messageId = parsed.messageId || "";
  if (messageId && (await EmailMessage.exists({ messageId }))) return; // already processed

  const kind = R.classifyInbound({
    from: parsed.from?.text || from,
    subject: parsed.subject,
    text: parsed.text,
    headers: parsed.headers,
    contentType: parsed.headers?.get("content-type")?.value
      ? `${parsed.headers.get("content-type").value}; ${Object.entries(parsed.headers.get("content-type").params || {}).map(([k, v]) => `${k}=${v}`).join("; ")}`
      : "",
  });
  const imp = await findImporterForMessage(parsed, kind, ownAddresses);
  if (!imp) return; // not about an outreach lead — leave it alone

  const text = (parsed.text || "").trim() || "(no text body)";
  await EmailMessage.create({
    importerId: imp._id,
    direction: "inbound",
    senderEmail: from || "unknown@unknown",
    senderName: parsed.from?.value?.[0]?.name || "",
    recipientEmail: inbox.email,
    recipientName: inbox.name,
    subject: parsed.subject || "(no subject)",
    body: text,
    snippet: text.slice(0, 140),
    status: kind === "bounce" ? "bounced" : "unread",
    receivedAt: parsed.date || new Date(),
    sentAt: parsed.date || new Date(),
    tags: ["outreach", kind],
    messageId: messageId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    inboxEmail: inbox.email,
    classification: kind,
  });

  const name = imp.companyName || imp.importerName;
  if (kind === "reply") {
    await stopSequence(imp._id, "replied", `Buyer replied: "${(parsed.subject || "").slice(0, 80)}" — sequence stopped`, {
      reply_detected_at: new Date(),
      pipeline_status: "Replied",
      status: "Replied",
    });
    summary.replies++;
  } else if (kind === "bounce") {
    await suppress(imp.email, "bounced", imp._id, (parsed.subject || "").slice(0, 120));
    await stopSequence(imp._id, "bounced", `Email bounced: "${(parsed.subject || "").slice(0, 80)}" — sequence stopped, address suppressed`, {
      bounce_detected_at: new Date(),
      email_status: "invalid",
    });
    summary.bounces++;
  } else if (kind === "unsubscribe") {
    await suppress(imp.email, "unsubscribed", imp._id, "Unsubscribe request by email");
    await stopSequence(imp._id, "unsubscribed", "Buyer asked to unsubscribe by email — sequence stopped, address suppressed", { unsubscribed: true });
    summary.unsubscribes++;
  } else {
    summary.autoReplies++;
  }
  summary.details.push(`${name}: ${kind}`);
}

let polling = false;

/** Read new mail in every inbox with IMAP configured. */
async function pollInboxes() {
  if (polling) return { skipped: "already running" };
  polling = true;
  const summary = { checked: 0, replies: 0, bounces: 0, unsubscribes: 0, autoReplies: 0, errors: [], details: [] };
  try {
    const inboxes = getInboxes().filter((ib) => ib.imap);
    if (!inboxes.length) return { ...summary, skipped: "no inbox has IMAP configured" };
    const settings = await getSettings();
    const state = { ...(settings.imap_state || {}) };
    const ownAddresses = getInboxes().map((ib) => ib.email);

    for (const inbox of inboxes) {
      const client = new ImapFlow({
        host: inbox.imap.host,
        port: inbox.imap.port,
        secure: inbox.imap.port === 993,
        auth: { user: inbox.imap.user, pass: inbox.imap.pass },
        logger: false,
        socketTimeout: 60_000,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          const box = client.mailbox;
          const prev = state[inbox.email] || {};
          const sameBox = prev.uidValidity && String(prev.uidValidity) === String(box.uidValidity);
          // First run (or mailbox reset): look back 14 days.
          const range = sameBox ? { uid: `${(prev.lastUid || 0) + 1}:*` } : { since: new Date(Date.now() - 14 * 864e5) };
          let maxUid = sameBox ? prev.lastUid || 0 : 0;
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            if (sameBox && msg.uid <= (prev.lastUid || 0)) continue;
            maxUid = Math.max(maxUid, msg.uid);
            summary.checked++;
            try {
              const parsed = await simpleParser(msg.source);
              await handleInbound(parsed, inbox, ownAddresses, summary);
            } catch (err) {
              summary.errors.push(`${inbox.email} uid ${msg.uid}: ${err.message}`);
            }
          }
          state[inbox.email] = { uidValidity: String(box.uidValidity), lastUid: maxUid };
        } finally {
          lock.release();
        }
        await client.logout();
      } catch (err) {
        summary.errors.push(`${inbox.email}: ${err.message}`);
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
    }
    await OutreachSettings.updateOne({}, { $set: { imap_state: state } });
    return summary;
  } finally {
    polling = false;
    const text = summary.skipped
      ? `Skipped: ${summary.skipped}`
      : `${summary.checked} new · ${summary.replies} replies · ${summary.bounces} bounces · ${summary.unsubscribes} unsubscribes · ${summary.autoReplies} auto-replies${summary.errors.length ? ` · errors: ${summary.errors.join("; ")}` : ""}`;
    await OutreachSettings.updateOne({}, { $set: { last_poll_at: new Date(), last_poll_result: text } }).catch(() => {});
  }
}

// ------------------------------------------------------------------ scheduler

let timers = [];
function startOutreachScheduler() {
  stopOutreachScheduler();
  timers.push(setInterval(() => tick().catch((e) => console.error("[Outreach] tick failed:", e.message)), TICK_MS));
  timers.push(setInterval(() => pollInboxes().catch((e) => console.error("[Outreach] IMAP poll failed:", e.message)), POLL_MS));
  console.log(`[Outreach] Scheduler started (send check every ${TICK_MS / 60000} min, inbox check every ${POLL_MS / 60000} min)`);
}
function stopOutreachScheduler() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = {
  getSettings,
  hoursOf,
  publicUrl,
  unsubscribeUrl,
  composeEmail,
  sendBlocker,
  enrollImporter,
  stopSequence,
  suppress,
  tick,
  pollInboxes,
  handleInbound,
  startOutreachScheduler,
  stopOutreachScheduler,
};
