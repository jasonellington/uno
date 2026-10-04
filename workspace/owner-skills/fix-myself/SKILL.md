---
name: fix-myself
description: "Hands a fix to your builder when the owner says you got something wrong or should work differently from now on: a wrong link, a reply that missed, something you forgot. Use in the owner's own chat."
metadata: { "openclaw": { "emoji": "🔧", "os": ["darwin"] } }
---

# Fixing yourself

Your builder is a coding agent that works in its own copy of `~/uno`: it finds out why you did what you did, fixes it, proves the fix with real tests (evals), and installs it. You start it with one shell command; the owner gets a 👍 prompt showing its task, and it starts only after they tap it.

1. **Is it just their preference?** ("send one text", "I wear a medium") Save it to USER.md and you're done; no builder.
2. **Otherwise it's a fix.** Gather the evidence before anything else, without searching the web or opening pages: their exact words, when it happened, what you sent or did (your own messages and tool calls in this chat), and this chat's session key.
3. **Start it** with one shell command, a short name for the fix and the whole task (it detaches right away and keeps going through restarts):
   `~/.openclaw/uno-data/watchdog/builder.sh <short-name> "<task>"`
   The task: the owner's words as they wrote them, your evidence, and "Reproduce this with an eval in test/evals first; it should fail. Fix it here, run the evals before and after, and follow this repo's AGENTS.md and your skills. Anything the owner has to OK (SOUL.md, AGENTS.md, IDENTITY.md, the guard plugin, anyone's access): stop and say exactly what to ask. When it passes, merge into master and install it the way your live-change steps say, restarting last. Report what was wrong and the before and after scores in three lines."
   Then tell the owner in one line that your builder is on it.
4. **While it works**, stay quiet. When it's done, its report arrives in this chat as a message marked as the builder's report, not from the owner. If it asks something, ask the owner in one text, then send their answer as a follow-up: the same command with the same short name and their reply as the task (it picks up where it left off).
5. **When it reports**, check it yourself: `openclaw channels status --probe` says iMessage works, and the change it named is live. Then tell the owner in two lines what was wrong and what changed, with the before and after scores. Its full output is in `~/.openclaw/uno-data/builder/<short-name>.out`.
6. Once it's done and merged, remove its copy: `~/.openclaw/uno-data/watchdog/builder.sh done <short-name>`.
