import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHandle, maskHandle, senderKind, scan, alertBody, runUnknownSenders, accessFrom, configGet, readAccess } from "../watchdog/unknown-senders.js";

const OWNER = "+14155550100";
const STRANGER = "+12125551234";
// OpenClaw's iMessage settings as `openclaw config get` returns them.
const ACCESS = { allowFrom: [OWNER, "Owner@Example.com"], groups: { "chat_id:7": {} }, groupPolicy: "allowlist" };
const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-09-26T12:00:00Z");

// A simulated chat.db, served the way `imsg chats/history --json` returns it.
function fakeImsg(db) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "chats") return db.chats;
    const id = Number(args[args.indexOf("--chat-id") + 1]);
    const rows = db.messages.filter((m) => m.chat_id === id).sort((a, b) => b.id - a.id);
    return args.includes("--start") ? rows : rows.slice(0, 1);
  };
  return { run, calls };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "unknown-senders-"));
  const db = {
    chats: [
      { id: 1, service: "iMessage", is_group: false, participants: [OWNER], last_message_at: new Date(T0).toISOString() },
      { id: 2, service: "iMessage", is_group: false, participants: [STRANGER], last_message_at: new Date(T0).toISOString() },
      { id: 7, service: "iMessage", is_group: true, participants: [OWNER, STRANGER], last_message_at: new Date(T0).toISOString() },
      { id: 8, service: "iMessage", is_group: true, participants: [OWNER, "friend@example.com"], last_message_at: new Date(T0).toISOString() },
    ],
    messages: [{ id: 10, chat_id: 1, is_from_me: false, sender: OWNER, text: "old", created_at: new Date(T0 - HOUR).toISOString() }],
  };
  const pings = [];
  const opts = (now, pingResult = "200 OK") => ({
    url: "https://hc.example/x", now, run: fakeImsg(db).run,
    ping: async (url, suffix, body) => { pings.push({ suffix, body }); return pingResult; },
    access: () => ACCESS, statePath: join(dir, "state.json"), logPath: join(dir, "log.jsonl"),
  });
  const add = (m) => db.messages.push({ is_group: [7, 8].includes(m.chat_id), created_at: new Date(T0).toISOString(), text: "hello there", ...m });
  const log = () => existsSync(join(dir, "log.jsonl")) ? readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { dir, db, pings, opts, add, log };
}

test("handles from chat.db and allowFrom normalize the same way", () => {
  assert.equal(canonicalHandle("imessage:+14155550100"), "+14155550100");
  assert.equal(canonicalHandle("+14155550100"), "+14155550100");
  assert.equal(canonicalHandle("(415) 555-0100"), "+14155550100");
  assert.equal(canonicalHandle("Owner@Example.com"), "owner@example.com");
  assert.equal(canonicalHandle("tel:+14155550100"), "+14155550100");
  assert.equal(canonicalHandle("262966"), "262966");
  assert.equal(senderKind("262966"), "shortcode");
  assert.equal(senderKind(STRANGER), "person");
});

test("masking keeps only the last four digits or the first letter", () => {
  assert.equal(maskHandle("+12125551234"), "+1•••1234");
  assert.equal(maskHandle("jane.doe@example.com"), "j•••@example.com");
  assert.equal(maskHandle("262966"), "•••2966");
});

test("first run sets the watermark from history and alerts on nothing", async () => {
  const s = setup();
  s.add({ id: 11, chat_id: 2, is_from_me: false, sender: STRANGER });
  const r = await runUnknownSenders(s.opts(T0));
  assert.equal(r.alerts, 0);
  assert.deepEqual(s.log(), []);
  assert.equal(JSON.parse(readFileSync(join(s.dir, "state.json"), "utf8")).watermark, 11);
  assert.deepEqual(s.pings.map((p) => p.suffix), [""]);
});

test("simulated unknown DM: logged without text, one masked /fail ping", async () => {
  const s = setup();
  await runUnknownSenders(s.opts(T0));
  s.add({ id: 20, chat_id: 2, is_from_me: false, sender: STRANGER, text: "secret words here" });
  const r = await runUnknownSenders(s.opts(T0 + 5 * 60_000));
  assert.equal(r.alerts, 1);
  const [e] = s.log();
  assert.equal(e.handle, STRANGER);
  assert.equal(e.chat, "dm");
  assert.equal(e.service, "iMessage");
  assert.equal(e.length, 17);
  assert.equal(e.alerted, true);
  assert.ok(!JSON.stringify(e).includes("secret"));
  const ping = s.pings.at(-1);
  assert.equal(ping.suffix, "/fail");
  assert.match(ping.body, /\+1•••1234, DM, iMessage/);
  assert.ok(!ping.body.includes(STRANGER) && !ping.body.includes("secret"));
  assert.equal(statSync(join(s.dir, "log.jsonl")).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.dir, "state.json")).mode & 0o777, 0o600);
});

