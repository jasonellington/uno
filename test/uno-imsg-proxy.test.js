import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReaction, isErrorReply, errorReplyFor, errorHint } from "../plugins/uno-imsg-proxy/rules.js";

const react = (extra = {}) => ({ action: "react", emoji: "❤️", messageId: "ABC", ...extra });
const theirs = { is_from_me: 0, handle: "+15555550100" };

test("a tapback on the sender's own message is allowed", () => {
  assert.equal(checkReaction(react(), theirs, "+15555550100"), null);
  assert.equal(checkReaction(react(), { is_from_me: 0, handle: "Owner@Example.com" }, "owner@example.com"), null);
});

test("tapbacks on Uno's own messages are blocked", () => {
  assert.match(checkReaction(react(), { is_from_me: 1, handle: null }, "+15555550100"), /own messages/);
});

test("a tapback must name a specific, known message from the current sender", () => {
  assert.match(checkReaction(react({ messageId: undefined }), null, "+15555550100"), /messageId/);
  assert.match(checkReaction(react(), null, "+15555550100"), /Unknown messageId/);
  assert.match(checkReaction(react(), { is_from_me: 0, handle: "+15555550101" }, "+15555550100"), /person you're talking to/);
  assert.match(checkReaction(react(), theirs, undefined), /person you're talking to/);
});

test("threaded replies follow the same target rules", () => {
  assert.equal(checkReaction({ action: "reply", messageId: "ABC", text: "x" }, theirs, "+15555550100"), null);
  assert.match(checkReaction({ action: "reply", messageId: "ABC", text: "x" }, { is_from_me: 1 }, "+15555550100"), /own messages.*normal message/);
});

test("every block tells the model to fall back to plain text", () => {
  assert.match(checkReaction(react({ messageId: undefined }), null, "+1"), /Anytime/);
  assert.match(checkReaction(react(), { is_from_me: 1 }, "+1"), /Anytime/);
});

test("error text is recognized", () => {
  assert.ok(isErrorReply("⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session."));
  assert.ok(isErrorReply("Codex session policy handoff failed"));
  assert.ok(isErrorReply("anything", true));
  assert.ok(!isErrorReply("Anytime."));
  assert.ok(!isErrorReply("Dentist is Thursday at 3:30."));
});

test("error replacements are worded by who's talking, never raw, never silent", () => {
  const raw = "⚠️ Something went wrong… Codex session policy handoff failed… use /new";
  const owner = errorReplyFor(raw, "agent:main:imessage:direct:me", "main");
  assert.equal(owner, "Hey, I'm having issues right now (my connection to the model hiccuped). You may want to take a look.");
  assert.equal(errorReplyFor("Something went wrong", "agent:main:main", "main"), "Hey, I'm having issues right now. You may want to take a look.");
  const family = errorReplyFor(raw, "agent:uno-agent-sam:imessage:direct:sam", "main", "Alex");
  assert.equal(family, "I'm having trouble right now. Please let Alex know if this keeps happening.");
  assert.equal(errorReplyFor(raw, undefined, "main", "Alex"), family); // unknown session: the non-technical one
  assert.equal(errorReplyFor(raw, "agent:uno-agent-sam:imessage:direct:sam", "main"), "I'm having trouble right now. Please let the owner know if this keeps happening.");
  // No admin configured: nobody gets the technical line, not even a session
  // key that happens to look like one.
  for (const none of [null, undefined, ""]) assert.equal(errorReplyFor(raw, "agent:main:imessage:direct:me", none, "Alex"), family);
  for (const r of [owner, family]) {
    assert.ok(!isErrorReply(r), r);
    assert.ok(!/\/new|codex|policy|⚠️/i.test(r), r);
  }
  assert.equal(errorHint("web_search timed out"), "search failed");
  assert.equal(errorHint("request timed out"), "something timed out");
  assert.equal(errorHint("429 usage limit reached"), "hit the usage limit");
});

test("other message actions and removals are untouched", () => {
  assert.equal(checkReaction({ action: "send", text: "hi" }, null, "+1"), null);
  assert.equal(checkReaction(react({ remove: true }), null, "+1"), null);
});

import { soleUrl, chatLookup } from "../plugins/uno-imsg-proxy/rules.js";

test("only a message that is just one URL becomes a rich link", () => {
  assert.equal(soleUrl(" https://example.com/a?b=1 "), "https://example.com/a?b=1");
  assert.equal(soleUrl("see https://example.com"), null);
  assert.equal(soleUrl("https://a.com https://b.com"), null);
  assert.equal(soleUrl("example.com"), null);
});

test("outbound targets map to a chat.db lookup", () => {
  assert.deepEqual(chatLookup("chat_id:12"), { sql: "SELECT guid FROM chat WHERE ROWID = ?", arg: 12 });
  assert.equal(chatLookup("imessage:+15555550100").arg, "+15555550100");
  assert.equal(chatLookup("Owner@Example.com").arg, "owner@example.com");
});

import { noEmDash } from "../plugins/uno-imsg-proxy/rules.js";


test("em dashes are rewritten to read naturally; en dashes stay", () => {
  assert.equal(noEmDash("No real age—I’m the family assistant."), "No real age. I’m the family assistant.");
  assert.equal(noEmDash("It’s mild — bring a layer."), "It’s mild, bring a layer.");
  assert.equal(noEmDash("Open 5–10pm"), "Open 5–10pm");
  assert.equal(noEmDash("Hold on—"), "Hold on.");
});

import { latestInboundQuery } from "../plugins/uno-imsg-proxy/rules.js";

test("their latest message is found for chat_id targets (the 9:31 miss), groups included, and handles", () => {
  const byChat = latestInboundQuery("chat_id:1");
  assert.equal(byChat.arg, 1);
  assert.match(byChat.sql, /cmj\.chat_id = \?/);
  assert.doesNotMatch(byChat.sql, /c\.style/); // groups too
  assert.equal(latestInboundQuery("imessage:+15555550100").arg, "+15555550100");
  assert.equal(latestInboundQuery(undefined), null);
});

test("common phrases in a normal answer aren't errors; the exact formats are", () => {
  for (const t of [
    "Something went wrong with the order last time, so I'd call the store first.",
    "The site says please try again later; tickets open at 10.",
    "If the Codex session policy handoff comes up in the article, it's about their app.",
  ]) assert.ok(!isErrorReply(t), t);
  for (const t of [
    "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
    "Something went wrong while processing your request.",
    "Codex session policy handoff failed: thread changed",
    "Codex agent harness failed",
  ]) assert.ok(isErrorReply(t), t);
});



test("typing pause: none for empty text, longer for longer text, capped", async () => {
  const { typingMs } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.equal(typingMs(""), 0);
  assert.equal(typingMs("hi"), 600);
  assert.ok(typingMs("x".repeat(40)) > typingMs("x".repeat(10)));
  assert.equal(typingMs("x".repeat(500)), 1500);
});

test("answered-since: only Uno's rows after theirs, in the same chat", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { ANSWERED_SINCE_SQL } = await import("../plugins/uno-imsg-proxy/rules.js");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, is_from_me INT, associated_message_type INT DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INT, message_id INT);
    INSERT INTO message VALUES (1,'THEIRS',0,0),(2,'OTHER-CHAT',1,0),(3,'THEIRS-2',0,0);
    INSERT INTO chat_message_join VALUES (1,1),(2,2),(1,3);`);
  const answered = (g) => db.prepare(ANSWERED_SINCE_SQL).get(g);
  assert.equal(answered("THEIRS"), undefined); // Uno's row is in another chat
  db.exec("INSERT INTO message VALUES (4,'UNO-TAPBACK',1,2006),(5,'UNO-TEXT',1,0); INSERT INTO chat_message_join VALUES (1,4),(1,5);");
  assert.equal(answered("THEIRS").kind, 2006); // the first one: a reaction
  assert.equal(answered("THEIRS-2").kind, 2006);
  assert.equal(answered("MISSING"), undefined);
});

test("got-it reaction: browser tasks only, not web search", async () => {
  const { ACK_TOOLS } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.equal(ACK_TOOLS.has("browser"), true);
  for (const t of ["web_search", "web_fetch", "message", "bash"]) assert.equal(ACK_TOOLS.has(t), false);
});

test("answered-text: skips Uno's reactions, finds its first text", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { ANSWERED_TEXT_SQL } = await import("../plugins/uno-imsg-proxy/rules.js");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, is_from_me INT, associated_message_type INT DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INT, message_id INT);
    INSERT INTO message VALUES (1,'THEIRS',0,0),(2,'TAP',1,2004);
    INSERT INTO chat_message_join VALUES (1,1),(1,2);`);
  assert.equal(db.prepare(ANSWERED_TEXT_SQL).get("THEIRS"), undefined);
  db.exec("INSERT INTO message VALUES (3,'TEXT',1,0); INSERT INTO chat_message_join VALUES (1,3);");
  assert.equal(db.prepare(ANSWERED_TEXT_SQL).get("THEIRS").kind, 0);
});


