// Uno evals: real model turns through the gateway, graded by rules.
// Each case sends its messages to a fresh test session on each agent
// (nothing is delivered; a case with "call": true gets a call session,
// agent:<id>:test:call:…) and grades the last reply as the phone would see
// it: texts and links after uno-imsg-proxy's bubble split, length, patterns
// it must not have, and the tapback (a react in a test session is logged by
// uno-imsg-proxy with its session key), and hand-offs: automations that text
// someone (a test session's are logged, never scheduled). Cases live in
// test/evals/*.json.
// Usage: node test/evals/run.mjs [suite ...] [--agents a,b] [--runs N] [--only id,id] [--jobs N] [--keep]
//        node test/evals/run.mjs --cleanup [--agents a,b]   (only sweeps up test sessions left by stopped runs)
// Results: printed, and saved to ~/.openclaw/uno-data/persona-results/.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const keep = args.includes("--keep") ? (args.splice(args.indexOf("--keep"), 1), true) : false;
const cleanupOnly = args.includes("--cleanup") ? (args.splice(args.indexOf("--cleanup"), 1), true) : false;
const suites = (args.length ? args : readdirSync(here).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)))
  .map((name) => ({ name, ...JSON.parse(readFileSync(join(here, `${name}.json`), "utf8")) }));

const EMOJI = /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/gu;
const LINK = /^\s*https?:\/\/\S+\s*$/;
const strip = (e) => e.replace(/️/g, "");
const inSet = (emoji, set) => [...set.matchAll(EMOJI)].some(([s]) => strip(s) === strip(emoji));
const within = (n, range) => !range || (n >= range[0] && n <= range[1]);
const logFile = (d) => `/tmp/openclaw/openclaw-${d.toLocaleDateString("en-CA")}.log`;

if (cleanupOnly) {
  const swept = await cleanUp(new Map(await Promise.all(agents.map(async (agent) => [agent, await leftovers(agent)]))));
  console.log(`swept up ${swept.done} test session(s) left by earlier runs${swept.failed.length ? `; not cleaned: ${swept.failed.join("; ")}` : ""}`);
  process.exit(swept.failed.length ? 1 : 0);
}

// One job: a case's messages in a fresh test session on one agent.
const started = new Date();
const stamp = started.toISOString().replace(/\D/g, "").slice(0, 14);
const jobs = [];
for (const suite of suites) for (const c of suite.cases) {
  if (only.length && !only.includes(c.id)) continue;
  const spec = { ...suite.defaults, ...c };
  // A suite about one person's own memory (their profile, their daily notes)
  // skips group-chat agents, which keep neither ("skip": [agent ids]).
  for (const agent of agents) for (let n = 1; n <= runs; n++) {
    if ((suite.skip ?? []).includes(agent)) continue;
    jobs.push({ suite: suite.name, id: c.id, spec, agent, n, tag: `${c.id}-${agent}-${stamp}-${n}`, key: `agent:${agent}:test:${spec.call ? "call:" : ""}eval-${c.id}-${stamp}-${n}` });
  }
}
const turn = async (job) => {
  let out = null;
  for (const template of job.spec.send) {
    const message = template.replaceAll("{tag}", job.tag);
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

// What uno-imsg-proxy logged for the test sessions: one text per log entry
// (each JSON line carries it twice). Reactions by session; hand-offs, the
// automations a test session asked for that text someone (logged, never
// scheduled); and texts it tried to send right away (blocked, never delivered).
const logged = [];
for (const file of new Set([logFile(started), logFile(new Date())])) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("uno-imsg-proxy: test ") && !line.includes("uno-family-memory: test ")) continue;
    try { const e = JSON.parse(line); logged.push(String(e["1"] ?? e.message ?? "")); } catch {}
  }
}
const reacts = new Map(), handoffs = new Map(), sends = new Map(), saves = new Map(), refused = new Map(), outside = new Map(), notes = new Map(), shared = new Map(), sentLinks = new Map();
const add = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
for (const text of logged) {
  let m;
  if ((m = text.match(/^uno-imsg-proxy: test react (\S+) session=(\S+)$/))) reacts.set(m[2], [...(reacts.get(m[2]) ?? []), m[1]]);
  // A hand-off: a job that texts someone, either to an iMessage handle or,
  // run in the chat's own conversation ("current" or unset), back to that chat.
  // One that runs isolated is counted as "outside", since the chat never sees it.
  // With no delivery set, OpenClaw announces back to the creating chat (mode "default").
  else if ((m = text.match(/^uno-imsg-proxy: test automation session=(\S+) deliver=(\S+) to=(\S+)(?: target=(\S+))?(?: mode=(\S+))?$/))) {
    const inChat = !m[4] || m[4] === "current" || m[4] === "unset";
    if ((m[2] === "imessage" && m[3] === "set") || (inChat && m[5] !== "none" && (m[2] !== "none" || m[5]))) add(handoffs, m[1]);
    if (!inChat) add(outside, m[1]);
  }
  else if ((m = text.match(/^uno-imsg-proxy: test message \S+ session=(\S+)( link)?$/))) { add(sends, m[1]); if (m[2]) add(sentLinks, m[1]); }
  // A profile save counts only when uno-family-memory let it through (not
  // after the turn read outside content); a refused one is shown, not counted.
  else if ((m = text.match(/^uno-family-memory: test profile_save session=(\S+)$/))) add(saves, m[1]);
  // A note written to the memory files (today's daily note or MEMORY.md).
  else if ((m = text.match(/^uno-imsg-proxy: test write \S+ file=(daily|memory-md) session=(\S+)$/))) add(notes, m[2]);
  else if ((m = text.match(/^uno-family-memory: test profile_save refused session=(\S+)$/))) add(refused, m[1]);
  // A save to the shared family memory.
  else if ((m = text.match(/^uno-imsg-proxy: test shared_memory_save session=(\S+)$/))) add(shared, m[1]);
}

