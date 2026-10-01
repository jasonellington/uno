// Unknown-sender alerts, independent of the model (docs/architecture.md).
// Run from healthping every 5 minutes. Reads new inbound messages through
// imsg (not sqlite from node, so it keeps working once node loses Full Disk
// Access; imsg is the one reader of chat.db) and flags:
//   - a DM sender whose handle isn't in channels.imessage.allowFrom
//   - a group sender who isn't in channels.imessage.groupAllowFrom (or, when
//     that's unset, allowFrom), the way OpenClaw gates group senders
//   - any message in a group chat that isn't approved: channels.imessage.groups
//     keys, and none at all while groupPolicy is "disabled"
// accessGroup:<name> entries expand to that group's iMessage and "*" members
// (OpenClaw docs: channels/access-groups.md). Reads those settings with
// `openclaw config get` (never the config file).
// Every event goes to unknown-senders.jsonl (0600, no message text). At most
// one Healthchecks /fail per sender (or unapproved group) per hour; runs with
// nothing new ping success so the next alert emails again.
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Absolute paths: this runs from OpenClaw's scheduler, not a login shell.
export const IMSG = "/opt/homebrew/bin/imsg";
export const OPENCLAW = "/opt/homebrew/bin/openclaw";
const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DIR = join(homedir(), ".openclaw/uno-data");
export const LOG = join(DIR, "unknown-senders.jsonl");
const STATE = join(DIR, "unknown-senders.state.json");
const HOUR = 60 * 60_000;
// Look this far back for rows newer than the watermark: a message delivered
// late (Mac offline) keeps its send time, so a tight window would miss it.
const LOOKBACK = 24 * HOUR;

// chat.db handles come as E.164, emails, or bare digits (short codes);
// allowFrom entries may carry a channel prefix.
export function canonicalHandle(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.trim().replace(/^(imessage|tel|mailto|sms):/i, "");
  if (E164_RE.test(s)) return s;
  if (EMAIL_RE.test(s.toLowerCase())) return s.toLowerCase();
  const digits = s.replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return s.toLowerCase();
}

// Short codes (verification codes, carrier notices) are 3-6 digits.
export function senderKind(handle) {
  return /^\d{3,6}$/.test(handle) ? "shortcode" : "person";
}

// +14155551234 -> +1•••1234; jane@example.com -> j•••@example.com
export function maskHandle(handle) {
  if (handle.includes("@")) {
    const [user, domain] = handle.split("@");
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  if (handle.startsWith("+")) return `${handle.slice(0, 2)}•••${handle.slice(-4)}`;
  return handle.length > 4 ? `•••${handle.slice(-4)}` : handle;
}

// allowFrom-style entries with accessGroup:<name> replaced by its members.
export function expandEntries(entries, accessGroups) {
  return (entries ?? []).map(String).flatMap((entry) => {
    const name = /^accessGroup:(.+)$/.exec(entry)?.[1];
    if (!name) return [entry];
    const members = accessGroups?.[name]?.members ?? {};
    return [...(members.imessage ?? []), ...(members["*"] ?? [])].map(String);
  });
}

// OpenClaw's iMessage access settings -> who and which groups are expected.
// "*" in an allowlist means anyone; "*" in groups means any group. Group
// senders: groupAllowFrom, or allowFrom while it's unset; its chat_id:<n>
// entries admit everyone in that chat.
export function accessFrom({ allowFrom, groupAllowFrom, accessGroups, groups, groupPolicy }) {
  const handles = expandEntries(allowFrom, accessGroups);
  const groupEntries = groupAllowFrom === undefined ? handles : expandEntries(groupAllowFrom, accessGroups);
  const keys = groupPolicy === "disabled" ? [] : Object.keys(groups ?? {});
  const senders = (list) => (list.includes("*") ? ALL : new Set(list.map(canonicalHandle)));
  return {
    known: senders(handles),
    groupSenders: senders(groupEntries.filter((e) => !/^chat_id:/i.test(e))),
    senderChats: new Set(groupEntries.filter((e) => /^chat_id:/i.test(e)).map((e) => e.replace(/^chat_id:/i, ""))),
    groups: keys.includes("*") ? ALL : new Set(keys.map((k) => k.replace(/^chat_id:/i, ""))),
  };
}
const ALL = { has: () => true };

// One setting via the CLI; undefined when unset. Anything else throws, so a
// broken read fails the check instead of flagging everyone.
export function configGet(path, run = (args) => execFileSync(OPENCLAW, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })) {
  let out;
  try {
    out = run(["config", "get", path, "--json"]);
  } catch (err) {
    if (/valid but unset/.test(String(err.stdout ?? "") + String(err.stderr ?? ""))) return undefined;
    throw err;
  }
  return JSON.parse(out);
}

export function readAccess(get = configGet) {
  return {
    allowFrom: get("channels.imessage.allowFrom"),
    groupAllowFrom: get("channels.imessage.groupAllowFrom"),
    accessGroups: get("accessGroups"),
    groups: get("channels.imessage.groups"),
    groupPolicy: get("channels.imessage.groupPolicy"),
  };
}

