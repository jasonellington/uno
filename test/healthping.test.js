import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv, upStatus, countErrors, bridgeStatus } from "../watchdog/healthping.js";

test("env file parsing", () => {
  assert.deepEqual(parseEnv("HC_UP_URL=https://hc-ping.com/a\n# x\nHC_ERRORS_URL = https://hc-ping.com/b\n"),
    { HC_UP_URL: "https://hc-ping.com/a", HC_ERRORS_URL: "https://hc-ping.com/b" });
});

test("up means gateway ok and iMessage running and connected", () => {
  const im = { enabled: true, running: true, connected: true, lastError: null };
  assert.equal(upStatus({ ok: true, channels: { imessage: im } }), null);
  assert.ok(upStatus({ ok: false }));
  assert.ok(upStatus({ ok: true, channels: { imessage: { ...im, connected: false } } }));
  assert.ok(upStatus({ ok: true, channels: { imessage: { ...im, lastError: "x" } } }));
});

test("error pings carry counts per subsystem, never message text", () => {
  const log = [
    '{"0":"{\\"subsystem\\":\\"agents/harness\\"}","1":"secret message text","_meta":{"logLevelName":"ERROR"}}',
    '{"0":"Hey.","_meta":{"logLevelName":"INFO"}}',
    '{"0":"{\\"subsystem\\":\\"agents/harness\\"}","_meta":{"logLevelName":"FATAL"}}',
  ].join("\n");
  const counts = countErrors(log);
  assert.deepEqual(counts, { "agents/harness": 2 });
  assert.ok(!JSON.stringify(counts).includes("secret"));
});

test("the bridge counts as down only after two misses in a row", () => {
  assert.deepEqual(bridgeStatus(true, 3), { misses: 0, problem: null });
  assert.deepEqual(bridgeStatus(false, 0), { misses: 1, problem: null });
  assert.equal(bridgeStatus(false, 1).problem, "imessage private api bridge down");
});

test("cron failures since the last check are counted, never named", async () => {
  const { cronFailures } = await import("../watchdog/healthping.js");
  const jobs = [
    { name: "call-dentist", state: { lastRunAtMs: 2000, lastRunStatus: "error", lastDeliveryStatus: "not-requested" } },
    { name: "reminder", state: { lastRunAtMs: 3000, lastRunStatus: "ok", lastDeliveryStatus: "failed" } },
    { name: "old", state: { lastRunAtMs: 500, lastRunStatus: "error" } },
    { name: "fine", state: { lastRunAtMs: 4000, lastRunStatus: "ok", lastDeliveryStatus: "delivered" } },
    { name: "never-ran", state: {} },
  ];
  assert.deepEqual(cronFailures(jobs, 1000), { "cron-run": 1, "cron-delivery": 1 });
  assert.ok(!JSON.stringify(cronFailures(jobs, 1000)).includes("dentist"));
});

test("the weekly skill review's known runtime error isn't counted; other review errors are", async () => {
  const { cronFailures } = await import("../watchdog/healthping.js");
  const since = 1000;
  const review = (lastError) => ({ name: "skill-collection-review-main", state: { lastRunAtMs: 2000, lastRunStatus: "error", lastError } });
  assert.deepEqual(cronFailures([review("collection review requires a runtime that enforces the Workshop root through OpenClaw tools")], since), {});
  assert.deepEqual(cronFailures([review("model timed out")], since), { "cron-run": 1 });
  assert.deepEqual(cronFailures([{ name: "remind me", state: { lastRunAtMs: 2000, lastRunStatus: "error", lastError: "requires a runtime that enforces the Workshop root" } }], since), { "cron-run": 1 });
});
