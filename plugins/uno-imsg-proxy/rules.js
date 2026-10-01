// Pure rules for uno-imsg-proxy, unit-tested in uno/test/uno-imsg-proxy.test.js.

export const norm = (h) => String(h ?? "").trim().toLowerCase().replace(/^imessage:/, "");

// Tapbacks must name the exact message (no default target, which can land on
// Uno's own last message) and that message must be one the current sender
// sent to Uno. row: the chat.db message row for params.messageId, or null.
// Threaded replies get the same target rules: their specific message, never
// Uno's own. Every block reason tells the model what to do instead, so a
// blocked tapback turns into a short text rather than a failed turn.
const FALLBACK = { react: " Reply with a few words instead (e.g. \"Anytime.\").", reply: " Send it as a normal message instead." };

export function checkReaction(params, row, senderId, chatRowId = null) {
  const action = params?.action;
  if ((action !== "react" && action !== "reply") || params.remove) return null;
  const what = action === "react" ? "Tapbacks" : "Threaded replies";
  const fix = FALLBACK[action];
  if (!params.messageId) return `${what} need the messageId (MessageSidFull) of the specific message.${fix}`;
  if (!row) return `Unknown messageId; use the full message id (MessageSidFull) of their message.${fix}`;
  if (row.is_from_me) return `${what} can't go on your own messages.${fix}`;
  if (!senderId || norm(row.handle) !== norm(senderId)) return `${what} can only go on a message the person you're talking to sent.${fix}`;
  if (!inThisChat(row, chatRowId)) return `${what} can only go on a message in this chat.${fix}`;
  return null;
}

// Group chats: a session is agent:<id>:imessage:group:<chat_id>. A tapback or
// threaded reply must land in the chat the turn came from: in a group, on a
// message in that group; in a one-on-one chat, never in a group (chat.db
// style 43 is a group, 45 a one-on-one).
export const GROUP_STYLE = 43;
export function groupChatOf(sessionKey) {
  const m = String(sessionKey ?? "").match(/:imessage:group:(?:chat_id:)?(\d+)$/i);
  return m ? Number(m[1]) : null;
}
export function inThisChat(row, chatRowId) {
  if (chatRowId != null) return row?.chat_rowid === chatRowId;
  return row?.chat_style !== GROUP_STYLE;
}

// Error text OpenClaw or the runtime would deliver to the chat: the
// isError flag, or one of their exact formats. Common phrases like
// "please try again" in a normal answer don't count (audit, 2026-09-25).
const ERROR_FORMATS = [
  /^\s*⚠️/, // OpenClaw's error payloads
  /^\s*something went wrong while processing your request\b/i,
  /\buse \/new to start a fresh session\b/i,
  /^\s*(codex )?(session policy handoff|agent harness) failed\b/i,
];
const ERROR_TEXT = { test: (t) => ERROR_FORMATS.some((re) => re.test(t)) };
export function isErrorReply(text, isError = false) {
  return Boolean(isError) || ERROR_TEXT.test(String(text ?? ""));
}

// Plain-words hint for the admin; never the raw error.
const HINTS = [
  [/rate.?limit|usage limit|429|quota/i, "hit the usage limit"],
  [/tapback|react/i, "couldn't send a tapback"],
  [/search/i, "search failed"],
  [/timed? ?out|timeout/i, "something timed out"],
  [/policy handoff|codex|harness|model/i, "my connection to the model hiccuped"],
];
export function errorHint(text) {
  return HINTS.find(([re]) => re.test(String(text ?? "")))?.[1] ?? null;
}

// Replacement for error text, by who's talking. Admin sessions belong to the
// admin agent ("agent:<admin>:..."); everyone else gets the non-technical one.
export function errorReplyFor(text, sessionKey, adminAgentId, ownerName) {
  const admin = Boolean(adminAgentId) && String(sessionKey ?? "").startsWith(`agent:${adminAgentId}:`);
  if (!admin) return `I'm having trouble right now. Please let ${ownerName || "the owner"} know if this keeps happening.`;
  const hint = errorHint(text);
  return `Hey, I'm having issues right now${hint ? ` (${hint})` : ""}. You may want to take a look.`;
}

