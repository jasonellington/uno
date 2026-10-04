// uno-imsg-proxy: Uno's iMessage style (README.md). Guardrails live in
// uno-guard, whose hooks run first; this plugin only shapes how Uno comes
// across, and the owner's Uno may change it (with tests and the owner's OK).
// - replies and reactions are the model's; in group chats it may stay quiet
//   (OpenClaw's silentReply), and a message that names Uno gets an answer.
// - tapbacks and threaded replies only on a specific message from the
//   current sender, never Uno's own; custom emoji through `imsg tapback`.
// - a reply that is one emoji goes out as a tapback on their message.
// - typing while the model works; a browser task, or 15 s with nothing sent,
//   gets a got-it reaction instead.
// - paragraphs as separate bubbles, link-only messages with a rich preview,
//   no em dashes.
// - error text never reaches iMessage: a plain line worded for who's talking,
//   logged at ERROR for Healthchecks; dropped right after a delivered reply.
// - the first-chat nudge until USER.md is set up.
// Settings (plugins.entries.uno-imsg-proxy.config): imsgPath, ackEmoji. Who
// the admin is and the owner's name come from uno-guard's settings.
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkReaction, isErrorReply, errorReplyFor, norm, soleUrl, chatLookup, noEmDash, latestInboundQuery, customEmoji, sendCustomReaction, ownMessageRedirect, emojiOnly, CUSTOM_CONFIRM_SQL, isTrailingError, conversationKeys, ACK_EMOJI, ACK_AFTER_MS, CLASSIC_EMOJI_OF, ACK_TOOLS, ANSWERED_SINCE_SQL, ANSWERED_TEXT_SQL, typingMs, firstChatNote, splitBubbles, bubbleTypingMs, tapbackFor, leadingReaction, groupChatOf, inThisChat, GROUP_STYLE, dropOpeningName, linkBubbles, keepBlockedLinksInline, shareLinkFor, isBotCheckTitle, isRestartNotice, isApprovalPrompt, sandboxedSession, agentsMdContext, chatTurn, callTurn, replyNote, callNote, callTextHandle, testAutomation, testMessage, testSave, isTestSession, isDirectChat, sentFrom, outsideSendNote, testSideEffect, guidReplyTarget, THREAD_TARGET_SQL, appleTime, bubbleArgs } from "./rules.js";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const CHAT_DB = join(homedir(), "Library/Messages/chat.db");
// The default imsg (tapbacks, custom emoji tapbacks, rich links); the
// imsgPath setting overrides it. Custom emoji needs a build with
// `tapback --emoji`.
export const IMSG = "/opt/homebrew/bin/imsg";

// Plugin settings with defaults. A missing or blank adminAgentId means no
// agent is admin.
export function settings(config = {}, guard = {}) {
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    // Who the admin is and the owner's name come from uno-guard's settings.
    adminAgentId: text(guard.adminAgentId),
    ownerName: text(guard.ownerName),
    imsg: text(config.imsgPath) ?? IMSG,
    ackEmoji: text(config.ackEmoji) ?? ACK_EMOJI,
  };
}

function withDb(fn) {
  const db = new DatabaseSync(CHAT_DB, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
// imsg is overridable only for side-by-side tests that call this directly.
export const customDeps = (log, imsg = IMSG) => ({
  imsg,
  exec: (bin, args) => execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }),
  maxRowId: () => withDb((db) => db.prepare("SELECT max(ROWID) AS id FROM message").get().id ?? 0),
  confirmed: (after, type, emoji, ref) => withDb((db) => Boolean(db.prepare(CUSTOM_CONFIRM_SQL).get(after, type, emoji, ref))),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  log,
});

const ROW_SQL = `SELECT m.is_from_me, m.guid, h.id AS handle,
  (SELECT c.guid FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID WHERE j.message_id = m.ROWID LIMIT 1) AS chat,
  (SELECT c.ROWID FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID WHERE j.message_id = m.ROWID LIMIT 1) AS chat_rowid,
  (SELECT c.style FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID WHERE j.message_id = m.ROWID LIMIT 1) AS chat_style
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id`;
export function lookup(messageId) {
  const db = new DatabaseSync(CHAT_DB, { readOnly: true });
  try {
    const q = /^\d+$/.test(String(messageId))
      ? `${ROW_SQL} WHERE m.ROWID = ?`
      : `${ROW_SQL} WHERE m.guid = ? OR m.guid LIKE '%' || ?`;
    const stmt = db.prepare(q);
    return (/^\d+$/.test(String(messageId)) ? stmt.get(Number(messageId)) : stmt.get(String(messageId), `/${messageId}`)) ?? null;
  } finally {
    db.close();
  }
}

