# The owner and the family group chat

One Uno, one gateway. The owner texts Uno one-on-one; everyone else in the
family reaches Uno in the family group chat. The owner's agent runs on the
Mac with every tool. The group chat's agent runs in OpenClaw's Docker
sandbox (no network, a read-only workspace) and reaches the Mac only through
gateway tools that the Uno plugins scope to it. Anyone else who texts Uno
one-on-one gets no answer. OpenClaw's own trust model is one trust boundary
per gateway: people who'd attack each other need separate Macs.

## Who has what

| | Owner | Family group chat |
|---|---|---|
| Agent | on the Mac, all tools | sealed group agent |
| Memory | own + shared | shared only (read-only workspace) |
| Browser | own profile; shared sites (`sharedSites`) in `family` | `family` profile |
| Apple lists, notes, files | everything | only what's unlocked for it |
| Email and invites | the family freely; anyone else with the owner's 👍 | no |
| Texting | the family; anyone else with the owner's 👍 | only the group |
| Skills | own + shared | shared |
| Scheduled texts and check-ins | yes | one-time, back to the group |
| Admin tools, other chats | yes | no |

Enforced in code or config: the sandbox and tool lists (the setup-check skill),
the browser profile and upload limits, the Apple filter lock, the purchase
block, scheduling only one-time jobs back to the group (`schedulingAgents`), texting only the family, email and invite approvals and the household
setup note (`plugins/uno-guard`), per-agent Apple folders
(`plugins/uno-apple-tools`), the append-only shared memory tool
(`plugins/uno-family-memory`). One-on-one chats are allowed only from the
owner's handles (`channels.imessage.allowFrom`); anyone else who gets
through lands on the fallback agent, which never answers.

## Before the group chat

The install guide's core setup ([install.md](install.md)) plus:

- **A container runtime and the sandbox image.** The group agent runs in
  OpenClaw's Docker sandbox, and sandbox runs fail until the image exists.
  Install OrbStack (`brew install --cask orbstack`) or Docker Desktop, then
  build `openclaw-sandbox:bookworm-slim` with the command in OpenClaw's docs
  (`gateway/sandboxing/images-and-setup.md`, "From an npm install").
- **The family's browser.** `openclaw browser create-profile --name family`.
  Sign it in to the shared sites once. For family sign-in, install the
  iCloud Passwords extension in it and keep the family's logins in a shared
  "Family" folder in the owner's Passwords app; filling them takes the
  screen control in install.md.
- **The access group.** `accessGroups.family` (`type: "message.senders"`,
  members under `imessage`), referenced as `accessGroup:family` in
  `channels.imessage.groupAllowFrom` only, so family members can talk to Uno
  in the group but not one-on-one. Only literal allowlist entries can
  approve, so they can't approve anything.

## What each Uno is told

Settings, not prompts, say how the household is set up. Every chat turn
carries a household setup note built from them (`plugins/uno-guard`
`householdNote`): whom it texts, email and invites, the shared sites and
whether placing orders is on, Uno's email address and whose mail reaches it,
and the family's shared spaces (`familySpaces`). USER.md keeps only what's
about the owner.

## The family group chat

Create the group in Messages with the family and Uno's address, send a
message, then text the owner's Uno: "set up the family group chat". Its
uno-admin skill creates the group agent if there isn't one
(`uno-agent-family` in [`agents.example.json`](agents.example.json): sealed,
read-only workspace, shared memory only), turns group chats on for that chat
only, and binds it to the group agent. Every message in the group reaches
Uno, which stays quiet unless it has something to add
(`agents.defaults.silentReply.group: "allow"`, `requireMention: false`); a
message that names Uno always gets an answer. What the family settles there
goes to shared memory.