// A message that is only one http(s) URL: sent as a rich link preview.
export function soleUrl(text) {
  const t = String(text ?? "").trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : null;
}

// Some stores block every automated preview but share through a Branch link
// domain (what their app's Share button uses). Branch fetches the page itself
// and serves its real title and photo, so a blocked link from one of these
// stores is wrapped in the store's own share link and still previews
// (Sept 30: abercrombie.app.link gave the product's title and photo while
// abercrombie.com gave "Client Challenge"). $web_only asks for the web page
// over the app; the app may still open where it's installed.
export const SHARE_LINK_DOMAINS = { "abercrombie.com": "abercrombie.app.link" };
export function shareLinkFor(url, domains = SHARE_LINK_DOMAINS) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  const branch = domains[host];
  if (!branch) return null;
  const e = encodeURIComponent(url);
  return `https://${branch}?%24desktop_url=${e}&%24fallback_url=${e}&%24web_only=true`;
}

// A link whose site blocks previews (a bot check) goes back onto the line it
// came from ("Item: https://…"): a message that is only a link gets a preview
// card built by the recipient's iPhone too, which shows the bot check
// ("Client Challenge"), while a link inside text shows as a plain tappable
// link (Sept 30, Abercrombie). With no line before it, it stays on its own.
export function keepBlockedLinksInline(bubbles, blocked) {
  const out = [];
  for (const b of bubbles) {
    const url = soleUrl(b);
    if (url && blocked.has(url) && out.length && !soleUrl(out[out.length - 1])) out[out.length - 1] = `${out[out.length - 1].replace(/[.:]?\s*$/, "")}: ${url}`;
    else out.push(b);
  }
  return out;
}

// The title Apple's preview fetcher got for a link is a bot check, not the
// page: the preview card would say "Client Challenge" (Sept 30, Abercrombie).
export const isBotCheckTitle = (title) => /^\s*(client challenge|access denied|just a moment|attention required|pardon our interruption|are you a (robot|human)|robot check|security check|verify(ing)? (you are|that you're) (a )?human|request (blocked|rejected)|403 forbidden)\b|^\s*forbidden\s*$/i.test(String(title ?? ""));

// iMessage only shows a preview for a message that is nothing but a link, and
// doesn't render markdown: "[Offer](https://…)" arrives as raw text, and a URL
// inside a sentence gets no preview (Sept 30, every link in the group). Each
// markdown link becomes its plain label, and a URL at the end of a line
// ("Item: https://…") comes off the line; either way the URL goes in its own
// bubble right after the line it was on, so it shows as a preview. A link
// that is a whole sentence of its own ("… for new customers. [Offer](…)") is
// dropped from the text. A URL mid-sentence stays put. Each URL is sent once.
const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
export function linkBubbles(bubbles) {
  const out = [], seen = new Set();
  const add = (url) => { if (!seen.has(url)) { seen.add(url); out.push(url); } };
  for (const b of bubbles) {
    const one = soleUrl(b);
    if (one) { add(one); continue; }
    if (String(b).includes("```")) { out.push(b); continue; }
    let text = [];
    const flush = () => { const t = text.join("\n").trim(); if (t) out.push(t); text = []; };
    for (const line of String(b).split("\n")) {
      const urls = [];
      const l = line
        .replace(/(^|[.!?:]\s+)\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\)[.!]?\s*$/, (_, before, url) => { urls.push(url); return before; })
        .replace(MD_LINK, (_, label, url) => { urls.push(url); return label; })
        .replace(/(\S)\s*(?:[:\-–—]\s*)?\(?(https?:\/\/[^\s)]+?)\)?[.,]?\s*$/, (_, last, url) => { urls.push(url); return last; })
        .replace(/^\s*(https?:\/\/\S+?)[.,]?\s*$/, (_, url) => { urls.push(url); return ""; })
        .replace(/\s+$/, "");
      if (l.trim()) text.push(l);
      if (urls.length) { flush(); urls.forEach(add); }
    }
    flush();
  }
  return out;
}

