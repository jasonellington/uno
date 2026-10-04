// Pure rules for uno-guard, unit-tested in uno/test/uno-guard.test.js.


// Shell audit trail (audit, 2026-09-25): every shell-type tool call admin
// Uno makes is appended to a local 0600 log so the owner can see what ran. It
// records, never blocks. Returns null for other tools.
export const SHELL_TOOLS = new Set(["bash", "exec", "process", "shell", "terminal", "code_execution"]);
export function shellEntry(toolName, params, now = new Date()) {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const raw = params?.command ?? params?.cmd ?? params?.script ?? params?.code ?? params;
  const command = (typeof raw === "string" ? raw : JSON.stringify(raw ?? null)).slice(0, 4000);
  return { ts: now.toISOString(), tool: toolName, command, ...(params?.workdir || params?.cwd ? { cwd: params.workdir ?? params.cwd } : {}) };
}


// Native OpenClaw approval (👍/👎 in the chat) before Uno acts toward other
// people: email to anyone but the owner, any email reply and calendar invites.
// Returns a requireApproval object for before_tool_call, or null.
const norm1 = (s) => String(s ?? "").trim().toLowerCase();
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(norm1).filter(Boolean);
export const MESSAGE_OUT = new Set(["send", "sendWithEffect", "sendAttachment", "upload-file", "broadcast", "reply", "thread-reply"]);
// An approval prompt for the owner's chat (👍 allow once / 👎 deny, 5 minutes).
// How long the owner has to answer, and how long a tool call that asks may
// wait (the tools pass APPROVAL_WAIT_MS as their own timeoutMs; see index.js).
export const APPROVAL_TIMEOUT_MS = 300_000;
export const APPROVAL_WAIT_MS = 330_000;
export const ask = (title, description) => ({ title, description: description.slice(0, 500), severity: "warning", allowedDecisions: ["allow-once", "deny"], timeoutMs: APPROVAL_TIMEOUT_MS });
export function approvalFor(toolName, params = {}, { owners = [], current = [], sink = null } = {}) {
  const own = new Set(owners.map(norm1));
  if (toolName === "apple_pim_mail") {
    if (params.action === "reply") return ask("Reply to an email", "Reply to an email?");
    if (params.action !== "send") return null;
    const to = [...list(params.to), ...list(params.cc), ...list(params.bcc)];
    const others = to.filter((a) => !own.has(a));
    return others.length ? ask("Send an email", `Email ${others.slice(0, 5).join(", ")}: "${String(params.subject ?? "").slice(0, 120)}"?`) : null;
  }
  if (toolName === "apple_pim_calendar") {
    const events = params.action === "batch_create" ? (Array.isArray(params.events) ? params.events : []) : ["create", "update"].includes(params.action) ? [params] : [];
    const invited = events.flatMap((e) => (Array.isArray(e?.attendees) ? e.attendees : []).map((a) => norm1(a?.email ?? a))).filter((a) => a && !own.has(a));
    return invited.length ? ask("Send calendar invites", `Invite ${invited.slice(0, 5).join(", ")} to ${String(params.title ?? params.summary ?? "an event").slice(0, 120)}?`) : null;
  }
  return null;
}

