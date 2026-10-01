import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrailingError, conversationKeys, TRAILING_ERROR_WINDOW_MS } from "../plugins/uno-imsg-proxy/rules.js";
import guard from "../plugins/uno-imsg-proxy/index.js";

test("an error within a minute of a delivered reply is trailing; older or none isn't", () => {
  const now = 1_000_000;
  assert.equal(isTrailingError(now - 5_000, now), true);
  assert.equal(isTrailingError(now - TRAILING_ERROR_WINDOW_MS, now), true);
  assert.equal(isTrailingError(now - TRAILING_ERROR_WINDOW_MS - 1, now), false);
  assert.equal(isTrailingError(-Infinity, now), false);
  assert.equal(isTrailingError(undefined, now), false);
});

test("conversation keys keep session keys, normalize handles, drop empties", () => {
  assert.deepEqual(conversationKeys("agent:main:imessage:direct:me", "imessage:+15550001111", "", null, "chat_id:1"),
    ["agent:main:imessage:direct:me", "+15550001111", "chat_id:1"]);
});

// Fake OpenClaw plugin API: captures the hooks uno-imsg-proxy registers.
// imsgPath points at /usr/bin/true so the typing pause never reaches Messages.
function loadGuard(pluginConfig = { adminAgentId: "main" }) {
  const hooks = {}, logs = [];
  guard.register({ pluginConfig: { imsgPath: "/usr/bin/true" }, config: { plugins: { entries: { "uno-guard": { config: pluginConfig } } } }, on: (name, fn) => { hooks[name] = fn; }, logger: { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) } });
  return { hooks, logs };
}
const ctx = { sessionKey: "agent:main:imessage:direct:me", conversationId: "chat_id:1", channelId: "imessage" };
const ERR = { text: "⚠️ Something went wrong while processing your request.", isError: true };

test("a trailing error after a delivered reply is dropped and logged at ERROR", async () => {
  const { hooks, logs } = loadGuard();
  assert.equal(await hooks.message_sending({ to: "chat_id:1", content: "Saved hello.txt in the shared files folder." }, ctx), undefined);
  const r = hooks.reply_payload_sending({ payload: ERR, sessionKey: ctx.sessionKey }, ctx);
  assert.equal(r.cancel, true);
  assert.ok(logs.some((l) => l.startsWith("ERROR") && l.includes("dropped trailing error")));
});

test("an error with nothing delivered before it is still replaced with the plain line", () => {
  const { hooks, logs } = loadGuard();
  const r = hooks.reply_payload_sending({ payload: ERR, sessionKey: "agent:main:imessage:direct:other" }, { ...ctx, sessionKey: "agent:main:imessage:direct:other", conversationId: "chat_id:9" });
  assert.match(r.payload.text, /having issues/);
  assert.ok(logs.some((l) => l.startsWith("ERROR") && l.includes("replaced error text")));
});

test("the same drop applies on the message-send path", async () => {
  const { hooks } = loadGuard();
  hooks.reply_payload_sending({ payload: { text: "Dinner is on the calendar for Sunday at 7." }, sessionKey: ctx.sessionKey }, ctx);
  const r = await hooks.message_sending({ to: "chat_id:1", content: "⚠️ Agent failed before reply." }, ctx);
  assert.equal(r.cancel, true);
});

test("without adminAgentId nobody is admin: the plain line, with the owner's name if set", () => {
  const other = { ...ctx, sessionKey: "agent:main:imessage:direct:solo", conversationId: "chat_id:8" };
  for (const [config, who] of [[{}, "the owner"], [{ ownerName: "Alex" }, "Alex"], [{ adminAgentId: "  " }, "the owner"]]) {
    const { hooks } = loadGuard(config);
    const r = hooks.reply_payload_sending({ payload: ERR, sessionKey: other.sessionKey }, other);
    assert.equal(r.payload.text, `I'm having trouble right now. Please let ${who} know if this keeps happening.`);
  }
});