// Outbound target ("+1...", "email", "imessage:+1...", "chat_id:12") -> the
// chat.db lookup to find the chat guid imsg send-rich needs.
export function chatLookup(to) {
  const t = String(to ?? "").trim().replace(/^(imessage|auto|sms):/i, "");
  const id = t.match(/^chat_id:(\d+)$/i);
  return id ? { sql: "SELECT guid FROM chat WHERE ROWID = ?", arg: Number(id[1]) }
            : { sql: "SELECT guid FROM chat WHERE lower(chat_identifier) = ? ORDER BY ROWID DESC LIMIT 1", arg: t.toLowerCase() };
}

// No em dashes: "a—b" reads as "a, b"; before a capitalized word it becomes a
// sentence break ("age—I'm" -> "age. I'm"). En dashes (ranges) are left alone.
export function noEmDash(text) {
  return String(text ?? "")
    .replace(/\s*—\s*(?=[A-Z])/g, ". ")
    .replace(/\s*—\s*$/g, ".")
    .replace(/\s*—\s*/g, ", ");
}

// Their latest real message in a chat within windowSec, for a target of
// "chat_id:N" (a one-on-one or a group) or, for one-on-ones, "imessage:+1...",
// "+1..." or an email. Also returns the sender's handle (for groups).
export function latestInboundQuery(target, windowSec = Number(process.env.UNO_GUARD_ACK_WINDOW_SEC) || 600) {
  const t = norm(target);
  if (!t) return null;
  const recent = `m.date > (strftime('%s','now') - 978307200 - ${Number(windowSec)}) * 1000000000`;
  const id = t.match(/^chat_id:(\d+)$/);
  if (id) {
    return { sql: `SELECT m.guid, m.text FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id = ? AND m.is_from_me = 0 AND m.associated_message_type = 0 AND ${recent}
      ORDER BY m.ROWID DESC LIMIT 1`, arg: Number(id[1]) };
  }
  return { sql: `SELECT m.guid, m.text FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 0 AND m.associated_message_type = 0 AND lower(h.id) = ? AND ${recent}
    ORDER BY m.ROWID DESC LIMIT 1`, arg: t };
}

// Text that is only emoji (up to 3), e.g. the "🔥" the model sends after its
// tapback when OpenClaw asks it for a final answer.
export function emojiOnly(text) {
  const t = String(text ?? "").replace(/\s+/g, "");
  return Boolean(t) && /^(\p{RGI_Emoji}){1,3}$/v.test(t);
}

// A tapback aimed at Uno's own message, when the sender has a message of
// their own to react to: block and name that message. Happens when they reply
// in a thread to one of Uno's messages ("React to this with 🔥"): imsg labels
// the reply target with the chat's handle even when Uno sent it, so the model
// believes it's theirs. Returns a blockReason or null.
export function ownMessageRedirect(action, row, latestGuid) {
  if (action !== "react" || !row?.is_from_me || !latestGuid || latestGuid === row.guid) return null;
  return `That message is one you sent, not theirs. To react to their latest message, call react again with messageId "${latestGuid}".`;
}

// Custom emoji tapbacks (2006/3006). OpenClaw's iMessage react only maps the
// six classic kinds and throws on anything else, so uno-imsg-proxy sends other
// single emoji itself through `imsg tapback --emoji`. Classic kinds and their
// emoji stay on OpenClaw's path.
const CLASSIC = new Set(["love", "heart", "❤️", "❤", "like", "thumbsup", "thumbs-up", "+1", "👍",
  "dislike", "thumbsdown", "thumbs-down", "-1", "👎", "laugh", "haha", "lol", "😂", "🤣",
  "emphasize", "emphasis", "!!", "‼", "‼️", "question", "?", "❓"]);