// The page a "page" case made: the newest HTML file named with its tag, on
// the Mac (a workspace, the iCloud folders, /tmp) or in a sandbox container
// (/tmp, /workspace). It's copied next to the results, where it stays.
const pageRoots = [join(homedir(), ".openclaw"), join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs"), "/private/tmp"];
const pageDir = join(homedir(), ".openclaw/uno-data/persona-results/pages");
const lines = (out) => String(out ?? "").split("\n").filter(Boolean);
const containers = await exec("docker", ["ps", "--format", "{{.Names}}", "--filter", "name=openclaw-sbx-"], { encoding: "utf8" }).then((r) => lines(r.stdout), () => []);
const findPage = async (tag) => {
  const found = [];
  for (const root of pageRoots.filter(existsSync)) {
    const { stdout } = await exec("find", [root, "-maxdepth", "5", "-path", "*/browser", "-prune", "-o", "-path", "*/codex-home", "-prune", "-o", "-path", "*/persona-results", "-prune", "-o", "-name", `*${tag}*.htm*`, "-type", "f", "-print"], { encoding: "utf8", maxBuffer: 16 << 20 }).catch((e) => ({ stdout: e.stdout ?? "" }));
    for (const file of lines(stdout)) found.push({ file, at: statSync(file).mtimeMs });
  }
  for (const container of containers) {
    const { stdout } = await exec("docker", ["exec", container, "find", "/tmp", "/workspace", "-maxdepth", "3", "-name", `*${tag}*.htm*`, "-type", "f"], { encoding: "utf8" }).catch((e) => ({ stdout: e.stdout ?? "" }));
    for (const file of lines(stdout)) found.push({ file, container, at: Date.now() });
  }
  return found.sort((a, b) => b.at - a.at);
};
for (const job of jobs) if (job.spec.page && !job.error) {
  job.pages = await findPage(job.tag);
  const newest = job.pages[0];
  if (!newest) continue;
  mkdirSync(pageDir, { recursive: true });
  job.page = join(pageDir, `${job.tag}.html`);
  // A sandbox's /tmp is a tmpfs `docker cp` can't read, so cat it.
  writeFileSync(job.page, newest.container ? (await exec("docker", ["exec", newest.container, "cat", newest.file], { encoding: "utf8", maxBuffer: 64 << 20 })).stdout : readFileSync(newest.file));
}

// Grading.
for (const job of jobs) {
  const s = job.spec, why = [];
  if (job.error) { job.pass = false; job.why = [`error: ${job.error}`]; continue; }
  const reply = job.reply;
  const bubbles = reply ? linkBubbles(splitBubbles(reply)) : [];
  job.links = bubbles.filter((b) => LINK.test(b)).length;
  job.texts = bubbles.length - job.links;
  // Texts sent during the turn (the message tool) arrive too: a link as a
  // preview, anything else as a text.
  const sentTexts = (sends.get(job.key) ?? 0) - (sentLinks.get(job.key) ?? 0);
  job.links += sentLinks.get(job.key) ?? 0;
  job.texts += sentTexts;
  job.chars = reply.length;
  const reacted = reacts.get(job.key) ?? [];
  job.tap = reacted[0] ?? (tapbackFor(reply) ? reply : leadingReaction(reply) ? reply.match(EMOJI)?.[0] : null) ?? null;
  const words = reply.replace(EMOJI, "").replace(/\s+/g, " ").trim();
  if (!words) job.texts = sentTexts; // an emoji-only reply goes out as the tapback, not a text
  job.shape = (job.tap ? "tap" : "") + (words ? (job.tap ? "+words" : "words") : "") || "nothing";
  if (!within(job.texts, s.texts)) why.push(`texts ${job.texts}, want ${s.texts.join("-")}`);
  if (!within(job.links, s.links)) why.push(`links ${job.links}, want ${s.links.join("-")}`);
  if (!within(job.chars, s.chars)) why.push(`chars ${job.chars}, want ${s.chars.join("-")}`);
  if (s.shape && s.shape !== "any" && job.shape !== s.shape) why.push(`shape ${job.shape}, want ${s.shape}`);
  job.handoffs = handoffs.get(job.key) ?? 0;
  job.sends = sends.get(job.key) ?? 0;
  job.saves = saves.get(job.key) ?? 0;
  job.refused = refused.get(job.key) ?? 0;
  job.notes = notes.get(job.key) ?? 0;
  if (s.notes && !within(job.notes, s.notes)) why.push(`memory notes ${job.notes}, want ${s.notes.join("-")}`);
  job.shared = shared.get(job.key) ?? 0;
  if (s.shared && !within(job.shared, s.shared)) why.push(`shared memory saves ${job.shared}, want ${s.shared.join("-")}`);
  if (s.saves && !within(job.saves, s.saves)) why.push(`profile saves ${job.saves}${job.refused ? ` (${job.refused} refused after outside content)` : ""}, want ${s.saves.join("-")}`);
  if (s.handoffs && !within(job.handoffs, s.handoffs)) why.push(`texted hand-offs ${job.handoffs}, want ${s.handoffs.join("-")}`);
  job.outside = outside.get(job.key) ?? 0;
  if (s.inChat && job.outside) why.push(`${job.outside} job(s) run outside this chat (isolated), so the chat won't know what they said`);
  if (s.react && !(job.tap && inSet(job.tap, s.react))) why.push(`tapback ${job.tap ?? "none"}, want one of ${s.react}`);
  if (s.avoid) for (const e of [job.tap, ...(reply.match(EMOJI) ?? [])].filter(Boolean)) if (inSet(e, s.avoid)) { why.push(`used ${e}`); break; }
  if (s.sends && !within(job.sends, s.sends)) why.push(`texts sent mid-turn ${job.sends}, want ${s.sends.join("-")}`);
  for (const p of s.not ?? []) if (new RegExp(p, "imu").test(reply)) why.push(`matched /${p}/`);
  for (const p of s.has ?? []) if (!new RegExp(p, "imu").test(reply)) why.push(`lacks /${p}/`);
  if (s.page) {
    if (!job.page) why.push("no page made");
    else {
      const html = readFileSync(job.page, "utf8");
      job.kb = Math.round(html.length / 1024);
      if (!within(job.kb, s.page.kb)) why.push(`page ${job.kb} KB, want ${s.page.kb.join("-")}`);
      for (const p of s.page.has ?? []) if (!new RegExp(p, "imu").test(html)) why.push(`page lacks /${p}/`);
      for (const p of s.page.not ?? []) if (new RegExp(p, "imu").test(html)) why.push(`page has /${p}/`);
    }
  }
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
    const got = rs.map((j) => j.error ? "error" : `${j.texts}+${j.links} ${j.chars}c${j.kb != null ? ` 📄${j.kb}KB` : ""}${j.tap ? ` ${j.tap}` : ""}${j.handoffs ? ` ↪${j.handoffs}` : ""}${j.outside ? ` 🏝${j.outside}` : ""}${j.sends ? ` ✉${j.sends}` : ""}${j.saves ? ` 💾${j.saves}` : ""}${j.notes ? ` 📝${j.notes}` : ""}${j.shared ? ` 🏠${j.shared}` : ""}${j.refused ? ` 🚫${j.refused}` : ""}`).join(" | ");
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

// Test sessions never become memories: what they left in an agent's memory is
// forgotten (which also keeps them out of later indexing and dreaming) and the
// sessions are deleted (the results file keeps the replies). Sessions left by
// runs that were stopped before this point (this runner's, idle 2 hours or
// more) are swept up with them. --keep leaves this run's sessions, to look at
// a transcript, and the pages where they were made.
if (!keep) {
  for (const job of jobs) for (const { file, container } of job.pages ?? []) {
    if (container) await exec("docker", ["exec", container, "rm", "-f", file]).catch(() => {});
    else rmSync(file, { force: true });
  }
  const byAgent = new Map();
  for (const job of jobs) byAgent.set(job.agent, [...(byAgent.get(job.agent) ?? []), job.key]);
  let old = 0;
  for (const [agent, keys] of byAgent) {
    const extra = (await leftovers(agent).catch(() => [])).filter((k) => !keys.includes(k));
    old += extra.length;
    keys.push(...extra);
  }
  const { done, failed } = await cleanUp(byAgent);
  console.log(`cleaned up ${done}/${jobs.length + old} test sessions${old ? ` (${old} left by earlier runs)` : ""}${failed.length ? `; not cleaned: ${failed.join("; ")}` : ""}`);
}

// One forget and one delete per agent, in batches: each call takes about 15 s
// however many sessions it covers, so one per session was too slow to finish.
async function cleanUp(byAgent) {
  let done = 0;
  const failed = [];
  for (const [agent, keys] of byAgent) for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    try {
      await exec("openclaw", ["memory", "forget", "--agent", agent, ...batch.flatMap((k) => ["--session", k])], { timeout: 600_000, maxBuffer: 64 << 20 });
    } catch (error) { failed.push(`${agent}: memory forget failed (${firstLine(error)})`); continue; }
    const { stdout } = await exec("openclaw", ["sessions", "delete", ...batch, "--agent", agent, "--yes", "--json"], { timeout: 600_000, maxBuffer: 64 << 20 }).catch((e) => ({ stdout: e.stdout ?? "" }));
    const results = parseJson(stdout)?.results ?? [];
    // A session that's already gone counts as cleaned.
    const ok = results.filter((r) => r.ok || r.status === "not_found").length;
    done += ok;
    const why = results.find((r) => !r.ok && r.status !== "not_found")?.error;
    if (ok < batch.length) failed.push(`${agent}: ${batch.length - ok} session(s) not deleted${why ? ` (${why})` : ""}; the next run sweeps them up`);
  }
  return { done, failed };
}

// This runner's test sessions on an agent that have been idle 2 hours or more:
// left by a run that was stopped before its cleanup (a run in progress is never
// that quiet).
async function leftovers(agent) {
  const { stdout } = await exec("openclaw", ["sessions", "list", "--agent", agent, "--limit", "all", "--json"], { timeout: 120_000, maxBuffer: 64 << 20 });
  const list = parseJson(stdout);
  const mine = new RegExp(`^agent:${agent.replace(/[^\w-]/g, "")}:test:(call:)?eval-`);
  return (list?.sessions ?? []).filter((s) => mine.test(s.key ?? "") && Date.now() - (s.updatedAt ?? Date.now()) > 2 * 3600_000).map((s) => s.key);
}

function parseJson(text) {
  const at = String(text ?? "").indexOf("{");
  try { return at < 0 ? null : JSON.parse(String(text).slice(at)); } catch { return null; }
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error).split("\n").find((l) => l.trim() && !l.startsWith("[state/")) ?? "no output";
}

process.exitCode = passed === jobs.length ? 0 : 1;