test("approvals: email to others, replies, invites", async () => {
  const { approvalFor } = await import("../plugins/uno-guard/rules.js");
  const o = { owners: ["+15555550100", "Owner@Example.com"], current: ["chat_id:7"] };
  assert.equal(approvalFor("apple_pim_mail", { action: "send", to: ["owner@example.com"] }, o), null);
  assert.ok(approvalFor("apple_pim_mail", { action: "send", to: ["owner@example.com"], cc: ["friend@example.com"], subject: "hi" }, o).description.includes("friend@example.com"));
  assert.ok(approvalFor("apple_pim_mail", { action: "reply", id: "<x@y>" }, o));
  assert.equal(approvalFor("apple_pim_mail", { action: "messages" }, o), null);
  assert.equal(approvalFor("apple_pim_calendar", { action: "create", title: "Dinner" }, o), null);
  assert.ok(approvalFor("apple_pim_calendar", { action: "create", title: "Dinner", attendees: [{ email: "friend@example.com" }] }, o));
  assert.ok(approvalFor("apple_pim_calendar", { action: "batch_create", events: [{ attendees: [{ email: "a@example.com" }] }] }, o));
  assert.equal(approvalFor("message", { action: "send", target: "+15555550199" }, o), null);
  assert.equal(approvalFor("web_search", { query: "x" }, o), null);
  assert.deepEqual(approvalFor("apple_pim_mail", { action: "reply" }, o).allowedDecisions, ["allow-once", "deny"]);
});

import { firstChatNote } from "../plugins/uno-imsg-proxy/rules.js";
test("first-chat note while USER.md is missing or unfinished, none once set up", () => {
  assert.match(firstChatNote(null), /first-chat skill/);
  assert.match(firstChatNote("# USER.md\n\nSetup isn't finished: use the first-chat skill.\n"), /welcome/);
  assert.equal(firstChatNote("# USER.md\n\n## Who you're talking to\n\nThis chat is with Alex.\n"), null);
});

import { splitBubbles, MAX_BUBBLES } from "../plugins/uno-imsg-proxy/rules.js";
test("paragraphs become bubbles; code stays whole; extras share the last", () => {
  assert.deepEqual(splitBubbles("Hi Alex!\n\nI'm Uno.\n \nLet's go."), ["Hi Alex!", "I'm Uno.", "Let's go."]);
  assert.deepEqual(splitBubbles("one line\nsecond line"), ["one line\nsecond line"]);
  assert.equal(splitBubbles("a\n\n```\nx\n\ny\n```").length, 1);
  const many = splitBubbles(Array.from({ length: 9 }, (_, i) => `p${i}`).join("\n\n"));
  assert.equal(many.length, MAX_BUBBLES);
  assert.equal(many.at(-1), "p5\n\np6\n\np7\n\np8");
});

test("chat lookup strips service prefixes", () => {
  for (const to of ["+15555550100", "imessage:+15555550100", "auto:+15555550100", "sms:+15555550100"]) assert.equal(chatLookup(to).arg, "+15555550100");
});

import { bubbleTypingMs } from "../plugins/uno-imsg-proxy/rules.js";
test("follow-up bubble typing scales with length, bounded, with jitter", () => {
  const mid = () => 0.5;
  assert.ok(bubbleTypingMs("ok", mid) >= 900 && bubbleTypingMs("ok", mid) < 1100);
  assert.ok(bubbleTypingMs("x".repeat(80), mid) > bubbleTypingMs("x".repeat(20), mid));
  assert.equal(bubbleTypingMs("x".repeat(500), mid), 3500);
  assert.ok(bubbleTypingMs("x".repeat(500), () => 0) < bubbleTypingMs("x".repeat(500), () => 1));
  assert.equal(bubbleTypingMs(""), 0);
});

import { browserDecision } from "../plugins/uno-guard/rules.js";
test("Browser: family agents browse like the admin, on the family profile only", () => {
  assert.equal(browserDecision("browser", { action: "open", profile: "openclaw" }, "main", "main"), null);
  assert.equal(browserDecision("web_search", {}, "kid", "main"), null);
  assert.deepEqual(browserDecision("browser", { action: "open", url: "https://example.com", profile: "openclaw" }, "kid", "main"), { params: { action: "open", url: "https://example.com", profile: "family", target: "host" } });
  assert.deepEqual(browserDecision("browser", { action: "act", kind: "evaluate", fn: "1" }, "kid", "main"), { params: { action: "act", kind: "evaluate", fn: "1", profile: "family", target: "host" } });
  assert.equal(browserDecision("browser", { action: "importprofile" }, "kid", "main").block, true);
  assert.equal(browserDecision("browser", { action: "snapshot", node: "phone" }, "kid", "main").block, true);
  assert.equal(browserDecision("browser", { action: "snapshot", target: "node" }, "kid", "main").block, true);
});