// Texting: Uno texts only the household, never anyone else, with no prompt to
// approve it. allowFrom decides who can text Uno, not whom Uno can text, and
// OpenClaw's message tool can reach any conversation, so every action that
// sends (not just send) is checked here. Allowed: literal allowFrom handles,
// members of access groups allowFrom names, registered group chats, the
// current chat (no target means the current chat) and the test sink.
export function householdHandles(imessage = {}, accessGroups = {}) {
  const out = new Set();
  for (const e of imessage.allowFrom ?? []) {
    const m = /^accessGroup:(.+)$/.exec(String(e));
    if (m) for (const h of accessGroups?.[m[1]]?.members?.imessage ?? []) out.add(norm1(h));
    else out.add(norm1(e));
  }
  for (const id of Object.keys(imessage.groups ?? {})) if (id !== "*") out.add(norm1(/^chat_id:/.test(id) ? id : `chat_id:${id}`));
  return [...out];
}
// Outside the family: the admin's agent asks the owner for 👍 (gate), any
// other agent is blocked. Returns { ask, recipients, blockReason } or null.
export const TEXT_BLOCKED = "You only text the family. Texting anyone else isn't something you can do; tell them in a line.";
export function textDecision(toolName, params = {}, { household = [], current = [], sink = null } = {}) {
  if (toolName !== "message" || !MESSAGE_OUT.has(params.action)) return null;
  const ok = new Set([...household, ...current, ...(sink ? [sink] : [])].map(norm1));
  const bare = (t) => t.replace(/^imessage:/, "");
  const others = [...list(params.target), ...list(params.to), ...list(params.targets)].filter((t) => !ok.has(t) && !ok.has(bare(t)));
  if (!others.length) return null;
  const text = String(params.message ?? params.text ?? params.caption ?? "").replace(/\s+/g, " ").slice(0, 240);
  return { ask: ask("Text someone outside the family", `Text ${others.slice(0, 5).map(bare).join(", ")}${text ? `: "${text}"` : ""}?`), recipients: others.map(bare), blockReason: TEXT_BLOCKED };
}
// What a text or shell decision becomes for this agent: the owner's 👍 in the
// admin's agent, a plain no anywhere else (no approver there).
// askers: other agents whose approvals are routed to the owner
// (approvalAgents, when approvals.plugin forwards to the owner's chat).
export function gate(decision, agentId, adminAgentId, askers = []) {
  if (!decision) return null;
  return (adminAgentId && agentId === adminAgentId) || askers.includes(agentId) ? { requireApproval: decision.ask } : { block: true, blockReason: decision.blockReason };
}

// The same rule at the send itself (message_sending), so every outgoing
// iMessage is checked whatever sent it: the message tool, a reply, a
// scheduled text, the CLI. `to` is usually "chat_id:N" (checked Sept 30);
// members(to) gives that chat's handles from chat.db. A chat is allowed when
// it's a registered group or everyone in it is in the household. Anything
// else, an unknown chat included, is cancelled, unless the owner just
// approved texting that person (approved: recipients of a recent 👍).
export function sendDecision(to, { household = [], sink = null, members = () => [], approved = [] } = {}) {
  const t = norm1(to).replace(/^(imessage|auto):/, "");
  if (!t) return null;
  const ok = new Set([...household, ...approved].map(norm1));
  if (ok.has(t) || (sink && t.replace(/\D/g, "").endsWith(String(sink).replace(/\D/g, "")) && /\d/.test(t))) return null;
  const hs = (members(t) ?? []).map(norm1).filter(Boolean);
  return hs.length && hs.every((h) => ok.has(h)) ? null : { cancel: true, cancelReason: "outside the family" };
}