export function customEmoji(params) {
  const v = String(params?.emoji ?? params?.reaction ?? params?.kind ?? "").trim();
  if (!v || CLASSIC.has(v.toLowerCase())) return null;
  return /^\p{RGI_Emoji}$/v.test(v) ? v : null;
}

// The outgoing row Messages writes once a custom tapback is sent; its
// presence is the confirmation (a bridge "ok" only means dispatched).
export const CUSTOM_CONFIRM_SQL = `SELECT ROWID FROM message
  WHERE ROWID > ? AND is_from_me = 1 AND associated_message_type = ?
    AND associated_message_emoji = ? AND associated_message_guid = ? AND error = 0
  LIMIT 1`;

// Stock imsg sends only the six classic kinds: its CLI rejects --emoji, and a
// stock helper rejects the kind ("Unknown reactionType"). Custom emoji need
// the imsg patch in patches/. Either way nothing was sent.
export const CUSTOM_UNSUPPORTED = /Unknown option\b.*--emoji|Unknown reactionType/i;

// Sends a custom emoji tapback and waits for chat.db to show it. Returns the
// before_tool_call result: always a block, since OpenClaw's own react would
// throw on the emoji. On any failure the model is told to send a few words
// instead (never a retry, which could toggle it), as the persona says; when
// imsg can't send custom emoji at all, a classic tapback is offered instead.
// deps: { imsg, exec(bin, args), maxRowId(), confirmed(afterRowId, type, emoji, ref), sleep(ms), log, waitMs }
export function sendCustomReaction(emoji, params, row, senderId, deps) {
  const remove = Boolean(params.remove);
  const part = Number.isInteger(params.partIndex) && params.partIndex >= 0 ? params.partIndex : 0;
  const nothingSent = "Nothing was sent. Don't retry it; send a few words instead.";
  if (!row?.guid || !row?.chat || row.is_from_me || !senderId || norm(row.handle) !== norm(senderId)) {
    deps.log.info?.("uno-imsg-proxy: custom tapback blocked (target isn't their message)");
    return { block: true, blockReason: `Tapbacks need the messageId of a message the person you're talking to sent. ${nothingSent}` };
  }
  const type = remove ? 3006 : 2006;
  const ref = `p:${part}/${row.guid}`;
  try {
    const before = deps.maxRowId();
    deps.exec(deps.imsg, ["tapback", "--chat", row.chat, "--message", row.guid, "--emoji", emoji,
      "--part", String(part), ...(remove ? ["--remove"] : [])]);
    for (let waited = 0; waited <= (deps.waitMs ?? 4000); waited += 200) {
      if (deps.confirmed(before, type, emoji, ref)) {
        deps.log.info?.(`uno-imsg-proxy: custom tapback ${remove ? "removed" : "sent"} and confirmed`);
        return { block: true, blockReason: `Done: the ${emoji} tapback is ${remove ? "removed from" : "on"} their message. Don't react again or mention it.` };
      }
      deps.sleep(200);
    }
    deps.log.warn?.(`uno-imsg-proxy: custom tapback ${remove ? "removal" : "send"} not confirmed in chat.db`);
  } catch (err) {
    const why = String(err?.stderr ?? err?.message ?? err).trim();
    deps.log.warn?.(`uno-imsg-proxy: custom tapback failed: ${why.slice(0, 200)}`);
    if (CUSTOM_UNSUPPORTED.test(why)) {
      return { block: true, blockReason: `Custom emoji tapbacks aren't available here, so nothing was sent. React with one of the classic six instead (❤️ 👍 👎 😂 ‼️ ❓), or send a few words.` };
    }
  }
  return { block: true, blockReason: `The ${emoji} tapback didn't go through. ${nothingSent}` };
}

