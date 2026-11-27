/**
 * LinkedIn outreach through Unipile (https://www.unipile.com).
 *
 * The CRM only queues messages. A background sender sends them slowly so the
 * LinkedIn account behaves like a person: at most LINKEDIN_DAILY_LIMIT per day
 * (default 5), weekdays 9:30 AM – 6:30 PM IST, with a random 15–75 minute gap.
 *
 * If the person is already a 1st-degree connection, a direct message is sent;
 * otherwise a connection request with the message as its note (LinkedIn caps
 * notes at 300 characters).
 *
 * Env: UNIPILE_API_KEY, UNIPILE_DSN (e.g. api21.unipile.com:15122),
 *      UNIPILE_ACCOUNT_ID (optional — the first LinkedIn account is used),
 *      LINKEDIN_DAILY_LIMIT, LINKEDIN_MIN_GAP_MIN, LINKEDIN_MAX_GAP_MIN.
 */
const LinkedInMessage = require("../models/LinkedInMessage");
const AppSetting = require("../models/AppSetting");

const TZ = "Asia/Kolkata";
const START_MIN = 9 * 60 + 30; // 9:30 AM IST
const END_MIN = 18 * 60 + 30; // 6:30 PM IST
const NOTE_LIMIT = 300;

const cfg = () => ({
  key: (process.env.UNIPILE_API_KEY || "").trim(),
  dsn: (process.env.UNIPILE_DSN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  accountId: (process.env.UNIPILE_ACCOUNT_ID || "").trim(),
  dailyLimit: Number(process.env.LINKEDIN_DAILY_LIMIT) || 5,
  minGap: Number(process.env.LINKEDIN_MIN_GAP_MIN) || 15,
  maxGap: Number(process.env.LINKEDIN_MAX_GAP_MIN) || 75,
});

const isConfigured = () => Boolean(cfg().key && cfg().dsn);

/**
 * Auto-send on/off, switched from the LinkedIn Queue screen and stored in the
 * database. LINKEDIN_AUTO_SEND in .env is only the default before anyone
 * changes it.
 */
const AUTO_SEND_KEY = "linkedin.autoSend";
async function getAutoSend() {
  const row = await AppSetting.findOne({ key: AUTO_SEND_KEY }).lean();
  if (row && typeof row.value === "boolean") return row.value;
  return !/^(false|0|off|no)$/i.test(process.env.LINKEDIN_AUTO_SEND || "");
}
async function setAutoSend(on, userName) {
  await AppSetting.updateOne(
    { key: AUTO_SEND_KEY },
    { $set: { value: Boolean(on), updatedBy: userName || "" } },
    { upsert: true }
  );
  console.log(`[LinkedIn] Auto-send turned ${on ? "ON" : "OFF"} by ${userName || "unknown"}`);
  return Boolean(on);
}

async function api(method, path, { json, form, query } = {}) {
  const { key, dsn } = cfg();
  const url = new URL(`https://${dsn}/api/v1${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  const headers = { "X-API-KEY": key, accept: "application/json" };
  let body;
  if (json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, v);
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data.detail || data.title || data.message || text.slice(0, 200);
    const err = new Error(`Unipile ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let cachedAccountId = "";
async function getAccountId() {
  if (cfg().accountId) return cfg().accountId;
  if (cachedAccountId) return cachedAccountId;
  const { items = [] } = await api("GET", "/accounts");
  const li = items.find((a) => a.type === "LINKEDIN");
  if (!li) throw new Error("No LinkedIn account is connected in Unipile");
  return (cachedAccountId = li.id);
}

/** Account + today's numbers, for the CRM screen. */
async function getStatus() {
  const base = {
    configured: isConfigured(),
    dailyLimit: cfg().dailyLimit,
    autoSend: await getAutoSend(),
    window: "Mon–Fri, 9:30 AM – 6:30 PM IST",
    sentToday: await countSentToday(),
    queued: await LinkedInMessage.countDocuments({ status: "queued" }),
  };
  if (!base.configured) return base;
  try {
    const { items = [] } = await api("GET", "/accounts");
    const id = await getAccountId();
    const acc = items.find((a) => a.id === id) || {};
    const state = acc.sources?.[0]?.status || (acc.id ? "OK" : "UNKNOWN");
    return { ...base, account: { id, name: acc.name || "", status: state } };
  } catch (err) {
    return { ...base, error: err.message };
  }
}

/** "https://www.linkedin.com/in/jane-doe-123/?x" → "jane-doe-123" */
function profileIdentifier(url) {
  const s = String(url || "").trim();
  const m = s.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s; // already a slug or provider id
  return "";
}

const isLinkedInProfileUrl = (url) => Boolean(profileIdentifier(url));

// ---- IST time helpers ----
function istParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return { weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
function startOfTodayIST() {
  const { date } = istParts();
  return new Date(`${date}T00:00:00+05:30`);
}
function inSendingWindow() {
  const { weekday, minutes } = istParts();
  return !["Sat", "Sun"].includes(weekday) && minutes >= START_MIN && minutes < END_MIN;
}
/** LinkedIn actions (requests + messages) made today; each one counts toward the daily limit. */
const countSentToday = () =>
  LinkedInMessage.countDocuments({
    status: { $in: ["sent", "invited", "accepted"] },
    sentAt: { $gte: startOfTodayIST() },
  });

/** Short connection-request note (LinkedIn allows 300 characters). */
function defaultNote(msg) {
  const first = String(msg.contactName || "").trim().split(/\s+/)[0];
  const sender = process.env.LINKEDIN_SENDER_NAME || "Vasanth";
  return (
    `Hi${first ? " " + first : ""}, I'm ${sender} from OneRoot. We export premium IPM grade turmeric, ` +
    `contract farmed from farms in Karnataka. I'd like to connect and explore any opportunities to work together` +
    `${msg.company ? ` with ${msg.company}` : ""}.`
  ).slice(0, NOTE_LIMIT);
}

async function lookupProfile(msg) {
  const accountId = await getAccountId();
  const ident = msg.providerId || profileIdentifier(msg.profileUrl);
  if (!ident) throw new Error("Not a LinkedIn profile link (needs linkedin.com/in/…)");
  const profile = await api("GET", `/users/${encodeURIComponent(ident)}`, { query: { account_id: accountId } });
  if (!profile.provider_id) throw new Error("Could not find this LinkedIn profile");
  msg.providerId = profile.provider_id;
  return {
    accountId,
    connected: profile.network_distance === "FIRST_DEGREE" || profile.is_relationship === true,
  };
}

/**
 * Next step for one person — connect first, then message:
 *  - not connected yet → connection request with the short note → "invited"
 *  - connected (already, or they accepted) → the full message → "sent"
 */
async function deliver(msg) {
  const { accountId, connected } = await lookupProfile(msg);
  if (connected) {
    const chat = await api("POST", "/chats", {
      form: { account_id: accountId, attendees_ids: msg.providerId, text: msg.text },
    });
    msg.chatId = chat.chat_id || chat.id || "";
    msg.status = "sent";
    if (msg.invitedAt && !msg.acceptedAt) msg.acceptedAt = new Date();
  } else if (msg.invitedAt) {
    msg.status = "invited"; // request already out; still waiting for them to accept
  } else {
    const note = (msg.note || defaultNote(msg)).slice(0, NOTE_LIMIT);
    await api("POST", "/users/invite", { json: { provider_id: msg.providerId, account_id: accountId, message: note } });
    msg.note = note;
    msg.status = "invited";
    msg.invitedAt = new Date();
  }
}

/**
 * Looks at pending connection requests and marks the accepted ones, so their
 * full message can go out. Runs every few hours, a handful at a time.
 */
const CHECK_EVERY_HOURS = 3;
const CHECK_BATCH = 15;
const GIVE_UP_DAYS = 30;
async function checkAcceptedInvites() {
  if (!isConfigured()) return 0;
  const due = new Date(Date.now() - CHECK_EVERY_HOURS * 3600000);
  const pending = await LinkedInMessage.find({
    status: "invited",
    invitedAt: { $gte: new Date(Date.now() - GIVE_UP_DAYS * 86400000) },
    $or: [{ checkedAt: null }, { checkedAt: { $lt: due } }],
  })
    .sort({ checkedAt: 1 })
    .limit(CHECK_BATCH);
  let accepted = 0;
  for (const msg of pending) {
    try {
      const { connected } = await lookupProfile(msg);
      msg.checkedAt = new Date();
      if (connected) {
        msg.status = "accepted";
        msg.acceptedAt = new Date();
        accepted++;
        console.log(`[LinkedIn] accepted → ${msg.contactName || msg.profileUrl}; full message is next`);
      }
      await msg.save();
    } catch (err) {
      console.warn(`[LinkedIn] accept check failed for ${msg.contactName || msg.profileUrl}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 4000 + Math.random() * 6000)); // don't hammer LinkedIn
  }
  return accepted;
}

let busy = false;
/** One scheduler tick: send at most one message if all the limits allow it. */
async function tick() {
  if (!(await getAutoSend())) return; // off → only the "Send now" button sends
  if (busy || !isConfigured() || !inSendingWindow()) return;
  busy = true;
  try {
    const { dailyLimit, minGap, maxGap } = cfg();
    if ((await countSentToday()) >= dailyLimit) return;

    const last = await LinkedInMessage.findOne({ sentAt: { $ne: null } }).sort({ sentAt: -1 }).lean();
    if (last?.nextAllowedAt && last.nextAllowedAt > new Date()) return;

    // People who accepted get their full message before new requests go out.
    const msg =
      (await LinkedInMessage.findOne({ status: "accepted" }).sort({ acceptedAt: 1 })) ||
      (await LinkedInMessage.findOne({ status: "queued" }).sort({ createdAt: 1 }));
    if (!msg) return;

    const gapMin = minGap + Math.random() * Math.max(0, maxGap - minGap);
    try {
      await deliver(msg);
      msg.error = "";
      console.log(`[LinkedIn] ${msg.status} → ${msg.contactName || msg.profileUrl} (${msg.company || ""})`);
    } catch (err) {
      msg.status = "failed";
      msg.error = err.message;
      console.warn(`[LinkedIn] failed → ${msg.contactName || msg.profileUrl}: ${err.message}`);
    }
    msg.sentAt = new Date();
    msg.nextAllowedAt = new Date(Date.now() + gapMin * 60000);
    await msg.save();
  } catch (err) {
    console.warn("[LinkedIn] scheduler error:", err.message);
  } finally {
    busy = false;
  }
}

/**
 * Send one queued message right now (the "Send now" button). Skips the timing
 * gap and sending hours — the person chose the moment — but still respects
 * the daily limit to protect the LinkedIn account.
 */
async function sendNow(id) {
  if (!isConfigured()) throw Object.assign(new Error("Unipile isn't connected on the server"), { status: 503 });
  if (busy) throw Object.assign(new Error("Another message is being sent — try again in a few seconds"), { status: 409 });
  busy = true;
  try {
    const { dailyLimit } = cfg();
    if ((await countSentToday()) >= dailyLimit) {
      throw Object.assign(new Error(`Daily limit reached (${dailyLimit} today) — it will go out on the next working day`), {
        status: 429,
      });
    }
    const msg = await LinkedInMessage.findOne({ _id: id, status: { $in: ["queued", "accepted", "failed", "invited"] } });
    if (!msg) throw Object.assign(new Error("This message has already been sent or was cancelled"), { status: 404 });
    const wasInvited = Boolean(msg.invitedAt);
    try {
      await deliver(msg);
      msg.error = "";
    } catch (err) {
      msg.status = "failed";
      msg.error = err.message;
    }
    if (wasInvited && msg.status === "invited") {
      // Nothing was sent: the request is still waiting for them to accept.
      msg.checkedAt = new Date();
      await msg.save();
      throw Object.assign(
        new Error(`${msg.contactName || "They"} hasn't accepted the connection request yet — the message goes out once they do`),
        { status: 409 }
      );
    }
    msg.sentAt = new Date();
    // Keep the automatic sender from firing right after a manual send.
    const { minGap } = cfg();
    msg.nextAllowedAt = new Date(Date.now() + minGap * 60000);
    await msg.save();
    return msg;
  } finally {
    busy = false;
  }
}

let timer = null;
function startLinkedInSender() {
  if (timer) return;
  timer = setInterval(() => void tick(), 5 * 60 * 1000);
  setTimeout(() => void tick(), 30 * 1000);
  // Look for accepted connection requests every hour (each request at most every 3 h).
  setInterval(() => void checkAcceptedInvites().catch(() => {}), 60 * 60 * 1000);
  setTimeout(() => void checkAcceptedInvites().catch(() => {}), 2 * 60 * 1000);
  console.log(
    isConfigured()
      ? `[LinkedIn] Sender on: up to ${cfg().dailyLimit}/day, Mon–Fri 9:30–18:30 IST`
      : "[LinkedIn] Sender idle: UNIPILE_API_KEY / UNIPILE_DSN not set"
  );
}

module.exports = {
  isConfigured,
  getStatus,
  isLinkedInProfileUrl,
  startLinkedInSender,
  tick,
  sendNow,
  setAutoSend,
  checkAcceptedInvites,
};