// Pure: turns new rows into events and alerts, and advances state.
//   known, groups: sets (has()) of canonical handles and approved chat ids
//   groupSenders, senderChats: who may write in groups (default: known)
//   messages: imsg history rows (any chat); chats: imsg chats rows by id
export function scan({ known, groupSenders = known, senderChats = new Set(), groups, messages, chats, state, now }) {
  const next = { watermark: state.watermark ?? 0, lastAlert: { ...(state.lastAlert ?? {}) } };
  for (const [k, at] of Object.entries(next.lastAlert)) if (now - at >= HOUR) delete next.lastAlert[k];
  const events = [];
  const alerts = [];
  const rows = [...messages].sort((a, b) => a.id - b.id);
  for (const m of rows) {
    if (!(m.id > (state.watermark ?? 0))) continue;
    next.watermark = Math.max(next.watermark, m.id);
    if (m.is_from_me) continue;
    const chat = chats.get(m.chat_id) ?? {};
    const isGroup = Boolean(m.is_group ?? chat.is_group);
    const handle = canonicalHandle(m.sender);
    const unknownSender = isGroup ? !(groupSenders.has(handle) || senderChats.has(String(m.chat_id))) : !known.has(handle);
    const unapprovedGroup = isGroup && !groups.has(String(m.chat_id));
    if (!unknownSender && !unapprovedGroup) continue;
    const event = {
      at: m.created_at,
      seen: new Date(now).toISOString(),
      handle,
      sender: senderKind(handle),
      service: m.service ?? chat.service ?? "unknown",
      chat: isGroup ? "group" : "dm",
      chat_id: m.chat_id,
      reason: unknownSender ? "unknown-sender" : "unapproved-group",
      participants: isGroup ? (m.participants ?? chat.participants ?? []).map(canonicalHandle) : undefined,
      length: typeof m.text === "string" ? [...m.text].length : 0,
      attachments: (m.attachments ?? []).length,
      alerted: false,
    };
    const key = alertKey(event);
    if (!(key in next.lastAlert)) {
      next.lastAlert[key] = now;
      event.alerted = true;
      alerts.push(event);
    }
    events.push(event);
  }
  return { events, alerts, state: next };
}

// Throttle key: the sender, or the group when a known person writes in an
// unapproved group.
export function alertKey(e) {
  return e.reason === "unknown-sender" ? e.handle : `group:${e.chat_id}`;
}

export function alertBody(alerts) {
  const lines = alerts.slice(0, 10).map((e) => {
    const who = `${maskHandle(e.handle)}${e.sender === "shortcode" ? " (short code)" : ""}`;
    const where = e.chat === "group" ? `group ${e.chat_id}${e.reason === "unapproved-group" ? " (not approved)" : ""}, ${e.participants.length} people` : "DM";
    return `${who}, ${where}, ${e.service}, ${e.at}`;
  });
  if (alerts.length > 10) lines.push(`+${alerts.length - 10} more`);
  return `Unknown sender texted Uno:\n${lines.join("\n")}\nDetails: ~/.openclaw/uno-data/unknown-senders.jsonl`;
}

function imsgJson(args) {
  const out = execFileSync(IMSG, [...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Reads what scan needs from chat.db via imsg. Rows keep their text only in
// memory, for the length; it is never written anywhere.
export function readChatDb(state, now, run = imsgJson) {
  const chats = new Map(run(["chats", "--limit", "200"]).map((c) => [c.id, c]));
  const since = (state.lastRun ?? now) - LOOKBACK;
  const messages = [];
  for (const chat of chats.values()) {
    if (state.watermark !== undefined && !(Date.parse(chat.last_message_at) >= since)) continue;
    // First run only needs each chat's newest row, for the watermark.
    const args = state.watermark === undefined ? ["--limit", "1"] : ["--start", new Date(since).toISOString(), "--limit", "1000"];
    for (const m of run(["history", "--chat-id", String(chat.id), ...args])) {
      messages.push({ ...m, service: m.service ?? chat.service });
    }
  }
  return { chats, messages };
}

// One healthping pass. Returns a summary for healthping.last.json; never the
// URL, never message text. An alert whose /fail ping didn't go through stays
// in state.pending and goes out on the next run.
export async function runUnknownSenders({ url, ping, now = Date.now(), run, access = readAccess, statePath = STATE, logPath = LOG }) {
  const { known, groupSenders, senderChats, groups } = accessFrom(access());
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const { chats, messages } = readChatDb(state, now, run);

  let result;
  if (state.watermark === undefined) {
    // First run: start from what's already there, no alerts for history.
    const watermark = messages.reduce((max, m) => Math.max(max, m.id), 0);
    result = { events: [], alerts: [], state: { watermark, lastAlert: {} } };
  } else {
    result = scan({ known, groupSenders, senderChats, groups, messages, chats, state, now });
  }

  const toSend = [...(state.pending ?? []), ...result.alerts];
  let pending = [];
  let sent = "none (no HC_UNKNOWN_URL)";
  if (url) {
    const r = toSend.length ? await ping(url, "/fail", alertBody(toSend)) : await ping(url, "", "ok");
    sent = `${toSend.length ? `fail: ${toSend.length} alert(s)` : "ok"} -> ${r}`;
    if (toSend.length && !/^2\d\d\b/.test(r)) pending = toSend.slice(-20);
  } else {
    for (const a of result.alerts) { a.alerted = false; delete result.state.lastAlert[alertKey(a)]; }
  }
  for (const e of result.events) appendFileSync(logPath, JSON.stringify(e) + "\n", { mode: 0o600 });
  if (result.events.length) chmodSync(logPath, 0o600);
  writeFileSync(statePath, JSON.stringify({ ...result.state, pending, lastRun: now }), { mode: 0o600 });
  return { at: new Date(now).toISOString(), events: result.events.length, alerts: toSend.length, sent };
}