// A trailing error right after Uno already delivered something to the
// conversation (a message, a rich link, a reaction) is noise from
// OpenClaw's "lacked a final answer" recovery (a known OpenClaw issue):
// drop it instead of replacing it. Still logged at ERROR by the caller.
export const TRAILING_ERROR_WINDOW_MS = 60_000;
export function isTrailingError(lastDeliveredAt, now = Date.now(), windowMs = TRAILING_ERROR_WINDOW_MS) {
  if (!Number.isFinite(lastDeliveredAt)) return false;
  const age = now - lastDeliveredAt;
  return age >= 0 && age <= windowMs;
}

// Keys that identify one conversation across hooks (session key, chat_id
// target, handle); empty values dropped, handles normalized.
export function conversationKeys(...candidates) {
  return [...new Set(candidates.filter((c) => c !== undefined && c !== null && String(c).trim())
    .map((c) => (/^agent:/.test(String(c)) ? String(c) : norm(c))))];
}

// Got-it reaction: a browser task is slow, so its first browser call reacts
// to their message (👀 by default) and stops the typing. Web search doesn't
// count. OpenClaw's typing is off (typingMode "never"): the plugin shows
// typing while the model works and for a short pause before each bubble.
export const ACK_EMOJI = "👀";
// A turn still working this long with nothing sent gets the got-it reaction.
// Sept 30, last 7 days: median first reply 9 s, 75th percentile 16 s.
export const ACK_AFTER_MS = 15_000;
// Classic tapback kinds as the emoji the model and the owner see.
export const CLASSIC_EMOJI_OF = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
// A reply that's a single emoji goes out as a tapback on their message
// instead of a big emoji bubble: { kind } for the classic six, else { emoji }.
const bare = (e) => String(e ?? "").replace(/\uFE0F/g, "");
const KIND_OF = Object.fromEntries(Object.entries(CLASSIC_EMOJI_OF).map(([k, e]) => [bare(e), k]));
export function tapbackFor(text) {
  const t = String(text ?? "").trim();
  if (!t || !emojiOnly(t) || [...new Intl.Segmenter().segment(t)].length !== 1) return null;
  return KIND_OF[bare(t)] ? { kind: KIND_OF[bare(t)] } : { emoji: t };
}
// A reply that opens with a lone emoji, on its own line or before the words
// ("😂 The sneeze…"), is a reaction plus a reply: the emoji goes out as a
// tapback on their message and the rest as text. The model writes reactions
// this way rather than calling the react tool (Sept 30: no react calls in
// any real or test turn).
export function leadingReaction(text) {
  const t = String(text ?? "").trim();
  const seg = [...new Intl.Segmenter().segment(t)];
  if (seg.length < 2) return null;
  const tap = tapbackFor(seg[0].segment);
  if (!tap) return null;
  const rest = t.slice(seg[0].segment.length);
  if (!/^\s/.test(rest) || !rest.trim() || emojiOnly(rest)) return null;
  return { tap, rest: rest.trim() };
}

export const ACK_TOOLS = new Set(["browser"]);

// Uno's first message or reaction in the same chat after theirs; kind is
// non-zero for a reaction. ANSWERED_TEXT_SQL: the first text message only.
export const ANSWERED_SINCE_SQL = `SELECT m.associated_message_type AS kind FROM message m
  JOIN chat_message_join j ON j.message_id = m.ROWID
  WHERE m.is_from_me = 1
    AND m.ROWID > (SELECT ROWID FROM message WHERE guid = ?1)
    AND j.chat_id = (SELECT cmj.chat_id FROM chat_message_join cmj
      JOIN message t ON t.ROWID = cmj.message_id WHERE t.guid = ?1 LIMIT 1)
  ORDER BY m.ROWID LIMIT 1`;
