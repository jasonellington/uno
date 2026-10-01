---
name: openclaw-facts
description: Finds out what OpenClaw can do and how a setting, command, hook or plugin API works, from the installed version's docs, --help and bundled source. Use before answering any question about OpenClaw behavior, before saying OpenClaw can't do something, and before writing custom code for something OpenClaw might already do.
---

# OpenClaw facts

OpenClaw changes quickly and model memory of it is often wrong or out of date. Several times something called "not possible" turned out to be a documented feature, so search before deciding.

## Where the truth is

- Installed docs: `$(npm root -g)/openclaw/docs` (index: `docs_map.md`). Search the whole tree with `grep -ril`, using several phrasings (the feature name, the config key, the user-facing words), not one page.
- `openclaw <command> --help` for flags.
- The bundled source under `$(npm root -g)/openclaw` for hook names, plugin APIs and defaults.
- A live read-only command (`openclaw config get <path>`, `openclaw health --json`, `openclaw channels status --probe`) for what's actually set. Never print the whole config file; it holds the gateway token.

## Reporting

- Cite the doc path, `--help` output or source file for each fact. Label anything else "unverified".
- When the answer is "not supported", say what you searched (paths and terms).
- Prefer the native feature over custom code, in this order: a setting, a skill, a plugin tool, then an `AGENTS.md` recipe (README "Adding a new feature").
