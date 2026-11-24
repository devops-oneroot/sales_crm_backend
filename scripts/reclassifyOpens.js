/**
 * Re-classify historical open events with the scanner/prefetch filter and
 * correct openCount / status / firstOpenedAt on emails that were falsely
 * marked as opened.
 *
 *   node scripts/reclassifyOpens.js          # dry run, prints changes
 *   node scripts/reclassifyOpens.js --apply  # writes changes
 */
require("dotenv").config();
const mongoose = require("mongoose");
const EmailMessage = require("../src/models/EmailMessage");
const Importer = require("../src/models/Importer");
const { classifyHit } = require("../src/routes/emailTracking");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const emails = await EmailMessage.find({ "opens.0": { $exists: true } });
  let changed = 0;

  for (const email of emails) {
    // Replay events in order so burst detection sees the same history it would have live
    const opens = [...email.opens].sort((a, b) => a.timestamp - b.timestamp);
    const replay = {
      sentAt: email.sentAt,
      createdAt: email.createdAt,
      scannerHits: email.scannerHits || [],
      opens: [],
    };
    let human = 0;
    let bots = 0;
    let firstHuman = null;
    let lastHuman = null;

    for (const o of opens) {
      let isBot = false;
      let reason = "";
      if (!o.inferredFromClick) {
        ({ isBot, reason } = classifyHit(replay, {
          userAgent: o.userAgent,
          ip: o.ip,
          kind: "open",
          now: new Date(o.timestamp).getTime(),
        }));
      }
      replay.opens.push(o);
      o.isBot = isBot;
      o.botReason = isBot ? reason : undefined;
      if (isBot) bots++;
      else {
        human++;
        firstHuman = firstHuman || o.timestamp;
        lastHuman = o.timestamp;
      }
    }

    const wasOpened = (email.openCount || 0) > 0 || email.status === "opened";
    if (email.openCount === human && (email.botOpenCount || 0) === bots) continue;
    changed++;

    console.log(
      `${email.recipientEmail.padEnd(34)} opens ${email.openCount} -> ${human} (bots ${bots})` +
        (wasOpened && human === 0 ? "  [status opened -> sent]" : "")
    );

    if (!APPLY) continue;

    email.openCount = human;
    email.botOpenCount = bots;
    email.firstOpenedAt = firstHuman || undefined;
    email.lastOpenedAt = lastHuman || undefined;
    if (human === 0 && email.status === "opened") email.status = "sent";
    await email.save();

    if (email.importerId) {
      const others = await EmailMessage.find({
        importerId: email.importerId,
        direction: "outbound",
      }).lean();
      const total = others.reduce((n, e) => n + (e.openCount || 0), 0);
      const first = others
        .map((e) => e.firstOpenedAt)
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      await Importer.updateOne(
        { _id: email.importerId },
        total
          ? { $set: { email_open_count: total, email_opened_at: first } }
          : { $set: { email_open_count: 0 }, $unset: { email_opened_at: "" } }
      );
    }
  }

  console.log(`\n${changed} of ${emails.length} emails ${APPLY ? "corrected" : "would change (dry run; pass --apply)"}`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