// True when Uno sent a tapback (any chat) in the last `sec` seconds, per
// chat.db. Stateless on purpose: OpenClaw runs hooks in separate plugin
// copies, so in-memory state from the hook that sent it isn't visible here.
export function recentTapback(sec = 20) {
  const db = new DatabaseSync(CHAT_DB, { readOnly: true });
  try {
    return Boolean(db.prepare(`SELECT 1 FROM message WHERE is_from_me = 1
      AND associated_message_type BETWEEN 2000 AND 2006
      AND date > (strftime('%s','now') - 978307200 - ?) * 1000000000 LIMIT 1`).get(sec));
  } catch { return false; } finally { db.close(); }
}

// The sender's most recent message to Uno in this chat: what a tapback
// without a messageId is acknowledging (Uno's react calls often omit the id).
// In a group session, that group; otherwise their one-on-one chats only.
function latestFrom(senderId, chatRowId = null) {
  const db = new DatabaseSync(CHAT_DB, { readOnly: true });
  try {
    const where = chatRowId != null ? "c.ROWID = ?" : `c.style != ${GROUP_STYLE}`;
    const args = chatRowId != null ? [norm(senderId), chatRowId] : [norm(senderId)];
    return db.prepare(`SELECT m.guid FROM message m JOIN handle h ON h.ROWID = m.handle_id
      JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
      WHERE m.is_from_me = 0 AND m.associated_message_type = 0 AND lower(h.id) = ? AND ${where}
      ORDER BY m.ROWID DESC LIMIT 1`).get(...args)?.guid ?? null;
  } finally {
    db.close();
  }
}

// Delivery state shared by every registration: OpenClaw can register the
// plugin more than once (separate hook runners), and the hook that sends a
// tapback must be seen by the one that sends replies.
const delivered = new Map(); // when Uno last delivered something, per conversation key
const tapped = new Map(); // when Uno last sent a tapback, per conversation key
const state = { lastTap: -Infinity };
// Placeholder reply for a turn the quick pass answered with a tapback: a
// silent claim (NO_REPLY) ends as an error turn in OpenClaw, so the claim
// carries this text and the sending hooks cancel it.
export const TAPBACK_SENTINEL = "\u2063uno-tapback\u2063";