export const ANSWERED_TEXT_SQL = `SELECT m.associated_message_type AS kind FROM message m
  JOIN chat_message_join j ON j.message_id = m.ROWID
  WHERE m.is_from_me = 1 AND m.associated_message_type = 0
    AND m.ROWID > (SELECT ROWID FROM message WHERE guid = ?1)
    AND j.chat_id = (SELECT cmj.chat_id FROM chat_message_join cmj
      JOIN message t ON t.ROWID = cmj.message_id WHERE t.guid = ?1 LIMIT 1)
  ORDER BY m.ROWID LIMIT 1`;

// How long to show typing before a bubble: longer text, longer pause.
export function typingMs(text) {
  const n = String(text ?? "").trim().length;
  if (!n) return 0;
  return Math.min(1500, Math.max(600, 500 + 15 * n));
}

// Sandboxed agents never see their workspace AGENTS.md on the Codex harness:
// Codex finds AGENTS.md by searching its working folder, which for a
// sandboxed agent is the container path, and OpenClaw doesn't inject it
// either (its prompt report says "native_unverified"). Sept 30: the family
// group's agent answered NONE for facts only in AGENTS.md. So the plugin adds
// the agent's own AGENTS.md to its system prompt. Unsandboxed agents already
// get it. mode: "all" sandboxes every session, "non-main" all but the main one.
export function sandboxedSession(agentsCfg, agentId, sessionKey) {
  const mode = agentsCfg?.entries?.[agentId]?.sandbox?.mode ?? agentsCfg?.defaults?.sandbox?.mode ?? "off";
  if (mode === "all") return true;
  if (mode === "non-main") return !/^agent:[^:]+:main$/.test(String(sessionKey ?? ""));
  return false;
}
export const agentsMdContext = (text) => {
  const t = String(text ?? "").trim();
  return t ? `The following is your workspace AGENTS.md: the rules you work by. Follow it.\n\n${t}` : null;
};

