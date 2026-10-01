# Uno: notes for coding agents

Uno is a self-hosted, personified iMessage assistant on OpenClaw. This repo is the template: persona (`workspace/`), plugin (`plugins/`), scripts beside OpenClaw (`watchdog/`), patches to upstream pieces (`patches/`), docs and tests. Start with [README.md](README.md) and [docs/architecture.md](docs/architecture.md). Private, per-install rules (if any) load from a gitignored `CLAUDE.local.md`.

- OpenClaw facts come from the docs that ship with the installed version (`$(npm root -g)/openclaw/docs`), a live read-only command, or the bundled source. Label anything else unverified.
- Before saying OpenClaw can't do something, search the whole installed docs (`grep -ri` across `docs/`, several phrasings, not one page), the relevant `--help`, and the bundled source, then say what you searched. More than once it turned out to be supported after a quick "not possible". Prefer the native feature over custom code even when it takes longer to find.
- Uno is one person. The owner's one-on-one, each person's one-on-one and every group chat are separate agents only for access and memory; persona, tone, formatting, reactions and ways of doing things are the same in all of them. Install persona changes to every Uno workspace, never branch plugin style by agent or chat type (access and group etiquette are the only differences), and test changes on more than one agent (`uno-one-person` skill).
- You are the builder, not Uno. Test Uno's behavior through OpenClaw on the real setup (through the gateway), not by reasoning about what you'd do. Every task starts with a real model turn that reproduces it and ends with real turns showing the result; a proposed persona line runs in a lab agent before the owner sees it (`npm run eval`, cases in `test/evals/`; `real-turn-test` skill).
- Nothing personal in this repo: no names, phone numbers, emails or household details. Tests use 555 numbers and example.com.
- `workspace/SOUL.md` is the owner's: change it only with their OK, showing the exact line before and after. Changes to `AGENTS.md` and `IDENTITY.md` are proposed as a diff with a reason per change. `IDENTITY.md` is the name and the avatar.
- Never mention the builder tools (the coding agents used on this repo) in `workspace/`; `git grep -i` for them before committing. Call the LLM "the model".
- Never print secrets or openclaw.json (it holds the gateway token). Use `openclaw config get <path>` for non-secret settings.
- Call something "enforced" only when code or OS permissions enforce it; otherwise it's a behavior rule.
- Work directly on master; `npm test` passes before each commit. A commit deploys nothing: installing the plugin, copying `watchdog/`, syncing the workspace and changing settings are separate live steps (README "Working on Uno"). Prefer an OpenClaw setting, then a skill, then a plugin tool, then an AGENTS.md recipe.
- Plugin hooks never throw into a turn and never log message text; put decisions in pure functions in `rules.js` with tests.
- After any live change, the owner's Uno runs its setup-check skill.
