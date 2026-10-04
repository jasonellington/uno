---
name: uno-lab
description: Tries a change to how Uno talks or behaves in the uno-lab test agent before the owner sees it - a new AGENTS.md, REPLY.md, CALL.md or SOUL.md line - with evals before and after, then restores the lab. Use for every proposed persona or reply-shape change, and whenever you want to test Uno freely without touching anyone's real chats.
---

# Testing in uno-lab

`uno-lab` is a sealed Uno with no bindings: nobody can text it, and its USER.md is a made-up person ("Alex Example"). The owner's word: talk to it, test and eval anything there, no asking. Real model turns through the gateway, graded by rules (`test/evals/`, real-turn-test skill).

## The loop

1. **Write the case first** in `test/evals/*.json`, from the owner's own words when they reported it. Grade what matters: links, texts, shape, tapback, `handoffs` (a texted job), `saves` (a profile save), `not` patterns.
2. **Baseline** on the owner's agent and the lab: `npm run eval -- <suites> --agents main,uno-lab --runs 2`. The new case should fail (if it passes, the problem is elsewhere: look again).
3. **Take the lab** (one trial at a time; parallel sessions share it): `mkdir ~/.openclaw/uno-data/lab.lock`, with a `note` inside saying who and what. If it exists, another session is mid-trial: wait for it, never remove it. **Put the proposal in the lab only:** copy the edited files into `~/.openclaw/workspace-uno-lab/` (never `~/uno/workspace/` yet). Change every file that says the same thing: REPLY.md (chats) and CALL.md (calls) ride along with each message and win over AGENTS.md, so a rule in AGENTS.md alone loses to them.
4. **Run the same command** on `--agents uno-lab`. Keep the change only if the new case passes and nothing else drops.
5. **Restore the lab:** `cp ~/uno/workspace/{SOUL,AGENTS,IDENTITY,REPLY,CALL}.md ~/.openclaw/workspace-uno-lab/` and `cmp` each, then release the lab (`rm -r ~/.openclaw/uno-data/lab.lock`). Evals that don't change the lab's files need no lock: each run's test sessions have their own names.
6. **Show the owner** the exact lines (before and after) and a before/after table. SOUL.md needs their yes; AGENTS.md, IDENTITY.md too.
7. **After the yes:** commit, copy into every Uno workspace, then the same evals on the owner's agent and the family group agent (`uno-agent-family`). AGENTS.md reaches a live chat only when its session starts (daily at 4, or `/new`); REPLY.md, CALL.md, SOUL.md and USER.md apply on the next message.

## What the lab can't do

It has no browser, no automations, no Apple apps and no shared memory: those cases run on the owner's agent, in test sessions, which is safe:

- Test sessions never reach a phone. uno-imsg-proxy logs and blocks their message sends, new automations and shared-memory saves, and cancels anything they still send; uno-family-memory logs and blocks their profile saves after its outside-content check (a save refused after a web search shows as 🚫, not 💾). Never write a case that needs a real delivery.
- The runner deletes its test sessions afterwards (`memory forget` + `sessions delete`, batched), so test chats never become anyone's memories, and sweeps up any that a stopped run left (its own, idle 2 hours or more; `npm run eval -- --cleanup --agents …` does only that). `--keep` keeps them to read a transcript. Test sessions record no channel, so OpenClaw's `memoryPolicy.excludeSessions` can't keep them out: the forget is what does.

## Gotchas

- The lab's USER.md has an empty Preferences section, which makes it save a profile on almost anything. A `saves: [0, 0]` case can fail there and pass on a real agent: check both before blaming the change.
- After changing what an agent's memory search covers (extra paths, `rememberAcrossConversations`), rebuild its index right away (`openclaw memory status --index --agent <id>`), or the agent tells people its memory is paused.
- Replies vary: `--runs 2` or more before deciding anything, and read the failing replies, not just the score.
