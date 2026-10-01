# How Uno works

## One text, start to finish

```
The owner's iPhone
  → Apple's iMessage servers
  → Messages on the Mac, signed in as Uno's Apple ID
  → imsg: reads new messages from the Messages database; its helper,
          loaded into Messages, sends reactions, read receipts, typing
          and threaded replies
  → OpenClaw's iMessage plugin (official, unmodified)
  → OpenClaw gateway: who may text (allowlist), which agent answers
    (bindings), sessions, memory
       · uno-guard checks tool calls and outgoing messages here first
         (guardrails), then uno-imsg-proxy shapes them (style)
  → Codex engine → the model
       · tools: web search (Brave), web fetch, the browser, the Apple apps,
         reactions, scheduling
  → the reply goes back the same way, one bubble per paragraph
```

## Reactions and typing

Replies and reactions are the model's: it sees the whole conversation and the persona. AGENTS.md tells Uno to react with `message` → `react`; uno-imsg-proxy points each reaction at the sender's message (never Uno's own), sends custom emoji tapbacks through imsg (with the patched imsg; stock imsg sends the six standard ones), and turns a reply that is a lone emoji, or opens with one, into a tapback. In group chats every message reaches the model, which may stay quiet (`agents.defaults.silentReply.group: "allow"`); a message that names Uno always gets an answer.

Typing belongs to uno-imsg-proxy, not OpenClaw (`typingMode: "never"`). Uno shows typing while the model works and for a moment before each bubble. A browser task is slow, so its first browser call stops the typing and puts a 👀 on their message instead; the answer arrives with its own short typing pause. Web search doesn't count as a browser task.

- The plugins' prompt and reply hooks need `hooks.allowConversationAccess: true` (they see the message text).
- Emoji-only text and error text within 20 s of a tapback are dropped quietly. The check reads chat.db, because OpenClaw can run hooks in separate plugin copies that don't share memory.
- A react aimed at one of Uno's own messages is redirected to the sender's latest message (imsg labels a thread reply's target with the chat's handle even when Uno sent it).

## Calls

FaceTime audio calls go to the same agent as texts, with its memory and tools, through OpenClaw's FaceTime plugin: a realtime voice model talks, and asks the agent (`openclaw_agent_consult`) whenever it needs Uno to know or do something. Each call is its own session (`agent:main:facetime:<call>`), so it never continues the text thread. CALL.md, added next to each of the agent's messages on a call, keeps its answers speakable.

## What's stock and what's this repo

| Piece | Source | Lives at |
|---|---|---|
| OpenClaw gateway | Official, unmodified | global npm install (`openclaw`) |
| Plugins: iMessage, Codex, Brave, Lobster, FaceTime (official); apple-pim-cli (community) | Unmodified, except the FaceTime patch (`patches/`) | `~/.openclaw/npm/projects/` and `~/.openclaw/extensions/` |
| imsg | Official, or built with the custom emoji patch (`patches/`) | Homebrew, or your own build on PATH |
| Settings | [install guide](install.md), set with `openclaw config set` | `~/.openclaw/openclaw.json` |
| Persona | `workspace/` | SOUL/AGENTS/IDENTITY/REPLY/CALL copied into each agent's workspace; `skills/` into `~/.openclaw/skills/` (managed skills, every agent loads them); `owner-skills/` into the owner's workspace only |
| uno-guard (guardrails), uno-imsg-proxy (style), uno-family-memory, uno-apple-tools | `plugins/` | installed copies in `~/.openclaw/extensions/` |
| Health checks, bridge check | `watchdog/` | copies in `~/.openclaw/uno-data/watchdog/`, run by the OpenClaw command job `uno-healthping` (every 5 min) and the LaunchAgent `ai.uno.imsg-bridge` (every 60 s: `imsg launch --force` when the helper is down, and texts the owner "I'm offline" after two failed gateway health checks and "I'm back online" when it recovers) |
| Weekly full backup | `watchdog/backup-archive.sh` | copy in `~/.openclaw/uno-data/watchdog/`, run by the OpenClaw command job `uno-backup-archive` (Sundays 4:30): `openclaw backup create --verify` into `~/Backups/archives`, keeps the newest 8, older ones to the Trash. Daily database backups: OpenClaw's own scheduled Git backup to `~/Backups/openclaw-git` |

Nothing live runs from the repo, so a merge is never a deploy. Each install step is deliberate (README "Working on Uno").

## How the persona reaches the model

| File | Reaches the model | Who writes it |
|---|---|---|
| `SOUL.md` (voice and character) | every request | this repo, byte for byte |
| `AGENTS.md` (trust, privacy, honesty, approvals, memory, sending, tools, Apple apps) | every request | this repo |
| `IDENTITY.md` (the name) | every request | this repo |
| `REPLY.md` (a chat reply's shape), `CALL.md` (a call's) | next to each message, by uno-imsg-proxy's `before_prompt_build` hook: REPLY.md in a chat, CALL.md on a call | this repo |
| `skills/*/` (Notes, Maps, Music, files and photos, first chat; Calendar, Reminders, Contacts and Mail come from the apple-pim-cli plugin) | a one-line description every request; the body when the model uses the skill | this repo |
| `USER.md` (household, who this chat is with, tone, quiet hours, what's shared) | every request | Uno, in the first chat (starts as `USER.start.md`), then kept up to date as dated OpenClaw directives |

OpenClaw retired TOOLS.md: tool notes live in AGENTS.md's `## Tools`. Extra bootstrap files must sit inside each workspace and symlinks are rejected, so shared files are copied, and the setup-check skill compares them.

## Memory

- **Private:** each agent's own workspace memory (`MEMORY.md`, `memory/`, nightly dreaming), stock OpenClaw. Each agent has its own index and searches only its own workspace; dreaming reads and writes only that workspace. A sandboxed agent's file tools reach only its own workspace.
- **Shared family memory:** one file, `~/.openclaw/uno-data/family-memory/family.md`, outside every workspace. Every agent lists the folder in its `memory.search.extraPaths` (stock), so shared facts come up in `memory_search` like its own. Saves go through `shared_memory_save` (for a sandboxed agent, the only write outside its workspace) from [uno-family-memory](../plugins/uno-family-memory/README.md): it runs in the gateway, takes only text, and appends one dated line. AGENTS.md says when to use it: an explicit ask in a one-on-one chat, or the family group chat.
- Memory Wiki and Active Memory stay off.

## Setup check (the owner's Uno, `setup-check` skill)

The owner's Uno checks its own setup after every change and on request, read-only, with `openclaw config get` (never the config file, which holds the gateway token), `openclaw plugins list`, `openclaw security audit` and `openclaw channels status --probe`. The rules and the approved copy are in [`workspace/owner-skills/setup-check/SKILL.md`](../workspace/owner-skills/setup-check/SKILL.md): only the owner is the owner, who can text Uno, group chats, strangers land on the silent fallback, every other agent sealed (sandbox, deny lists, no cross-chat messages), approvals reach the owner, the guard plugins loaded, managed files identical to `workspace/`. Drift: the settings are compared with an approved copy in `~/.openclaw/uno-data/approved-setup/`, saved again only after the owner OKs a change.

## Health checks

`watchdog/healthping.js` runs every 5 minutes as an OpenClaw command job (no model call). It pings three Healthchecks.io checks: up (gateway, iMessage, imsg helper), errors (ERROR lines and failed automation runs, counts only), and unknown sender (`watchdog/unknown-senders.js`: reads new messages through imsg, compares senders with `channels.imessage.allowFrom` (one-on-one) or `groupAllowFrom` (groups; `accessGroup:` entries count their members) and groups with `channels.imessage.groups`, logs events without message text). Alerts go to email, never iMessage. If the gateway is down, the pings stop, and that is what makes Healthchecks alert.

## Known limits

- **Shell checks read the command text.** Uno's shell commands reach the plugins as OpenClaw's `exec` tool, so uno-guard logs them and asks before any that text or email; a send hidden in a script file isn't recognized.
- **Cold starts.** A gateway restart or a long gap empties the model's cache; the next reply takes a few seconds longer.
- **Calls are experimental.** The FaceTime plugin is new; the patch fixes the problems found here (calls that never ended, tool answers that never arrived), and a voice that hears itself can still misfire.

## What could break on an OpenClaw update

1. Tool names written into `workspace/AGENTS.md`. A rename makes Uno slower (it looks the tool up), not broken.
2. uno-guard's and uno-imsg-proxy's hooks: when they fire can change, especially under Codex.
3. Codex-specific settings (direct tool loading, reply delivery).
4. A newer iMessage plugin needing a newer imsg.
5. The FaceTime patch: a new plugin version may need a new one.
