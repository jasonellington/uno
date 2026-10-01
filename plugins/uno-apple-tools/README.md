# uno-apple-tools

Notes, Maps, Music and Files as OpenClaw agent tools that run on the gateway.
A family agent runs in a Docker sandbox with no network and only its own
workspace, so it has no `osascript` and no view of the Mac. These tools are
its only way to the Mac's Apple apps, and each one is scoped to the person
that agent serves.

| Tool | What it does | Scope |
| --- | --- | --- |
| `apple_notes` | `list`, `read` (by id or exact title), `create`, `append` | one Notes folder |
| `apple_files` | `list`, `read` (text), `write` (text), `save` (workspace file into the folder), `fetch` (folder file into the workspace's `files/`) | one iCloud Drive folder |
| `apple_maps` | place search (MapKit): name, phone, website, category, address, Apple Maps link | none needed |
| `apple_music` | status, play/pause/next/previous, volume, shuffle, playlists, play a playlist or song, AirPlay speakers | the Mac's Music app |

## Scoping

Each tool is registered with `api.registerTool` as a factory. OpenClaw calls
the factory for each run with the run's agent id (host-supplied, never from
the model). The factory looks that id up in the plugin config:

```json5
plugins: {
  entries: {
    "uno-apple-tools": {
      config: {
        notesAccount: "iCloud", // default
        agents: {
          "family-agent-id": {
            notesFolder: "Family Shared",   // Notes folder name; unset = no apple_notes
            filesFolder: "Family Shared",   // folder inside iCloud Drive; unset = no apple_files
            maps: true,                      // default true
            music: true                      // default true
          }
        }
      }
    }
  }
}
```

An agent that isn't listed gets no tools at all (the factory returns
nothing). The owner's agent is normally left out and keeps its own skills.

The tools are optional plugin tools. A sandboxed agent also needs them in its
sandbox tool allowlist, `agents.entries.<id>.tools.sandbox.tools.allow`, and
not in any of its deny lists.

## Assume the model is adversarial

- The model never names the person, the folder, a host path, or script text.
  Folders come from config; the Notes account and folder are filled in by the
  plugin whatever the call says.
- The AppleScript side is three fixed JavaScript for Automation files in
  `scripts/`, run with `execFile` (no shell) as
  `osascript -l JavaScript <script> <json>`. The model's values arrive as that
  one JSON argument, which always starts with `{` and comes after the script
  path, so osascript can't read it as an option. Values are validated first
  (actions are enums, sizes capped) and note text is HTML-escaped.
- `append` rewrites the note's body, which is how Notes scripting works: a
  note with attachments is refused (they'd be dropped), and checklist
  formatting may not survive.
- Notes are picked only from the folder's own list, and each is checked to
  still be in that folder before it is read or changed. Only one folder is
  ever touched; there is no scan across Notes.
- Files: paths are relative, with no `..`, no `~`, and no hidden names. The
  folder's real path is resolved once, and every open uses macOS
  `O_NOFOLLOW_ANY`, so the kernel refuses a symlink anywhere in the path,
  including one the sandbox swaps in between a check and the open. Reads must
  be regular files (a FIFO can't hang the gateway). New files never replace
  existing ones unless `overwrite: true`. `save` reads only from the agent's
  own workspace (as the host gives it), `fetch` writes only into its
  `files/` folder and never overwrites.
- Results name files relative to the folder, never by host path. Failures are
  plain words; osascript's stderr never reaches the model.
- Calls to each app run one at a time, with timeouts (Notes 30 s, Music
  20 s, Maps 15 s).

## Permissions

The gateway runs the scripts, so macOS asks once per app whether the
gateway may control Notes and Music (Automation). Until someone allows it,
the tools answer "This Mac hasn't allowed Uno to control Music yet."

## Install and test

```bash
npm test                                   # test/uno-apple-tools.test.js, osascript stubbed
openclaw plugins install ./plugins/uno-apple-tools --force --accept-capabilities
openclaw plugins inspect uno-apple-tools --runtime
openclaw agent --agent <id> --session-key agent:<id>:apple-tools-test \
  --message "List the notes in my folder" --json
```
