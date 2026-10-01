---
name: setup-check
description: "Checks Uno's own setup: one owner, everyone sealed, nothing changed without the owner's OK. Use after any setup change or when the owner asks."
metadata: { "openclaw": { "emoji": "🔎", "os": ["darwin"] } }
---

# Checking your setup

Read-only: this changes nothing except, with the owner's OK, the approved copy at the end. Read settings with `openclaw config get <path> --json`, never `openclaw.json` itself, and never print a key.

Report to the owner in plain words: "all good", or each problem in one line with what it means for them. A problem is something to report, never something to fix quietly; if they want it fixed, that's a change (uno-admin).

## The rules

The admin agent is `plugins.entries.uno-guard.config.adminAgentId` (you). Everyone else's agent is "sealed". Check:

1. Only the owner is the owner. `commands.ownerAllowFrom` and `commands.allowFrom.imessage` hold only the owner's handles, and each of those handles is bound to the admin agent.
2. Who can text you. `channels.imessage.dmPolicy` is `"allowlist"`; `channels.imessage.allowFrom` is the owner's handles plus `accessGroup:family`, never `"*"`. Every handle in `accessGroups.family.members.imessage` is bound (`bindings`) to that person's own sealed agent, never to the admin agent.
3. Group chats. `channels.imessage.groupPolicy` is `"allowlist"` (or `"disabled"`). Every chat under `channels.imessage.groups` has a binding to a sealed agent, and either `requireMention: true` or `agents.defaults.silentReply.group` set to `"allow"` (you may stay quiet there). No `"*"`.
4. Strangers get nothing. A channel-wide binding sends everyone else to the fallback agent (`fallbackAgentId`), which is sandboxed and whose only allowed tool is `uno_fallback_no_tools`.
5. Sealed agents stay sealed. For every agent but the admin and the fallback: `sandbox.mode` is `"all"`, `sandbox.scope` isn't `"shared"`, `tools.elevated.enabled` is false, `tools.message.crossContext.allowWithinProvider` is false (the group's and people's agents), and both `tools.deny` and `tools.sandbox.tools.deny` include `gateway`, `openclaw`, `plugins`, `secrets`, `nodes`, `canvas`, `computer`, `onepassword`, `sessions_list`, `sessions_history`, `sessions_search`, `sessions_send`, `sessions_spawn`, `subagents`, `transcripts`, `skill_workshop`, `cron` and `automations`.
6. Nobody reads other chats. `tools.sessions.visibility` is `"self"` and `tools.agentToAgent.enabled` is false.
7. Approvals reach the owner. `approvals.plugin` is enabled, mode `"targets"`, with the owner's phone as the target.
8. The guard plugins are running. `openclaw plugins list` shows `uno-guard`, `uno-imsg-proxy`, `uno-family-memory` and `uno-apple-tools` loaded from their installed copies, `~/.openclaw/extensions/uno-guard/` is identical to `~/uno/plugins/uno-guard/` (`diff -r`, ignoring `node_modules`; a difference means the guard changed and the owner hasn't OKed it), `plugins.load.paths` is empty, and `plugins.allow` lists exactly the plugins in use (a new one needs the owner's OK).
9. Managed files match. In every agent's workspace, SOUL.md, AGENTS.md, IDENTITY.md, REPLY.md and CALL.md are identical to `~/uno/workspace/` (`cmp`).
10. OpenClaw's own audit. `openclaw security audit`: report anything it flags that isn't explained by the rules above.
11. iMessage works. `openclaw channels status --probe` says iMessage "works".

## Nothing changed without the owner's OK

The approved setup is a copy of these settings in `~/.openclaw/uno-data/approved-setup/`, one file per path: `agents.entries`, `bindings`, `channels.imessage`, `accessGroups`, `commands`, `approvals`, `tools`, `skills`, `plugins.entries.uno-guard.config`, `plugins.entries.uno-apple-tools.config`, `plugins.entries.uno-family-memory.config`, `plugins.allow` (file name: the path, e.g. `bindings.json`), plus a copy of every `~/.openclaw/uno-data/pim/<agent>/config.json` as `pim-<agent>.json`.

- Compare each: `diff <(openclaw config get <path> --json) ~/.openclaw/uno-data/approved-setup/<path>.json`. Any difference is a change: say what it is in plain words (who gained or lost what).
- Only after the owner OKs a change, save today's settings as the new approved copy: the same `openclaw config get <path> --json > ~/.openclaw/uno-data/approved-setup/<path>.json` for each (mode 0600), and copy the Apple filter files again.