// Shell commands that text or email: `imsg send`, AppleScript to Messages or
// Mail, and `openclaw message` / `openclaw cron` aimed outside the household.
// Everything else in the shell runs as usual. Returns { ask, recipients,
// blockReason } (see gate) or null. Recipients are what the command names,
// so an approved text isn't cancelled at the send.
const QUOTED = /--(?:to|target)(?:=|\s+)("[^"]*"|'[^']*'|[^\s;|&]+)/g;
const BUDDY = /\b(?:buddy|participant)\s+"([^"]+)"/gi;
export const SHELL_TEXT_BLOCKED = "Texts go out only through your message tool, never the shell. Use it, or tell them in a line that you can't.";
export const SHELL_MAIL_BLOCKED = "Email goes out only through your mail tool, never the shell. Use it, or offer a draft they can send themselves.";
export function shellSendDecision(toolName, params, { household = [], sink = null } = {}) {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const raw = params?.command ?? params?.cmd ?? params?.script ?? params?.code;
  const cmd = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(" ") : "";
  if (!cmd) return null;
  const shown = `Command: ${cmd.replace(/\s+/g, " ").slice(0, 400)}`;
  const named = (re) => [...cmd.matchAll(re)].map((m) => norm1(m[1].replace(/^["']|["']$/g, "")).replace(/^imessage:/, ""));
  if (/\bimsg\b[^\n;|&]*\bsend(-rich|-attachment)?\b/i.test(cmd) || /application\s+(id\s+)?"?(Messages|com\.apple\.(iChat|MobileSMS))"?[\s\S]*\bsend\b/i.test(cmd)) {
    return { ask: ask("Send a text from the shell", shown), recipients: [...named(QUOTED), ...named(BUDDY)], blockReason: SHELL_TEXT_BLOCKED };
  }
  if (/application\s+(id\s+)?"?(Mail|com\.apple\.mail)"?[\s\S]*\b(send|outgoing message)\b/i.test(cmd)) return { ask: ask("Send an email from the shell", shown), recipients: [], blockReason: SHELL_MAIL_BLOCKED };
  if (/\bopenclaw\b[^\n;|&]*\b(message|cron)\b/i.test(cmd)) {
    const ok = new Set([...household, ...(sink ? [sink] : [])].map(norm1));
    const others = named(QUOTED).filter((x) => !ok.has(x));
    if (others.length) return { ask: ask("Text someone outside the family", `Text ${others.slice(0, 5).join(", ")} from the shell? ${shown}`), recipients: others, blockReason: TEXT_BLOCKED };
  }
  return null;
}

// Only the admin's chats have someone who can approve (family members aren't
// approvers), so for any other agent an approval would sit unseen and expire
// after 5 minutes: it's a plain no instead.
export const NEEDS_OWNER = "You can't email or invite other people for them yet. Say so in a line and offer a draft they can send themselves.";
export function approvalOrBlock(requireApproval, agentId, adminAgentId, askers = []) {
  if (!requireApproval) return null;
  return (adminAgentId && agentId === adminAgentId) || askers.includes(agentId) ? { requireApproval } : { block: true, blockReason: NEEDS_OWNER };
}

// Household setup, written from config into every chat's prompt so no
// USER.md or AGENTS.md line has to repeat a setting (and go stale when it
// changes). Spaces are Apple Reminders lists, calendars, Notes folders and
// iCloud Drive folders: `familySpaces` for everyone, `spaces[agentId]` for one
// person. For a sealed agent a space counts once it's unlocked (Apple filter or
// Apple tools folder); a personal one that isn't yet is waiting on their Accept.
const SPACE_KINDS = [["reminders", "Reminders list"], ["calendar", "calendar"], ["notes", "Notes folder"], ["files", "iCloud Drive folder"]];
export const FILES_ROOT = "~/Library/Mobile Documents/com~apple~CloudDocs";
export function unlockedSpaces(pimFilter, appleTools) {
  return {
    reminders: new Set(pimFilter?.reminders?.enabled === false ? [] : pimFilter?.reminders?.items ?? []),
    calendar: new Set(pimFilter?.calendars?.enabled === false ? [] : pimFilter?.calendars?.items ?? []),
    notes: new Set(appleTools?.notesFolder ? [appleTools.notesFolder] : []),
    files: new Set(appleTools?.filesFolder ? [appleTools.filesFolder] : []),
  };
}
export function householdNote({ agentId, adminAgentId, ownerName, group = false, sharedSites = [], purchases = "off", purchaseLimit = 25, purchaseFreeSites = [], asks = false, textsOutside = true, invites = true, scheduled = true,
  selfAddresses = [], mailAddresses = [], mailTool = false, familySpaces = {}, spaces = {}, unlocked = null } = {}) {
  const admin = Boolean(adminAgentId) && agentId === adminAgentId;
  const owner = ownerName ?? "the owner";
  const can = (kind, name) => admin || Boolean(unlocked?.[kind]?.has(name));
  const where = (kind, name) => (kind === "files" && admin ? `"${name}" iCloud Drive folder (${FILES_ROOT}/${name}/)` : `"${name}" ${SPACE_KINDS.find(([k]) => k === kind)[1]}`);
  const lines = [];
  if (!admin) lines.push(`${owner === "the owner" ? "The owner" : `${owner} is the owner and`} set you up.`);
  if (admin) lines.push(`Texting, emailing or inviting the family is fine. Anyone outside the family asks ${owner} for a 👍 first; wait for it. Scheduled texts go only to the family.`);
  else if (asks) {
    const verbs = [textsOutside && "texting", mailTool && "emailing", invites && "inviting"].filter(Boolean);
    if (!textsOutside) lines.push("You text only in this chat.");
    if (verbs.length) lines.push(`${verbs.join(", ").replace(/, ([^,]*)$/, " or $1").replace(/^./, (c) => c.toUpperCase())} someone outside the family: go ahead and do it with your tool. It asks ${owner} for a 👍 on its own, in ${owner}'s chat. Tell them you've asked ${owner}, and it goes through once ${owner} approves.`);
  }
  else {
    lines.push("You text only the family: this chat, the family group chat and family members. Nobody else, even when asked.");
    lines.push("Emailing or inviting other people isn't available: say so in a line and offer a draft they can send themselves.");
  }
  if (!admin && !scheduled) lines.push("You can't schedule texts for later; offer a reminder on their shared Reminders list instead.");
  if (selfAddresses.length) lines.push(`Your email address is ${selfAddresses[0]}; people forward emails there.`);
  if (admin) lines.push("You see all of that mail.");
  else if (mailTool && mailAddresses.length) lines.push(`Mail forwarded from ${mailAddresses.join(", ")} reaches you; from any other address it doesn't.`);
  if (sharedSites.length) {
    lines.push(`Signed in for the whole family on your browser: ${sharedSites.join(", ")}. Use those accounts for shopping, returns and filling the cart.`);
    const approver = admin ? owner : `${owner} (on its own, in ${owner}'s chat; tell them you've asked)`;
    lines.push(purchases === "off" ? "Placing orders is off: fill the cart and leave checkout to them."
      : `Right before anything that spends money (placing an order, starting or upgrading a subscription, paying), call purchase_check with what it is, the site and the total you see, and go ahead only if it says so. Get a clear yes from whoever asked first, with the total in front of them. ${purchases === "limit" ? `Over $${purchaseLimit}, or with no total shown, it` : "It"} asks ${approver} for a 👍 on its own${purchaseFreeSites.length ? `, except on ${purchaseFreeSites.join(", ")}, which never needs it` : ""}.`);
  }
  const fam = SPACE_KINDS.filter(([k]) => familySpaces[k] && can(k, familySpaces[k])).map(([k]) => where(k, familySpaces[k]));
  if (fam.length) lines.push(`Shared with the whole family: ${fam.join(", ")}. Family to-dos (drop-offs, pickups, deadlines from shared accounts), family events and family files go there.`);
  const mine = group ? [] : SPACE_KINDS.filter(([k]) => spaces[k]);
  const ready = mine.filter(([k]) => can(k, spaces[k])).map(([k]) => where(k, spaces[k]));
  const waiting = mine.filter(([k]) => !can(k, spaces[k])).map(([k, label]) => `${label} "${spaces[k]}"`);
  if (ready.length) lines.push(`Theirs, shared with you: ${ready.join(", ")}. Their own reminders, events, notes and files go there.`);
  if (waiting.length) lines.push(`Invites to their own ${waiting.join(", ")} are on their way from you; tapping Accept on each is all it takes. Don't ask whether they arrived.`);
  if (!mine.length && !group && !admin) lines.push("They don't have spaces of their own with you yet.");
  return `Household setup, from the owner's settings (current; it wins over anything older in USER.md or memory):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// Browser logins: every agent except the admin's drives only the family
// browser profile (the logins shared with everyone), on this Mac. OpenClaw has
// no per-agent profile limit (checked Sept 28), and a sandboxed agent's only
// way to the Mac's browser is this tool, so this is the gate. It browses
// exactly like the admin's agent, except that the profile and target are
// forced and it can't import cookies from the Mac's own Chrome. OpenClaw
// merges returned params into the call, so a call naming a node is blocked,
// not rewritten.
export const FAMILY_BROWSER_PROFILE = "family";
export function browserDecision(toolName, params, agentId, adminAgentId, profile = FAMILY_BROWSER_PROFILE) {
  if (toolName !== "browser" || !agentId || agentId === adminAgentId) return null;
  const no = { block: true, blockReason: "Not available." };
  if (params?.action === "importprofile") return no;
  if (params?.node != null || (params?.target != null && params.target !== "host")) return no;
  return { params: { ...(params ?? {}), profile, target: "host" } };
}

// Apple data: every agent except the admin's reads Calendar, Reminders,
// Contacts and Mail only through its own filter file, kept in a folder its
// sandbox can't reach (<root>/<agentId>/config.json). The Apple plugin lets a
// call pick its own settings folder or profile, and a missing file means no
// filter at all, so the folder is forced here, a named profile blocks, and a
// missing file blocks.
// config_init is blocked because it lists every calendar and list by name.
export function pimDecision(toolName, params, agentId, adminAgentId, root, exists) {
  if (!String(toolName ?? "").startsWith("apple_pim_") || !agentId || agentId === adminAgentId) return null;
  if (params?.action === "config_init") return { block: true, blockReason: "Not available." };
  const configDir = `${root}/${agentId}`;
  if (!exists(`${configDir}/config.json`)) return { block: true, blockReason: "Apple apps aren't set up for this person yet." };
  // OpenClaw merges returned params into the call, so a profile can't be
  // stripped; a call that names one is blocked instead.
  if (params?.profile != null) return { block: true, blockReason: "Not available." };
  return { params: { ...(params ?? {}), configDir } };
}

// Shared sites: the logins everyone shares (sharedSites, e.g. amazon.com) live
// only in the family profile, so the admin's agent opens those there and
// everything else in its own profile. The site decides, not the model: a
// profile the model names is ignored (it reused a leftover family tab for a
// private site, Sept 28), and a call without a URL follows the session's last
// open or navigate. profiles/status/doctor are left alone.
export function siteOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}
export function isSharedSite(url, sharedSites = []) {
  const host = siteOf(url);
  return !!host && sharedSites.some((d) => host === d || host.endsWith(`.${d}`));
}
export const BROWSER_INFO_ACTIONS = new Set(["profiles", "status", "doctor"]);
export function adminBrowserProfile(params, { sharedSites = [], familyProfile = FAMILY_BROWSER_PROFILE, defaultProfile = "openclaw", lastProfile = null } = {}) {
  if (BROWSER_INFO_ACTIONS.has(params?.action)) return null;
  const url = params?.url ?? params?.targetUrl;
  if (url && ["open", "navigate"].includes(params?.action)) return isSharedSite(url, sharedSites) ? familyProfile : defaultProfile;
  return lastProfile ?? defaultProfile;
}

// Purchases: the model doing the task decides what's a purchase. Before
// anything that spends money (an order, subscription, upgrade, payment) it
// calls purchase_check with what, where and the total it sees; this rule
// decides. mode "off": no. "approve": the owner's 👍. "limit": through at or
// under `limit` dollars, the owner's 👍 over it or with no total. On a
// `freeSites` site (a standing subscription the owner is fine with) it always
// goes through, whatever the mode but off.
export const PURCHASES_OFF = "Placing orders is turned off. Leave it in the cart and tell them it's ready for them to check out.";
export const PURCHASE_GO = "Go ahead: place it now, then confirm what was placed and the total.";
export function purchaseCheck(params = {}, { mode = "off", limit = 25, freeSites = [] } = {}) {
  if (mode !== "approve" && mode !== "limit") return { block: PURCHASES_OFF };
  const host = params?.site ? siteOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(params.site)) ? params.site : `https://${String(params.site).trim()}`) : null;
  if (host && freeSites.some((d) => host === d || host.endsWith(`.${d}`))) return { allow: true, amount: null, free: true };
  const total = Number(params?.total);
  const amount = params?.total != null && params?.total !== "" && Number.isFinite(total) && total >= 0 ? total : null;
  if (mode === "limit" && amount != null && amount <= limit) return { allow: true, amount };
  const shown = amount != null ? `$${amount.toFixed(2)}` : "total not shown";
  const what = String(params?.what ?? "a purchase").replace(/\s+/g, " ").slice(0, 160);
  return { ask: ask(`Buy something (${shown})`, `Buy ${what}${params?.site ? ` on ${String(params.site).slice(0, 60)}` : ""} ${amount != null ? `for ${shown}` : "(total not shown)"}?`), amount };
}

// Photo uploads: a browser upload may send files from OpenClaw's inbound media
// folder, which holds everyone's photos. An agent other than the admin's may
// upload only files that arrived in its own chats (owners: file name -> agent,
// recorded as messages come in); anything else, or unrecorded, is blocked.
export const agentOfSession = (key) => String(key ?? "").match(/^agent:([^:]+):/)?.[1] ?? null;
export function uploadDecision(params, agentId, owners) {
  if (params?.action !== "upload") return null;
  const paths = [...(Array.isArray(params?.paths) ? params.paths : []), params?.path].filter(Boolean).map(String);
  const notMine = paths.filter((p) => owners?.get(p.split("/").pop()) !== agentId);
  return notMine.length ? { block: true, blockReason: "That file didn't come from this chat." } : null;
}

// Mail for everyone but the admin: Uno's mailbox holds everyone's email, so
// an agent sees only messages from its person's own addresses (mailAddresses
// in the plugin config, never from the model), and may list, search, read
// and send new mail. Replies, moves, deletes, flags and attachments stay off.
// mailFilter trims results before the model sees them; anything it can't
// parse is replaced, not passed through.
export const MAIL_ACTIONS = new Set(["messages", "search", "get", "send"]);
const lowerSet = (xs) => new Set((xs ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
export function mailDecision(toolName, params, agentId, adminAgentId, mailAddresses) {
  if (toolName !== "apple_pim_mail" || !agentId || agentId === adminAgentId) return null;
  if (!(mailAddresses?.[agentId] ?? []).length) return { block: true, blockReason: "Mail isn't set up for this person yet." };
  if (!MAIL_ACTIONS.has(params?.action)) return { block: true, blockReason: "Not available." };
  return null;
}
const addrOf = (x) => String(typeof x === "object" && x ? x.address ?? x.email ?? "" : x ?? "").trim().toLowerCase();
export function mailFilter(action, text, addresses) {
  const own = lowerSet(addresses);
  const denied = JSON.stringify({ success: false, error: "Not found." });
  if (action === "send") return text;
  let d;
  try { d = JSON.parse(String(text)); } catch { return denied; }
  if (action === "get") {
    const m = d?.message;
    if (!m || m.isJunk) return denied;
    // From them: only if iCloud says the sender's domain really sent it, so a
    // forged From line stays hidden. To them: the sender isn't claiming to be
    // them, so no check is needed.
    const fromThem = own.has(addrOf(m.senderAddress)) && senderVerified(m.allHeaders, m.senderAddress);
    const toThem = [...(m.to ?? []), ...(m.cc ?? [])].some((r) => own.has(addrOf(r)));
    return fromThem || toThem ? text : denied;
  }
  if (Array.isArray(d?.messages)) {
    const messages = d.messages.filter((m) => !m?.isJunk && own.has(addrOf(m?.senderAddress)));
    const out = { ...d, messages, count: messages.length };
    delete out.totalInMailbox;
    return JSON.stringify(out);
  }
  return denied;
}

// Did the receiving server (iCloud) verify the sender? The topmost DMARC
// result it added (a sender can forge headers further down) must pass for
// the From address's domain. Real notifications (Apple, stores, a person's
// own iCloud or Gmail) pass; a forged From line fails.
export function senderVerified(allHeaders, senderAddress) {
  const domain = addrOf(senderAddress).split("@")[1];
  if (!domain) return false;
  const lines = String(allHeaders ?? "").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const top = lines.find((l) => /^authentication-results:\s*[^;]*icloud\.com\s*;.*\bdmarc=/i.test(l));
  if (!top) return false;
  const m = top.match(/\bdmarc=(\w+)[^;]*?header\.from=([^\s;]+)/i);
  return Boolean(m && m[1].toLowerCase() === "pass" && m[2].toLowerCase() === domain);
}

// Family sign-in: the family's agents can't sign in themselves (filling a
// login takes the Passwords extension by screen control, which only the
// admin's agent has). They call family_sign_in with the site; the admin's
// agent signs in on the family profile when it's a shared site, and asks the
// owner whether it should be one when it isn't. The site becomes a bare host
// name here, so nothing else the model writes reaches the admin's agent.
export const SIGN_IN_OUTCOMES = ["SIGNED_IN", "NO_SAVED_LOGIN", "ASKED", "FAILED"];
export function signInSite(site, sharedSites = []) {
  const raw = String(site ?? "").trim().toLowerCase();
  const host = siteOf(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null;
  const shared = sharedSites.find((d) => host === d || host.endsWith(`.${d}`));
  return { site: shared ?? host, shared: Boolean(shared) };
}
export function signInTask({ site, shared, who, ownerName }) {
  const owner = ownerName ?? "the owner";
  return shared
    ? `Family sign-in: ${who} needs ${site} signed in on the family browser. Use the family-sign-in skill. End your reply with one word: SIGNED_IN, NO_SAVED_LOGIN or FAILED.`
    : `Family sign-in: ${who} asked to sign in to ${site}, which isn't one of the family's sites. Don't sign in. Text ${owner} asking whether ${site} should be a family site (its password would go in the family's shared folder in Passwords). End your reply with one word: ASKED or FAILED.`;
}
export function signInOutcome(text) {
  const words = String(text ?? "").toUpperCase().match(/[A-Z_]+/g) ?? [];
  return [...words].reverse().find((w) => SIGN_IN_OUTCOMES.includes(w)) ?? "FAILED";
}
export function signInReply(outcome, { site, ownerName }) {
  const owner = ownerName ?? "the owner";
  return {
    SIGNED_IN: `Signed in to ${site} on the family browser. Go ahead.`,
    NO_SAVED_LOGIN: `There's no saved login for ${site} yet. ${owner} has been asked to add it; tell them it'll work once that's done.`,
    ASKED: `${site} isn't one of the family's sites, so it wasn't signed in. ${owner} has been asked whether it should be.`,
  }[outcome] ?? `Couldn't sign in to ${site} right now. Say so; don't try to sign in yourself.`;
}

// Approvals by iMessage, in plain words. OpenClaw's forwarded prompt is
// technical (tool, plugin, agent, ID, /approve line), and after a decision it
// sends a "✅ Plugin approval …" line too. uno-guard sends its own approvals as
// one plain question instead and resolves them itself on the owner's 👍 or 👎
// (index.js); both of OpenClaw's messages are cancelled.
const PROMPT_KEYS = ["Title", "Description", "Tool", "Plugin", "Agent", "ID", "Expires in", "Reply with", "React with"];
export function parseApprovalPrompt(text) {
  const t = String(text ?? "");
  if (!/Plugin approval required/i.test(t)) return null;
  const field = (k) => {
    const m = new RegExp(`^${k}:[ \\t]*([\\s\\S]*?)(?=\\n(?:${PROMPT_KEYS.join("|")}):|\\n\\s*\\n|$)`, "m").exec(t);
    return m ? m[1].replace(/\\s+/g, " ").trim() : null;
  };
  const id = /^ID:\s*(plugin:[\w-]+)/m.exec(t)?.[1] ?? null;
  return id ? { id, title: field("Title"), description: field("Description"), plugin: field("Plugin"), agent: field("Agent") } : null;
}
export const isApprovalFollowUp = (text) => /^\W*Plugin approval (?:allowed|approved|denied|expired|resolved|cancell?ed|timed out)\b/i.test(String(text ?? "").trim());
export function approvalFrom(agentId, { adminAgentId, names = {}, groupAgents = [] } = {}) {
  if (!agentId || agentId === adminAgentId) return "";
  if (groupAgents.includes(agentId)) return "Group chat";
  return names[agentId] ? `${names[agentId]}'s chat` : "";
}
export function cleanApprovalPrompt(p, from = "") {
  const q = String(p?.description || p?.title || "Go ahead?").trim();
  const line = from ? `${from}: ${q.charAt(0).toLowerCase()}${q.slice(1)}` : q;
  return `${line}\n👍 or 👎`;
}
// A reaction row in chat.db: 2000-2005 add a tapback (2001 👍, 2002 👎).
export const decisionOfTapback = (type) => (Number(type) === 2001 ? "allow-once" : Number(type) === 2002 ? "deny" : null);

// The builder: the owner's coding agent, run headless by the builder script
// (watchdog/builder.sh, installed in uno-data/watchdog) in a worktree of the
// repo, with full file and shell access. Starting it, from a shell command or
// an ACP spawn, takes the admin's agent, the owner's own message (not a
// scheduled or background run) and the owner's 👍 on the task shown in full,
// so nothing Uno reads (a web page, an email) can start it or write its task.
// Running the agent's own command (builderBinary) any other way is blocked.
const shellCommand = (toolName, params) => (SHELL_TOOLS.has(String(toolName)) ? String(params?.command ?? params?.cmd ?? params?.script ?? params?.code ?? "") : "");
// The script started as a command (at the start, or after ; & | ( or a
// newline), not merely named, as in `ls` or `tail` of its files.
const BUILDER_START = /(?:^|[;&|(\n]\s*)(?:\S*\/)?uno-data\/watchdog\/builder\.sh(?=\s|$)/;
export function builderTask(command) {
  const c = String(command ?? "");
  const at = c.search(BUILDER_START);
  if (at < 0) return null;
  const m = c.slice(at).match(/builder\.sh\s+([a-z0-9][a-z0-9-]{0,39})\s+([\s\S]+)$/);
  return m ? { name: m[1], task: m[2].replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ").trim() } : null;
}
export function builderSpawnDecision(toolName, params, { agentId, adminAgentId, fromOwner, builderBinary = null }) {
  const command = shellCommand(toolName, params);
  const viaScript = BUILDER_START.test(command);
  if (viaScript && /builder\.sh\s+done\s+[a-z0-9][a-z0-9-]{0,39}\s*$/.test(command)) return null; // cleanup needs no 👍
  const acp = toolName === "sessions_spawn" && params?.runtime === "acp";
  const direct = builderBinary && !viaScript && new RegExp(`(^|[\\s;&|/(])${builderBinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(command);
  if (direct) return { block: "Start the builder with your builder script, so the owner sees the task first." };
  if (!viaScript && !acp) return null;
  if (!adminAgentId || agentId !== adminAgentId) return { block: "Only the owner's own chat can start the builder." };
  if (!fromOwner) return { block: "The builder starts only on the owner's own message, not from a scheduled or background run." };
  const task = acp ? String(params?.task ?? "").replace(/\s+/g, " ").trim() : builderTask(command)?.task ?? "";
  if (!task) return { block: "Give the builder a short name and its whole task: builder.sh <short-name> <task>." };
  return { ask: ask("Start the builder", `Start the builder on this? "${task.slice(0, 380)}${task.length > 380 ? "…" : ""}"`) };
}

// Scheduling outside the admin's chat ("text us at 6", a check-in), only in
// the agents listed in schedulingAgents (the family group chat): a one-time
// agent-turn job that runs in this chat's own conversation (session target
// current, or unset, which OpenClaw resolves to it) and reports back to it,
// deleted after it runs. Nothing recurring, nothing aimed at another chat or
// handle, no command or script payloads. Listing and removing pass.
export function chatJobDecision(toolName, params, { agentId, adminAgentId, schedulingAgents = [] }) {
  if (toolName !== "automations" && toolName !== "cron") return null;
  if (!agentId || agentId === adminAgentId) return null;
  if (!schedulingAgents.includes(agentId)) return { block: true, blockReason: "Scheduling isn't available in this chat." };
  const action = String(params?.action ?? "");
  if (["list", "status", "runs", "remove", "rm", "delete"].includes(action)) return null;
  if (action !== "add") return { block: true, blockReason: "From this chat you can add one-time texts and check-ins, list them and cancel them; nothing else." };
  const job = params?.job ?? {};
  const target = job.sessionTarget == null ? "current" : String(job.sessionTarget);
  const d = job.delivery ?? {};
  if (job.schedule?.kind !== "at") return { block: true, blockReason: "Only one-time texts and check-ins from this chat, nothing recurring." };
  if (target !== "current") return { block: true, blockReason: "Run it in this conversation (session target current) so it comes back to this chat." };
  if (job.payload?.kind && job.payload.kind !== "agentTurn") return { block: true, blockReason: "Only a message for yourself to answer, no commands or scripts." };
  if (d.to != null || (d.channel != null && d.channel !== "last") || (d.mode != null && d.mode !== "announce")) return { block: true, blockReason: "It can only report back to this chat; leave out the delivery target." };
  if (job.deleteAfterRun === false) return { block: true, blockReason: "One-time jobs are deleted after they run." };
  return { params: { ...params, job: { ...job, sessionTarget: "current", deleteAfterRun: true } } };
}