test("own sends and known senders in DMs and approved groups are ignored; the next quiet run re-arms", async () => {
  const s = setup();
  await runUnknownSenders(s.opts(T0));
  s.add({ id: 21, chat_id: 1, is_from_me: false, sender: OWNER });
  s.add({ id: 22, chat_id: 2, is_from_me: true, sender: STRANGER });
  s.add({ id: 23, chat_id: 7, is_from_me: false, sender: OWNER });
  s.add({ id: 24, chat_id: 1, is_from_me: false, sender: "OWNER@example.com" });
  const r = await runUnknownSenders(s.opts(T0 + 5 * 60_000));
  assert.equal(r.events, 0);
  assert.deepEqual(s.pings.map((p) => p.suffix), ["", ""]);
});

test("groups: unknown member in an approved group, and anyone in an unapproved group", async () => {
  const s = setup();
  await runUnknownSenders(s.opts(T0));
  s.add({ id: 30, chat_id: 7, is_from_me: false, sender: STRANGER, participants: [OWNER, STRANGER] });
  s.add({ id: 31, chat_id: 8, is_from_me: false, sender: OWNER, participants: [OWNER, "friend@example.com"] });
  await runUnknownSenders(s.opts(T0 + 5 * 60_000));
  const [a, b] = s.log();
  assert.deepEqual([a.reason, a.chat, a.participants], ["unknown-sender", "group", [OWNER, STRANGER]]);
  assert.deepEqual([b.reason, b.chat_id], ["unapproved-group", 8]);
  assert.match(s.pings.at(-1).body, /group 8 \(not approved\), 2 people/);
});

test("a flood alerts once per sender per hour but logs everything", async () => {
  const s = setup();
  await runUnknownSenders(s.opts(T0));
  for (let i = 0; i < 5; i++) s.add({ id: 40 + i, chat_id: 2, is_from_me: false, sender: STRANGER });
  await runUnknownSenders(s.opts(T0 + 5 * 60_000));
  s.add({ id: 50, chat_id: 2, is_from_me: false, sender: STRANGER });
  await runUnknownSenders(s.opts(T0 + 30 * 60_000));
  s.add({ id: 51, chat_id: 2, is_from_me: false, sender: STRANGER });
  await runUnknownSenders(s.opts(T0 + 66 * 60_000));
  assert.equal(s.log().length, 7);
  assert.deepEqual(s.log().map((e) => e.alerted), [true, false, false, false, false, false, true]);
  assert.deepEqual(s.pings.map((p) => p.suffix), ["", "/fail", "", "/fail"]);
});

test("a failed /fail ping is retried on the next run", async () => {
  const s = setup();
  await runUnknownSenders(s.opts(T0));
  s.add({ id: 60, chat_id: 2, is_from_me: false, sender: STRANGER });
  await runUnknownSenders(s.opts(T0 + 5 * 60_000, "TimeoutError"));
  await runUnknownSenders(s.opts(T0 + 10 * 60_000));
  assert.deepEqual(s.pings.map((p) => p.suffix), ["", "/fail", "/fail"]);
  assert.match(s.pings.at(-1).body, /\+1•••1234/);
  await runUnknownSenders(s.opts(T0 + 15 * 60_000));
  assert.equal(s.pings.at(-1).suffix, "");
});

test("without HC_UNKNOWN_URL it still logs and never pings", async () => {
  const s = setup();
  await runUnknownSenders({ ...s.opts(T0), url: undefined });
  s.add({ id: 70, chat_id: 2, is_from_me: false, sender: STRANGER });
  const r = await runUnknownSenders({ ...s.opts(T0 + 5 * 60_000), url: undefined });
  assert.equal(s.log().length, 1);
  assert.equal(s.log()[0].alerted, false);
  assert.equal(s.pings.length, 0);
  assert.match(r.sent, /no HC_UNKNOWN_URL/);
});

