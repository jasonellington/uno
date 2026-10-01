// Healthchecks.io pings, outside iMessage (docs/architecture.md). Run every 5
// minutes by an OpenClaw command job (uno-healthping), from a copy in
// ~/.openclaw/uno-data/watchdog. If the gateway is down the pings stop, which is
// what makes Healthchecks email.
//   HC_UP_URL      gateway up + iMessage channel healthy + Private API bridge
//                  ready (down on two runs in a row, ~5-10 min, so the
//                  bridge LaunchAgent's relaunch has time) -> ping, else /fail
//   HC_ERRORS_URL  ERROR/FATAL lines in the gateway log since the last run
//                  -> /fail with counts per subsystem, else ping
//   HC_UNKNOWN_URL anyone not in OpenClaw's iMessage allowlist texted Uno, or a message in an
//                  unapproved group -> /fail with a masked handle, at most
//                  once per sender per hour, else ping (unknown-senders.js)
// URLs live in ~/.openclaw/uno-data/healthchecks.env (0600, never in git).
// Until that file exists this does nothing. Pings never include log lines,
// because the log contains message text.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runUnknownSenders, IMSG, OPENCLAW } from "./unknown-senders.js";

// The scheduler's environment may lack Homebrew; openclaw needs node on PATH.
process.env.PATH = `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`;

const DIR = join(homedir(), ".openclaw/uno-data");
const ENV = join(DIR, "healthchecks.env");
const STATE = join(DIR, "healthping.state.json");

export function parseEnv(text) {
  return Object.fromEntries(text.split("\n").map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(\S+)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

export function upStatus(health) {
  if (!health?.ok) return "gateway health not ok";
  const im = health.channels?.imessage;
  if (!im?.enabled) return "imessage channel disabled";
  if (im.running === false || im.connected === false || im.lastError) return `imessage: ${im.lastError ? "error" : "not running"}`;
  return null;
}

// Counts ERROR/FATAL lines per subsystem. Never returns message content.
export function countErrors(logText) {
  const counts = {};
  for (const line of logText.split("\n")) {
    if (!/"logLevelName":"(ERROR|FATAL)"/.test(line)) continue;
    const sub = line.match(/\\"subsystem\\":\\"([\w/.-]+)\\"/)?.[1] ?? "unknown";
    counts[sub] = (counts[sub] ?? 0) + 1;
  }
  return counts;
}

// Cron runs or deliveries that failed since the last check (cron failure
// alerts to iMessage are off, so this is where a missed reminder shows up).
// Counts only: job names can carry reminder text.
export function cronFailures(jobs, sinceMs) {
  const counts = {};
  for (const job of jobs ?? []) {
    const st = job.state ?? job;
    if (!(st.lastRunAtMs > sinceMs)) continue;
    if (st.lastRunStatus && !["ok", "skipped"].includes(st.lastRunStatus)) counts["cron-run"] = (counts["cron-run"] ?? 0) + 1;
    if (/fail|error/i.test(st.lastDeliveryStatus ?? "")) counts["cron-delivery"] = (counts["cron-delivery"] ?? 0) + 1;
  }
  return counts;
}

// Returns "<status> <body>" (e.g. "200 OK") or the error name; never the URL.
// Bridge problem only after two consecutive not-ready checks.
export function bridgeStatus(ready, previousMisses) {
  const misses = ready ? 0 : previousMisses + 1;
  return { misses, problem: misses >= 2 ? "imessage private api bridge down" : null };
}

function bridgeReady() {
  try {
    return /"v2_ready":true/.test(execFileSync(IMSG, ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }));
  } catch {
    return false;
  }
}

async function ping(url, suffix = "", body = "") {
  try {
    const res = await fetch(url + suffix, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    return `${res.status} ${(await res.text()).trim().slice(0, 40)}`;
  } catch (err) {
    return err.name;
  }
}
const LAST = join(DIR, "healthping.last.json");

async function main() {
  if (!existsSync(ENV)) return;
  const env = parseEnv(readFileSync(ENV, "utf8"));
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const last = {};

  if (env.HC_UP_URL) {
    let problem;
    try {
      problem = upStatus(JSON.parse(execFileSync(OPENCLAW, ["health", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 })));
    } catch {
      problem = "gateway unreachable";
    }
    const prev = existsSync(LAST) ? JSON.parse(readFileSync(LAST, "utf8")) : {};
    const bridge = bridgeStatus(bridgeReady(), prev.bridgeMisses ?? 0);
    last.bridgeMisses = bridge.misses;
    problem ??= bridge.problem;
    last.up = { at: new Date().toISOString(), sent: problem ? `fail: ${problem}` : "ok", result: await ping(env.HC_UP_URL, problem ? "/fail" : "", problem ?? "ok") };
  }

  if (env.HC_ERRORS_URL) {
    const log = `/tmp/openclaw/openclaw-${new Date().toLocaleDateString("en-CA")}.log`;
    const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
    let text = "";
    if (existsSync(log)) {
      const size = statSync(log).size;
      const from = state.log === log && state.offset <= size ? state.offset : 0;
      const buf = Buffer.alloc(size - from);
      const fd = openSync(log, "r"); readSync(fd, buf, 0, buf.length, from); closeSync(fd);
      text = buf.toString("utf8");
      writeFileSync(STATE, JSON.stringify({ ...state, log, offset: size }), { mode: 0o600 });
    }
    const counts = countErrors(text);
    const now = Date.now();
    try {
      const listed = JSON.parse(execFileSync(OPENCLAW, ["cron", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }));
      Object.assign(counts, cronFailures(Array.isArray(listed) ? listed : listed.jobs, state.cronSince ?? now - 5 * 60_000));
    } catch { counts["cron-list"] = 1; }
    const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
    writeFileSync(STATE, JSON.stringify({ ...saved, cronSince: now }), { mode: 0o600 });
    const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("\n");
    last.errors = { at: new Date().toISOString(), sent: summary ? `fail: ${Object.keys(counts).length} subsystem(s)` : "ok", result: await ping(env.HC_ERRORS_URL, summary ? "/fail" : "", summary || "no errors") };
  }
  // Always runs (the local log works without a URL), isolated from the
  // other checks. On error, /fail with the error name only.
  try {
    last.unknown = await runUnknownSenders({ url: env.HC_UNKNOWN_URL, ping });
  } catch (err) {
    last.unknown = { at: new Date().toISOString(), error: `${err.name}: ${String(err.message).split("\n")[0].slice(0, 160)}`, result: env.HC_UNKNOWN_URL ? await ping(env.HC_UNKNOWN_URL, "/fail", `unknown-sender watcher failed: ${err.name}`) : "no url" };
  }
  writeFileSync(LAST, JSON.stringify(last, null, 2), { mode: 0o600 });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
