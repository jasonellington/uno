---
name: uno-admin
description: "Changes Uno's own setup: settings, shared spaces, the group chat, new tools, skill updates, restarts. Use when the owner asks, in their own chat."
metadata: { "openclaw": { "emoji": "🛠️", "os": ["darwin"] } }
---

# Running your own setup

You're the admin: the owner asks, in their own chat, and you make the change with OpenClaw's own commands, check it, and tell them in a line or two what changed.

## Ground rules

- The live setup is `~/.openclaw`. The template your files come from is `~/uno` (workspace files, skills, plugins, docs).
- Never print `~/.openclaw/openclaw.json` or anything in `~/.openclaw/secrets`: they hold keys. Read settings one path at a time with `openclaw config get <path> --json`.
- Change settings with `openclaw config set <path> <value>` or, for several at once, a JSON file and `openclaw config patch --file <file>`. Try `--dry-run` first. A patch replaces whole lists, so to add to a list (bindings, handles), get the current list, add to it, and write the whole list back.
- Settings, skills and your setup note are yours to change once the owner says so. Your style is yours to change too: `~/uno/plugins/uno-imsg-proxy/` (reactions, tapbacks, typing, bubbles, link previews, error lines), with a test for each change (`npm test` in `~/uno`, all passing), the owner's OK, then `openclaw plugins install ~/uno/plugins/uno-imsg-proxy --force --accept-capabilities` and a restart. Commit every change in `~/uno` (`git add` the files you changed, `git commit -m "<what and why>"`) so it's saved and can be undone. `~/uno/plugins/uno-guard/` isn't: it's what keeps you in check (texting, approvals, purchases, scoping). If a change needs it, say so and leave it for the owner's builder.
- Never edit SOUL.md. AGENTS.md and IDENTITY.md changes are shown to the owner as the exact before and after, and made only after their OK.
- Before a change that widens access (someone new in the family group chat, a new shared site, a higher purchase limit), say exactly what will change and wait for their yes.

## Every change

1. Take the lock, so nobody else changes the live setup at the same moment: `mkdir ~/.openclaw/uno-data/live.lock && echo "uno: <what> $(date)" > ~/.openclaw/uno-data/live.lock/note`. If the mkdir fails, someone else is mid-change: stop and tell the owner.
2. Make the change.
3. Run `openclaw doctor --lint` and fix anything it reports about your change.
4. Commit it in `~/uno` if it changed files there.
5. Release the lock (`rm -r ~/.openclaw/uno-data/live.lock`) before any restart: a restart ends your turn, and a lock left behind blocks the next change.
6. Restart if the change needs one (see Restarting), as the very last step.
7. After it's live (after the restart, when OpenClaw picks your turn back up): prove the one thing the change was for with a live check, for example `openclaw config get <path>`, `openclaw agents bindings --agent <id>`, or `openclaw skills list --agent <id>`. Until that shows it, it isn't done. Then run the setup-check skill (save the approved setup once the owner has OKed the change) and tell the owner what changed and what you checked.

## Common changes

- Household settings are under `plugins.entries.uno-guard.config`: `sharedSites`, `purchases` (`off`, `approve`, `limit`), `purchaseLimit` (dollars), `familySpaces`, `spaces.<agent>`, `mailAddresses.<agent>`, `approvalAgents`. `~/uno/plugins/uno-guard/README.md` says what each does. Every chat's setup note is built from them, so nothing else needs editing.
- Unlocking shared spaces for the family group chat's agent (`uno-agent-family`) once the family has accepted the invites (the share-spaces skill sends them):
  - Reminders list or calendar: add its exact name to `items` under `reminders` or `calendars` in `~/.openclaw/uno-data/pim/uno-agent-family/config.json` (keep it valid JSON, mode 0600); for reminders, also set `"default"` to the family's list.
  - Notes folder or iCloud Drive folder: set `plugins.entries.uno-apple-tools.config.agents.uno-agent-family.notesFolder` or `.filesFolder` to the folder's name.
  - Then allow the matching tool for that agent: add `apple_pim_reminder`, `apple_pim_calendar`, `apple_notes` or `apple_files` to `agents.entries.uno-agent-family.tools.sandbox.tools.allow`, and take it out of both `agents.entries.uno-agent-family.tools.deny` and `.tools.sandbox.tools.deny`.
- The family group chat: the owner creates it in Messages with everyone in it and Uno's address, and sends a message. Find its chat id with `imsg chats --limit 10 --json` (the newest group whose members are all family). If there's no group agent yet, create `uno-agent-family` (`openclaw agents add uno-agent-family --workspace ~/.openclaw/workspace-uno-agent-family --non-interactive`), seal it with its entries in `~/uno/docs/agents.example.json`, copy the managed files into its workspace, and add it to `plugins.entries.uno-guard.config.approvalAgents` and `schedulingAgents` (so the group can schedule one-time texts and check-ins back to itself). Then set `channels.imessage.groupPolicy` to `"allowlist"`, add `"<id>": { "requireMention": false }` under `channels.imessage.groups` and `agents.defaults.silentReply.group` to `"allow"` (every message reaches you and you may stay quiet; a message that names you always gets an answer), set `channels.imessage.groupAllowFrom` to the owner's handles plus `accessGroup:family`, and add a binding `{ "agentId": "uno-agent-family", "match": { "channel": "imessage", "accountId": "*", "peer": { "kind": "group", "id": "<id>" } } }` (the bare number, not `chat_id:`), before the fallback's channel-wide binding.
- A new tool, skill or plugin: look first at what's already there (`openclaw skills list`, `openclaw plugins list`; many show "needs setup" and only need their app or a sign-in), then ClawHub (clawhub skill). Say what it does, what it can reach and what it costs, and wait for the owner's yes. A plugin also has to be added to `plugins.allow` (write the whole list back), installed with `openclaw plugins install <spec> --pin`, and needs a restart. Only you get a new tool unless the owner says it's for everyone.
- Your skills and managed files: skills everyone gets live in `~/.openclaw/skills/<name>/` (OpenClaw's managed skills, which every agent loads), skills the family shares for shared sites in `~/.openclaw/uno-data/shared-skills/`, and the ones only you get in your own `skills/` folder. After a skill or SOUL.md, AGENTS.md, IDENTITY.md, REPLY.md or CALL.md changes in `~/uno/workspace/`, copy it into place with `cp` (skills from `~/uno/workspace/skills/` to `~/.openclaw/skills/`, from `~/uno/workspace/owner-skills/` to your own; the five managed files into every agent's workspace, `openclaw agents list` shows where). Then restart.

## Restarting

`openclaw gateway restart` ends every turn in progress, yours included. First check nobody is mid-task: everyone's latest message has an answer from you, or the owner says go ahead. Tell the owner in one line that you're restarting, then restart as the very last thing you do. OpenClaw picks your turn back up afterwards; then check `openclaw channels status --probe` says iMessage "works" and say how it went.
