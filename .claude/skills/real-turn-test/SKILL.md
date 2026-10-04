---
name: real-turn-test
description: Tests Uno with evals - real model turns through the gateway, graded by rules - to reproduce a problem before changing anything, try a proposed persona line, and verify an installed change on more than one agent. Use at the start and end of every task that changes how Uno talks, reacts, formats or does things, and before proposing any persona change.
---

# Evals

Unit tests and reasoning about what the model would do aren't verification. A change is done when the evals, real model turns run through the gateway, show it.

## The loop

1. **Write the case first.** Add the behavior to a suite in `test/evals/*.json`: the message(s) to send and what passes (texts, links, length, tapback, patterns it must not have). Use the owner's exact words when they reported it.
2. **Baseline.** `npm run eval -- <suite> --agents main,uno-agent-family --runs 2` (the owner's agent and a sealed one; `uno-lab` before there's a family). The new case should fail.
3. **Change, install, re-run** the same command. Keep the change only if the score goes up and nothing else drops; run every suite before calling it done.
4. **Report** the score before and after, per agent, with one quoted reply. Behavior that needs a real inbound group message is still a phone test.

## The runner

- `npm run eval -- [suite ...] [--agents a,b] [--runs N] [--only id,id] [--jobs N]`. Each case runs in a fresh test session (`agent:<id>:test:eval-…`; nothing is delivered), 6 at a time. It prints PASS/FAIL per case and agent with the failing replies, and a score; results are saved in `~/.openclaw/uno-data/persona-results/`. Afterwards it forgets and deletes its test sessions (and any a stopped run left), so evals never become the agent's memories; `--keep` leaves this run's.
- A case: `{ "id", "send": [messages; the last reply is graded], "texts": [min, max], "links": [min, max], "chars": [min, max], "shape": "tap" | "tap+words" | "words", "react": "emoji that fit", "avoid": "emoji that mustn't appear", "handoffs": [min, max], "sends": [min, max] (texts sent mid-turn, like an "on it"), "saves": [min, max] (USER.md saves), "notes": [min, max] (writes to today's note or MEMORY.md), "shared": [min, max] (shared-memory saves), "not": [regexes], "has": [regexes it must match] }`. A suite's `defaults` apply to all its cases, and its `skip` lists agents it doesn't run on. `handoffs` counts automations that would text someone (a call handing slow work to a texted job).
- Test sessions never reach a phone or change real data: uno-imsg-proxy logs and blocks their message sends, new automations and writes to reminders, events, contacts, notes, mail, music and the record files (TASKS.md, MEMORY.md, memory/), answering "Done."; uno-family-memory does the same for profile saves. A new tool with side effects needs a line in `testSideEffect` (Oct 3: evals had put fake tasks in the owner's TASKS.md and fake reminders in the family's list). Never write a case that relies on a real delivery.
- Texts and links are counted the way uno-imsg-proxy sends the reply (one bubble per paragraph, each link its own preview). The tapback is the react call (logged by uno-imsg-proxy with the test session's key) or a lone or leading emoji.
- Replies vary between runs: use `--runs 2` or more for anything that decides a change.

## Trying a line before the owner OKs it

Use the uno-lab skill: baseline, the proposal in the lab only, the same evals, restore, then show the owner.

## Where instructions land

- SOUL.md, IDENTITY.md and USER.md go with every request; AGENTS.md reaches a session when it starts (sandboxed agents get it through uno-imsg-proxy's hook).
- REPLY.md is added next to every chat message by uno-imsg-proxy. Reply-shape rules belong there: in SOUL.md or AGENTS.md they lost to the model's habit of writing up all its research (Sept 30, six wordings), and next to the message they held. CALL.md is its FaceTime-call version (spoken replies); cases with `"call": true` (test/evals/call.json) run in a call session.
- What the model was given: the Codex rollout under `~/.openclaw/agents/<id>/agent/codex-home/sessions/` (base instructions, developer message, the turn's input).
