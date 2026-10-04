# uno-guard

Uno's guardrails, in code, for every agent: whom Uno texts and emails, the
owner's approvals, purchases, and what each agent can reach. Its
hooks run before uno-imsg-proxy's (priority 100), so a block here always
wins. The owner's Uno never changes this plugin; its setup-check skill flags
any difference between the installed copy and this folder.

Install: `openclaw plugins install ./plugins/uno-guard --force --accept-capabilities`,
then restart. Code: `index.js` (hooks and the `purchase_check` and `family_sign_in` tools),
`rules.js` (pure rules, unit-tested in `test/uno-imsg-proxy.test.js`).
Needs `hooks.allowConversationAccess: true` on its entry and
`approvals.plugin.enabled: true`.

Settings (`plugins.entries.uno-guard.config`):

| Key | Default | What |
|---|---|---|
| `adminAgentId` | none (no admin) | The owner's agent: unscoped, and the one whose chat approves |
| `ownerName` | "the owner" | The owner's name, in the setup note and error lines |
| `fallbackAgentId` | none | The agent that catches senders with no binding; its turns end silently and it sends nothing |
| `mailAddresses` | none | Agent id -> that person's email addresses; scopes Uno's mailbox for their agent, and they're family for email |
| `sharedSites` | none | Sites whose logins everyone shares; they live in the family browser profile |
| `purchases` | `off` | `off`, `approve` (always the owner's 👍) or `limit` (see purchaseLimit) |
| `purchaseLimit` | 25 | Dollars: at or under goes through with `purchases: "limit"` |
| `purchaseFreeSites` | none | Sites where purchases never need the owner's 👍 (standing subscriptions, for example), when `purchases` isn't `off` |
| `schedulingAgents` | none | Agents besides the admin's that may schedule one-time texts and check-ins back to their own chat (see Scheduling outside the owner's chat) |
| `builderBinary` | none | The builder's own command name; running it except through the builder script is blocked (see The builder) |
| `approvalAgents` | none | Agents besides the admin's that ask the owner for 👍 (e.g. the group chat's), when approvals.plugin forwards to the owner's chat |
| `familySpaces` | none | The family's shared spaces by name: `reminders`, `calendar`, `notes`, `files` |
| `spaces` | none | Agent id -> that person's own spaces (same keys) |
| `testSinkHandle` | none | A fictional number whose messages are logged and never sent, for tests |
| `logDir` | `~/.openclaw/uno-data` | Where `shell-commands.jsonl` and `media-owners.json` go |

## The guards

