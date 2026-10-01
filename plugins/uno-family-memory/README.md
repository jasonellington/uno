# uno-family-memory

Shared family memory: household and family facts that every agent can
recall, next to each agent's own private memory.

| Part | How | Native? |
|---|---|---|
| Private memory | Each agent's workspace (`MEMORY.md`, `memory/`, dreaming), unchanged | OpenClaw |
| Recall of shared facts | The store's folder is in each agent's `agents.entries.<id>.memory.search.extraPaths`, so `memory_search` and `memory_get` return shared facts alongside the agent's own | OpenClaw |
| Saving a shared fact | `shared_memory_save` (this plugin): appends one line to `<dir>/family.md` | custom |

Why a tool: a sandboxed agent can't reach any host path outside its
workspace, and it shouldn't. The tool runs in the gateway and takes only
`text`, never a path. It cleans the text to one line (no headings, no
HTML comments, no invisible characters, 500 characters max), adds the
date and where it came from (`one-on-one chat` or `family group chat`,
from the session key, not the model), skips exact duplicates, and appends
to one fixed file (created 0600, symlinks refused, 256 KB cap). It returns
only a one-line confirmation and never logs the text.

Code: `index.js` (the tool), `rules.js` (pure rules, unit-tested in
`test/uno-family-memory.test.js`).

Settings (`plugins.entries.uno-family-memory.config`):

| Key | Default | What |
|---|---|---|
| `dir` | `~/.openclaw/uno-data/family-memory` | The shared store. Keep it outside every agent workspace, and list the same absolute path in each agent's `memory.search.extraPaths` |
| `skillsDir` | `~/.openclaw/uno-data/shared-skills` | Shared skills. List the same absolute path in `skills.load.extraDirs` so every agent loads it |
| `sharedSites` | uno-guard's `sharedSites` | Sites a shared skill may name |
| `names` | none | Agent id → the person's first name, stamped on each shared note so everyone sees whose chat it came from (the add-person skill sets it) |

## Who gets it

- Unsandboxed agents on the `full` tool profile get the tool automatically.
- Adding the path to an agent changes its index scope: run
  `openclaw memory status --index --agent <id>` right after, or its memory
  search stays paused.
- A sandboxed agent needs `shared_memory_save` (plus `memory_search` and
  `memory_get`) in `agents.entries.<id>.tools.sandbox.tools.allow`. It needs
  no bind mount: memory tools and this tool run in the gateway, so the
  store never appears inside the container.
- When to save shared vs private is a behavior rule in `workspace/AGENTS.md`
  (Memory). What's enforced: the only write a sandboxed agent has outside
  its workspace is this append.

## shared_skill_save: skills for shared sites

A skill follows the permission it needs. One for a site everyone shares (the
logins in the family browser profile, `sharedSites`) can be shared; one for
anything that's only one person's stays theirs. Any agent can share: a new
skill (name, description, instructions) or one of its own skills by name
(`skill`, from its workspace `skills/` or its learned `workshop-skills/`).
The tool refuses a skill that names any site outside `sharedSites`, or none.
It writes `<skillsDir>/<name>/SKILL.md` (SKILL.md only, with a "shared by"
note) from the gateway, so a sandboxed agent needs no other write access;
every agent picks it up from its next conversation through
`skills.load.extraDirs`. Sharing again with the same name updates it.

## profile_save: each person's USER.md

OpenClaw puts USER.md in the prompt only while the last write to it through
its file tools counted as trusted. A write from anyone but the owner, or
after the turn read outside content, is untrusted, and the flag sticks: one
such write and the profile drops out of the prompt for good. On a sealed
agent every write comes from a non-owner, so the person's own profile would
never load.

So USER.md has its own tool. `profile_save` takes the whole new file (at
most 4,000 characters, OpenClaw's cap) and writes it into the calling
agent's workspace from the gateway, which records no flag. The plugin blocks
`write`, `edit` and `apply_patch` on any USER.md, and refuses `profile_save`
in a turn that already used a tool that reads outside content (web, browser,
mail, shell), so a web page still can't plant instructions in a profile.
Read-only workspaces (the group agent) are refused. OpenClaw drops a
flag when the file is deleted through its file tools, so an existing one is
cleared by deleting the file and saving it again with `profile_save`.

## The family group chat

The group chat's agent (`uno-agent-family`, [people.md](../../docs/people.md))
keeps no private memory; what's worth remembering lands in the shared store:

- `agents.entries.<id>.memory.search.extraPaths`: the store's folder.
- Sandbox it with `workspaceAccess: "ro"`: it can't write private memory
  files, and OpenClaw skips its pre-compaction memory flush.
- `tools.sandbox.tools.allow` includes `shared_memory_save`, `memory_search`,
  `memory_get`. Its saves are labeled `family group chat`.
- `plugins.entries.memory-core.config.memoryPolicy.excludeSessions.chatTypes: ["group"]`,
  so dreaming never turns group transcripts into anyone's private `MEMORY.md`.
- AGENTS.md already says: in the family group chat, save what's worth
  remembering to shared memory.