test("short codes are flagged as such, not dropped", () => {
  const out = scan({
    known: new Set([OWNER]), groups: new Set(), chats: new Map(), state: { watermark: 0 }, now: T0,
    messages: [{ id: 1, chat_id: 3, is_from_me: false, sender: "262966", text: "Your code is 123456", created_at: "x", service: "SMS" }],
  });
  assert.equal(out.events[0].sender, "shortcode");
  assert.match(alertBody(out.alerts), /•••2966 \(short code\), DM, SMS/);
  assert.ok(!alertBody(out.alerts).includes("123456"));
});

test("access comes from allowFrom and groups; disabled groups approve none; * means any", () => {
  const a = accessFrom(ACCESS);
  assert.ok(a.known.has(OWNER) && a.known.has("owner@example.com") && !a.known.has(STRANGER));
  assert.ok(a.groups.has("7") && !a.groups.has("8"));
  assert.ok(!accessFrom({ ...ACCESS, groupPolicy: "disabled" }).groups.has("7"));
  assert.ok(!accessFrom({ allowFrom: undefined, groups: undefined }).known.has(OWNER));
  const any = accessFrom({ allowFrom: ["*"], groups: { "*": {} }, groupPolicy: "open" });
  assert.ok(any.known.has(STRANGER) && any.groups.has("8"));
});

test("configGet: JSON value, undefined when unset, throws on anything else", () => {
  assert.deepEqual(configGet("x", () => '["+15555550100"]'), ["+15555550100"]);
  const fail = (text) => () => { const e = new Error("exit 1"); e.stdout = text; throw e; };
  assert.equal(configGet("x", fail('{"ok":false,"error":{"message":"Config path is valid but unset: x."}}')), undefined);
  assert.throws(() => configGet("x", fail("gateway exploded")));
  const asked = [];
  readAccess((p) => { asked.push(p); return undefined; });
  assert.deepEqual(asked, ["channels.imessage.allowFrom", "channels.imessage.groupAllowFrom", "accessGroups", "channels.imessage.groups", "channels.imessage.groupPolicy"]);
});

test("accessGroup entries expand to their iMessage and * members", () => {
  const KID = "+15555550111", AUNT = "aunt@example.com";
  const accessGroups = { family: { type: "message.senders", members: { imessage: [KID], "*": [AUNT], telegram: ["123"] } } };
  const a = accessFrom({ allowFrom: [OWNER, "accessGroup:family"], accessGroups, groups: {}, groupPolicy: "allowlist" });
  assert.ok(a.known.has(KID) && a.known.has(AUNT) && a.known.has(OWNER) && !a.known.has("123"));
  assert.ok(!accessFrom({ allowFrom: ["accessGroup:missing"], accessGroups }).known.has(KID));
});

test("a family member in the approved group isn't flagged; a stranger there is", () => {
  const KID = "+15555550111";
  const accessGroups = { family: { type: "message.senders", members: { imessage: [KID] } } };
  const a = accessFrom({ allowFrom: [OWNER], groupAllowFrom: [OWNER, "accessGroup:family"], accessGroups, groups: { "chat_id:7": {} }, groupPolicy: "allowlist" });
  const msg = (id, sender, chat_id, is_group) => ({ id, chat_id, is_group, is_from_me: false, sender, text: "hi", created_at: "x", service: "iMessage" });
  const out = scan({ ...a, chats: new Map(), state: { watermark: 0 }, now: T0,
    messages: [msg(1, KID, 7, true), msg(2, STRANGER, 7, true), msg(3, KID, 9, false)] });
  assert.deepEqual(out.events.map((e) => [e.handle, e.chat, e.reason]), [
    [STRANGER, "group", "unknown-sender"],
    [KID, "dm", "unknown-sender"],
  ]);
});

test("group senders fall back to allowFrom; chat_id entries admit a whole chat", () => {
  const unset = accessFrom({ allowFrom: [OWNER], groups: {}, groupPolicy: "allowlist" });
  assert.ok(unset.groupSenders.has(OWNER) && !unset.groupSenders.has(STRANGER));
  const chat = accessFrom({ allowFrom: [OWNER], groupAllowFrom: ["chat_id:7"], groups: { "chat_id:7": {} }, groupPolicy: "allowlist" });
  const out = scan({ ...chat, chats: new Map(), state: { watermark: 0 }, now: T0,
    messages: [{ id: 1, chat_id: 7, is_group: true, is_from_me: false, sender: STRANGER, text: "hi", created_at: "x" }] });
  assert.equal(out.events.length, 0);
});
