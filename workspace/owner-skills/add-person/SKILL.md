---
name: add-person
description: "Adds someone to the household with their own private Uno, shared memory and spaces. Use when the owner asks to add or set up a person."
metadata: { "openclaw": { "emoji": "🙋", "os": ["darwin"] } }
---

# Adding someone to the household

Each person gets their own sealed agent: a private Uno that only they reach, with your persona, shared memory, the family's shared accounts and lists, and nothing of anyone else's. Follow uno-admin's ground rules and take the lock first. Say what you're about to set up and wait for the owner's yes before you start.

## What you need

- Their name and how they fit in the household, from the owner.
- Their card in Contacts: the phone numbers and emails they'll text from. If there's no card, ask the owner for them and add one. Numbers go in as +1…, emails lowercase.
- The email of their Apple account for the spaces' invites (often the same as one above; ask if it's not clear).

Their agent id is `uno-agent-<first name, lowercase>`. Use an existing family member's sealed agent as the model (`openclaw agents list`; not the admin, the group chat's or the fallback). For the first person there's none yet: use the `uno-agent-sam` entries in `~/uno/docs/agents.example.json` (a person before their own spaces are unlocked).

## Set it up

1. Create the agent: `openclaw agents add <id> --workspace ~/.openclaw/workspace-<id> --non-interactive`.
2. Seal it like the model: `openclaw config get agents.entries.<model> --json` (or the template), then patch `agents.entries.<id>` with the same `sandbox`, `identity`, `memory` and `tools`, except what was unlocked for that person alone: take `apple_notes` and `apple_files` out of `tools.sandbox.tools.allow` and put them in both deny lists (their own spaces come later), and keep `apple_pim_mail` in the allow list only if they have an email.
3. The plugins that scope it (one patch):
   - `plugins.entries.uno-family-memory.config.names.<id>`: their first name.
   - `plugins.entries.uno-apple-tools.config.agents.<id>`: `{ "maps": true, "music": true }`.
   - `plugins.entries.uno-guard.config.mailAddresses.<id>`: their emails.
   - `plugins.entries.uno-guard.config.spaces.<id>`: `"<First name> and Uno"` for `reminders`, `calendar`, `notes` and `files`.
4. Their Apple filter: create `~/.openclaw/uno-data/pim/<id>/` (mode 700) with `config.json` (mode 600), modeled on the model's file: reminders and calendars in `"allowlist"` mode with just the family's list and calendar (`familySpaces`), contacts off, mail on if they have an email.
5. Their workspace: copy SOUL.md, AGENTS.md, IDENTITY.md, REPLY.md and CALL.md from `~/uno/workspace/`, and `avatars/uno.jpg` from yours if you have one. Write their USER.md: the "Setup isn't finished" line from `~/uno/workspace/USER.start.md`, then who they are (name, not the owner) and the household lines from your own USER.md (town, who set you up and how they're related).
6. Let them text you: add their handles to `accessGroups.family.members.imessage`, and add one binding per handle: `{ "agentId": "<id>", "match": { "channel": "imessage", "accountId": "*", "peer": { "kind": "direct", "id": "<handle>" } } }`. Write the whole lists back.
7. Restart (uno-admin) and run `openclaw doctor --lint`.
8. Prove it: `openclaw agents bindings --agent <id>` shows each of their handles, `openclaw skills list --agent <id>` shows first-chat ready, and their Apple filter file reads back. Then run setup-check; the owner asked for this person, so save the result as the approved setup.

## Then

- Their shared spaces: the share-spaces skill creates the four "<First name> and Uno" spaces and sends the invites. Their setup note tells their Uno the invites are on the way. After they accept, unlock them (uno-admin).
- The family group chat: if the owner wants them in it, the owner adds them in Messages. They're already allowed there as family.
- Tell the owner in a few lines: they can text you now, their first chat welcomes them, and which invites are on the way.
