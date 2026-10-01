import { test } from "node:test";
import assert from "node:assert/strict";
import { customEmoji, sendCustomReaction } from "../plugins/uno-imsg-proxy/rules.js";

const OWNER = "+15555550100";
const row = { is_from_me: 0, guid: "GUID-1", handle: OWNER, chat: "any;-;+15555550100" };
const react = (emoji, extra = {}) => ({ action: "react", emoji, messageId: "GUID-1", ...extra });

// Fake deps: records imsg calls; `lands` decides whether chat.db ever shows the row.
function deps({ lands = true, throws = null } = {}) {
  const calls = [], logs = [];
  return {
    calls, logs,
    imsg: "/test/imsg",
    exec: (bin, args) => { calls.push([bin, ...args]); if (throws) throw Object.assign(new Error("x"), { stderr: throws }); },
    maxRowId: () => 100,
    confirmed: (after, type, emoji, ref) => lands && after === 100 && calls.length > 0 && { type, emoji, ref },
    sleep: () => {},
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    waitMs: 400,
  };
}

test("classic kinds and their emoji stay on OpenClaw's path", () => {
  for (const e of ["👍", "👎", "❤️", "😂", "‼️", "❓", "like", "love", "emphasize"]) assert.equal(customEmoji({ emoji: e }), null, e);
});

test("other single emoji are custom, from any param name", () => {
  for (const e of ["🎉", "🔥", "💯", "👀", "🙏", "✅", "❤️‍🔥", "👍🏽"]) assert.equal(customEmoji({ emoji: e }), e);
  assert.equal(customEmoji({ reaction: "✅" }), "✅");
  assert.equal(customEmoji({ kind: " ✅ " }), "✅");
  for (const e of ["", "ok", "✅✅", "1", "done ✅"]) assert.equal(customEmoji({ emoji: e }), null, e);
});

test("a confirmed custom tapback reports done and sends exactly one imsg call", () => {
  const d = deps();
  const r = sendCustomReaction("✅", react("✅"), row, OWNER, d);
  assert.equal(r.block, true);
  assert.match(r.blockReason, /^Done: the ✅ tapback is on their message/);
  assert.deepEqual(d.calls, [["/test/imsg", "tapback", "--chat", "any;-;+15555550100", "--message", "GUID-1", "--emoji", "✅", "--part", "0"]]);
});

test("removal sends --remove and confirms a 3006 row on the right part", () => {
  const d = deps();
  let seen;
  d.confirmed = (after, type, emoji, ref) => (seen = { type, emoji, ref }) && true;
  const r = sendCustomReaction("✅", react("✅", { remove: true, partIndex: 1 }), row, OWNER, d);
  assert.match(r.blockReason, /removed from their message/);
  assert.deepEqual(d.calls[0].slice(-3), ["--part", "1", "--remove"]);
  assert.deepEqual(seen, { type: 3006, emoji: "✅", ref: "p:1/GUID-1" });
});

test("a failed send is logged, not retried, and asks for a few words instead", () => {
  const d = deps({ throws: "Dylib error: bridge request timed out" });
  const r = sendCustomReaction("🎉", react("🎉"), row, OWNER, d);
  assert.equal(d.calls.length, 1);
  assert.match(r.blockReason, /didn't go through\. Nothing was sent\. Don't retry it; send a few words instead\./);
  assert.ok(d.logs.some((l) => l.startsWith("WARN") && l.includes("timed out")));
});

