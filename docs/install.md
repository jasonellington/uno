# Install guide

Every step, setting and command to turn a Mac into Uno. Built and tested on OpenClaw 2026.9.6, imsg 0.15.9 and macOS 27 with Xcode 27. Install those versions: a newer OpenClaw usually works, but its plugins change with it, so check each setting against the docs that ship with your version (`$(npm root -g)/openclaw/docs`).

Placeholders: `+15555550100` / `owner@example.com` are the owner's iMessage handles, `Alex` is the owner's name, `uno@example.com` is Uno's own Apple ID email, `uno` is the macOS account, and `main` is the owner's agent (OpenClaw's default first agent).

Sections 1 to 9 get the owner's Uno working over iMessage. After that come the optional parts: screen control, calls, custom emoji reactions, and the family ([people.md](people.md)).

## 1. The Mac

- A Mac that stays on (a Mac mini is ideal), on Ethernet, with FileVault on. After a power loss someone has to log in before Uno runs again.
- An administrator account for yourself, and a separate account (`uno`) where everything Uno-related runs.
- A separate Apple ID for Uno, signed in to Messages in the `uno` account (Messages in iCloud off). Turn on iCloud Drive, Calendars, Contacts, Notes and Reminders for it, and add its iCloud mail to Mail.app (Uno's mail tools need Mail running).
- Homebrew, git, and Node 24.16+ or 26.1+ (26 is what OpenClaw recommends). Pin them (`brew pin`) so they don't update by surprise.
- This repo at `~/uno` (the owner's Uno keeps its own setup up to date from there): `git clone <repo-url> ~/uno`.

## 2. iMessage bridge (imsg)

```sh
brew install steipete/tap/imsg && brew pin imsg
```

Reactions, read receipts, typing and threaded replies need imsg's Private API helper loaded into Messages, which requires SIP and library validation off (a real reduction in system protection; read imsg's docs and decide). Grant Full Disk Access to imsg and to node (macOS checks the responsible process, and the gateway runs under node).

Keep the helper loaded with the bridge LaunchAgent:

```sh
cd ~/uno
mkdir -p ~/.openclaw/uno-data/watchdog ~/Library/Logs/openclaw
cp watchdog/imsg-bridge-check.sh ~/.openclaw/uno-data/watchdog/ && chmod 755 ~/.openclaw/uno-data/watchdog/imsg-bridge-check.sh
sed "s#__HOME__#$HOME#g" watchdog/ai.uno.imsg-bridge.plist.template > ~/Library/LaunchAgents/ai.uno.imsg-bridge.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.uno.imsg-bridge.plist
imsg status --json    # "v2_ready": true
```

It checks every 60 s and runs `imsg launch --force` only when the helper isn't ready, under a lock so two launches never race. (`--force` matters: a plain launch can leave Messages running with a dead helper and never recover.) By hand: `lockf -t 30 /tmp/ai.uno.imsg-bridge.lock imsg launch --force`.

Stock imsg sends the six standard tapbacks. Reactions with any other emoji (🔥 🎉 👀) need a patched imsg ([Custom emoji reactions](#custom-emoji-reactions)); without it, Uno uses a standard one instead.

## 3. OpenClaw

```sh
npm install -g openclaw@2026.9.6 --allow-scripts=openclaw
openclaw onboard --install-daemon
```

In onboarding, choose local mode with the gateway on loopback, and sign in to OpenAI with your ChatGPT account. Onboarding creates the first agent, `main`, and the gateway's LaunchAgent; this guide treats `main` as the owner's agent. Other agents (one per family member) don't sign in: any agent without a login of its own uses `main`'s ChatGPT sign-in, so everyone shares the one subscription. Never sign an agent in separately, because a local login overrides the shared one.

```sh
openclaw agents set-identity --agent main --name Uno
openclaw models set openai/gpt-6-sol
openclaw models status
```

Never set `OPENAI_API_KEY` if you use a ChatGPT sign-in, and leave `plugins.entries.codex.config.appServer.homeScope` at `agent`.

## 4. Plugins

Install the plugins before the settings that configure them. Official plugins must match your OpenClaw version: a newer plugin release refuses to install on an older OpenClaw, so pin them.

```sh
openclaw plugins install @openclaw/imessage@2026.9.6 --pin
openclaw plugins install @openclaw/codex@2026.9.6 --pin
openclaw plugins install @openclaw/brave-plugin@2026.9.6 --pin
openclaw plugins install @openclaw/lobster@2026.9.6 --pin
openclaw plugins install clawhub:apple-pim-cli --accept-capabilities
git clone https://github.com/omarshahine/apple-pim ~/src/apple-pim && (cd ~/src/apple-pim && ./setup.sh --install)
cd ~/uno && for p in uno-guard uno-imsg-proxy uno-family-memory uno-apple-tools; do
  openclaw plugins install ./plugins/$p --force --accept-capabilities
done
openclaw doctor --fix --non-interactive
```

| Plugin | What it's for |
|---|---|
| `imessage`, `codex` | The iMessage channel; the Codex harness that runs the model on your ChatGPT sign-in |
| `brave-plugin` | Web search |
| `lobster` | Workflows that stop for an approval |
| `apple-pim-cli` (ClawHub, community) | Calendar, Reminders, Contacts and Mail, through apple-pim's Swift CLIs (`setup.sh --install` puts them in `~/.local/bin`) |
| `uno-guard` | The guardrails: whom Uno texts and emails, approvals, purchases, per-person scoping, the household setup note ([README](../plugins/uno-guard/README.md)) |
| `uno-imsg-proxy` | Uno's iMessage style: tapbacks, typing, bubbles, link previews, the reply-shape notes ([README](../plugins/uno-imsg-proxy/README.md)) |
| `uno-family-memory` | Shared family memory, shared skills and the USER.md save tool ([README](../plugins/uno-family-memory/README.md)) |
| `uno-apple-tools` | Notes, Maps, Music and Files as tools, scoped per agent |

Always an installed copy, never `--link` and never `plugins.load.paths`: a load path outranks the installed copy and ties the live system to this repo. A local-path install logs one "no authoritative package-owner metadata" warning; that's expected. A failed install can leave a folder behind that blocks the retry; rerun it with `--force`. `doctor --fix` finishes the Codex plugin's settings upgrade.

## 5. Settings

Secrets live in files, never in `openclaw.json`. Create them yourself:

```sh
mkdir -p ~/.openclaw/secrets ~/.openclaw/uno-data && chmod 700 ~/.openclaw/secrets
openssl rand -hex 32 > ~/.openclaw/secrets/gateway-token.txt
# Paste your Brave Search API key into ~/.openclaw/secrets/brave-api-key.txt
chmod 600 ~/.openclaw/secrets/*
```

The fallback agent answers no one: anyone who reaches Uno without a binding of their own lands there and gets nothing. Create it before the settings that seal and bind it:

```sh
openclaw agents add uno-agent-fallback --workspace ~/.openclaw/workspace-uno-agent-fallback --non-interactive
```

[`settings.example.json`](settings.example.json) holds every setting below as an OpenClaw batch file. Copy it out of the repo, put in your handles, name and Uno's email, then:

```sh
cp ~/uno/docs/settings.example.json ~/.openclaw/uno-data/settings.json
openclaw config set --batch-file ~/.openclaw/uno-data/settings.json --dry-run
openclaw config set --batch-file ~/.openclaw/uno-data/settings.json
openclaw config set plugins.allow "$(openclaw plugins list --enabled --json | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).plugins.map(p => p.id))')" --strict-json
openclaw gateway restart
```

`plugins.allow` lists the plugins in use, so a new one loads only once you add it (the setup check flags a change). One warning is expected: `channels.apple-mail.allowFrom` is empty, so the mail channel admits no one (see "Quiet and safe by default").

### Who can talk to Uno

| Path | Value | Why |
|---|---|---|
| `channels.imessage.dmPolicy` | `allowlist` | Only listed handles get replies; everyone else is dropped before Uno sees them |
| `channels.imessage.allowFrom` | the owner's handles | The allowlist. Never `"*"` |
| `channels.imessage.groupPolicy` | `disabled` | No group chats. An empty `groups` list does not block groups; this does |
| `commands.allowFrom.imessage` | the owner's handles | Who can run slash commands |
| `commands.ownerAllowFrom` | the owner's handles as `imessage:<handle>` | Marks the owner for owner-only commands (`/config`, `/restart`, `/update`) and standing intents |
| `approvals.plugin` | enabled, `mode: "targets"`, the owner's phone as the target | Native approval prompts in the owner's chat (👍 allow once, 👎 deny); uno-guard asks before texts, email and invites to anyone outside the family and before purchases over the limit |
| `commands.config` | `true` | The owner can change settings from chat (`/config`); `channels.imessage.configWrites` stays at its default (on) |
| `bindings` | the owner's handles → `main` (exact peer matches), then everyone else → `uno-agent-fallback` | Which agent answers whom. The channel-wide fallback binding goes last |
| `agents.entries.uno-agent-fallback` | sandboxed, no workspace, only the tool `uno_fallback_no_tools` (which doesn't exist) | Answers nobody; `plugins.entries.uno-guard.config.fallbackAgentId` ends its turns before the model runs |
| `session.dmScope` | `per-channel-peer` | One session per person per channel |
| `session.identityLinks` | the owner's phone and email as one person | Both handles share a session |
| `tools.sessions.visibility` | `self` | Agents see only their own sessions |
| `tools.agentToAgent.enabled` | `false` | No agent-to-agent messaging |
| `agents.defaults.systemAgent`, `talk.agentId`, `agents.defaults.heartbeat.agentId` | `main` | Admin-only surfaces point at the owner's agent |

### Model and speed

| Path | Value | Why |
|---|---|---|
| `agents.defaults.models.openai/gpt-6-sol.params.thinking` | `low` | Reasoning effort (the Codex default is medium) |
| `agents.defaults.utilityModel`, its `thinking` | `openai/gpt-6-luna`, `medium` | The smaller model for OpenClaw's own background jobs |
| `agents.defaults.fastModeDefault` | `true` | Priority tier on every call (overrides `serviceTier`) |
| `plugins.entries.codex.config.appServer.serviceTier` | `priority` | Native Codex tier, used when no Fast policy applies |
| `plugins.entries.codex.config.codexDynamicToolsLoading` | `direct` | OpenClaw tools in the first prompt; no lookup call per tool |
| `agents.defaults.reasoningDefault` | `off` | Display only: reasoning text isn't shown |

### Replies

| Path | Value | Why |
|---|---|---|
| `messages.visibleReplies` | `automatic` | OpenClaw delivers the model's final text |
| `channels.imessage.streaming` | block on, `chunkMode: newline`, coalesce idle 0 | One bubble per paragraph |
| `agents.defaults.blockStreamingChunk` | min 1, max 1500, paragraph | Chunk sizes |
| `agents.defaults.humanDelay.mode` | `natural` | A human pause between bubbles |
| `agents.defaults.typingMode` | `never` | uno-imsg-proxy shows typing itself |
| `channels.imessage.actions` | reactions, reply, effects (`sendWithEffect`) and attachments on; edit, unsend, polls and group actions off | What Uno may do in Messages |
| `channels.imessage.sendReadReceipts` | `true` | "Read" shows when a turn starts |
| `channels.imessage.includeAttachments` | `true` | Photos and voice memos reach the model (inbound only) |
| `session.resetByType.direct` | daily at 4 | A fresh thread each day; the session-memory hook keeps a summary |
| `hooks.internal.entries.session-memory.enabled` | `true` | That hook (hooks are opt-in) |

### Search

| Path | Value | Why |
|---|---|---|
| `secrets.providers.brave_key_file` | file `~/.openclaw/secrets/brave-api-key.txt`, singleValue | The key never sits in openclaw.json |
| `plugins.entries.brave.config.webSearch` | apiKey = SecretRef to that provider (`id: "value"`), mode `web` | Brave Search |
| `tools.web.search.provider` | `brave` | Fast raw results with dates; the persona asks for past-day freshness on news |

### Quiet and safe by default

| Path | Value | Why |
|---|---|---|
| `agents.defaults.heartbeat` | `every: "0m"`, target `none` | No recurring heartbeat until proactive work exists |
| `skills.workshop` | unset (defaults: autonomous `auto`, approval `auto`) | Uno writes and maintains its own skills |
| `gateway.auth.token` | file SecretRef, provider `gateway_token_file` → `~/.openclaw/secrets/gateway-token.txt` | No plaintext token in openclaw.json |
| `tools.deny` | nodes, mobile_ui, file_fetch, file_write, dir_list, dir_fetch, node_inference, dashboard, portal, theme, terminal, progress_card, canvas, talk_voice, conversations_list/send/turn, agents_list, github_identity_status, typesafe_evaluate, codex_plugins (no native Codex plugins) | Tools for paired devices, the web dashboard, voice and other agents that Uno doesn't use; ~20k fewer characters per turn |
| `agents.entries.main.tools.exec.host` | `gateway` | Shell commands run on the gateway, never on a paired app (which may be asleep) |
| `plugins.entries.apple-pim-cli.config.binDir` | `~/.local/bin` | Where apple-pim's Swift CLIs live |
| `channels.apple-mail` | `selfAddresses: ["uno@example.com"]`, `dmPolicy: "allowlist"`, `allowFrom: []` | apple-pim's mail channel, closed: it admits no one. It has to stay configured: unset, it crash-loops on the missing address, and disabling it turns off every apple_pim tool. uno-guard also tells Uno its own address from here |
| `plugins.entries.memory-core.config.dreaming.enabled` | `true` | Nightly (3:00) memory promotion into MEMORY.md, log in DREAMS.md |
| `plugins.entries.memory-core.config.memoryPolicy.excludeSessions.chatTypes` | `["group"]` | Group chats never become anyone's private memory |
| `plugins.entries.codex.config.sessionCatalog.enabled`, `plugins.entries.anthropic.config.sessionCatalog.enabled` | `false` | Uno never lists or opens the Mac's own coding-agent sessions |
| `agents.defaults.skills` | unset (no allowlist) | Every eligible skill is available, including ones Uno writes |
| `skills.entries.notion.enabled`, `skills.entries.coding-agent.enabled` | `false`, `true` | Notion off; coding-agent on (it delegates coding to the Codex CLI, section 7) |
| `skills.entries.imsg.enabled` | `false` | The iMessage plugin's own imsg skill sends around uno-guard's send check |
| `cron.failureAlert.enabled` | `false` | Failures go to Healthchecks, not the chat |
| `browser.allowSystemProfileImport` | unset (default on) | Uno's browser may import a local Chrome profile's logins |
| `memory.search.extraPaths` | unset (empty) | No global shared folders; shared family memory is added per agent (below) |

### Shared family memory and skills

Each agent keeps its own private memory. Household and family facts live in one shared store that every agent searches; the `uno-family-memory` plugin is the only way to add to it ([README](../plugins/uno-family-memory/README.md)).

| Path | Value | Why |
|---|---|---|
| `agents.entries.<id>.memory.search.extraPaths` | `["/Users/<you>/.openclaw/uno-data/family-memory"]` (absolute, no symlinks) for every agent | `memory_search` and `memory_get` find shared facts next to the agent's own. Per agent, so the global list stays empty |
| `skills.load.extraDirs` | `["/Users/<you>/.openclaw/uno-data/shared-skills"]` | Skills one Uno shares (`shared_skill_save`) reach every agent |
| `agents.entries.<id>.tools.sandbox.tools.allow` | add `shared_memory_save`, and `profile_save` for a person's own agent (not the read-only group agent) | Sandboxed agents only; unsandboxed agents on the `full` profile have them already |
| `plugins.entries.uno-family-memory.config.dir` | unset (default `~/.openclaw/uno-data/family-memory`) | Outside every workspace, so no agent's file tools reach it |
| `memory-wiki`, `active-memory` | disabled (defaults) | A global wiki vault in bridge mode would compile one agent's memory into a vault every agent reads |

After adding the path to an agent, rebuild its index right away: `openclaw memory status --index --agent <id>`. Until then OpenClaw pauses that agent's memory search ("index scope changed"), and the model may tell the person about it.

### The Uno plugins

| Path | Value | Why |
|---|---|---|
| `plugins.entries.uno-guard.enabled`, `uno-imsg-proxy`, `uno-family-memory`, `uno-apple-tools` | `true` | All four are needed |
| `plugins.entries.uno-imsg-proxy.hooks.allowConversationAccess`, `plugins.entries.uno-guard.hooks.allowConversationAccess` | `true` | Lets their prompt and reply hooks run: the reply-shape notes (REPLY.md, CALL.md), the household setup note, the fallback agent's silence. Without it OpenClaw blocks those hooks |
| `plugins.entries.uno-guard.config.adminAgentId` | `main` | The owner's agent: unscoped, and the one whose chat approves. Unset: no admin |
| `plugins.entries.uno-guard.config.ownerName` | `Alex` | Who other people are told to contact, and the setup note's owner |
| `plugins.entries.uno-guard.config.fallbackAgentId` | `uno-agent-fallback` | The agent whose turns end silently |
| Household settings under `plugins.entries.uno-guard.config` | see [uno-guard](../plugins/uno-guard/README.md) | Shared sites, purchases, spaces, mail addresses, approvals |
| `plugins.entries.uno-imsg-proxy.config.imsgPath`, `plugins.entries.uno-guard.config.logDir` | defaults `/opt/homebrew/bin/imsg`, `~/.openclaw/uno-data` | Only if yours differ |

## 6. Persona

Start each agent's `USER.md` from [`workspace/USER.start.md`](../workspace/USER.start.md) (one line: setup isn't finished). Uno fills it in during the first chat, starting from the owner's contact card; [`workspace/USER.example.md`](../workspace/USER.example.md) shows a finished one. Then copy the files in:

```sh
cd ~/uno/workspace
for ws in ~/.openclaw/workspace ~/.openclaw/workspace-uno-agent-fallback; do
  cp SOUL.md AGENTS.md IDENTITY.md REPLY.md CALL.md "$ws"/ && rm -f "$ws"/BOOTSTRAP.md
done
cp USER.start.md ~/.openclaw/workspace/USER.md
mkdir -p ~/.openclaw/skills ~/.openclaw/workspace/skills
cp -R skills/* ~/.openclaw/skills/            # every agent loads these; they outrank bundled skills of the same name
cp -R owner-skills/* ~/.openclaw/workspace/skills/
openclaw config unset skills.entries.apple-notes    # onboarding may have turned off the bundled apple-notes skill, which shares the name of Uno's
openclaw gateway restart
```

`IDENTITY.md` names the avatar `avatars/uno.jpg` in the workspace; put a square image there if you want one (it isn't in the repo). After this, the owner's Uno keeps these files up to date itself (uno-admin skill); never copy over `USER.md` or memory.

## 7. Tools Uno runs

```sh
npm install -g @steipete/summarize @openai/codex
codex login
```

`summarize` gets the text or transcript of articles, videos and podcasts (Uno writes the summary itself). The Codex CLI is what the coding-agent skill hands coding work to.

## 8. Health checks and backups

Create checks on [Healthchecks.io](https://healthchecks.io) (up, errors, unknown sender) and put their ping URLs in `~/.openclaw/uno-data/healthchecks.env` (0600):

```
HC_UP_URL=https://hc-ping.com/…
HC_ERRORS_URL=https://hc-ping.com/…
HC_UNKNOWN_URL=https://hc-ping.com/…
```

Then install the scripts and schedule them in OpenClaw (a command job makes no model call):

```sh
cd ~/uno
cp watchdog/healthping.js watchdog/unknown-senders.js watchdog/package.json watchdog/backup-archive.sh ~/.openclaw/uno-data/watchdog/
openclaw automations add --name uno-healthping --every 5m \
  --command-argv '["/opt/homebrew/bin/node","'"$HOME"'/.openclaw/uno-data/watchdog/healthping.js"]' \
  --command-cwd ~/.openclaw/uno-data/watchdog --timeout-seconds 120 --no-deliver
openclaw automations runs --id <job id>
```

`--no-deliver` matters: jobs announce their output by default. If the gateway dies, the pings stop, which is what makes Healthchecks email you.

- **up**: gateway health ok, iMessage running and connected, and imsg's helper ready (down only after two misses in a row).
- **errors**: ERROR lines in the gateway log and failed automation runs since the last check (counts only, never log text).
- **unknown sender**: anyone texting Uno who isn't allowed (`allowFrom` for one-on-one chats; `groupAllowFrom`, or `allowFrom` while that's unset, in groups; `accessGroup:` entries count their members), or any message in a group that isn't approved. One alert per sender per hour, logged to `unknown-senders.jsonl` without message text.

Backups: a daily snapshot of OpenClaw's databases into a local Git repository, and a weekly full archive (config, credentials, sessions, workspaces) that keeps the newest 8 and moves older ones to the Trash.

```sh
openclaw backup git init --repository ~/Backups/openclaw-git
openclaw backup enable --repository ~/Backups/openclaw-git
openclaw automations add --name uno-backup-archive --cron "30 4 * * 0" \
  --command-argv '["/bin/zsh","'"$HOME"'/.openclaw/uno-data/watchdog/backup-archive.sh"]' \
  --timeout-seconds 600 --no-deliver
```

## 9. Check

Text the owner's Uno "check your setup". Its setup-check skill reads the settings, runs `openclaw security audit`, and compares them with the approved copy in `~/.openclaw/uno-data/approved-setup/` (the first time, it saves one once you OK it).

## Screen control (the Mac app)

Uno signs in to family sites through the Passwords extension, and shares Calendars with the Share button, by controlling the Mac's screen. That's OpenClaw's `computer` tool, served by the OpenClaw Mac app paired as a node. Optional: everything else works without it.

1. Get `OpenClaw-<version>.dmg` from [OpenClaw's releases](https://github.com/openclaw/openclaw/releases) and install it. If it keeps relaunching from an App Translocation copy, clear its quarantine flag (`xattr -dr com.apple.quarantine /Applications/OpenClaw.app`).
2. Run it under its own profile, as a client of the local gateway: `open -n --env OPENCLAW_PROFILE=unomac /Applications/OpenClaw.app`, and connect it to `ws://127.0.0.1:18789` with the gateway token. Its own config (`~/.openclaw-unomac/openclaw.json`, 0600) keeps a copy of the token: the default profile can't sign in, because its local mode reads `gateway.auth.token` as plain text and ours is a file SecretRef. Never run `openclaw-mac primary set --direct-url …` on the default profile: it switches the gateway's own config to remote mode and the gateway stops.
3. Approve the pairing: `openclaw nodes pending`, then `openclaw nodes approve <id>`.
4. Grant OpenClaw Accessibility and Screen Recording, and keep the app's Allow Computer Control on (OpenClaw docs: `nodes/computer-use.md`).
5. Start it at login: `cp ~/uno/watchdog/ai.uno.openclaw-unomac.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.uno.openclaw-unomac.plist`.

## Calls

FaceTime audio calls with Uno: the same agent, memory and tools as texting, out loud. Each call is its own session, so it doesn't continue (or show up in) the text thread. It uses OpenClaw's experimental FaceTime plugin, and the calls are still rough. Optional.

What it costs: the voice is a realtime model on an API key, billed per use; the ChatGPT sign-in doesn't cover FaceTime. This guide uses OpenAI's `gpt-realtime-2.1-mini`. OpenClaw's FaceTime docs also list Google's Gemini Live, with a Gemini API key (not tried here; it has a free tier, but Google may use free-tier data to improve its products). Only the owner's handles (`ownerHandles`) are answered.

Install the plugin, its helper and the patch first:

```sh
openclaw plugins install @openclaw/facetime@2026.9.6 --pin
brew install openclaw/tap/openclaw-facetime
cd "$(openclaw plugins inspect facetime --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).plugin.rootDir')"
patch -p1 < ~/uno/patches/facetime-2026.9.6.patch
```

Then prepare the Mac with OpenClaw's FaceTime docs (`$(npm root -g)/openclaw/docs/plugins/facetime.md`, "Prepare the Mac"): full Xcode, developer-tools access, debugger attachment, Screen & System Audio Recording, the audio driver (`openclaw gateway call facetime.installDriver --json`, after the patch), and `OpenClaw-Mic` as FaceTime's microphone. Then the settings:

```sh
# Put your OpenAI API key in ~/.openclaw/secrets/openai-voice-key.txt (0600). Never OPENAI_API_KEY.
cp ~/uno/docs/settings.calls.example.json ~/.openclaw/uno-data/settings.calls.json   # your handles
openclaw config set --batch-file ~/.openclaw/uno-data/settings.calls.json
openclaw config set plugins.allow "$(openclaw plugins list --enabled --json | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).plugins.map(p => p.id))')" --strict-json
openclaw gateway restart
openclaw gateway call facetime.setup --json    # lists anything still missing
```

The patch ([`patches/facetime-2026.9.6.patch`](../patches/facetime-2026.9.6.patch)) fixes what made calls unusable here: on macOS 27 a call never registered as ended, so the next call wasn't answered until a gateway restart; a repeated request from the voice cancelled the tool work in progress, so answers never arrived; and the driver didn't build with Xcode 27. It also makes the greeting casual. Apply it again after every install or update of the plugin.

| Path | Value | Why |
|---|---|---|
| `plugins.entries.facetime.config.ownerHandles` | the owner's handles | Who gets answered |
| `…realtime.provider`, `model`, `voice` | `openai`, `gpt-realtime-2.1-mini`, `marin` | The voice. A GA realtime model: GPT-Live models can't call tools here |
| `…realtime.providers.openai.apiKey` | file SecretRef, provider `openai_voice_key_file` → `~/.openclaw/secrets/openai-voice-key.txt` | Scoped to FaceTime |
| `…realtime.sessionKey` | `agent:main:facetime` | A session that doesn't exist, so each call starts fresh instead of forking the text thread |
| `…realtime.toolPolicy` | `owner` | The owner's own tools on calls |
| `…realtime.instructions` | Uno, out loud (in the example file) | The voice is the same Uno as in SOUL.md; CALL.md shapes the agent's answers for speech |

## Custom emoji reactions

Stock imsg can't send tapbacks beyond the standard six, and upstream hasn't taken a change for it. [`patches/imsg-custom-emoji-tapback.patch`](../patches/imsg-custom-emoji-tapback.patch) adds them (made on 0.15.9, applies cleanly to 0.15.10). Optional: without it, Uno uses one of the six.

```sh
git clone https://github.com/openclaw/imsg.git ~/src/imsg && cd ~/src/imsg
git checkout v0.15.10
git apply ~/uno/patches/imsg-custom-emoji-tapback.patch
make build && make build-dylib
```

Install `bin/imsg`, the resource bundles beside it and `.build/release/imsg-bridge-helper.dylib` together in one folder, and make that `imsg` the one on your PATH instead of Homebrew's (`brew unlink imsg`; a symlink to the binary works). Grant that binary Full Disk Access; it's ad-hoc signed, so every rebuild needs a new grant. Then `imsg launch --force` (loads the new helper into Messages), check that `imsg tapback --help` lists `--emoji` and `imsg status --json` says `"v2_ready": true`, and `openclaw gateway restart`.

## Updating OpenClaw

```sh
openclaw update --tag <version> --dry-run
openclaw update --tag <version>
openclaw plugins update
```

1. `openclaw config set --batch-file ~/.openclaw/uno-data/settings.json --dry-run` flags renamed or removed settings.
2. Reapply the FaceTime patch if you use calls (a new plugin version may need a new patch).
3. `npm test`, then have the owner's Uno run its setup check.
4. From the phone: a "thanks" (tapback), a lone link (preview), a news question, a "text me at…", and a custom emoji if you built the patched imsg.

Most likely to need attention: tool names in `workspace/AGENTS.md`, the plugins' hooks, and Codex-specific settings.

## Rolling back

- A setting: `openclaw config set` the old value (or `config unset`), then `openclaw gateway restart`.
- The persona: `git revert`, then copy the files in again (section 6).
- A Uno plugin: install the previous commit's folder with the same command.
- The model: `openclaw models set <model>`, then restart.

## After a reboot

Log in to the `uno` account. The LaunchAgents start OpenClaw, the Mac app and the bridge check, and reload imsg's helper within a minute; the healthping job resumes with the gateway. Check with `openclaw channels status --probe` and `imsg status --json`.