export default {
  id: "uno-imsg-proxy",
  name: "Uno iMessage style",
  description: "Uno's iMessage style: quick reactions, tapbacks, typing, bubbles, link previews and plain error lines.",
  register(api) {
    const log = api.logger ?? console;
    const { adminAgentId, ownerName, imsg, ackEmoji } = settings(api.pluginConfig ?? {}, api.config?.plugins?.entries?.["uno-guard"]?.config ?? {});
    const markDelivered = (...keys) => { const t = Date.now(); for (const k of conversationKeys(...keys)) delivered.set(k, t); };
    const lastDelivered = (...keys) => Math.max(-Infinity, ...conversationKeys(...keys).map((k) => delivered.get(k) ?? -Infinity));
    // When Uno last sent a tapback, per conversation key: emoji-only text
    // right after one is a duplicate and is dropped.
    const markTapback = (...keys) => { const t = Date.now(); state.lastTap = t; for (const k of conversationKeys(...keys)) { tapped.set(k, t); delivered.set(k, t); } };
    // Keyed match within 60 s, or any tapback in the last 20 s (the hooks
    // don't always share a conversation key).
    const justTapped = (...keys) => Date.now() - state.lastTap < 20_000 || recentTapback() || Date.now() - Math.max(-Infinity, ...conversationKeys(...keys).map((k) => tapped.get(k) ?? -Infinity)) < 60_000;
    const shape = (v) => (v == null ? "none" : /^chat_id:/i.test(String(v)) ? "chat_id" : /^\d+$/.test(String(v)) ? "digits" : /@/.test(String(v)) ? "email" : /^\+/.test(String(v)) ? "phone" : /^agent:/.test(String(v)) ? "session" : "other");
    api.on("before_tool_call", (event, ctx) => {
      try {
        if (ACK_TOOLS.has(event.toolName)) browserStarted(ctx?.requester?.senderId, groupChatOf(ctx?.sessionKey));
        else if (event.toolName === "message" && event.params?.action === "react" && !event.params?.remove) {
          const theirs = ctx?.requester?.senderId ? latestFrom(ctx.requester.senderId, groupChatOf(ctx?.sessionKey)) : null;
          if (theirs && claimed("both", theirs)) {
            log.info?.("uno-imsg-proxy: blocked a second react after a react-and-reply tapback");
            return { block: true, blockReason: "You already reacted to their latest message. Don't react again; reply in words." };
          }
          if (theirs) quiet(theirs);
        }
      } catch {}
      try {
        const testJob = testAutomation(event.toolName, event.params, ctx?.sessionKey) ?? testMessage(event.toolName, event.params, ctx?.sessionKey) ?? testSave(event.toolName, event.params, ctx?.sessionKey) ?? testSideEffect(event.toolName, event.params, ctx?.sessionKey);
        if (testJob) { log.info?.(testJob.log); return testJob.result; }
        const action = event.params?.action;
        if (event.toolName !== "message" || (action !== "react" && action !== "reply")) return;
        // Test sessions (agent:<id>:test:…, the evals) have no real message to
        // react to: the react is logged with its session and reported done, so
        // the turn goes on as it would in a chat.
        if (action === "react" && String(ctx?.sessionKey ?? "").includes(":test:")) {
          log.info?.(`uno-imsg-proxy: test react ${String(event.params.emoji ?? "").slice(0, 16)} session=${ctx.sessionKey}`);
          return { block: true, blockReason: "Done: reacted." };
        }
        const senderId = ctx?.requester?.senderId;
        const chatRowId = groupChatOf(ctx?.sessionKey);
        // Uno's react calls often omit the id. Rather than rewrite params (a
        // rejected rewrite would send with OpenClaw's default target, which
        // can be Uno's own message), block and name the exact message to use.
        if (action === "react" && !event.params.messageId && senderId) {
          const guid = latestFrom(senderId, chatRowId);
          if (guid) {
            log.info?.("uno-imsg-proxy: react without messageId; pointed it at the sender's latest message");
            return { block: true, blockReason: `Tapbacks need the exact message. To react to their latest message, call react again with messageId "${guid}".` };
          }
        }
        const row = event.params.messageId ? lookup(event.params.messageId) : null;
        const redirect = senderId ? ownMessageRedirect(action, row, latestFrom(senderId, chatRowId)) : null;
        if (redirect) {
          log.info?.("uno-imsg-proxy: react on Uno's own message; pointed it at the sender's latest message");
          return { block: true, blockReason: redirect };
        }
        const convo = [ctx?.sessionKey, ctx?.conversationId, senderId];
        const emoji = action === "react" ? customEmoji(event.params) : null;
        if (emoji) {
          if (row && !inThisChat(row, chatRowId)) return { block: true, blockReason: "Tapbacks can only go on a message in this chat. Reply in words instead." };
          const result = sendCustomReaction(emoji, event.params, row, senderId, customDeps(log, imsg));
          if (/^Done:/.test(result.blockReason ?? "")) markTapback(...convo);
          return result;
        }
        const reason = checkReaction(event.params, row, senderId, chatRowId);
        if (reason) log.info?.(`uno-imsg-proxy: blocked ${action} (${senderId ? "sender known" : "no sender"}, ${event.params.messageId ? (row ? "target found" : "target not found") : "no messageId"})`);
        if (!reason && action === "react") markTapback(...convo);
        return reason ? { block: true, blockReason: reason } : undefined;
      } catch {
        return { block: true, blockReason: "Couldn't check that message. Reply with a few words instead." };
      }
    });

    // Error text: null if it isn't an error; { drop } right after a delivered
    // reply; otherwise { text } with the plain replacement line.
    const scrub = (text, isError, sessionKey, where, keys) => {
      if (!isErrorReply(text, isError)) return null;
      const len = String(text ?? "").length;
      if (isError || /^(⚠️|Something went wrong|Agent failed)/.test(String(text ?? ""))) log.info?.(`uno-imsg-proxy: error payload text: ${String(text ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
      if (Date.now() - state.lastTap < 20_000 || recentTapback()) {
        log.info?.(`uno-imsg-proxy: dropped error in ${where} right after a tapback (${len} chars)`);
        return { drop: true };
      }
      if (isTrailingError(lastDelivered(...keys))) {
        log.error?.(`uno-imsg-proxy: dropped trailing error in ${where} after a delivered reply (${len} chars)`);
        return { drop: true };
      }
      log.error?.(`uno-imsg-proxy: replaced error text in ${where} (${len} chars)`);
      return { text: errorReplyFor(text, sessionKey, adminAgentId, ownerName) };
    };
    api.on("reply_payload_sending", (event, ctx) => {
      try {
        const p = event.payload ?? event;
        if (String(p?.text ?? "").includes(TAPBACK_SENTINEL)) return { cancel: true, reason: "answered with a tapback" };
        const sessionKey = event.sessionKey ?? ctx?.sessionKey;
        const keys = [sessionKey, ctx?.conversationId, event.to];
        const err = scrub(p?.text, p?.isError, sessionKey, "reply payload", keys);
        if (err?.drop) return { cancel: true, reason: "trailing error after a delivered reply" };
        if (err) return { payload: { ...p, text: err.text, isError: false, replyToId: undefined } };
        const channel = event.channel ?? ctx?.channelId;
        if (emojiOnly(p?.text)) log.info?.(`uno-imsg-proxy: emoji-only reply payload; tapped=${justTapped(...keys)} keys=${keys.map(shape).join("/")}`);
        if (emojiOnly(p?.text) && justTapped(...keys)) {
          log.info?.("uno-imsg-proxy: dropped emoji-only text right after a tapback (reply payload)");
          return { cancel: true, reason: "duplicate of the tapback" };
        }
        if (String(p?.text ?? "").trim()) markDelivered(...keys);
        if (String(p?.text ?? "").includes("—")) return { payload: { ...p, text: noEmDash(p.text) } };
      } catch {}
    });
    const chatGuid = (to) => {
      const { sql, arg } = chatLookup(to);
      const db = new DatabaseSync(CHAT_DB, { readOnly: true });
      try { return db.prepare(sql).get(arg)?.guid ?? null; } finally { db.close(); }
    };
    // Their latest message in a DM, if it arrived in the last 10 minutes.
    const latestInbound = (target) => {
      const q = latestInboundQuery(target);
      if (!q) return null;
      const db = new DatabaseSync(CHAT_DB, { readOnly: true });
      try { return db.prepare(q.sql).get(q.arg) ?? null; } finally { db.close(); }
    };
    // A chat_id target that chat.db says is a group chat.
    const isGroupTarget = (to) => {
      const id = /^(?:imessage:)?chat_id:(\d+)$/i.exec(String(to ?? "").trim())?.[1];
      if (!id) return false;
      try { return withDb((db) => db.prepare("SELECT style FROM chat WHERE ROWID = ?").get(Number(id)))?.style === GROUP_STYLE; } catch { return false; }
    };
    // First names Uno might open a group reply with: the owner, each
    // person's agent (uno-family-memory names).
    const householdNames = () => {
      const plugins = api.config?.plugins?.entries ?? {};
      return [ownerName, ...Object.values(plugins["uno-family-memory"]?.config?.names ?? {})].filter(Boolean);
    };
    const tapback = (to, messageGuid, kind) => {
      const guid = chatGuid(to);
      if (!guid) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          execFileSync(imsg, ["tapback", "--chat", guid, "--message", messageGuid, "--kind", kind],
            { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
          return true;
        } catch {}
      }
      return false;
    };
    // Before a link goes out as a preview, Apple's own preview fetcher
    // (link-title.swift, compiled once) checks what the page gives it. A bot
    // check ("Client Challenge") would make a broken card, so that link goes
    // as plain text instead. Any failure: send the preview as before.
    const linkTitleSrc = join(fileURLToPath(new URL(".", import.meta.url)), "link-title.swift");
    // Named by the source's content, so a reinstall doesn't force a recompile.
    let linkTitleBin = null;
    try {
      const tag = createHash("sha256").update(readFileSync(linkTitleSrc)).digest("hex").slice(0, 12);
      linkTitleBin = join(homedir(), ".openclaw", "uno-data", "bin", `link-title-${tag}`);
    } catch {}
    let linkTitleOk = Boolean(linkTitleBin && existsSync(linkTitleBin));
    // Compiled once in the background at startup, never inside a message send.
    if (linkTitleBin && !linkTitleOk) {
      try { mkdirSync(join(homedir(), ".openclaw", "uno-data", "bin"), { recursive: true }); } catch {}
      execFile("swiftc", ["-O", linkTitleSrc, "-o", linkTitleBin], { timeout: 180_000 }, (err) => {
        linkTitleOk = !err && existsSync(linkTitleBin);
        log.info?.(`uno-imsg-proxy: link check helper ${linkTitleOk ? "compiled" : "failed to compile; previews sent unchecked"}`);
      });
    }
    const previewBlocked = (url) => new Promise((resolve) => {
      if (!linkTitleOk) { log.info?.("uno-imsg-proxy: link check helper not ready; preview sent unchecked"); return resolve(false); }
      execFile(linkTitleBin, [url], { timeout: 10_000 }, (err, out) => {
        let title = "";
        try { title = JSON.parse(String(out)).title; } catch {}
        const blocked = !err && isBotCheckTitle(title);
        log.info?.(`uno-imsg-proxy: link check ${err ? `failed (${err.killed ? "timed out" : err.code ?? "error"})` : blocked ? "found a bot check; keeping the link inline" : "ok"}`);
        resolve(blocked);
      });
    });
    const linkArgs = async (guid, url) => (await previewBlocked(url))
      ? ["send", "--chat-guid", guid, "--text", url]
      : ["send-rich", "--chat", guid, "--url", url];
    const sendRichLink = async (to, url, thread = null) => {
      const guid = chatGuid(to);
      if (!guid) return false;
      const args = await linkArgs(guid, url);
      // On the thread when there is one (a blocked preview goes as threaded text).
      const threaded = thread ? (args[0] === "send" ? ["send-rich", "--chat", guid, "--text", url, "--reply-to", thread] : [...args, "--reply-to", thread]) : args;
      try { execFileSync(imsg, threaded, { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }); }
      catch (err) { if (!thread) throw err; execFileSync(imsg, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }); }
      return true;
    };

    // Plugin copies share nothing in memory, so per-message state lives in
    // small claim files named after their message's guid: the first copy to
    // create one owns that job.
    const claimFile = (kind, guid) => join(tmpdir(), `uno-${kind}-${String(guid).replace(/[^\w-]/g, "_")}`);
    const claim = (kind, guid) => {
      try { writeFileSync(claimFile(kind, guid), "", { flag: "wx" }); return true; } catch { return false; }
    };
    const claimed = (kind, guid) => existsSync(claimFile(kind, guid));
    // Typing while the model works on a reply, as OpenClaw did before
    // (typingMode is "never" so the plugin owns it). Refreshed every 5 s;
    // stops at Uno's first message or reaction (or the moment it calls
    // react), when a browser task starts or the turn passes ACK_AFTER_MS
    // with nothing sent (both get the got-it reaction instead), or after
    // 3 minutes.
    const startTurnTyping = (target) => {
      const theirs = target ? latestInbound(target) : null;
      const chat = theirs?.guid ? chatGuid(target) : null;
      if (!chat || !claim("typing", theirs.guid)) return;
      const t0 = Date.now();
      const stop = () => execFile(imsg, ["typing", "--chat-guid", chat, "--stop", "true"], { timeout: 5_000 }, () => {});
      const tick = () => {
        try {
          if (claimed("quiet", theirs.guid)) return clearInterval(timer);
          // After a react-and-reply tapback, only Uno's text ends the typing.
          const sql = claimed("both", theirs.guid) ? ANSWERED_TEXT_SQL : ANSWERED_SINCE_SQL;
          const answer = withDb((db) => db.prepare(sql).get(theirs.guid));
          if (answer) { if (answer.kind) stop(); return clearInterval(timer); }
          if (Date.now() - t0 > 180_000) { stop(); return clearInterval(timer); }
          // Still working with nothing sent: the got-it reaction says it's on it.
          if (Date.now() - t0 >= ACK_AFTER_MS && !claimed("both", theirs.guid)) { gotIt(theirs.guid, "slow turn"); return clearInterval(timer); }
          execFile(imsg, ["typing", "--chat-guid", chat], { timeout: 5_000 }, () => {});
        } catch { clearInterval(timer); }
      };
      const timer = setInterval(tick, 5_000);
      timer.unref?.();
      tick();
    };
    // Got-it reaction: the first browser call of a turn stops the typing and
    // reacts to their message (👀 by default), since browser tasks are slow.
    // Stop the turn's typing now: a reaction is on its way, or a browser task.
    const quiet = (theirs) => {
      claim("quiet", theirs);
      const chat = lookup(theirs)?.chat;
      if (chat) execFile(imsg, ["typing", "--chat-guid", chat, "--stop", "true"], { timeout: 5_000 }, () => {});
      return chat;
    };
    const gotIt = (theirs, why, emoji = ackEmoji) => {
      if (!theirs) return;
      const chat = quiet(theirs);
      if (!chat || !emoji || !claim("got-it", theirs)) return;
      execFile(imsg, ["tapback", "--chat", chat, "--message", theirs, "--emoji", emoji, "--part", "0"],
        { timeout: 10_000 }, (err) => log.info?.(`uno-imsg-proxy: got-it reaction ${err ? "failed" : "sent"} (${why})`));
    };
    const browserStarted = (senderId, chatRowId = null) => gotIt(senderId ? latestFrom(senderId, chatRowId) : null, "browser task");
    // Typing right before a bubble, for a moment scaled to its length.
    // Sends the remaining bubbles in order, each after a typing pause; waits
    // a beat first so the first bubble (sent by OpenClaw) lands before them.
    // Every bubble goes on the first one's thread: OpenClaw's reply target when
    // it's a guid, else the thread the first bubble landed on (up to 3 s).
    const sendBubbles = async (guid, to, rest, { replyTo = null, since = 0 } = {}) => {
      const run = (args) => new Promise((resolve, reject) => execFile(imsg, args, { timeout: 15_000 }, (err) => err ? reject(err) : resolve()));
      try {
        await new Promise((r) => setTimeout(r, 700));
        let thread = replyTo;
        for (let i = 0; !thread && since && i < 10; i++) {
          try { thread = withDb((db) => db.prepare(THREAD_TARGET_SQL).get(guid, since))?.guid ?? null; } catch {}
          if (!thread) await new Promise((r) => setTimeout(r, 300));
        }
        log.info?.(`uno-imsg-proxy: ${rest.length} more bubble(s) ${thread ? "on the thread" : "unthreaded (no thread target)"}`);
        for (const text of rest) {
          await typingPause(to, text, bubbleTypingMs(text));
          try { await run(bubbleArgs(guid, text, thread)); }
          catch (err) {
            if (!thread) throw err;
            log.info?.("uno-imsg-proxy: threaded bubble failed; sent unthreaded");
            await run(bubbleArgs(guid, text, null));
          }
        }
      } catch (err) { log.warn?.(`uno-imsg-proxy: bubble send failed (${err?.killed ? "timed out" : err?.code ?? err?.name ?? "error"})`); }
    };

    const typingPause = async (to, text, ms = typingMs(text)) => {
      const guid = ms ? chatGuid(to) : null;
      if (!guid) return;
      execFile(imsg, ["typing", "--chat-guid", guid], { timeout: 5_000 }, () => {});
      await new Promise((r) => setTimeout(r, ms));
    };

    // Quick pass: a message that only needs a tapback gets it here, before
    // the model runs (so no typing and no model call). Anything unclear, or
    // any failure, falls through to the normal turn. Never logs message text.
    api.on("before_agent_reply", async (event, ctx) => {
      try {
        const chat = ctx?.chatId ?? ctx?.conversationId;
        const target = chat != null && /^\d+$/.test(String(chat)) ? `chat_id:${chat}` : chat ?? ctx?.senderId ?? ctx?.requester?.senderId ?? null;
        if (!target) return;
        // Replies and reactions are the model's: it sees the whole
        // conversation and the persona. A quick pass before the model used to
        // pick tapbacks from the last five messages; it misread banter and
        // missed messages meant for Uno (Sept 30). The 👀 comes with the
        // turn's first browser call.
        // Group chats: OpenClaw's silentReply.group "allow" lets the model stay
        // quiet (a message that names Uno always gets an answer), so no typing
        // shows up front there; each bubble still types before it goes.
        if (groupChatOf(ctx?.sessionKey) != null) return;
        log.info?.(`uno-imsg-proxy: turn start chat=${shape(chat)} sender=${shape(ctx?.senderId)}`);
        startTurnTyping(target);
      } catch (err) {
        log.warn?.(`uno-imsg-proxy: turn start failed (${err?.name ?? "error"}); model answers`);
        try { startTurnTyping(ctx?.chatId != null && /^\d+$/.test(String(ctx.chatId)) ? `chat_id:${ctx.chatId}` : ctx?.senderId); } catch {}
      }
    });

    // Sandboxed agents' AGENTS.md (rules.js sandboxedSession): added to the
    // system prompt, since the Codex harness can't find it in the sandbox.
    api.on("before_prompt_build", (event, ctx) => {
      try {
        const agents = api.config?.agents ?? {};
        if (!ctx?.agentId || !sandboxedSession(agents, ctx.agentId, ctx?.sessionKey)) return;
        const ws = String(agents.entries?.[ctx.agentId]?.workspace ?? agents.defaults?.workspace ?? "~/.openclaw/workspace").replace(/^~(?=\/)/, homedir());
        const file = join(ws, "AGENTS.md");
        const text = existsSync(file) ? agentsMdContext(readFileSync(file, "utf8")) : null;
        if (text) return { appendSystemContext: text };
      } catch {}
    });

    // Reply shape from the agent's workspace, next to each message: REPLY.md in
    // a chat, CALL.md on a FaceTime call (said out loud).
    api.on("before_prompt_build", (event, ctx) => {
      try {
        const name = callTurn(ctx?.sessionKey) ? "CALL.md" : chatTurn(ctx?.sessionKey) ? "REPLY.md" : null;
        if (!name) return;
        const agents = api.config?.agents ?? {};
        const ws = String(agents.entries?.[ctx?.agentId]?.workspace ?? agents.defaults?.workspace ?? "~/.openclaw/workspace").replace(/^~(?=\/)/, homedir());
        const file = join(ws, name);
        const text = existsSync(file) ? readFileSync(file, "utf8") : null;
        const note = !text ? null : name === "CALL.md" ? callNote(text, callTextHandle(api.config?.plugins?.entries?.facetime?.config?.ownerHandles)) : replyNote(text);
        if (note) return { appendContext: note };
      } catch {}
    });

    // First chat: point the model at the first-chat skill until USER.md is set up.
    api.on("before_prompt_build", (event, ctx) => {
      try {
        if (!String(ctx?.sessionKey ?? "").includes(":imessage:")) return;
        const agents = api.config?.agents ?? {};
        const ws = String(agents.entries?.[ctx?.agentId]?.workspace ?? agents.defaults?.workspace ?? "~/.openclaw/workspace").replace(/^~(?=\/)/, homedir());
        const file = join(ws, "USER.md");
        const note = firstChatNote(existsSync(file) ? readFileSync(file, "utf8") : null);
        if (note) return { appendContext: note };
      } catch {}
    });

    // React-and-reply: tell the model its tapback is already on their message.
    api.on("before_prompt_build", () => {
      try {
        const r = JSON.parse(readFileSync(claimFile("reacted", "latest"), "utf8"));
        if (Date.now() - r.t > 60_000) return;
        // Only while that message is still the newest one Uno received.
        const newest = withDb((db) => db.prepare(`SELECT guid FROM message WHERE is_from_me = 0
          AND associated_message_type = 0 ORDER BY ROWID DESC LIMIT 1`).get()?.guid);
        if (newest !== r.guid) return;
        return { appendContext: `You already reacted ${r.emoji} to the owner's latest message. Don't react to it again; reply in words.` };
      } catch {}
    });

    // Texts sent from outside a chat's own conversation (rules.js
    // outsideSendNote): the handle -> chat map lives in a file, since plugin
    // copies don't share memory.
    const DM_FILE = join(homedir(), ".openclaw", "uno-data", "dm-sessions.json");
    const dmSessions = () => { try { return JSON.parse(readFileSync(DM_FILE, "utf8")); } catch { return {}; } };
    api.on("message_received", (event, ctx) => {
      try {
        const key = ctx?.sessionKey, who = norm(ctx?.senderId ?? event?.from);
        if (!isDirectChat(key) || !who) return;
        const map = dmSessions();
        if (map[who] === key) return;
        map[who] = key;
        writeFileSync(DM_FILE, JSON.stringify(map), { mode: 0o600 });
      } catch {}
    });
    api.on("message_sent", async (event, ctx) => {
      try {
        if (!event?.success) return;
        const chatSession = dmSessions()[norm(event.to)];
        const fromSession = event.sessionKey ?? ctx?.sessionKey;
        const text = outsideSendNote({ fromSession, chatSession, content: event.content, at: new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) });
        if (!text) return;
        const enqueue = api.session?.workflow?.enqueueNextTurnInjection ?? api.enqueueNextTurnInjection;
        if (!enqueue) return;
        await enqueue({ sessionKey: chatSession, text, idempotencyKey: `sent-${event.messageId ?? `${fromSession}-${Date.now()}`}`, ttlMs: 7 * 24 * 3600 * 1000 });
        log.info?.(`uno-imsg-proxy: queued a note for ${chatSession} about a text sent from ${sentFrom(fromSession)}`);
      } catch (err) { log.warn?.(`uno-imsg-proxy: couldn't queue a sent-text note: ${err?.message ?? err}`); }
    });

    api.on("message_sending", async (event, ctx) => {
      if (isTestSession(ctx?.sessionKey)) {
        log.info?.(`uno-imsg-proxy: cancelled a send from test session ${ctx.sessionKey}`);
        return { cancel: true, cancelReason: "test session" };
      }
      const sendStart = Date.now();
      const keys = [ctx?.sessionKey, event.to, ctx?.conversationId];
      if (String(event.content ?? "").includes(TAPBACK_SENTINEL)) return { cancel: true, cancelReason: "answered with a tapback" };
      if (isRestartNotice(event.content)) { log.info?.("uno-imsg-proxy: dropped OpenClaw's restart notice"); return { cancel: true, cancelReason: "restart notice" }; }
      if (isApprovalPrompt(event.content)) { log.info?.("uno-imsg-proxy: approval prompt sent whole"); return; }
      try {
        const err = scrub(event.content, false, ctx?.sessionKey, "message send", keys);
        if (err?.drop) return { cancel: true, cancelReason: "trailing error after a delivered reply" };
        if (err) return { content: err.text };
        if (emojiOnly(event.content)) log.info?.(`uno-imsg-proxy: emoji-only message send; tapped=${justTapped(...keys)} keys=${keys.map(shape).join("/")}`);
        if (emojiOnly(event.content) && justTapped(...keys)) {
          log.info?.("uno-imsg-proxy: dropped emoji-only text right after a tapback (message send)");
          return { cancel: true, cancelReason: "duplicate of the tapback" };
        }
        // A reply that's just one emoji becomes a tapback on their latest
        // message, the way a person would react; on any failure it goes as text.
        const tap = ctx?.channelId === "imessage" ? tapbackFor(event.content) : null;
        const theirs = tap ? latestInbound(event.to) : null;
        if (tap && theirs?.guid) {
          let ok = false;
          if (tap.kind) ok = tapback(event.to, theirs.guid, tap.kind);
          else {
            const guid = chatGuid(event.to);
            if (guid) { try { execFileSync(imsg, ["tapback", "--chat", guid, "--message", theirs.guid, "--emoji", tap.emoji, "--part", "0"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }); ok = true; } catch {} }
          }
          log.info?.(`uno-imsg-proxy: emoji-only reply ${ok ? "sent as a tapback" : "tapback failed; sent as text"}`);
          if (ok) { markTapback(...keys); return { cancel: true, cancelReason: "sent as a tapback" }; }
        }
        // An opening emoji is a reaction: a tapback on their message, then the
        // words as the reply (rules.js leadingReaction).
        let leadSent = false;
        const lead = ctx?.channelId === "imessage" ? leadingReaction(event.content) : null;
        // Only on a reply to their latest message that Uno hasn't answered yet,
        // so a scheduled text that opens with an emoji never reacts to an old one.
        const leadTo = lead ? latestInbound(event.to) : null;
        const unanswered = leadTo?.guid ? !withDb((db) => db.prepare(ANSWERED_SINCE_SQL).get(leadTo.guid)) : false;
        if (lead && leadTo?.guid && unanswered) {
          let ok = false;
          if (lead.tap.kind) ok = tapback(event.to, leadTo.guid, lead.tap.kind);
          else {
            const guid = chatGuid(event.to);
            if (guid) { try { execFileSync(imsg, ["tapback", "--chat", guid, "--message", leadTo.guid, "--emoji", lead.tap.emoji, "--part", "0"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }); ok = true; } catch {} }
          }
          log.info?.(`uno-imsg-proxy: opening emoji ${ok ? "sent as a tapback" : "tapback failed; kept in the text"}`);
          if (ok) { event = { ...event, content: lead.rest }; leadSent = true; }
        }
        // Group chats: no opening "Name," (rules.js dropOpeningName).
        const unnamed = ctx?.channelId === "imessage" && isGroupTarget(event.to) ? dropOpeningName(event.content, householdNames()) : event.content;
        const renamed = unnamed !== event.content;
        if (renamed) { log.info?.("uno-imsg-proxy: dropped an opening name in a group"); event = { ...event, content: unnamed }; }
        // Paragraphs go out as separate bubbles: OpenClaw sends the first, the
        // rest follow one at a time, each after a typing pause.
        // Links go in bubbles of their own so they show as previews.
        let bubbles = ctx?.channelId === "imessage" && !event.mediaUrl && !event.mediaUrls?.length ? linkBubbles(splitBubbles(event.content)) : [];
        // Links whose site blocks previews stay on their line (all checked at once).
        const urls = bubbles.map(soleUrl).filter(Boolean);
        if (urls.length && bubbles.length > 1) {
          // A blocked link from a store with a share-link domain is wrapped in
          // it (checked again); any other blocked link stays on its line.
          const checks = await Promise.all(urls.map(async (u) => {
            if (!(await previewBlocked(u))) return [u, null];
            const wrapped = shareLinkFor(u);
            return [u, wrapped && !(await previewBlocked(wrapped)) ? wrapped : "inline"];
          }));
          const swap = new Map(checks.filter(([, r]) => r && r !== "inline"));
          if (swap.size) log.info?.(`uno-imsg-proxy: ${swap.size} blocked link(s) sent as the store's share link`);
          bubbles = keepBlockedLinksInline(bubbles.map((b) => swap.get(soleUrl(b)) ?? b), new Set(checks.filter(([, r]) => r === "inline").map(([u]) => u)));
        }
        const guid = bubbles.length > 1 ? chatGuid(event.to) : null;
        const threadOpts = { replyTo: guidReplyTarget(event.replyToId), since: appleTime(sendStart) };
        // A reply that opens with a link has no OpenClaw bubble to follow, so its
        // thread is the reply target, or the message being answered (their latest).
        const linkThread = () => threadOpts.replyTo ?? (event.replyToId != null && String(event.replyToId).trim() ? latestInbound(event.to)?.guid ?? null : null);
        if (bubbles.length > 1 || /\n\s*\n/.test(String(event.content ?? ""))) log.info?.(`uno-imsg-proxy: bubbles=${bubbles.length} channel=${ctx?.channelId ?? "none"} chat=${guid ? "found" : "missing"} to=${String(event.to ?? "").replace(/[0-9]/g, "#").replace(/[a-z0-9._%+-]+@/gi, "x@")}`);
        if (guid) {
          const [first, ...rest] = bubbles.map(noEmDash);
          try { await typingPause(event.to, first); } catch {}
          if (soleUrl(first)) {
            try {
              const thread = linkThread();
              if (await sendRichLink(event.to, soleUrl(first), thread)) {
                markDelivered(...keys);
                sendBubbles(guid, event.to, rest, { replyTo: thread });
                return { cancel: true, cancelReason: "sent as rich link preview" };
              }
            } catch {}
          }
          markDelivered(...keys);
          sendBubbles(guid, event.to, rest, threadOpts);
          return { content: first };
        }
        if (ctx?.channelId === "imessage") { try { await typingPause(event.to, event.content); } catch {} }
        if (soleUrl(event.content)) log.info?.(`uno-imsg-proxy: url-only send seen (channel ${ctx?.channelId ?? "unknown"})`);
        const url = ctx?.channelId === "imessage" ? soleUrl(event.content) : null;
        if (url && await sendRichLink(event.to, url, guidReplyTarget(event.replyToId) ?? (event.replyToId != null && String(event.replyToId).trim() ? latestInbound(event.to)?.guid ?? null : null))) {
          log.info?.("uno-imsg-proxy: sent link with rich preview");
          markDelivered(...keys);
          return { cancel: true, cancelReason: "sent as rich link preview" };
        }
        if (String(event.content ?? "").trim()) markDelivered(...keys);
        if (String(event.content ?? "").includes("—")) return { content: noEmDash(event.content) };
        if (renamed || leadSent) return { content: event.content };
      } catch {
        log.info?.("uno-imsg-proxy: rich link send failed; sending plain link");
        if (String(event.content ?? "").trim()) markDelivered(...keys);
      }
    });
  },
};