test("stock imsg (no custom emoji) offers a classic tapback instead", () => {
  // The stock CLI rejects the flag; a patched CLI with a stock helper rejects the kind.
  for (const err of ["Unknown option --emoji", "Dylib error: Unknown reactionType"]) {
    const d = deps({ throws: err });
    const r = sendCustomReaction("🔥", react("🔥"), row, OWNER, d);
    assert.equal(d.calls.length, 1);
    assert.match(r.blockReason, /aren't available here, so nothing was sent\. React with one of the classic six instead \(❤️ 👍 👎 😂 ‼️ ❓\)/);
    assert.doesNotMatch(r.blockReason, /Don't retry/);
  }
});

test("a send chat.db never confirms counts as failed", () => {
  const d = deps({ lands: false });
  const r = sendCustomReaction("🔥", react("🔥"), row, OWNER, d);
  assert.match(r.blockReason, /didn't go through/);
  assert.ok(d.logs.some((l) => l.startsWith("WARN") && l.includes("not confirmed")));
});

test("never on Uno's own message or someone else's, and nothing is sent", () => {
  for (const [target, sender] of [[{ ...row, is_from_me: 1 }, OWNER], [row, "+15550000000"], [null, OWNER], [row, undefined]]) {
    const d = deps();
    const r = sendCustomReaction("✅", react("✅"), target, sender, d);
    assert.equal(d.calls.length, 0);
    assert.match(r.blockReason, /Nothing was sent/);
  }
});

test("shell-type tool calls become log entries; other tools don't", async () => {
  const { shellEntry } = await import("../plugins/uno-guard/rules.js");
  const now = new Date("2026-09-25T16:01:45Z");
  assert.deepEqual(shellEntry("bash", { command: "ls ~", workdir: "/tmp" }, now), { ts: "2026-09-25T16:01:45.000Z", tool: "bash", command: "ls ~", cwd: "/tmp" });
  assert.equal(shellEntry("exec", { cmd: "x".repeat(5000) }, now).command.length, 4000);
  assert.equal(shellEntry("message", { action: "send" }, now), null);
  assert.equal(shellEntry("web_search", { query: "q" }, now), null);
});

test("plugin settings: defaults, trimming, overrides", async () => {
  const style = await import("../plugins/uno-imsg-proxy/index.js");
  assert.deepEqual(style.settings({}), { adminAgentId: null, ownerName: null, imsg: style.IMSG, ackEmoji: "👀" });
  assert.deepEqual(style.settings({ imsgPath: "/x/imsg", ackEmoji: "👍" }, { adminAgentId: " main ", ownerName: "Alex" }), { adminAgentId: "main", ownerName: "Alex", imsg: "/x/imsg", ackEmoji: "👍" });
  const guard = await import("../plugins/uno-guard/index.js");
  const { homedir } = await import("node:os");
  assert.deepEqual(guard.settings({}), { adminAgentId: null, fallbackAgentId: null, ownerName: null, testSink: null, mailAddresses: {}, sharedSites: [], purchases: "off", purchaseLimit: 25, purchaseFreeSites: [], approvalAgents: [], familySpaces: {}, spaces: {}, sites: {}, logDir: `${homedir()}/.openclaw/uno-data` });
  assert.deepEqual(guard.settings({ adminAgentId: " main ", fallbackAgentId: "catch", testSinkHandle: "+15555550142", sharedSites: [" Example.com ", ""], purchases: "limit", purchaseLimit: 10, approvalAgents: ["g"], spaces: { a: { notes: "A" } } }),
    { adminAgentId: "main", fallbackAgentId: "catch", ownerName: null, testSink: "+15555550142", mailAddresses: {}, sharedSites: ["example.com"], purchases: "limit", purchaseLimit: 10, purchaseFreeSites: [], approvalAgents: ["g"], familySpaces: {}, spaces: { a: { notes: "A" } }, sites: {}, logDir: `${homedir()}/.openclaw/uno-data` });
});

test("a react on Uno's own message is pointed at the sender's latest message", async () => {
  const { ownMessageRedirect } = await import("../plugins/uno-imsg-proxy/rules.js");
  const own = { is_from_me: 1, guid: "UNO-REPLY", chat: "any;-;+15555550100" };
  assert.match(ownMessageRedirect("react", own, "THEIRS-1"), /one you sent.*messageId "THEIRS-1"/);
  // Theirs, missing, not a react, nothing of theirs to point at, or the same row: no redirect.
  assert.equal(ownMessageRedirect("react", { ...own, is_from_me: 0 }, "THEIRS-1"), null);
  assert.equal(ownMessageRedirect("react", null, "THEIRS-1"), null);
  assert.equal(ownMessageRedirect("reply", own, "THEIRS-1"), null);
  assert.equal(ownMessageRedirect("react", own, null), null);
  assert.equal(ownMessageRedirect("react", own, "UNO-REPLY"), null);
});
