// Uno evals: real model turns through the gateway, graded by rules.
// Each case sends its messages to a fresh test session on each agent
// (nothing is delivered; a case with "call": true gets a call session,
// agent:<id>:test:call:…) and grades the last reply as the phone would see
// it: texts and links after uno-imsg-proxy's bubble split, length, patterns
// it must not have, and the tapback (a react in a test session is logged by
// uno-imsg-proxy with its session key). Cases live in test/evals/*.json.
// Usage: node test/evals/run.mjs [suite ...] [--agents a,b] [--runs N] [--only id,id] [--jobs N]
// Results: printed, and saved to ~/.openclaw/uno-data/persona-results/.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitBubbles, linkBubbles, tapbackFor, leadingReaction } from "../../plugins/uno-imsg-proxy/rules.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : fallback; };
const agents = option("--agents", "main").split(",").filter(Boolean);
const runs = Math.max(1, Number(option("--runs", 1)) || 1);
const only = option("--only", "").split(",").filter(Boolean);
const jobsAtOnce = Math.max(1, Number(option("--jobs", 6)) || 6);
const suites = (args.length ? args : readdirSync(here).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)))
  .map((name) => ({ name, ...JSON.parse(readFileSync(join(here, `${name}.json`), "utf8")) }));

const EMOJI = /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/gu;
const LINK = /^\s*https?:\/\/\S+\s*$/;
const strip = (e) => e.replace(/️/g, "");
const inSet = (emoji, set) => [...set.matchAll(EMOJI)].some(([s]) => strip(s) === strip(emoji));
const within = (n, range) => !range || (n >= range[0] && n <= range[1]);
const logFile = (d) => `/tmp/openclaw/openclaw-${d.toLocaleDateString("en-CA")}.log`;

// One job: a case's messages in a fresh test session on one agent.
const started = new Date();
const stamp = started.toISOString().replace(/\D/g, "").slice(0, 14);
const jobs = [];
for (const suite of suites) for (const c of suite.cases) {
  if (only.length && !only.includes(c.id)) continue;
  const spec = { ...suite.defaults, ...c };
  for (const agent of agents) for (let n = 1; n <= runs; n++) {
    jobs.push({ suite: suite.name, id: c.id, spec, agent, n, key: `agent:${agent}:test:${spec.call ? "call:" : ""}eval-${c.id}-${stamp}-${n}` });
  }
}
const turn = async (job) => {
  let out = null;
  for (const message of job.spec.send) {
    // Call cases run like a FaceTime consult: a call session at the lowest
    // thinking level (the consult asks for off, which the CLI refuses for gpt-6-sol).
    const args = ["agent", "--agent", job.agent, "--session-key", job.key, "--message", message, "--json", ...(job.spec.call ? ["--thinking", "low"] : [])];
    const { stdout } = await exec("openclaw", args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 << 20 });
    out = JSON.parse(stdout.slice(stdout.indexOf("{")));
  }
  job.reply = (out?.result?.payloads ?? []).map((p) => p?.text ?? "").filter(Boolean).join("\n\n").trim();
  job.seconds = Math.round((out?.result?.meta?.durationMs ?? 0) / 1000);
};
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobsAtOnce, jobs.length) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    try { await turn(job); } catch (error) { job.error = String(error?.message ?? error).split("\n")[0]; }
  }
}));

// Reactions from the gateway log, by session key.
const reacts = new Map();
for (const file of new Set([logFile(started), logFile(new Date())])) {
  if (!existsSync(file)) continue;
  for (const m of readFileSync(file, "utf8").matchAll(/uno-imsg-proxy: test react (\S+) session=([^"\\\s]+)/g)) {
    reacts.set(m[2], [...(reacts.get(m[2]) ?? []), m[1]]);
  }
}

// Grading.
for (const job of jobs) {
  const s = job.spec, why = [];
  if (job.error) { job.pass = false; job.why = [`error: ${job.error}`]; continue; }
  const reply = job.reply;
  const bubbles = reply ? linkBubbles(splitBubbles(reply)) : [];
  job.links = bubbles.filter((b) => LINK.test(b)).length;
  job.texts = bubbles.length - job.links;
  job.chars = reply.length;
  const reacted = reacts.get(job.key) ?? [];
  job.tap = reacted[0] ?? (tapbackFor(reply) ? reply : leadingReaction(reply) ? reply.match(EMOJI)?.[0] : null) ?? null;
  const words = reply.replace(EMOJI, "").replace(/\s+/g, " ").trim();
  if (!words) job.texts = 0; // an emoji-only reply goes out as the tapback, not a text
  job.shape = (job.tap ? "tap" : "") + (words ? (job.tap ? "+words" : "words") : "") || "nothing";
  if (!within(job.texts, s.texts)) why.push(`texts ${job.texts}, want ${s.texts.join("-")}`);
  if (!within(job.links, s.links)) why.push(`links ${job.links}, want ${s.links.join("-")}`);
  if (!within(job.chars, s.chars)) why.push(`chars ${job.chars}, want ${s.chars.join("-")}`);
  if (s.shape && s.shape !== "any" && job.shape !== s.shape) why.push(`shape ${job.shape}, want ${s.shape}`);
  if (s.react && !(job.tap && inSet(job.tap, s.react))) why.push(`tapback ${job.tap ?? "none"}, want one of ${s.react}`);
  if (s.avoid) for (const e of [job.tap, ...(reply.match(EMOJI) ?? [])].filter(Boolean)) if (inSet(e, s.avoid)) { why.push(`used ${e}`); break; }
  for (const p of s.not ?? []) if (new RegExp(p, "imu").test(reply)) why.push(`matched /${p}/`);
  job.pass = !why.length;
  job.why = why;
}

// Report.
const short = (t) => t.replace(/\s+/g, " ").slice(0, 300);
for (const suite of suites) {
  const mine = jobs.filter((j) => j.suite === suite.name);
  if (!mine.length) continue;
  console.log(`\n${suite.name}: ${suite.about ?? ""}`);
  for (const c of suite.cases) for (const agent of agents) {
    const rs = mine.filter((j) => j.id === c.id && j.agent === agent);
    if (!rs.length) continue;
    const ok = rs.filter((j) => j.pass).length;
    const got = rs.map((j) => j.error ? "error" : `${j.texts}+${j.links} ${j.chars}c${j.tap ? ` ${j.tap}` : ""}`).join(" | ");
    console.log(`${ok === rs.length ? "PASS" : "FAIL"} ${ok}/${rs.length}  ${agent.padEnd(18)} ${c.id.padEnd(18)} ${got}`);
    for (const j of rs.filter((j) => !j.pass)) console.log(`      run ${j.n}: ${j.why.join("; ")}${j.reply ? ` | ${short(j.reply)}` : ""}`);
  }
}
const passed = jobs.filter((j) => j.pass).length;
console.log(`\nscore: ${passed}/${jobs.length} runs passed (${Math.round((100 * passed) / Math.max(1, jobs.length))}%) | agents ${agents.join(", ")} | ${runs} run${runs > 1 ? "s" : ""} per case`);
const dir = join(homedir(), ".openclaw/uno-data/persona-results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `eval-${stamp}.json`);
writeFileSync(file, JSON.stringify({ started, agents, runs, suites: suites.map((s) => s.name), passed, total: jobs.length, jobs: jobs.map(({ spec, ...j }) => j) }, null, 1));
console.log(`saved: ${file}`);
process.exitCode = passed === jobs.length ? 0 : 1;
