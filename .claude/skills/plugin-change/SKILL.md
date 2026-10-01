---
name: plugin-change
description: Changes or adds behavior in one of Uno's OpenClaw plugins (uno-guard, uno-imsg-proxy, uno-apple-tools, uno-family-memory) - hooks, tool scoping, approvals, tapbacks, message handling. Use when editing anything under plugins/ or adding a plugin tool.
---

# Plugin change

Each plugin splits into `rules.js` (decisions) and `index.js` (wiring: hooks, chat.db reads, imsg calls). Read the plugin's README first; it lists its settings and hooks.

- Put each decision in a pure function in `rules.js` with a test in `test/<plugin>*.test.js`, so it's testable without a gateway. Keep `index.js` to wiring.
- A hook runs inside someone's live turn, so it must never throw into it: on any failure, fall through to the normal path.
- Never log message text; the gateway log is read by health checks and shared in reports.
- Behavior applies to every Uno agent and chat: Uno is one person (uno-one-person skill). Don't branch style or reactions on agent id or chat type.
- Anything that must never happen (scoping, approvals, owner-only actions) is enforced here in code. Call something "enforced" only when code or OS permissions enforce it.
- OpenClaw can run hooks in separate plugin copies that don't share memory; state that must be shared goes through chat.db or a file, not a module variable.
- Check hook names and plugin APIs with the openclaw-facts skill rather than from memory.
- Unit tests check the pure rules only. The change is verified when a real model turn shows the right result in chat.db (real-turn-test skill; a phone test for anything that needs a real inbound message); never report "tests pass" as done.

A commit changes nothing live. Installing is `openclaw plugins install ./plugins/<id> --force --accept-capabilities` plus a gateway restart (README "Working on Uno").
