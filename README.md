# Uno

Uno is a personal iMessage assistant you run yourself: a Mac with its own
macOS account and its own Apple ID, answering texts through
[OpenClaw](https://docs.openclaw.ai). It's a someone, not a something: warm,
quick, a little dry, and it uses the Apple apps (Messages, Mail, Reminders,
Calendar, Contacts, Notes, iCloud Drive, Maps, Music, FaceTime) the way a real
assistant would. One Uno serves a whole household: each person gets a private
Uno of their own, and the family shares a group chat and a memory.

This repo is a template. It holds the parts that turn an OpenClaw install
into Uno: the persona, four plugins, the health checks and backups, patches
for imsg and OpenClaw's FaceTime plugin, and a guide to every setting.
OpenClaw itself runs unmodified.

**Quick start:** follow [docs/install.md](docs/install.md). How the pieces
fit: [docs/architecture.md](docs/architecture.md). People, sealed rooms and the family group chat: [docs/people.md](docs/people.md).

## Layout

| Folder | What |
|---|---|
| `workspace/` | The persona: `SOUL.md` (who Uno is), `AGENTS.md` (the rules: trust, privacy, honesty, approvals; memory, sending, tools, Apple apps), `IDENTITY.md` (the name), `REPLY.md` and `CALL.md` (the shape of a reply in a chat and on a call), `skills/` (Notes, Maps, Music, files and photos, first chat, what Uno can do), `USER.start.md` (the per-person file before the first chat), `USER.example.md` (a filled-in one) |
| `plugins/uno-guard/` | Uno's guardrails: whom it texts and emails, approvals, purchases, per-person scoping, the setup note ([README](plugins/uno-guard/README.md)). The owner's Uno never changes it |
| `plugins/uno-imsg-proxy/` | Uno's iMessage style (the owner's Uno may change it): reaction targets, custom emoji, typing, bubbles, error scrubbing, link previews, the reply-shape notes ([README](plugins/uno-imsg-proxy/README.md)) |
| `plugins/uno-family-memory/` | Shared family memory, shared skills and the USER.md save tool ([README](plugins/uno-family-memory/README.md)) |
| `plugins/uno-apple-tools/` | Notes, Maps, Music and Files as tools, each scoped to the person's own spaces |
| `patches/` | Changes to two upstream pieces: imsg (custom emoji tapbacks) and OpenClaw's FaceTime plugin (calls that end, tool answers that arrive). Both optional; the install guide says how |
| `watchdog/` | Scripts that run beside OpenClaw: `healthping.js` (Healthchecks.io pings plus the unknown-sender watcher, run as an OpenClaw command job), `imsg-bridge-check.sh` (keeps imsg's helper loaded), `backup-archive.sh` (the weekly full backup), LaunchAgents for the bridge check and the Mac app |
| `workspace/owner-skills/` | Skills only the owner's Uno gets: running its own setup (`uno-admin`), adding a person (`add-person`), checking the setup (`setup-check`), sharing spaces (`share-spaces`), signing in to family sites for the family's Unos (`family-sign-in`) |
| `workspace/sites/` | A person's website helper: the chat agent's `site-change` skill, and the coder's and quality agent's instructions (`coder/`, `qa/` with its `site-quality` skill). Set up in `plugins/uno-guard` (`sites`) |
| `docs/` | [Install guide](docs/install.md) with every setting and command, the settings as batch files ([settings.example.json](docs/settings.example.json), [settings.calls.example.json](docs/settings.calls.example.json)), sealed-agent templates ([agents.example.json](docs/agents.example.json)), [architecture](docs/architecture.md), [people and the group chat](docs/people.md) |
| `test/` | Unit tests (`npm test`), evals that run real model turns and grade them by rules (`npm run eval`, cases in `test/evals/`), and the persona regression cases (`test/persona/tests.md`) |

## Everyday commands

```sh
npm test                                   # unit tests for the plugins and watchdog
openclaw security audit                    # OpenClaw's own safety audit
openclaw channels status --probe           # iMessage: "works"
imsg status --json                         # "v2_ready": true = reactions and read receipts work
```

## Working on Uno

The owner's Uno is the admin: setup changes (a setting, a new person,
shared spaces, the group chat, skill updates, restarts, the setup check)
run through it, by text, with its owner-only skills. There are no setup
scripts; everything uses OpenClaw's own commands.

Nothing live runs from this repo, so a commit changes nothing until it's
installed. Every change follows the same loop:

1. Change on master, `npm test`.
2. Commit.
3. Install the piece you changed (table below).
4. Restart the gateway if the table says so, ideally right after a health
   ping so the restart doesn't look like an outage.
5. `openclaw health --json`, `openclaw channels status --probe`, and the
   owner's Uno runs its setup-check skill.
6. Try it from the phone, one change at a time.

| You changed | Test with | Install with | Restart? |
|---|---|---|---|
| Persona and skills (`workspace/`) | `npm run eval`; `git grep` for anything personal | `cp`: SOUL/AGENTS/IDENTITY/REPLY/CALL into every agent's workspace, `skills/` into `~/.openclaw/skills/` (OpenClaw's managed skills), `owner-skills/` into the owner's workspace (uno-admin skill) | yes |
| A Uno plugin (`plugins/`) | `npm test` (rules are pure functions in `rules.js`) | `openclaw plugins install ./plugins/<plugin> --force --accept-capabilities` | yes |
| Watchdog scripts (`watchdog/`) | `npm test` | copy to `~/.openclaw/uno-data/watchdog/` | no |
| A setting | `openclaw config set … --dry-run` | `openclaw config set …`, then update docs/install.md | yes |

### Changing an existing feature

- **Persona:** the files in `workspace/` belong to the owner. `SOUL.md` is
  copied byte for byte and never reworded to satisfy a lint (report the
  lint instead). Changes to `AGENTS.md` and `IDENTITY.md` start as a diff
  with a reason per change. `USER.md` is per workspace and never synced.
- **Plugin:** put the decision in a pure function in `rules.js` with a
  test, and keep `index.js` to wiring (hooks, chat.db reads, imsg calls). A
  hook must never throw into a turn: on failure, fall through to the normal
  path. Never log message text.
- **Watchdog:** it runs without a login shell, so use absolute paths
  (`/opt/homebrew/bin/...`). healthping never sends log lines anywhere.

### Adding a new feature

Prefer, in this order:

1. **An OpenClaw setting.** Zero code, survives upgrades, and the
   setup-check skill can guard it. Look in OpenClaw's docs first.
2. **A skill** (bundled, or a local one read before installing). Loaded on
   demand, so it costs nothing until used.
3. **A plugin tool** (`uno-guard`, `uno-apple-tools`, `uno-family-memory`). For anything that
   must be enforced in code: scoping, approvals, owner-only actions.
4. **An `AGENTS.md` recipe.** Always loaded, so it costs prompt space on
   every turn, and it's a behavior rule, not enforcement. Best for short
   "how to use app X" notes.

Enforce in code what must never happen; leave the rest to the persona's
judgment.

## Rules for the persona

- Nothing personal in `workspace/`: no names, numbers or emails. Who Uno
  serves lives in each workspace's `USER.md`, which Uno fills in during the
  first chat (starts as `USER.start.md`; see `USER.example.md`). `git grep`
  for phone numbers and emails before committing.
- `USER.md` uses OpenClaw's directive format (dated Always/Never/Prefer entries, superseded in place); Uno keeps it up to date.

## License

MIT, see [LICENSE](LICENSE). imsg and OpenClaw are MIT too; the patches in `patches/` keep their notices.
