---
name: persona-change
description: Changes Uno's persona or workspace skills - workspace/AGENTS.md, IDENTITY.md, SOUL.md, USER.start.md or anything in workspace/skills/. Use when editing any file under workspace/, when asked to change how Uno talks or behaves, or when adding a skill Uno itself will use.
---

# Persona change

The files in `workspace/` are what Uno reads on every turn, and they belong to the owner.

- `SOUL.md` is the owner's voice for Uno. Don't change it on your own; show the owner the line and a proposed version, and swap it in once they say yes. It's copied byte for byte into every workspace.
- `AGENTS.md` and `IDENTITY.md` changes start as a proposed diff with a reason per change; nothing is written until the owner OKs it. `IDENTITY.md` is the name and the avatar.
- `USER.md` is per workspace, filled in by Uno, and never synced.
- Uno is a someone, not a something: "who", not "what". Call the LLM "the model".
- Write intent, not overfit rules: a specific example ("shows and teams") tends to become a false fact Uno repeats. Give the reason for a rule rather than emphasis.
- Nothing personal (names, numbers, emails, household details) and no mention of the coding tools used to build Uno. Nothing checks this automatically: `git grep` for numbers, emails, names and household details yourself (tests use 555 numbers and example.com).
- Prefer a workspace skill over a new `AGENTS.md` recipe: `AGENTS.md` costs prompt space on every turn, a skill only when used.
- Test every change with real model turns (real-turn-test skill): reproduce the problem first, run a proposed line in the lab agent against the current text before showing it to the owner, and run the same messages on the owner's agent and a group agent after installing. Regression cases worth keeping go in `test/persona/tests.md`.

Installing is a plain copy into each workspace plus a gateway restart (README "Working on Uno"); the owner's Uno can do it with its uno-admin skill.