import { pimDecision } from "../plugins/uno-guard/rules.js";
test("Apple tools: family agents are pinned to their own filter file", () => {
  const has = (p) => p === "/r/kid/config.json";
  assert.equal(pimDecision("apple_pim_reminder", { action: "lists" }, "main", "main", "/r", has), null);
  assert.equal(pimDecision("web_search", { q: "x" }, "kid", "main", "/r", has), null);
  assert.deepEqual(pimDecision("apple_pim_reminder", { action: "items", list: "A" }, "kid", "main", "/r", has), { params: { action: "items", list: "A", configDir: "/r/kid" } });
  assert.deepEqual(pimDecision("apple_pim_calendar", { action: "list", configDir: "/nonexistent" }, "kid", "main", "/r", has), { params: { action: "list", configDir: "/r/kid" } });
  assert.equal(pimDecision("apple_pim_calendar", { action: "list", profile: "work" }, "kid", "main", "/r", has).block, true);
  assert.equal(pimDecision("apple_pim_reminder", { action: "config_init" }, "kid", "main", "/r", has).block, true);
  assert.equal(pimDecision("apple_pim_reminder", { action: "lists" }, "other", "main", "/r", has).block, true);
});

import { adminBrowserProfile, isSharedSite, agentOfSession, uploadDecision } from "../plugins/uno-guard/rules.js";
test("Uploads: a family agent sends only files from its own chats", () => {
  assert.equal(agentOfSession("agent:kid:imessage:direct:+15555550177"), "kid");
  assert.equal(agentOfSession("main"), null);
  const owners = new Map([["IMG_1---a.jpg", "kid"], ["IMG_2---b.jpg", "main"]]);
  const dir = "/Users/x/.openclaw/media/inbound/";
  assert.equal(uploadDecision({ action: "upload", paths: [dir + "IMG_1---a.jpg"] }, "kid", owners), null);
  assert.equal(uploadDecision({ action: "upload", paths: [dir + "IMG_1---a.jpg", dir + "IMG_2---b.jpg"] }, "kid", owners).block, true);
  assert.equal(uploadDecision({ action: "upload", paths: [dir + "unknown.jpg"] }, "kid", owners).block, true);
  assert.equal(uploadDecision({ action: "snapshot" }, "kid", owners), null);
});

import { groupChatOf, inThisChat } from "../plugins/uno-imsg-proxy/rules.js";
test("Group chats: tapbacks and threaded replies stay in the chat the turn came from", () => {
  assert.equal(groupChatOf("agent:fam:imessage:group:42"), 42);
  assert.equal(groupChatOf("agent:fam:imessage:group:chat_id:42"), 42);
  assert.equal(groupChatOf("agent:main:main"), null);
  const inGroup = { is_from_me: 0, handle: "+15555550100", chat_rowid: 42, chat_style: 43 };
  const inDm = { is_from_me: 0, handle: "+15555550100", chat_rowid: 7, chat_style: 45 };
  const react = { action: "react", messageId: "X", emoji: "👍" };
  assert.equal(checkReaction(react, inGroup, "+15555550100", 42), null);
  assert.match(checkReaction(react, inDm, "+15555550100", 42), /in this chat/);
  assert.equal(checkReaction(react, inDm, "+15555550100"), null);
  assert.match(checkReaction(react, inGroup, "+15555550100"), /in this chat/);
  assert.equal(inThisChat({ chat_style: undefined }, null), true);
});

import { mailDecision, mailFilter } from "../plugins/uno-guard/rules.js";
test("Mail: a family agent sees only mail from its person's addresses", () => {
  const addrs = { kid: ["Kid@Example.com"] };
  assert.equal(mailDecision("apple_pim_mail", { action: "messages" }, "main", "main", addrs), null);
  assert.equal(mailDecision("apple_pim_mail", { action: "messages" }, "kid", "main", addrs), null);
  assert.equal(mailDecision("apple_pim_mail", { action: "messages" }, "other", "main", addrs).block, true);
  for (const action of ["delete", "move", "reply", "save_attachment", "accounts", "batch_update", undefined]) assert.equal(mailDecision("apple_pim_mail", { action }, "kid", "main", addrs).block, true, String(action));
  const list = JSON.stringify({ success: true, count: 3, totalInMailbox: 40, messages: [
    { messageId: "a", senderAddress: "kid@example.com", subject: "mine" },
    { messageId: "b", senderAddress: "owner@example.com", subject: "bank" },
    { messageId: "c", senderAddress: "shop@example.com", subject: "order" },
    { messageId: "d", senderAddress: "kid@example.com", subject: "spam", isJunk: true }] });
  const out = JSON.parse(mailFilter("messages", list, addrs.kid));
  assert.deepEqual(out.messages.map((m) => m.messageId), ["a"]);
  assert.equal(out.count, 1);
  assert.equal(out.totalInMailbox, undefined);
  const auth = (dom, verdict = "pass") => `Authentication-Results: dmarc.icloud.com; dmarc=${verdict} header.from=${dom}\nAuthentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=${dom}`;
  const fromKid = (headers, extra = {}) => JSON.stringify({ success: true, message: { senderAddress: "kid@example.com", to: [{ address: "uno@example.com" }], allHeaders: headers, content: "x", ...extra } });
  assert.equal(JSON.parse(mailFilter("get", fromKid(auth("example.com")), addrs.kid)).success, true);
  assert.match(mailFilter("get", fromKid(auth("example.com", "fail")), addrs.kid), /Not found/, "forged From fails DMARC");
  assert.match(mailFilter("get", fromKid(""), addrs.kid), /Not found/, "no results, not trusted");
  assert.match(mailFilter("get", fromKid(auth("evil.example")), addrs.kid), /Not found/, "passes for another domain");
  assert.match(mailFilter("get", fromKid(`Authentication-Results: dmarc.icloud.com; dmarc=fail header.from=example.com\nAuthentication-Results: dmarc.icloud.com; dmarc=pass header.from=example.com`), addrs.kid), /Not found/, "a forged pass further down doesn't count");
  assert.match(mailFilter("get", fromKid(auth("example.com"), { isJunk: true }), addrs.kid), /Not found/, "junk stays hidden");
  const theirs = JSON.stringify({ success: true, message: { senderAddress: "owner@example.com", to: [{ address: "uno@example.com" }], content: "secret" } });
  const toKid = JSON.stringify({ success: true, message: { senderAddress: "shop@example.com", to: [{ address: "kid@example.com" }], content: "hi" } });
  assert.match(mailFilter("get", theirs, addrs.kid), /Not found/);
  assert.equal(mailFilter("get", toKid, addrs.kid), toKid);
  assert.match(mailFilter("search", "not json", addrs.kid), /Not found/);
  assert.equal(mailFilter("send", "sent", addrs.kid), "sent");
});