| Guard | Why it exists | Delete it when… |
|---|---|---|
| **Family sign-in.** The family's agents can't sign in: filling a login takes Apple's Passwords extension by screen control, which only the admin's agent has. They call `family_sign_in` (site); the admin's agent runs its family-sign-in skill in a background session on the family profile for a `sharedSites` site, or texts the owner asking whether the site should be shared, and ends with an outcome word the caller gets a fixed reply for. The site is reduced to a bare host name, so nothing else the model writes reaches the admin's agent (`signInSite`, `signInTask`) | Passwords live in the owner's shared Passwords folders; the model never types or reads one | Never |
| **Approvals in plain words.** uno-guard's approval prompts forwarded to the owner's iMessage chat are replaced by one plain question (who's asking, what, "👍 or 👎") sent with imsg; a watcher reads the owner's tapback on it from chat.db and resolves the approval through OpenClaw's approval service (`resolveApprovalOverGateway`, which checks the owner is an approver). OpenClaw's "✅ Plugin approval …" follow-up is cancelled. If the plain question can't be sent, OpenClaw's prompt goes out unchanged (`parseApprovalPrompt`, `cleanApprovalPrompt`, `approvalFrom`, `isApprovalFollowUp`, `decisionOfTapback`) | OpenClaw's prompt is technical (tool, plugin, agent, ID, `/approve` line) and it adds a resolved line after the reaction; neither has a setting | OpenClaw's iMessage approvals get a plain format |
| **Purchases.** The model calls `purchase_check` (what, site, total) right before anything that spends money; it decides, from what it's doing, what counts. `purchases: "off"` says no, `"approve"` asks the owner, `"limit"` lets it through at or under `purchaseLimit` and asks the owner over it or with no total (`purchaseCheck`). The setup note tells every agent to call it | A buy-button text list missed Amazon's "Start Ultra subscription" (Sept 30); the model knew it was buying | Never |
| **Mail scope.** For agents other than the admin's, `apple_pim_mail` allows only messages, search, get and send, and a tool-result filter keeps only messages from that person's `mailAddresses` (a get must be to them, or from them with a passing iCloud DMARC result, so a forged From stays hidden; junk is hidden); unparseable results are replaced. The admin sees all mail, notifications included. Sending to their own addresses needs no approval | Uno's mailbox holds everyone's email | Mail gets per-person accounts |
| **Photo uploads.** A browser upload from an agent other than the admin's may send only files that arrived in that agent's own chats (owners recorded from `message_received`, kept in `logDir/media-owners.json`) | The browser can upload from OpenClaw's inbound media folder, which holds everyone's photos | OpenClaw keeps inbound media per agent |
| **Audit.** Every tool call from an agent other than the admin's is logged (tool, action, any path, URL or target; never content) | Evidence of what a family agent tried, independent of what it says | Never |
| **The builder.** Starting the owner's coding agent, through the builder script (`uno-data/watchdog/builder.sh <short-name> <task>`) or an ACP spawn, is allowed only in the admin's agent, only on the owner's own message (not a scheduled or background run), and only after the owner's 👍 on the task, shown in full; running its command (`builderBinary`) any other way is blocked (`builderSpawnDecision`) | The builder edits the repo and runs commands with full access; a web page or email Uno read must not be able to start it or write its task | Never |
| **Scheduling outside the owner's chat.** Only agents in `schedulingAgents` (the family group chat) may use the automations tool, and only for one-time agent-turn jobs that run in that chat's own conversation (session target `current`) and report back to it, deleted after they run; listing and cancelling pass (`chatJobDecision`) | A job runs later with the agent's tools; nothing recurring or aimed at another chat or person should come from a shared chat | OpenClaw scopes agent-created jobs this way |
| **Fallback agent.** Turns of `fallbackAgentId` end silently in `before_agent_reply`, before the model runs | Anyone without an exact binding lands there (a channel-wide binding), so an unrouted sender never reaches the admin's agent or gets a reply | OpenClaw can refuse unrouted senders on its own |
| **Family browser.** Browser calls from any agent but the admin's are pinned to the `family` profile on the Mac (`target: host`); `importprofile` and node targets are blocked. Otherwise they browse exactly like the admin's agent | OpenClaw lets any agent name any browser profile, and a sandboxed agent's only way to the Mac's browser is this tool | OpenClaw gets a per-agent profile limit |
| **Shared sites.** Browser calls from the admin's agent open `sharedSites` (e.g. amazon.com) in the `family` profile and everything else in its own; the site decides, not the profile the model names. Calls without a URL follow the session's last open | Shared logins live in one place (the family profile), so each is signed in once | OpenClaw gets per-site profiles |
| **Apple filter lock.** Apple PIM calls from any agent but the admin's get `configDir` forced to `~/.openclaw/uno-data/pim/<agentId>` (outside every sandbox); a named profile, `config_init` or a missing filter file blocks the call | The Apple plugin lets each call pick its own settings folder, and no file means no filter | The Apple plugin gets per-agent settings the model can't override |
| **Household setup note.** Every chat turn gets a note built from config (`householdNote`): whom Uno texts, email and invites, `sharedSites` and `purchases`, Uno's address (`channels.apple-mail.selfAddresses`) and whose mail reaches it (`mailAddresses`), and the spaces it can use (`familySpaces`, `spaces`, filtered by what's unlocked for that agent; a person's space not yet unlocked is an invite waiting on their Accept) | Settings copied by hand into USER.md go stale the moment a setting changes | Never; config stays the one source |
| **Shell log.** Shell-type calls to OpenClaw's own tools are appended to `shell-commands.jsonl` in `logDir` (0600) | A record of what ran | Replaced by the Codex hook relay |

**Texting only the family, unless the owner approves.** In the admin's agent, a text to anyone outside the family, and any text or email sent from the shell, asks the owner for 👍 first; every other agent is blocked (`gate`). An approved recipient is let through the send-time check for 10 minutes. Checked twice. At the send (`message_sending`, `sendDecision`): every outgoing iMessage, whatever sent it (message tool, reply, scheduled text, CLI), goes only to a registered group chat or a chat whose members are all in the household (per chat.db); anything else, an unknown chat included, is cancelled. At the tool: any message action that sends (send, sendWithEffect, sendAttachment, upload-file, broadcast, reply, thread-reply) to someone outside the household needs that 👍 (or is blocked): no approval is needed for the literal `channels.imessage.allowFrom` handles, members of the access groups it names, registered group chats, the current chat and `testSinkHandle`. `allowFrom` only decides who can text Uno; OpenClaw's message tool can reach any conversation. Decision: `textDecision` in `rules.js`. Shell commands that text or email (`imsg send`, AppleScript to Messages or Mail, `openclaw message`/`cron` aimed outside the household) need the same 👍 (`shellSendDecision`); everything else in the shell runs as usual. Scheduled texts outside the family are cancelled at the send, since an approval covers 10 minutes. Sealed agents also get OpenClaw's own `tools.message.crossContext` confinement to their own chat.

**Approvals.** A `before_tool_call` hook returns OpenClaw's native `requireApproval` (👍 allow once / 👎 deny in the chat, 5-minute timeout) before: `apple_pim_mail` send to anyone outside the family (the household handles plus every `mailAddresses` entry) and every `reply`; `apple_pim_calendar` create/update/batch_create with attendees. Only the admin's agent asks: for any other agent (whose chats have no approver) it's blocked with a plain no (`approvalOrBlock`). Decision: `approvalFor` in `rules.js`. Needs `approvals.plugin.enabled: true`. Shell commands that send mail or texts need the same 👍 (above).

## Known limits

- **Shell checks read the command text.** Uno's shell commands reach the
  plugin as OpenClaw's `exec` tool (checked Sept 30: every shell command in
  `shell-commands.jsonl` came through it), so they're logged and checked.
  A send hidden in a script file or an encoded string isn't recognized, and
  `imsg` talks to Messages directly, so the send-time check never sees it.
