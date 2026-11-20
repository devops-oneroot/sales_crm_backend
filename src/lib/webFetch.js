/**
 * Polite page fetching for Discovery: honours robots.txt, identifies itself,
 * times out, and returns both readable text and the page's outbound links.
 */

const USER_AGENT = "Mozilla/5.0 (compatible; CRM-Discovery/1.0; buyer research)";
const ROBOTS_AGENT = "crm-discovery";
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

const robotsCache = new Map(); // origin -> { rules, fetchedAt }

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** HTML → readable text, keeping block boundaries as line breaks. */
function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/section|\/article)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const href = new URL(decodeEntities(m[1].trim()), baseUrl).toString();
      if (!/^https?:/i.test(href)) continue;
      links.push({ href, text: htmlToText(m[2]).replace(/\s+/g, " ").slice(0, 200) });
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return links;
}

/**
 * Emails and phones that only exist inside mailto:/tel: links ("Email us" buttons).
 * They are appended to the page text as "Email links:" / "Phone links:" lines so the
 * stored evidence contains them verbatim.
 */
function extractContactLinks(html) {
  const emails = new Set();
  const phones = new Set();
  const re = /href\s*=\s*["'](mailto|tel):([^"'?]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let v = m[2];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    v = decodeEntities(v).trim();
    if (m[1].toLowerCase() === "mailto") {
      for (const e of v.split(/[,;]/)) if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim())) emails.add(e.trim().toLowerCase());
    } else if (v.replace(/\D/g, "").length >= 7) {
      phones.add(v);
    }
  }
  return { emails: [...emails], phones: [...phones] };
}

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out) ? out.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * Contacts the page publishes outside its visible text:
 *  - schema.org JSON-LD (Organization / LocalBusiness "email", "telephone", contactPoint)
 *  - Cloudflare-protected emails (shown as "[email protected]" in the page text)
 */
function extractHiddenContacts(html) {
  const emails = new Set();
  const phones = new Set();

  const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const key = k.toLowerCase();
      const values = Array.isArray(v) ? v : [v];
      if (key === "email") {
        for (const e of values) {
          const s = String(e || "").replace(/^mailto:/i, "").trim().toLowerCase();
          if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) emails.add(s);
        }
      } else if (key === "telephone") {
        for (const p of values) {
          const s = String(p || "").replace(/^tel:/i, "").trim();
          if (s.replace(/\D/g, "").length >= 7) phones.add(s);
        }
      } else if (typeof v === "object") {
        walk(v, depth + 1);
      }
    }
  };
  for (const block of ldBlocks) {
    const json = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      walk(JSON.parse(json));
    } catch {
      /* malformed JSON-LD — ignore */
    }
  }

  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) emails.add(e);
  }
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) emails.add(e);
  }
  return { emails: [...emails], phones: [...phones] };
}

/** "info [at] firm [dot] com" / "info(at)firm.com" → "info@firm.com" (as written on the page). */
function deobfuscateEmails(text) {
  return text.replace(
    /\b([A-Za-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\s+at\s+)\s*([A-Za-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\.|\s+dot\s+)\s*[A-Za-z0-9-]+)+)\b/gi,
    (all, user, domain) => {
      const d = domain.replace(/\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*/gi, ".").replace(/\s*\.\s*/g, ".");
      return /\.[A-Za-z]{2,}$/.test(d) && /\[at\]|\(at\)|\{at\}|\[dot\]|\(dot\)/i.test(all) ? `${all} (${user}@${d})` : all;
    }
  );
}

function extractMeta(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const siteName = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i) ||
    [])[1];
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "",
    siteName: siteName ? decodeEntities(siteName).trim() : "",
  };
}

/** Parse the rules that apply to us (our agent, else "*"). */
function parseRobots(txt) {
  const groups = [];
  let current = null;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === "disallow" || key === "allow")) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && ROBOTS_AGENT.includes(a)));
  const star = groups.find((g) => g.agents.includes("*"));
  return (mine || star || { rules: [] }).rules;
}

function robotsAllows(rules, pathWithQuery) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    const pattern = "^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp(pattern).test(pathWithQuery)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return !best || best.allow;
}

async function isAllowedByRobots(url) {
  const u = new URL(url);
  let entry = robotsCache.get(u.origin);
  if (!entry || Date.now() - entry.fetchedAt > 6 * 3600 * 1000) {
    let rules = [];
    try {
      const res = await fetch(`${u.origin}/robots.txt`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) rules = parseRobots(await res.text());
    } catch {
      /* unreachable robots.txt → treat as no rules */
    }
    entry = { rules, fetchedAt: Date.now() };
    robotsCache.set(u.origin, entry);
  }
  return robotsAllows(entry.rules, u.pathname + u.search);
}

const RETRY_DELAY_MS = 1500;

/**
 * Fetch a page. Never throws; returns { ok, status, url, finalUrl, html, text, title,
 * siteName, links, error, blockedByRobots }.
 * Transient failures (timeout, dropped connection, HTTP 429/5xx) are retried once.
 */
async function fetchPage(url) {
  const first = await fetchPageOnce(url);
  if (first.ok || first.blockedByRobots || first.transient === false) return first;
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  const second = await fetchPageOnce(url);
  return second.ok ? second : { ...second, error: `${second.error} (after retry)` };
}

async function fetchPageOnce(url) {
  const base = { ok: false, url, finalUrl: url, html: "", text: "", title: "", siteName: "", links: [] };
  try {
    if (!(await isAllowedByRobots(url))) {
      return { ...base, blockedByRobots: true, error: "Disallowed by the site's robots.txt" };
    }
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const finalUrl = res.url || url;
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      return { ...base, finalUrl, status: res.status, error: `HTTP ${res.status}`, transient };
    }
    const type = res.headers.get("content-type") || "";
    if (type && !/html|xml|text\/plain/i.test(type)) {
      return { ...base, finalUrl, status: res.status, error: `Not an HTML page (${type})`, transient: false };
    }
    let html = await res.text();
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
    const contactLinks = extractContactLinks(html);
    const hidden = extractHiddenContacts(html);
    let text = deobfuscateEmails(htmlToText(html));
    // Appended as labelled lines so the stored evidence contains each value verbatim.
    if (contactLinks.emails.length) text += `\nEmail links: ${contactLinks.emails.join(", ")}`;
    if (contactLinks.phones.length) text += `\nPhone links: ${contactLinks.phones.join(", ")}`;
    if (hidden.emails.length) text += `\nPage data email: ${hidden.emails.join(", ")}`;
    if (hidden.phones.length) text += `\nPage data phone: ${hidden.phones.join(", ")}`;
    return {
      ...base,
      ok: true,
      status: res.status,
      finalUrl,
      html,
      text,
      contactLinks,
      links: extractLinks(html, finalUrl),
      ...extractMeta(html),
    };
  } catch (err) {
    const code = err?.cause?.code || err?.name || "";
    // A domain that doesn't exist won't appear on retry; everything else might.
    const transient = code !== "ENOTFOUND";
    return { ...base, error: code === "TimeoutError" ? "Timed out" : `${code ? code + ": " : ""}${err.message}`, transient };
  }
}

module.exports = {
  fetchPage,
  htmlToText,
  extractLinks,
  extractContactLinks,
  extractHiddenContacts,
  decodeCfEmail,
  deobfuscateEmails,
  parseRobots,
  robotsAllows,
  USER_AGENT,
};