test("texting: outside the family needs the owner's 👍 in the admin's agent, a no elsewhere", async () => {
  const { householdHandles, textDecision, gate, TEXT_BLOCKED } = await import("../plugins/uno-guard/rules.js");
  const household = householdHandles({ allowFrom: ["+15555550100", "Owner@Example.com", "accessGroup:family"], groups: { "12": {}, "*": {} } }, { family: { members: { imessage: ["+15555550101"] } } });
  assert.deepEqual(household.sort(), ["+15555550100", "+15555550101", "chat_id:12", "owner@example.com"]);
  const o = { household, current: ["chat_id:7"] };
  assert.equal(textDecision("message", { action: "send", message: "on it" }, o), null);
  assert.equal(textDecision("message", { action: "send", target: "chat_id:7" }, o), null);
  assert.equal(textDecision("message", { action: "send", target: "chat_id:12" }, o), null);
  assert.equal(textDecision("message", { action: "send", target: "imessage:+15555550100" }, o), null);
  assert.equal(textDecision("message", { action: "send", target: "+15555550101" }, o), null);
  assert.equal(textDecision("message", { action: "react", target: "+15555550199" }, o), null);
  assert.ok(textDecision("message", { action: "send", target: "+15555550199" }, o).ask);
  assert.ok(textDecision("message", { action: "send", to: "friend@example.com" }, o).ask);
  for (const action of ["sendWithEffect", "sendAttachment", "upload-file", "broadcast", "reply", "thread-reply"]) assert.ok(textDecision("message", { action, target: "+15555550199" }, o)?.ask, action);
  assert.ok(textDecision("message", { action: "broadcast", targets: ["imessage:+15555550100", "+15555550199"] }, o).ask);
  assert.equal(textDecision("message", { action: "upload-file", target: "+15555550142" }, { ...o, sink: "+15555550142" }), null);
  assert.equal(textDecision("message", { action: "send", target: "+15555550199" }, { household: [], current: [] })?.ask?.title, "Text someone outside the family");
  const d = textDecision("message", { action: "send", target: "imessage:+15555550199", message: "Running late" }, o);
  assert.deepEqual(d.recipients, ["+15555550199"]);
  assert.match(d.ask.description, /^Text \+15555550199: "Running late"\?$/);
  assert.deepEqual(gate(d, "main", "main"), { requireApproval: d.ask });
  assert.deepEqual(gate(d, "family-a", "main"), { block: true, blockReason: TEXT_BLOCKED });
  assert.equal(gate(null, "main", "main"), null);
});

test("approvals: only the admin's agent asks; others get a plain no", async () => {
  const { approvalOrBlock } = await import("../plugins/uno-guard/rules.js");
  const ask = { title: "Send an email" };
  assert.equal(approvalOrBlock(null, "family-a", "main"), null);
  assert.deepEqual(approvalOrBlock(ask, "main", "main"), { requireApproval: ask });
  assert.ok(approvalOrBlock(ask, "family-a", "main").block);
  assert.ok(approvalOrBlock(ask, "main", null).block);
});

test("sending: every outgoing iMessage goes only to the family", async () => {
  const { sendDecision } = await import("../plugins/uno-guard/rules.js");
  const household = ["+15555550100", "owner@example.com", "+15555550101", "chat_id:12"];
  const chats = { "chat_id:3": ["+15555550100"], "chat_id:4": ["+15555550101", "owner@example.com"], "chat_id:5": ["+15555550199"], "chat_id:6": ["+15555550100", "+15555550199"] };
  const o = { household, sink: "+15555550142", members: (to) => chats[to] ?? (to.startsWith("chat_id:") ? [] : [to]) };
  for (const to of ["chat_id:3", "chat_id:4", "chat_id:12", "+15555550100", "imessage:owner@example.com", "+15555550142"]) assert.equal(sendDecision(to, o), null, to);
  for (const to of ["chat_id:5", "chat_id:6", "chat_id:99", "+15555550199", "friend@example.com"]) assert.equal(sendDecision(to, o)?.cancel, true, to);
  assert.equal(sendDecision("chat_id:3", { household: [], members: () => ["+15555550100"] })?.cancel, true);
  assert.equal(sendDecision("chat_id:5", { ...o, approved: ["+15555550199"] }), null);
  assert.equal(sendDecision("chat_id:6", { ...o, approved: ["+15555550199"] }), null);
});

test("shell: texting and email from the shell, and CLI sends outside the family, need the owner's 👍", async () => {
  const { shellSendDecision } = await import("../plugins/uno-guard/rules.js");
  const o = { household: ["+15555550100", "chat_id:12"], sink: "+15555550142" };
  const run = (command) => shellSendDecision("exec", { command }, o);
  for (const c of ["imsg send --to +15555550199 --text hi", "/opt/homebrew/bin/imsg send-rich --chat x --url https://example.com",
    `osascript -e 'tell application "Messages" to send "hi" to buddy "+15555550199"'`,
    `osascript -e 'tell application "Mail" to make new outgoing message with properties {subject:"x"}'`,
    "openclaw message send --channel imessage --target +15555550199 -m hi",
    `openclaw cron add --name x --at 5m --announce --channel imessage --to "+15555550199"`]) assert.ok(run(c)?.ask, c);
  assert.deepEqual(run(`osascript -e 'tell application "Messages" to send "hi" to buddy "+15555550199"'`).recipients, ["+15555550199"]);
  assert.deepEqual(run("imsg send --to +15555550199 --text hi").recipients, ["+15555550199"]);
  assert.match(run("imsg send --to +15555550199 --text hi").ask.description, /^Command: imsg send/);
  for (const c of ["imsg chats --limit 5", "imsg history --chat-id 3", `osascript -e 'tell application "Notes" to get name of folders'`,
    `osascript -e 'tell application "Mail" to get subject of messages of inbox'`,
    "openclaw cron add --name x --at 5m --announce --channel imessage --to +15555550100", "openclaw cron list", "openclaw message send --target chat_id:12 -m hi"]) assert.equal(run(c), null, c);
  assert.equal(shellSendDecision("browser", { command: "imsg send" }, o), null);
});

