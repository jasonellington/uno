# Security

Uno gives a model its own Mac account, a shell, a browser and an iMessage
account. Before you run it, read who can reach what
([docs/people.md](docs/people.md)) and the known limits
([docs/architecture.md](docs/architecture.md#known-limits)). Give it a macOS
account and an Apple ID of its own. The guardrails that matter are enforced
in code (`plugins/uno-guard`) or by OpenClaw's sandbox, and the setup-check
skill compares the live settings with an approved copy.

## Reporting a vulnerability

Report it privately with GitHub's **Report a vulnerability** button on this
repo's Security tab, not in a public issue. Say what you sent or did, what
Uno did, and your OpenClaw version.
