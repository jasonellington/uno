# People and the family group chat

One Uno, one gateway, a sealed room for each person. The owner's agent runs
on the Mac with every tool. Everyone else's agent runs in OpenClaw's Docker
sandbox (no network, only its own workspace) and reaches the Mac only
through gateway tools that the Uno plugins scope to that agent. OpenClaw's
own trust model is one trust boundary per gateway: this keeps family
members' private things apart, and people who'd attack each other need
separate Macs.

## What each person has

| | Owner | Family member | Family group chat |
|---|---|---|---|
| Agent | on the Mac, all tools | sealed agent of their own | sealed group agent |
| Memory | own + shared | own + shared | shared only (read-only workspace) |
| Browser | own profile; shared sites (`sharedSites`) in `family` | `family` profile | `family` profile |
| Apple lists, notes, files | everything | only what they shared with Uno | only what's unlocked for it |
| Email and invites | the family freely; anyone else with the owner's 👍 | no | no |
| Texting | the family; anyone else with the owner's 👍 | only their own chat | only the group |
| Skills | own + shared | own + shared; can share skills for shared sites | shared |
| Admin tools, other chats | yes | no | no |

Enforced in code or config: the sandbox and tool lists (the setup-check skill),
the browser profile and upload limits, the Apple filter lock, the purchase
block, texting only the family, email and invite approvals and the household
setup note (`plugins/uno-guard`), per-agent Apple
folders (`plugins/uno-apple-tools`), the USER.md save tool and the append-only shared memory tool
(`plugins/uno-family-memory`). Anyone without a binding lands on the
fallback agent, which never answers.

## Before the first person

The install guide's core setup ([install.md](install.md)) plus:

- **A container runtime and the sandbox image.** Every agent but the
  owner's runs in OpenClaw's Docker sandbox, and sandbox runs fail until
  the image exists. Install OrbStack (`brew install --cask orbstack`) or
  Docker Desktop, then build `openclaw-sandbox:bookworm-slim` with the
  command in OpenClaw's docs (`gateway/sandboxing/images-and-setup.md`,
  "From an npm install").
- **The family's browser.** `openclaw browser create-profile --name family`
  (and `--name sites` if you use the website helper). Sign the family
  profile in to the shared sites once. For family sign-in, install the
  iCloud Passwords extension in it and keep the family's logins in a shared
  "Family" folder in the owner's Passwords app; filling them takes the
  screen control in install.md.
- **The access group.** `accessGroups.family` (`type: "message.senders"`,
  members under `imessage`), referenced as `accessGroup:family` in
  `channels.imessage.allowFrom`. The add-person skill fills it in.
- **The first sealed agent.** add-person seals a new person's agent like an
  existing family member's. For the first one there's no model yet, so it
  uses [`agents.example.json`](agents.example.json): `uno-agent-sam` is a
  person before their spaces are unlocked, `uno-agent-family` the group agent.

## Putting someone live

Text the owner's Uno: "add <name>". Its owner-only add-person skill
creates their sealed agent with `openclaw agents add`, seals it like an
existing family member's (or the template), puts their handles in the
`family` access group (they can text Uno; only literal allowlist entries
can approve, so they can't approve anything), binds each handle to their
agent, and sends the invites for their own spaces (share-spaces). Once they
accept, "unlock <name>'s spaces" (uno-admin) opens them for their agent.

## What each Uno is told

Settings, not prompts, say how the household is set up. Every chat turn
carries a household setup note built from them (`plugins/uno-guard`
`householdNote`): whom it texts, email and invites, the shared sites and
whether placing orders is on, Uno's email address and whose mail reaches it,
and the spaces: `familySpaces` for everyone, `spaces.<agentId>` for one
person. A person's space shows as an invite waiting on their Accept until it's
unlocked for their agent. USER.md keeps only what's about the person.

## The family group chat

Create the group in Messages with everyone (all already live) and Uno's
address, send a message, then text the owner's Uno: "set up the family
group chat". Its uno-admin skill creates the group agent if there isn't one
(`uno-agent-family` in [`agents.example.json`](agents.example.json): sealed,
read-only workspace, shared memory only), turns group chats on for that chat
only, and binds it to the group agent. Every message in the group reaches
Uno, which stays quiet unless it has something to add
(`agents.defaults.silentReply.group: "allow"`, `requireMention: false`); a
message that names Uno always gets an answer. What the family settles there
goes to shared memory.