test("household note: from config, per agent", async () => {
  const { householdNote, unlockedSpaces } = await import("../plugins/uno-guard/rules.js");
  const familySpaces = { reminders: "Family + Uno", calendar: "Family + Uno", files: "Family + Uno" };
  const base = { adminAgentId: "main", ownerName: "Sam", sharedSites: ["example.com"], selfAddresses: ["uno@example.com"], familySpaces };
  const admin = householdNote({ ...base, agentId: "main", spaces: { reminders: "Sam and Uno", files: "Sam and Uno" } });
  assert.match(admin, /Texting, emailing or inviting the family is fine\. Anyone outside the family asks Sam for a 👍/);
  assert.doesNotMatch(admin, /You text only the family/);
  assert.match(admin, /You see all of that mail/);
  assert.match(admin, /"Sam and Uno" Reminders list/);
  assert.match(admin, /CloudDocs\/Sam and Uno\//);
  assert.match(admin, /Placing orders is off/);
  assert.doesNotMatch(admin, /purchase_check/);
  assert.doesNotMatch(admin, /is the owner and set you up/);
  const unlocked = unlockedSpaces({ reminders: { items: ["Family + Uno"] }, calendars: { items: [] } }, { maps: true });
  const person = householdNote({ ...base, agentId: "family-a", mailTool: true, mailAddresses: ["alex@example.com"], spaces: { reminders: "Alex and Uno", notes: "Alex and Uno" }, unlocked });
  assert.match(person, /Sam is the owner and set you up/);
  assert.match(person, /isn't available: say so/);
  assert.match(person, /You text only the family/);
  assert.doesNotMatch(person, /schedule texts/);
  assert.match(householdNote({ agentId: "family-a", adminAgentId: "main", scheduled: false }), /can't schedule texts for later/);
  assert.doesNotMatch(householdNote({ agentId: "main", adminAgentId: "main", scheduled: false }), /schedule texts/);
  assert.match(person, /Mail forwarded from alex@example.com reaches you/);
  assert.match(person, /Shared with the whole family: "Family \+ Uno" Reminders list\./);
  assert.doesNotMatch(person, /"Family \+ Uno" (calendar|iCloud Drive folder)/);
  assert.match(person, /Invites to their own Reminders list "Alex and Uno", Notes folder "Alex and Uno" are on their way/);
  const later = householdNote({ ...base, agentId: "family-a", spaces: { reminders: "Alex and Uno" }, unlocked: unlockedSpaces({ reminders: { items: ["Alex and Uno"] } }, {}) });
  assert.match(later, /Theirs, shared with you: "Alex and Uno" Reminders list/);
  assert.doesNotMatch(later, /on their way/);
  const group = householdNote({ ...base, agentId: "group-a", group: true, spaces: { reminders: "x" }, unlocked: unlockedSpaces({ reminders: { items: ["Family + Uno"] }, calendars: { items: ["Family + Uno"] } }, {}) });
  assert.match(group, /"Family \+ Uno" calendar/);
  assert.doesNotMatch(group, /Invites|Theirs|don't have spaces/);
  assert.doesNotMatch(householdNote({ agentId: "family-a", adminAgentId: "main" }), /Signed in|Placing/);
});

test("routed approvals: listed agents ask the owner, others get a no", async () => {
  const { gate, approvalOrBlock, householdNote } = await import("../plugins/uno-guard/rules.js");
  const d = { ask: { title: "x" }, blockReason: "no" };
  assert.deepEqual(gate(d, "group-a", "main", ["group-a"]), { requireApproval: d.ask });
  assert.ok(gate(d, "family-a", "main", ["group-a"]).block);
  assert.deepEqual(approvalOrBlock(d.ask, "group-a", "main", ["group-a"]), { requireApproval: d.ask });
  const group = householdNote({ agentId: "group-a", adminAgentId: "main", ownerName: "Sam", group: true, asks: true, sharedSites: ["example.com"], purchases: "limit", purchaseLimit: 25 });
  assert.match(group, /Texting or inviting someone outside the family: go ahead and do it with your tool\. It asks Sam for a 👍 on its own/);
  assert.match(group, /call purchase_check/);
  assert.match(group, /Over \$25, or with no total shown, it asks Sam \(on its own, in Sam's chat/);
  const sealed = householdNote({ agentId: "group-a", adminAgentId: "main", ownerName: "Sam", group: true, asks: true, textsOutside: false, mailTool: false });
  assert.match(sealed, /You text only in this chat\./);
  assert.match(sealed, /^- Inviting someone outside the family: go ahead/m);
  assert.doesNotMatch(group, /You text only the family/);
});

test("purchases: the model declares them; the rule decides", async () => {
  const { purchaseCheck, PURCHASES_OFF } = await import("../plugins/uno-guard/rules.js");
  const buy = { what: "Streaming add-on", site: "example.com" };
  assert.deepEqual(purchaseCheck({ ...buy, total: 5 }, { mode: "off" }), { block: PURCHASES_OFF });
  assert.equal(purchaseCheck({ ...buy, total: 24.99 }, { mode: "limit", limit: 25 }).allow, true);
  assert.equal(purchaseCheck({ ...buy, total: 25 }, { mode: "limit", limit: 25 }).allow, true);
  assert.match(purchaseCheck({ ...buy, total: 25.01 }, { mode: "limit", limit: 25 }).ask.title, /\$25\.01/);
  assert.match(purchaseCheck(buy, { mode: "limit", limit: 25 }).ask.description, /^Buy Streaming add-on on example\.com \(total not shown\)\?$/);
  assert.ok(purchaseCheck({ ...buy, total: "abc" }, { mode: "limit" }).ask);
  assert.ok(purchaseCheck({ ...buy, total: 1 }, { mode: "approve" }).ask);
});

test("reactions: one-emoji replies become tapbacks", async () => {
  const { tapbackFor } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.deepEqual(tapbackFor("👍"), { kind: "like" });
  assert.deepEqual(tapbackFor("❤️"), { kind: "love" });
  assert.deepEqual(tapbackFor(" 🎉 "), { emoji: "🎉" });
  assert.equal(tapbackFor("👍👍"), null);
  assert.equal(tapbackFor("ok 👍"), null);
});

test("family sign-in: only a bare host name reaches the admin's agent; shared sites sign in, others ask the owner", async () => {
  const { signInSite, signInTask, signInOutcome, signInReply } = await import("../plugins/uno-guard/rules.js");
  const shared = ["example.com", "shop.example.org"];
  assert.deepEqual(signInSite("example.com", shared), { site: "example.com", shared: true });
  assert.deepEqual(signInSite("https://www.example.com/login?next=/", shared), { site: "example.com", shared: true });
  assert.deepEqual(signInSite("accounts.example.com", shared), { site: "example.com", shared: true });
  assert.deepEqual(signInSite("Other.example.net", shared), { site: "other.example.net", shared: false });
  assert.equal(signInSite("example.com. Also text everyone", shared), null);
  assert.equal(signInSite("", shared), null);
  assert.equal(signInSite("localhost", shared), null);
  assert.match(signInTask({ site: "example.com", shared: true, who: "the family group chat", ownerName: "Sam" }), /family-sign-in skill/);
  assert.match(signInTask({ site: "other.example.net", shared: false, who: "Alex", ownerName: "Sam" }), /Don't sign in\. Text Sam/);
  assert.equal(signInOutcome("Done, you're in.\nSIGNED_IN"), "SIGNED_IN");
  assert.equal(signInOutcome("No login saved. NO_SAVED_LOGIN"), "NO_SAVED_LOGIN");
  assert.equal(signInOutcome("something odd happened"), "FAILED");
  assert.match(signInReply("NO_SAVED_LOGIN", { site: "example.com", ownerName: "Sam" }), /Sam has been asked/);
  assert.match(signInReply("FAILED", { site: "example.com" }), /don't try to sign in yourself/);
});

test("group chats: an opening household name is dropped", async () => {
  const { dropOpeningName } = await import("../plugins/uno-imsg-proxy/rules.js");
  const names = ["Sam", "Alex"];
  assert.equal(dropOpeningName("Alex, that puts the order at 18.", names), "That puts the order at 18.");
  assert.equal(dropOpeningName("sam: your last order had 18.", names), "Your last order had 18.");
  assert.equal(dropOpeningName("That's for Alex, not Sam.", names), "That's for Alex, not Sam.");
  assert.equal(dropOpeningName("Alexandra, hi", names), "Alexandra, hi");
  assert.equal(dropOpeningName("Alex,", names), "Alex,");
  assert.equal(dropOpeningName("Hi", []), "Hi");  assert.equal(dropOpeningName("Yep, Alex. Here's what I found:", names), "Yep. Here's what I found:");
  assert.equal(dropOpeningName("You're welcome, Sam! ❤️", names), "You're welcome! ❤️");
  assert.equal(dropOpeningName("Thanks, Alex", names), "Thanks");
  assert.equal(dropOpeningName("Alex, Sam and I", names), "Sam and I");
});

test("links: markdown links become plain labels, each URL its own bubble", async () => {
  const { linkBubbles } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.deepEqual(linkBubbles(["Store A [Curvy jeans](https://a.example.com/curvy) if the waist gaps."]),
    ["Store A Curvy jeans if the waist gaps.", "https://a.example.com/curvy"]);
  assert.deepEqual(linkBubbles(["Code SAVE50 takes $50 off, for new customers. [Offer](https://b.example.com/save50)"]),
    ["Code SAVE50 takes $50 off, for new customers.", "https://b.example.com/save50"]);
  assert.deepEqual(linkBubbles(["Its [offers page](https://c.example.com/o) and [sale](https://c.example.com/s) are worth a look.", "Next"]),
    ["Its offers page and sale are worth a look.", "https://c.example.com/o", "https://c.example.com/s", "Next"]);
  assert.deepEqual(linkBubbles(["[A](https://d.example.com)", "https://d.example.com", "Plain text"]), ["https://d.example.com", "Plain text"]);
  assert.deepEqual(linkBubbles(["see https://e.example.com for more"]), ["see https://e.example.com for more"]);
  assert.deepEqual(linkBubbles(["```\n[x](https://f.example.com)\n```"]), ["```\n[x](https://f.example.com)\n```"]);
});

test("purchases on a no-approval site go through without a total; elsewhere the limit holds", async () => {
  const { purchaseCheck, PURCHASES_OFF } = await import("../plugins/uno-guard/rules.js");
  const opts = { mode: "limit", limit: 25, freeSites: ["example.com"] };
  assert.equal(purchaseCheck({ what: "box", site: "example.com" }, opts).allow, true);
  assert.equal(purchaseCheck({ what: "box", site: "https://www.example.com/cart", total: 90 }, opts).allow, true);
  assert.equal(purchaseCheck({ what: "box", site: "shop.example.com", total: 90 }, opts).allow, true);
  assert.ok(purchaseCheck({ what: "box", site: "example.org", total: 90 }, opts).ask);
  assert.ok(purchaseCheck({ what: "box", site: "notexample.com" }, opts).ask);
  assert.deepEqual(purchaseCheck({ what: "box", site: "example.com" }, { ...opts, mode: "off" }), { block: PURCHASES_OFF });
});

test("OpenClaw's restart notice is recognized; ordinary text isn't", async () => {
  const { isRestartNotice } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.equal(isRestartNotice("I'm continuing your interrupted request now (the gateway has just restarted).  Don't be concerned with the lack of typing; I am working behind the scenes and I'll send a message when I'm done!"), true);
  assert.equal(isRestartNotice("I'm continuing with the order now."), false);
});

test("OpenClaw's approval prompts are recognized so they go out whole", async () => {
  const { isApprovalPrompt, splitBubbles } = await import("../plugins/uno-imsg-proxy/rules.js");
  const prompt = "🛡️ Plugin approval required\nTitle: Buy something\nID: plugin:abc\n\n• Allow Once\n• Deny\n\nReact with:\n\n👍 Allow Once\n\nExpires in: 300s\nReply with: /approve plugin:abc allow-once|deny";
  assert.equal(isApprovalPrompt(prompt), true);
  assert.ok(splitBubbles(prompt).length > 1); // why it must skip the bubble split
  assert.equal(isApprovalPrompt("Approval required? I'll /approve it later"), true);
  assert.equal(isApprovalPrompt("Your order needs approval from the store."), false);
});

test("approvals by iMessage: OpenClaw's prompt is parsed and replaced by one plain question; its follow-up is recognized", async () => {
  const { parseApprovalPrompt, isApprovalFollowUp, approvalFrom, cleanApprovalPrompt, decisionOfTapback, purchaseCheck } = await import("../plugins/uno-guard/rules.js");
  const prompt = "🛡️ Plugin approval required\nTitle: Buy something ($99.00)\nDescription: Buy a test item on example.com for $99.00?\nTool: purchase_check\nPlugin: uno-guard\nAgent: agent-group\nID: plugin:15d233a6-1f94-456f-a6d7-9b37d016eba3\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\nExpires in: 300s\nReply with: /approve plugin:15d233a6 allow-once|deny";
  const p = parseApprovalPrompt(prompt);
  assert.deepEqual(p, { id: "plugin:15d233a6-1f94-456f-a6d7-9b37d016eba3", title: "Buy something ($99.00)", description: "Buy a test item on example.com for $99.00?", plugin: "uno-guard", agent: "agent-group" });
  assert.equal(parseApprovalPrompt("Hello"), null);
  const opts = { adminAgentId: "main", names: { "agent-a": "Alex" }, groupAgents: ["agent-group"] };
  assert.equal(approvalFrom("main", opts), "");
  assert.equal(approvalFrom("agent-group", opts), "Group chat");
  assert.equal(approvalFrom("agent-a", opts), "Alex's chat");
  assert.equal(cleanApprovalPrompt(p, "Group chat"), "Group chat: buy a test item on example.com for $99.00?\n👍 or 👎");
  assert.equal(cleanApprovalPrompt(p, ""), "Buy a test item on example.com for $99.00?\n👍 or 👎");
  assert.equal(isApprovalFollowUp("✅ Plugin approval denied. Resolved by iMessage approval (+15555550100). ID: plugin:x"), true);
  assert.equal(isApprovalFollowUp("⏱️ Plugin approval expired. ID: plugin:x"), true);
  assert.equal(isApprovalFollowUp("Plugin approvals are neat"), false);
  assert.equal(decisionOfTapback(2001), "allow-once");
  assert.equal(decisionOfTapback(2002), "deny");
  assert.equal(decisionOfTapback(2003), null);
  assert.equal(purchaseCheck({ what: "a box", site: "example.org" }, { mode: "approve" }).ask.description, "Buy a box on example.org (total not shown)?");
});

test("reply shape: REPLY.md goes next to chat and test turns, CALL.md next to call turns", async () => {
  const { chatTurn, callTurn, replyNote, callNote } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.equal(chatTurn("agent:main:imessage:direct:+15555550100"), true);
  assert.equal(chatTurn("agent:uno-agent-family:imessage:group:2"), true);
  assert.equal(chatTurn("agent:main:test:replies-1"), true);
  assert.equal(chatTurn("agent:main:cron:abc"), false);
  assert.equal(chatTurn("agent:main:main"), false);
  assert.equal(chatTurn(undefined), false);
  assert.equal(chatTurn("agent:main:facetime:3f2a"), false);
  assert.equal(chatTurn("agent:main:test:call:eval-call-hello-1"), false);
  assert.equal(callTurn("agent:main:facetime:3f2a"), true);
  assert.equal(callTurn("agent:main:test:call:eval-call-hello-1"), true);
  assert.equal(callTurn("agent:main:imessage:direct:+15555550100"), false);
  assert.equal(callTurn("agent:main:test:replies-1"), false);
  assert.equal(callTurn(undefined), false);
  assert.equal(replyNote("  Keep it a text.\n"), "Keep it a text.");
  assert.equal(replyNote(" \n"), null);
  assert.equal(callNote("  Say it out loud.\n"), "[Setup note, not from them] Say it out loud.");
  assert.equal(callNote(" \n"), null);
});

test("threading: every bubble follows the first one's thread", async () => {
  const { guidReplyTarget, bubbleArgs, appleTime } = await import("../plugins/uno-imsg-proxy/rules.js");
  const g = "af635f06-1234-4abc-9def-0123456789ab";
  assert.equal(guidReplyTarget(g), g.toUpperCase());
  assert.equal(guidReplyTarget(`p:0/${g}`), g.toUpperCase());
  assert.equal(guidReplyTarget("42"), null);
  assert.equal(guidReplyTarget(undefined), null);
  const chat = "iMessage;-;+15555550100";
  assert.deepEqual(bubbleArgs(chat, "more words", "GUID"), ["send-rich", "--chat", chat, "--text", "more words", "--reply-to", "GUID"]);
  assert.deepEqual(bubbleArgs(chat, "https://example.com/a", "GUID"), ["send-rich", "--chat", chat, "--url", "https://example.com/a", "--reply-to", "GUID"]);
  assert.deepEqual(bubbleArgs(chat, "more words", null), ["send", "--chat-guid", chat, "--text", "more words"]);
  assert.deepEqual(bubbleArgs(chat, "https://example.com/a", null), ["send-rich", "--chat", chat, "--url", "https://example.com/a"]);
  assert.equal(appleTime(978307200000), 0);
});

test("test sessions: a new automation is logged with its delivery and reported done, never scheduled", async () => {
  const { testAutomation } = await import("../plugins/uno-imsg-proxy/rules.js");
  const job = { action: "add", job: { delivery: { mode: "announce", channel: "imessage", to: "+15555550100" } } };
  const t = testAutomation("automations", job, "agent:main:test:call:eval-x-1");
  assert.match(t.log, /test automation session=agent:main:test:call:eval-x-1 deliver=imessage to=set target=\S+ mode=\S+$/);
  assert.equal(t.result.block, true);
  assert.match(t.result.blockReason, /^Done: the job is scheduled/);
  assert.match(testAutomation("cron", { action: "add", job: {} }, "agent:main:test:eval-y").log, /deliver=none to=none target=unset mode=default$/);
  assert.match(testAutomation("automations", { action: "add", job: { sessionTarget: "current", delivery: { mode: "announce" } } }, "agent:main:test:eval-y").log, /target=current mode=announce$/);
  assert.equal(testAutomation("automations", job, "agent:main:imessage:direct:me"), null); // real chats schedule for real
  assert.equal(testAutomation("automations", { ...job, action: "list" }, "agent:main:test:call:eval-x-1"), null);
  assert.equal(testAutomation("message", job, "agent:main:test:call:eval-x-1"), null);
});

test("test sessions never text: message sends are logged and reported done; reacts keep their own path", async () => {
  const { testMessage, isTestSession } = await import("../plugins/uno-imsg-proxy/rules.js");
  const key = "agent:main:test:call:eval-x-1";
  const t = testMessage("message", { action: "send", message: "hi", target: "+15555550100" }, key);
  assert.match(t.log, /test message send session=agent:main:test:call:eval-x-1$/);
  assert.deepEqual(t.result, { block: true, blockReason: "Done: sent." });
  assert.match(testMessage("message", { message: "hi" }, key).log, /test message send session=\S+$/); // no action: a send
  assert.match(testMessage("message", { action: "send", message: "https://www.amazon.com/dp/B000" }, key).log, / link$/);
  assert.equal(testMessage("message", { action: "react", emoji: "👍" }, key), null);
  assert.equal(testMessage("message", { action: "send" }, "agent:main:imessage:direct:me"), null);
  assert.equal(isTestSession("agent:uno-lab:test:eval-y"), true);
  assert.equal(isTestSession("agent:main:facetime:abc"), false);
});

test("call note: where their texts go, from the owner's FaceTime handles (phone first)", async () => {
  const { callNote, callTextHandle } = await import("../plugins/uno-imsg-proxy/rules.js");
  assert.equal(callTextHandle(["owner@example.com", "+15555550100"]), "+15555550100");
  assert.equal(callTextHandle(["owner@example.com"]), "owner@example.com");
  assert.equal(callTextHandle(undefined), null);
  assert.equal(callNote("Say it out loud.", "+15555550100"), "[Setup note, not from them] Say it out loud.\n\nTexts to them go to +15555550100.");
  assert.equal(callNote("Say it out loud."), "[Setup note, not from them] Say it out loud.");
  assert.equal(callNote("  ", "+15555550100"), null);
});

test("test sessions: shared-memory saves are logged, never written; profile_save is left to uno-family-memory", async () => {
  const { testSave } = await import("../plugins/uno-imsg-proxy/rules.js");
  const t = testSave("shared_memory_save", {}, "agent:uno-lab:test:eval-a-1");
  assert.match(t.log, /test shared_memory_save session=agent:uno-lab:test:eval-a-1$/);
  assert.equal(t.result.block, true);
  assert.equal(testSave("profile_save", { content: "x" }, "agent:main:test:eval-b"), null);
  assert.equal(testSave("shared_memory_save", {}, "agent:main:imessage:direct:me"), null);
  assert.equal(testSave("write", {}, "agent:main:test:eval-b"), null);
});

test("builder: only the admin's agent, on the owner's own message, with the owner's 👍 on the task", async () => {
  const { builderSpawnDecision, builderTask } = await import("../plugins/uno-guard/rules.js");
  const admin = { agentId: "main", adminAgentId: "main", fromOwner: true, builderBinary: "agentcli" };
  const run = (command, who = admin, tool = "exec") => builderSpawnDecision(tool, { command }, who);
  const start = `~/.openclaw/uno-data/watchdog/builder.sh wrong-link "Fix the wrong link; run the evals before and after."`;
  assert.deepEqual(builderTask(start), { name: "wrong-link", task: "Fix the wrong link; run the evals before and after." });
  assert.match(run(start).ask.description, /wrong link; run the evals/);
  assert.match(run(start, admin, "process").ask.title, /builder/);
  assert.match(run(start, { ...admin, agentId: "uno-agent-sam" }).block, /owner's own chat/);
  assert.match(run(start, { ...admin, fromOwner: false }).block, /owner's own message/);
  assert.match(run("~/.openclaw/uno-data/watchdog/builder.sh wrong-link").block, /whole task/);
  assert.match(run("agentcli -p 'do it'").block, /builder script/); // the agent's own command, any other way
  assert.match(run("/Users/x/.local/bin/agentcli -p hi").block, /builder script/);
  assert.equal(run("ls -la; echo agentclient"), null);
  assert.equal(run("npm test"), null);
  assert.equal(run("ls -l ~/.openclaw/uno-data/builder/x.out ~/.openclaw/uno-data/watchdog/builder.sh; tail -n 12 ~/.openclaw/uno-data/builder/x.out"), null); // looking isn't starting
  assert.equal(run("~/.openclaw/uno-data/watchdog/builder.sh done wrong-link"), null); // cleanup needs no 👍
  assert.match(run(`cd ~ && ~/.openclaw/uno-data/watchdog/builder.sh wrong-link "Fix it."`).ask.description, /Fix it/);
  // An ACP spawn of a coding agent takes the same path.
  const acp = builderSpawnDecision("sessions_spawn", { runtime: "acp", task: "Fix it." }, admin);
  assert.match(acp.ask.description, /Fix it/);
  assert.equal(builderSpawnDecision("sessions_spawn", { task: "x" }, admin), null); // a native sub-agent isn't the builder
});

test("a text sent from outside a chat's own conversation becomes a note for that chat", async () => {
  const { outsideSendNote, isDirectChat, sentFrom } = await import("../plugins/uno-imsg-proxy/rules.js");
  const chat = "agent:main:imessage:direct:me";
  assert.ok(isDirectChat(chat));
  assert.ok(!isDirectChat("agent:main:test:eval-a-1:direct:x"));
  assert.ok(!isDirectChat("agent:uno-agent-family:imessage:group:2"));
  const cron = outsideSendNote({ fromSession: "agent:main:cron:abc:run:def", chatSession: chat, content: "I'd pick the clover killer.", at: "Oct 2, 4:36 PM" });
  assert.match(cron, /^\[Setup note, not from them\] At Oct 2, 4:36 PM you texted them this from a scheduled job/);
  assert.match(cron, /«I'd pick the clover killer\.»$/);
  assert.equal(sentFrom("agent:main:facetime:333d"), "a call");
  assert.equal(outsideSendNote({ fromSession: chat, chatSession: chat, content: "hi", at: "now" }), null); // its own reply
  assert.equal(outsideSendNote({ fromSession: undefined, chatSession: chat, content: "hi", at: "now" }), null); // unknown sender: can't tell
  assert.equal(outsideSendNote({ fromSession: "agent:main:test:eval-x-1", chatSession: chat, content: "hi", at: "now" }), null);
  assert.equal(outsideSendNote({ fromSession: "agent:main:cron:a", chatSession: undefined, content: "hi", at: "now" }), null);
  assert.ok(outsideSendNote({ fromSession: "agent:main:cron:a", chatSession: chat, content: "x".repeat(2000), at: "now" }).endsWith("…»"));
});

test("scheduling outside the owner's chat: the group chat only, one-time, back to itself", async () => {
  const { chatJobDecision } = await import("../plugins/uno-guard/rules.js");
  const who = { agentId: "uno-agent-family", adminAgentId: "main", schedulingAgents: ["uno-agent-family"] };
  const add = (job) => chatJobDecision("automations", { action: "add", job }, who);
  const once = { schedule: { kind: "at", at: "2026-10-04T18:00:00-04:00" }, payload: { kind: "agentTurn", message: "Reply with exactly this: water the lawn" } };
  const ok = add(once);
  assert.equal(ok.params.job.sessionTarget, "current");
  assert.equal(ok.params.job.deleteAfterRun, true);
  assert.equal(add({ ...once, sessionTarget: "current", delivery: { mode: "announce" } }).params.job.sessionTarget, "current");
  assert.match(add({ ...once, schedule: { kind: "cron", expr: "0 9 * * *" } }).blockReason, /nothing recurring/);
  assert.match(add({ ...once, sessionTarget: "isolated" }).blockReason, /this conversation/);
  assert.match(add({ ...once, delivery: { channel: "imessage", to: "+15555550100" } }).blockReason, /report back to this chat/);
  assert.match(add({ ...once, payload: { kind: "command", argv: ["ls"] } }).blockReason, /no commands/);
  assert.equal(chatJobDecision("automations", { action: "list" }, who), null);
  assert.match(chatJobDecision("automations", { action: "update" }, who).blockReason, /nothing else/);
  assert.match(chatJobDecision("automations", { action: "add", job: once }, { ...who, agentId: "uno-agent-juliet" }).blockReason, /isn't available/);
  assert.equal(chatJobDecision("automations", { action: "add", job: { schedule: { kind: "cron" } } }, { ...who, agentId: "main" }), null); // the owner's chat is unchanged
});

test("test sessions change nothing real: reminders, events, notes, music and the record files", async () => {
  const { testSideEffect } = await import("../plugins/uno-imsg-proxy/rules.js");
  const k = "agent:uno-agent-family:test:eval-a-1";
  assert.match(testSideEffect("apple_pim_reminder", { action: "create", title: "Water the lawn" }, k).log, /test write apple_pim_reminder\.create session=/);
  assert.equal(testSideEffect("apple_pim_reminder", { action: "create" }, k).result.blockReason, "Done.");
  assert.ok(testSideEffect("apple_pim_calendar", { action: "create" }, k));
  assert.ok(testSideEffect("apple_notes", { action: "append" }, k));
  assert.ok(testSideEffect("apple_music", { action: "play_song" }, k));
  assert.ok(testSideEffect("write", { path: "/Users/x/.openclaw/workspace/TASKS.md" }, k));
  assert.match(testSideEffect("edit", { path: "memory/2026-10-03.md" }, k).log, / file=daily session=/);
  assert.match(testSideEffect("write", { path: "/Users/x/.openclaw/workspace/MEMORY.md" }, k).log, / file=memory-md session=/);
  assert.ok(testSideEffect("apply_patch", { input: "*** Begin Patch\n*** Update File: MEMORY.md\n@@\n" }, k));
  for (const [t, p] of [["apple_pim_reminder", { action: "lists" }], ["apple_pim_calendar", { action: "events" }], ["apple_notes", { action: "read" }], ["apple_files", { action: "save" }], ["write", { path: "/tmp/page.html" }], ["read", { path: "TASKS.md" }]]) assert.equal(testSideEffect(t, p, k), null, t);
  assert.match(testSideEffect("browser", { action: "act", kind: "click", ref: "e12" }, k).result.blockReason, /by their URL/); // a real cart is real data
  for (const p of [{ action: "navigate", targetUrl: "https://www.amazon.com/gp/buyagain" }, { action: "snapshot" }, { action: "act", kind: "evaluate" }]) assert.equal(testSideEffect("browser", p, k), null, p.action);
  assert.equal(testSideEffect("browser", { action: "act", kind: "click" }, "agent:main:imessage:direct:me"), null);
  assert.equal(testSideEffect("apple_pim_reminder", { action: "create" }, "agent:main:imessage:direct:me"), null); // real chats act for real
});