// Threading every bubble: OpenClaw threads the first bubble on the message
// it answers; the rest follow on the same thread. The target is a message
// guid from OpenClaw's replyToId when it is one ("p:0/GUID" or "GUID"),
// otherwise the thread the first bubble landed on in this chat.
export function guidReplyTarget(id) {
  const m = String(id ?? "").trim().match(/^(?:p:\d+\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1].toUpperCase() : null;
}
export const THREAD_TARGET_SQL = `SELECT m.thread_originator_guid AS guid FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE c.guid = ? AND m.is_from_me = 1 AND m.thread_originator_guid IS NOT NULL AND m.date >= ?
  ORDER BY m.date DESC LIMIT 1`;
// Messages-database time (nanoseconds since 2001) for a JS timestamp.
export const appleTime = (ms) => Math.floor((ms / 1000 - 978307200) * 1e9);
// The imsg arguments for one bubble: a lone link as a rich preview, text as
// plain text, each on the thread when there is one.
export function bubbleArgs(chatGuidValue, text, threadGuid) {
  const url = soleUrl(text);
  const reply = threadGuid ? ["--reply-to", threadGuid] : [];
  if (url) return ["send-rich", "--chat", chatGuidValue, "--url", url, ...reply];
  return threadGuid ? ["send-rich", "--chat", chatGuidValue, "--text", text, ...reply] : ["send", "--chat-guid", chatGuidValue, "--text", text];
}

// Reply shape: the workspace's REPLY.md goes next to each chat message. The
// same words in SOUL.md or AGENTS.md lose to the model's habit of writing up
// everything it found after a long research run; next to the message they
// hold. Chat turns only: scheduled jobs and helpers keep their own format.
// A FaceTime call (agent:<id>:facetime:<call>, or a call eval's
// agent:<id>:test:call:…) is said out loud, so it gets CALL.md instead.
export const callTurn = (sessionKey) => /^agent:[^:]+:(facetime|test:call):/.test(String(sessionKey ?? ""));
export const chatTurn = (sessionKey) => !callTurn(sessionKey) && /^agent:[^:]+:(imessage|test):/.test(String(sessionKey ?? ""));
export const replyNote = (text) => String(text ?? "").trim() || null;
// On a call the note says it isn't theirs: unmarked, "ok sounds good" got
// "Got it, I'll keep replies concise". Chat notes stay unmarked: marked,
// REPLY.md lost its hold on research replies (compare-dig 4/4 to 1/8, Oct 1).
export const callNote = (text) => { const t = replyNote(text); return t ? `[Setup note, not from them] ${t}` : null; };

// First chat: while USER.md is missing or still has the setup line, tell the
// model in the turn itself to follow the first-chat skill. A line in USER.md
// alone was ignored (Sept 28).
export const SETUP_LINE = "Setup isn't finished";
export function firstChatNote(userMd) {
  if (userMd != null && !String(userMd).includes(SETUP_LINE)) return null;
  return "This person's setup isn't finished. Before you reply, read your first-chat skill (its location is in your skills list) and follow it from the top, starting with the welcome.";
}

// Bubbles: a reply with paragraphs goes out as one iMessage per paragraph.
// OpenClaw's own paragraph chunking only splits past the 4,000-character
// limit, and block streaming doesn't split on the Codex harness (checked
// Sept 28). Code blocks stay whole; past MAX_BUBBLES the rest share the last.
export const MAX_BUBBLES = 6;
export function splitBubbles(text) {
  const t = String(text ?? "").trim();
  if (!t || t.includes("```")) return [t];
  const parts = t.split(/\n[\t ]*\n+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= MAX_BUBBLES) return parts;
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")];
}

// Typing before each follow-up bubble scales with its length, like someone
// typing it (about 25 ms a character, 0.9 to 3.5 s), with a little jitter so
// the rhythm doesn't look mechanical.
export function bubbleTypingMs(text, rand = Math.random) {
  const n = String(text ?? "").trim().length;
  if (!n) return 0;
  const base = Math.min(3500, Math.max(900, 400 + 25 * n));
  return Math.round(base * (0.85 + 0.3 * rand()));
}

// Group chats: a reply is already threaded to the message it answers, so an
// opening "Name," (a household first name) is dropped. The model kept doing
// it even when told not to (Sept 30).
export function dropOpeningName(text, names = []) {
  let t = String(text ?? "");
  for (const n of names.map((x) => String(x ?? "").trim()).filter(Boolean)) {
    const name = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^\\s*${name}\\s*[,:]\\s+(?=\\S)`, "i");
    if (re.test(t)) { const rest = t.replace(re, ""); t = rest.charAt(0).toUpperCase() + rest.slice(1); }
    // Also a name tacked on with a comma: "Yep, Name." / "You're welcome, Name!"
    t = t.replace(new RegExp(`,\\s*${name}(?=\\s*[.!?]|\\s*$)`, "gi"), "");
  }
  return t;
}

// OpenClaw's own "I'm continuing your interrupted request now (the gateway
// has just restarted)…" notice, sent into the chat after a restart. It has
// no setting; Uno's typing and got-it reaction already say it's working, so
// it never goes out (a restart mid-turn posted it in the family group, Sept 30).
export const isRestartNotice = (text) => /^\s*I'm continuing your interrupted request now \(the gateway has just restarted\)/i.test(String(text ?? ""));

// OpenClaw's approval prompts go out exactly as OpenClaw wrote them: it links
// a 👍 to the approval by checking the text it sent (header, ID line, the
// /approve line and the reaction hint), so a split or rewrite breaks
// approving by reaction (Sept 30: split into bubbles, the 👍 did nothing).
export const isApprovalPrompt = (text) => { const t = String(text ?? ""); return /approval required/i.test(t) && /\/approve\s+\S+/.test(t); };
