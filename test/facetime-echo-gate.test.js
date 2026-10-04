import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The echo gate in patches/facetime-2026.9.6.patch, run on synthetic calls:
// Uno's voice comes back as echo (random strength, delay and wobble), and
// sometimes the caller talks over it. The gate must never open on echo alone
// (that's Uno talking to itself), and should open soon after a caller who's
// clearly louder than the echo talks over Uno. By design it can miss a caller
// barely louder than the echo, or one who talks during the first 3 s of Uno's
// speech on a call, while it learns this call's echo (the fallback is just:
// wait for Uno).
const SR = 24000, CHUNK = 480; // 20 ms

function loadGate() {
  const lines = readFileSync(new URL("../patches/facetime-2026.9.6.patch", import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("+// Uno patch: the echo gate, with barge-in."));
  assert.ok(start >= 0, "echo gate not found in the patch");
  const src = [];
  let depth = 0, inGate = false;
  for (const raw of lines.slice(start)) {
    if (!raw.startsWith("+")) break;
    const line = raw.slice(1);
    src.push(line);
    if (line.startsWith("function createEchoGate(")) inGate = true;
    if (inGate) {
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth === 0) break;
    }
  }
  return new Function(`const FACETIME_AUDIO_SAMPLE_RATE_HZ = 24e3;\n${src.join("\n")}\nreturn createEchoGate;`)();
}

// Seeded, so a failure reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Speech-like audio: syllables of shaped noise with gaps and word pauses.
function speech(seconds, rand) {
  const out = new Float64Array(Math.round(seconds * SR));
  let i = 0;
  while (i < out.length) {
    const syl = Math.round((0.1 + 0.2 * rand()) * SR);
    for (let k = 0; k < syl && i + k < out.length; k++) {
      out[i + k] = (rand() * 2 - 1) * 0.25 * Math.sin((Math.PI * k) / syl);
    }
    i += syl + Math.round((rand() < 0.2 ? 0.25 + 0.3 * rand() : 0.04 + 0.12 * rand()) * SR);
  }
  return out;
}

// aheadMs: how far ahead of playback Uno's audio is handed over (the model
// streams faster than real time; on Oct 1 that made the gate forget what was
// playing, and Uno cut itself off mid-word).
function trial(createEchoGate, rand, { echoDb, delayMs, wobbleDb, callerDb = null, callerStartMs = 0, aheadMs = 0 }) {
  const uno = speech(10, rand), caller = speech(3.5, rand);
  const level = (x) => 10 * Math.log10(x.reduce((s, v) => s + v * v, 0) / x.length);
  const eg = 10 ** ((echoDb - level(uno)) / 20), cg = callerDb === null ? 0 : 10 ** ((callerDb - level(caller)) / 20);
  const playUntil = 100 + (uno.length / SR) * 1000;
  const gate = createEchoGate({ millisecondsUntilDrained: (t) => Math.max(0, playUntil - t) });
  let wobble = 0, opened = null, queuedTo = 100;
  for (let t = 0; t < playUntil + 2000; t += 20) {
    wobble = Math.max(-wobbleDb, Math.min(wobbleDb, wobble + (rand() * 2 - 1)));
    while (queuedTo < Math.min(playUntil, t + aheadMs + 20)) {
      const said = Buffer.alloc(CHUNK * 2), k0 = Math.round(((queuedTo - 100) * SR) / 1000);
      for (let k = 0; k < CHUNK; k++) said.writeInt16LE(Math.round((uno[k0 + k] ?? 0) * 32768), k * 2);
      gate.noteOutput(said, queuedTo, t);
      queuedTo += 20;
    }
    const heard = Buffer.alloc(CHUNK * 2);
    for (let k = 0; k < CHUNK; k++) {
      const i = Math.round((t * SR) / 1000) + k;
      const e = (uno[i - Math.round(((100 + delayMs) * SR) / 1000)] ?? 0) * eg * 10 ** (wobble / 20);
      const c = (caller[i - Math.round((callerStartMs * SR) / 1000)] ?? 0) * cg;
      const v = (e + c + (rand() * 2 - 1) * 1e-3) * 32768;
      heard.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), k * 2);
    }
    if (gate.process(heard, t).some((x) => x !== 0) && t < playUntil + 1000 && opened === null) opened = t;
  }
  return opened;
}

test("echo gate: echo alone never opens it; a caller talking over Uno does, quickly", () => {
  const createEchoGate = loadGate();
  const rand = rng(7);
  const pick = (a, b) => a + rand() * (b - a);
  let falseOpens = 0;
  for (let n = 0; n < 20; n++) {
    if (trial(createEchoGate, rand, { echoDb: pick(-50, -24), delayMs: pick(150, 1000), wobbleDb: pick(0, 6), aheadMs: n % 2 ? 6000 : 0 }) !== null) falseOpens++;
  }
  assert.equal(falseOpens, 0, "the gate opened on echo alone");
  const delays = [];
  let misses = 0;
  for (let n = 0; n < 20; n++) {
    const echoDb = pick(-50, -30), start = pick(3500, 7000);
    const opened = trial(createEchoGate, rand, { echoDb, delayMs: pick(150, 1000), wobbleDb: pick(0, 4), callerDb: Math.min(-12, echoDb + pick(15, 30)), callerStartMs: start, aheadMs: n % 2 ? 6000 : 0 });
    if (opened === null) misses++;
    else delays.push(opened - start);
  }
  delays.sort((a, b) => a - b);
  assert.ok(misses <= 1, `missed ${misses} of 20 talk-overs`);
  assert.ok(delays[Math.floor(delays.length / 2)] <= 600, `median time to open ${delays[Math.floor(delays.length / 2)]} ms`);
});
