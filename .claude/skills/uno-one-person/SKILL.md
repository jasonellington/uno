---
name: uno-one-person
description: Keeps Uno one person across every chat - the owner's one-on-one and the family group chat. Use for any change to how Uno talks, reacts, formats or does things (persona files, plugin behavior, prompts) and when testing one - install it for every Uno agent and test it on more than one.
---

# Uno is one person

Everyone texts the same Uno. The owner's one-on-one and the family group chat run as separate OpenClaw agents (there are no per-person one-on-one agents) only so that access and memory stay separate. The persona, tone, formatting, reactions and ways of doing things are the same in all of them.

## Changing behavior

- Persona files (`SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `REPLY.md`, `CALL.md`) are identical in every Uno workspace. Install to all of them (`openclaw agents list` shows each agent's workspace; skip worker agents that aren't Uno, such as coding or QA helpers) and `cmp` each one against the repo.
- Plugin behavior (style, reactions, link previews, bubbles, typing) applies to every agent and chat. Don't branch on agent id or chat type for how Uno talks or reacts. The only allowed differences are access (what a sealed agent may use or see) and group etiquette (Uno may stay quiet when a group message isn't for it; replies don't open with a name).
- Sandboxed agents (every Uno but the owner's) get `AGENTS.md` only through uno-imsg-proxy's system-context hook: the Codex harness can't find it in the sandbox. To check an agent really has it, ask it in a test session for a fact that only `AGENTS.md` states; `openclaw agent … --json` shows `injectedWorkspaceFiles` in its `systemPromptReport`.
- A fix found in one chat is a fix for all of them. Check where else the same behavior runs before calling it done.
- `AGENTS.md` reaches a conversation only when its session starts (the Codex harness loads it at thread start). After an `AGENTS.md` change, restart every live Uno conversation: `openclaw agent --agent <id> --session-key <key> --message /new` prints "New session started." and sends nothing to the chat. List the live ones with `openclaw sessions list --all-agents --active 1440`.

## Testing

- Run the evals on at least the owner's agent and one group agent (real-turn-test skill): `npm run eval -- --agents main,uno-agent-family --runs 2` (`uno-lab` before there's a family), with a case for the change itself in `test/evals/`. The same message should get the same kind of answer from each.
- Behavior that needs a real inbound group message (staying quiet, answering when named) still needs a phone test.
- Report results per agent.
