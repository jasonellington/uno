// uno-guard (README.md): Uno's guardrails, enforced in code for every agent.
// - texting only the family: checked on the message tool, on shell commands
//   that text or email, and at the send itself; the admin's agent can ask the
//   owner for 👍 for anyone else, every other agent is told no.
// - email and invites outside the family: the owner's 👍, or a no.
// - purchases: the model declares them with purchase_check; the owner's
//   limit and 👍 decide.
// - per-person scoping: mail, Apple lists (filter lock), photo uploads, the
//   family browser profile and shared sites.
// - the silent fallback agent, the audit log, the shell log, and the
//   household setup note built from these settings.
// Its hooks run before uno-imsg-proxy's (priority GUARD), so a block here
// always wins. Hooks never throw into a turn and never log message text.
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { approvalFor, approvalOrBlock, gate, householdHandles, signInSite, signInTask, signInOutcome, signInReply, APPROVAL_WAIT_MS, parseApprovalPrompt, isApprovalFollowUp, approvalFrom, cleanApprovalPrompt, decisionOfTapback, siteRole, changeCheck, CHANGE_GO, siteSpawnDecision, deployDecision, siteToolDecision, siteNote, coderShellDecision, textDecision, sendDecision, shellSendDecision, householdNote, unlockedSpaces, shellEntry, browserDecision, pimDecision, adminBrowserProfile, siteOf, purchaseCheck, PURCHASES_OFF, PURCHASE_GO, agentOfSession, uploadDecision, mailDecision, mailFilter } from "./rules.js";

const CHAT_DB = join(homedir(), "Library/Messages/chat.db");
const PIM_ROOT = join(homedir(), ".openclaw/uno-data/pim");
// Guard hooks run first: before_tool_call blocks are terminal, and a cancelled
// send skips lower-priority handlers.
const GUARD = { priority: 100 };

// Plugin settings with defaults. A missing or blank adminAgentId means no
// agent is admin.
export function settings(config = {}) {
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return {
    adminAgentId: text(config.adminAgentId),
    fallbackAgentId: text(config.fallbackAgentId),
    ownerName: text(config.ownerName),
    testSink: text(config.testSinkHandle),
    mailAddresses: obj(config.mailAddresses),
    sharedSites: Array.isArray(config.sharedSites) ? config.sharedSites.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [],
    purchases: ["approve", "limit"].includes(config.purchases) ? config.purchases : "off",
    purchaseLimit: Number.isFinite(config.purchaseLimit) && config.purchaseLimit >= 0 ? config.purchaseLimit : 25,
    purchaseFreeSites: Array.isArray(config.purchaseFreeSites) ? config.purchaseFreeSites.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [],
    approvalAgents: Array.isArray(config.approvalAgents) ? config.approvalAgents.map(String) : [],
    familySpaces: obj(config.familySpaces),
    spaces: obj(config.spaces),
    sites: obj(config.sites),
    logDir: text(config.logDir) ?? join(homedir(), ".openclaw/uno-data"),
  };
}

export default {
  id: "uno-guard",
  name: "Uno guard",
  description: "Uno's guardrails: whom it texts and emails, approvals, purchases, and per-person scoping.",
  register(api) {
    const log = api.logger ?? console;
    const { adminAgentId, fallbackAgentId, ownerName, testSink, mailAddresses, sharedSites, purchases, purchaseLimit, purchaseFreeSites, approvalAgents, familySpaces, spaces, sites, logDir } = settings(api.pluginConfig ?? {});
    const household = () => householdHandles(api.config?.channels?.imessage, api.config?.accessGroups);
    // Other agents' approvals reach the owner only when approvals.plugin
    // forwards them to explicit targets (the owner's chat); otherwise they'd
    // sit unseen, so those agents get a plain no instead.
    const routed = () => { const a = api.config?.approvals?.plugin; return Boolean(a?.enabled && ["targets", "both"].includes(a?.mode) && a?.targets?.length); };
    const askers = () => (routed() ? approvalAgents : []);
    const isFallback = (key) => Boolean(fallbackAgentId) && agentOfSession(key) === fallbackAgentId;

    // Recipients the owner just approved texting (10 minutes), so the send
    // check lets that text out. A file: plugin copies share no memory.
    const APPROVED_FILE = join(tmpdir(), "uno-approved-recipients.json");
    const readApproved = () => { try { return JSON.parse(readFileSync(APPROVED_FILE, "utf8")).filter((e) => Date.now() - e.t < 600_000); } catch { return []; } };
    const approve = (recipients) => { try { writeFileSync(APPROVED_FILE, JSON.stringify([...readApproved(), ...(recipients ?? []).map((h) => ({ h, t: Date.now() }))]), { mode: 0o600 }); } catch {} };

    // Tools that can wait on the owner's 👍 carry their own time limit: the
    // Codex harness stops a plugin tool call after 90 s unless the call's
    // arguments give a timeoutMs (up to 10 min), and there's no setting for
    // it. APPROVAL_WAIT_MS covers the 5-minute approval.
    const WAIT = { timeoutMs: { type: "integer", enum: [APPROVAL_WAIT_MS], description: `Always ${APPROVAL_WAIT_MS}: time to wait for the owner's OK` } };

    // purchase_check: the model calls it before anything that spends money;
    // the before_tool_call hook applies the owner's rules (rules.js
    // purchaseCheck), so reaching execute means it may go ahead.
    try {
      api.registerTool?.(() => ({
        name: "purchase_check",
        label: "Check a purchase",
        description: "Call right before anything that spends money: placing an order, starting or upgrading a subscription, paying. Give what it is, the site and the total you see (omit total if the page doesn't show one). Go ahead only if it says so.",
        parameters: { type: "object", additionalProperties: false, required: ["what", "timeoutMs"], properties: { ...WAIT,
          what: { type: "string", description: "What's being bought, in a few words" },
          site: { type: "string", description: "The site, e.g. example.com" },
          total: { type: "number", description: "The order total in dollars, as shown on the page" },
        } },
        async execute() { return { content: [{ type: "text", text: PURCHASE_GO }], details: { go: true } }; },
      }), { name: "purchase_check" });
    } catch (err) { log.warn?.(`uno-guard: purchase_check not registered: ${err?.message ?? err}`); }

    // family_sign_in: a family agent asks the admin's agent to sign in to a
    // site on the family browser (rules.js signInSite, signInTask). The admin's
    // agent runs it in its own background session and ends with an outcome
    // word; the caller gets a fixed reply for it. One run per site at a time.
    const signIns = new Map();
    const lastText = (messages) => {
      for (const m of [...(messages ?? [])].reverse()) {
        if (m?.role !== "assistant") continue;
        const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
        if (text.trim()) return text;
      }
      return "";
    };
    const signIn = async ({ site, shared, who }) => {
      const sessionKey = `agent:${adminAgentId}:subagent:family-sign-in-${Date.now()}`;
      const { runId } = await api.runtime.subagent.run({ sessionKey, message: signInTask({ site, shared, who, ownerName }), deliver: false });
      const done = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 240_000 });
      const text = done?.terminalReply ?? lastText((await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 }))?.messages);
      const outcome = done?.status === "ok" ? signInOutcome(typeof text === "string" ? text : JSON.stringify(text)) : "FAILED";
      log.info?.(`uno-guard: family sign-in ${site} -> ${outcome} (${done?.status ?? "?"})`);
      if (done?.status !== "pending" && done?.status !== "timeout") api.runtime.subagent.deleteSession?.({ sessionKey }).catch?.(() => {});
      return outcome;
    };
    try {
      api.registerTool?.((ctx) => ({
        name: "family_sign_in",
        label: "Sign in to a family site",
        description: "Call when a site in the family browser asks you to sign in, or someone asks you to sign in to one. You can't sign in yourself; this gets it signed in for you. Give the site, e.g. example.com.",
        parameters: { type: "object", additionalProperties: false, required: ["site"], properties: {
          site: { type: "string", description: "The site, e.g. example.com" },
        } },
        async execute(_toolCallId, params) {
          const reply = (text, details) => ({ content: [{ type: "text", text }], details });
          try {
            if (!adminAgentId || !api.runtime?.subagent) return reply("Signing in isn't available.", { ok: false });
            if (ctx?.agentId === adminAgentId) return reply("Sign in yourself with the family-sign-in skill.", { ok: false });
            const req = signInSite(params?.site, sharedSites);
            if (!req) return reply("That isn't a site name. Give it like example.com.", { ok: false });
            const names = api.config?.plugins?.entries?.["uno-family-memory"]?.config?.names ?? {};
            const who = String(ctx?.sessionKey ?? "").includes(":group:") ? "the family group chat" : names[ctx?.agentId] ?? "a family member";
            if (!signIns.has(req.site)) signIns.set(req.site, signIn({ ...req, who }).finally(() => signIns.delete(req.site)));
            const outcome = await signIns.get(req.site);
            return reply(signInReply(outcome, { site: req.site, ownerName }), { outcome });
          } catch (err) {
            log.warn?.(`uno-guard: family sign-in failed: ${err?.message ?? err}`);
            return reply(signInReply("FAILED", { site: String(params?.site ?? "the site"), ownerName }), { outcome: "FAILED" });
          }
        },
      }), { name: "family_sign_in" });
    } catch (err) { log.warn?.(`uno-guard: family_sign_in not registered: ${err?.message ?? err}`); }

    // Websites (rules.js siteRole): change_check sizes a change (a large one
    // waits for the owner's 👍 in the hook below) and, once through, lets this
    // chat start its coder for 2 hours; site_deploy merges a pull request on
    // GitHub with the site's token, which the model never sees.
    const CLEARED_FILE = join(tmpdir(), "uno-site-cleared.json");
    const readCleared = () => { try { return JSON.parse(readFileSync(CLEARED_FILE, "utf8")).filter((e) => Date.now() - e.t < 7_200_000); } catch { return []; } };
    const clear = (key) => { try { writeFileSync(CLEARED_FILE, JSON.stringify([...readCleared(), { key, t: Date.now() }]), { mode: 0o600 }); } catch {} };
    const cleared = (key) => readCleared().some((e) => e.key === key);
    const text = (t, details) => ({ content: [{ type: "text", text: t }], details });
    try {
      api.registerTool?.((ctx) => ({
        name: "change_check",
        label: "Check a website change",
        description: "Call once a website change is clear, before starting the coder. Say what it is and whether it's small (wording, photos, prices shown on a page, a small style fix) or large (a new page or feature, checkout or payments, a redesign, anything risky or long). A large one waits for the owner's OK. Start the coder only if it says go.",
        parameters: { type: "object", additionalProperties: false, required: ["summary", "size", "timeoutMs"], properties: { ...WAIT,
          summary: { type: "string", description: "The change, in a sentence or two" },
          size: { type: "string", enum: ["small", "large"] },
        } },
        async execute() {
          if (siteRole(ctx?.agentId, sites)?.role !== "chat") return text("Not available.", { go: false });
          clear(ctx?.sessionKey ?? "none");
          return text(CHANGE_GO, { go: true });
        },
      }), { name: "change_check" });
      api.registerTool?.((ctx) => ({
        name: "site_deploy",
        label: "Deploy the website",
        description: "Call after the quality agent passed a change's preview: merges its pull request, which deploys the site. It asks the owner first.",
        parameters: { type: "object", additionalProperties: false, required: ["pr", "summary", "timeoutMs"], properties: { ...WAIT,
          pr: { type: "integer", description: "The pull request number" },
          summary: { type: "string", description: "The change, in a sentence" },
        } },
        async execute(_id, params) {
          const role = siteRole(ctx?.agentId, sites);
          if (role?.role !== "chat") return text("Not available.", { ok: false });
          const { repo, tokenFile } = role.site;
          if (!repo || !tokenFile) return text("GitHub isn't connected yet, so it can't deploy. Tell them the change waits on that.", { ok: false });
          let token;
          try { token = readFileSync(tokenFile, "utf8").trim(); } catch { return text("The GitHub token is missing. Tell them it can't deploy right now.", { ok: false }); }
          const ok = await new Promise((resolve) => execFile("gh", ["pr", "merge", String(Number(params?.pr)), "--repo", repo, "--squash", "--delete-branch"],
            { env: { ...process.env, GH_TOKEN: token }, timeout: 60_000 }, (err) => resolve(!err)));
          log.info?.(`uno-guard: site deploy PR #${Number(params?.pr)} ${ok ? "merged" : "failed"} for ${ctx?.agentId}`);
          return ok ? text("Merged; the site is deploying. Check the live site, then tell them it's done.", { ok: true })
            : text("The merge didn't go through. Tell them in a line; don't retry on your own.", { ok: false });
        },
      }), { name: "site_deploy" });
    } catch (err) { log.warn?.(`uno-guard: website tools not registered: ${err?.message ?? err}`); }

    // Senders with no binding of their own land on the fallback agent: its
    // turns end in silence before the model runs, and nothing it would send
    // (an error line included) goes out.
    api.on("before_agent_reply", (event, ctx) => {
      if (fallbackAgentId && ctx?.agentId === fallbackAgentId) {
        log.info?.("uno-guard: fallback agent turn silenced");
        return { handled: true };
      }
    }, GUARD);
    api.on("reply_payload_sending", (event, ctx) => {
      if (isFallback(event.sessionKey ?? ctx?.sessionKey)) return { cancel: true, reason: "fallback agent" };
    }, GUARD);

    // Audit: every tool call from an agent other than the admin's, with the
    // action and any path, URL or target (never content), in the gateway log.
    api.on("before_tool_call", (event, ctx) => {
      try {
        if (!ctx?.agentId || ctx.agentId === adminAgentId) return;
        const p = event.params ?? {};
        const where = ["path", "file", "filePath", "paths", "url", "targetUrl", "target", "to", "media", "mediaUrl", "configDir", "profile", "sessionKey", "agentId", "slug"]
          .filter((k) => p[k] != null).map((k) => `${k}=${JSON.stringify(p[k]).slice(0, 120)}`).join(" ");
        log.info?.(`uno-guard: audit ${ctx.agentId} ${event.toolName}${p.action ? `.${p.action}` : ""} ${where}`.trim());
      } catch {}
    }, GUARD);

    // Shell log: every shell-type tool call, appended to shell-commands.jsonl (0600).
    const SHELL_LOG = join(logDir, "shell-commands.jsonl");
    api.on("before_tool_call", (event, ctx) => {
      try {
        const entry = shellEntry(event.toolName, event.params);
        if (entry) appendFileSync(SHELL_LOG, `${JSON.stringify({ ...entry, agent: ctx?.agentId ?? null })}\n`, { mode: 0o600 });
      } catch {}
    }, GUARD);

    // Who each incoming photo or file belongs to (file name -> agent), kept in
    // logDir so a restart doesn't forget it (rules.js uploadDecision).
    const OWNERS_FILE = join(logDir, "media-owners.json");
    const mediaOwners = new Map((() => { try { return Object.entries(JSON.parse(readFileSync(OWNERS_FILE, "utf8"))); } catch { return []; } })());
    api.on("message_received", (event, ctx) => {
      try {
        const agent = agentOfSession(ctx?.sessionKey);
        const names = (event.media ?? []).map((m) => m?.path && String(m.path).split("/").pop()).filter(Boolean);
        if (!agent || !names.length) return;
        for (const n of names) { mediaOwners.delete(n); mediaOwners.set(n, agent); }
        while (mediaOwners.size > 2000) mediaOwners.delete(mediaOwners.keys().next().value);
        writeFileSync(OWNERS_FILE, JSON.stringify(Object.fromEntries(mediaOwners)), { mode: 0o600 });
      } catch {}
    });

    // Mail results for everyone but the admin: only their own messages reach
    // the model (rules.js mailFilter).
    try {
      api.registerAgentToolResultMiddleware?.((event, ctx) => {
        try {
          if (event.toolName !== "apple_pim_mail" || !ctx?.agentId || ctx.agentId === adminAgentId) return;
          const content = (event.result?.content ?? []).map((c) => (c?.type === "text" ? { ...c, text: mailFilter(event.args?.action, c.text, mailAddresses[ctx.agentId]) } : c));
          return { result: { ...event.result, content, details: undefined } };
        } catch {
          return { result: { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Not found." }) }] } };
        }
      }, { runtimes: ["openclaw", "codex"] });
    } catch (err) { log.warn?.(`uno-guard: mail result filter not registered: ${err?.message ?? err}`); }

    // Apple data for everyone but the admin goes through their own locked
    // filter file (rules.js pimDecision). Registered before the approval hook
    // so an approval freezes the locked parameters.
    api.on("before_tool_call", (event, ctx) => {
      try {
        const mail = mailDecision(event.toolName, event.params, ctx?.agentId, adminAgentId, mailAddresses);
        if (mail) { log.info?.(`uno-guard: mail blocked for ${ctx?.agentId}`); return mail; }
        const decision = pimDecision(event.toolName, event.params, ctx?.agentId, adminAgentId, PIM_ROOT, existsSync);
        if (decision) log.info?.(`uno-guard: apple ${decision.block ? "blocked" : "scoped"} for ${ctx?.agentId}`);
        return decision ?? undefined;
      } catch { return { block: true, blockReason: "Not available." }; }
    }, GUARD);

    // Browser: family agents only with the shared family profile; the admin's
    // agent opens shared sites there and everything else in its own.
    const lastBrowserProfile = new Map();
    api.on("before_tool_call", (event, ctx) => {
      try {
        if (event.toolName === "browser" && adminAgentId && ctx?.agentId === adminAgentId) {
          if (!sharedSites.length) return;
          const key = ctx?.sessionKey ?? "none";
          const profile = adminBrowserProfile(event.params, { sharedSites, defaultProfile: api.config?.browser?.defaultProfile ?? "openclaw", lastProfile: lastBrowserProfile.get(key) });
          if (!profile) return;
          lastBrowserProfile.set(key, profile);
          const url = event.params?.url ?? event.params?.targetUrl;
          log.info?.(`uno-guard: admin browser ${event.params?.action ?? "?"}${url ? ` ${siteOf(url) ?? "?"}` : ""} -> ${profile}${event.params?.profile ? ` (asked ${event.params.profile})` : ""}`);
          return profile === event.params?.profile ? undefined : { params: { ...(event.params ?? {}), profile } };
        }
        const site = siteToolDecision(event.toolName, event.params, siteRole(ctx?.agentId, sites));
        if (site) { if (site.block) log.info?.(`uno-guard: ${event.toolName} blocked for ${ctx?.agentId}`); return site; }
        const decision = browserDecision(event.toolName, event.params, ctx?.agentId, adminAgentId);
        const upload = decision?.params ? uploadDecision(event.params, ctx?.agentId, mediaOwners) : null;
        if (upload) { log.info?.(`uno-guard: browser upload blocked for ${ctx?.agentId}`); return upload; }
        if (decision) log.info?.(`uno-guard: browser ${decision.block ? `blocked (${event.params?.action})` : "on the family profile"} for ${ctx?.agentId}`);
        return decision ?? undefined;
      } catch { return event.toolName === "browser" && ctx?.agentId !== adminAgentId ? { block: true, blockReason: "Not available." } : undefined; }
    }, GUARD);

    // Texting, email, invites and purchases: the owner's rules (rules.js).
    api.on("before_tool_call", (event, ctx) => {
      try {
        // Email and invites to the family (anyone Uno texts freely, plus each
        // person's mailAddresses) need no approval, like texting them.
        const owners = [...household(), ...Object.values(mailAddresses).flat()].map(String);
        const chat = ctx?.chatId ?? ctx?.conversationId;
        const current = [chat, chat != null ? `chat_id:${chat}` : null, ctx?.requester?.senderId, ctx?.senderId, ...(mailAddresses[ctx?.agentId] ?? [])].filter((x) => x != null).map(String);
        // Texting outside the family, or texting or emailing from the shell:
        // the owner's 👍 in the admin's agent (or an approvalAgents one), a
        // plain no anywhere else.
        const send = textDecision(event.toolName, event.params ?? {}, { household: household(), current, sink: testSink })
          ?? shellSendDecision(event.toolName, event.params, { household: household(), sink: testSink });
        const sendGate = gate(send, ctx?.agentId, adminAgentId, askers());
        if (sendGate?.block) { log.info?.(`uno-guard: ${event.toolName} send outside the family blocked for ${ctx?.agentId}`); return sendGate; }
        if (sendGate) {
          log.info?.(`uno-guard: ${event.toolName} send needs the owner's approval`);
          return { requireApproval: { ...sendGate.requireApproval, onResolution: (d) => { if (d === "allow-once" || d === "allow-always") approve(send.recipients); log.info?.(`uno-guard: send approval ${d}`); } } };
        }
        const approval = approvalOrBlock(approvalFor(event.toolName, event.params ?? {}, { owners, current, sink: testSink }), ctx?.agentId, adminAgentId, askers());
        if (approval) { if (approval.block) log.info?.(`uno-guard: ${event.toolName} to others blocked for ${ctx?.agentId}`); return approval; }
        const role = siteRole(ctx?.agentId, sites);
        if (event.toolName === "change_check") {
          if (role?.role !== "chat") return { block: true, blockReason: "Not available." };
          const d = changeCheck(event.params ?? {});
          log.info?.(`uno-guard: website change ${d.block ? "unclear" : d.allow ? "small" : "large, needs the owner's approval"} for ${ctx?.agentId}`);
          if (d.block) return { block: true, blockReason: d.block };
          if (d.ask) return routed() ? { requireApproval: d.ask } : { block: true, blockReason: "Large changes need the owner's OK, and approvals aren't set up. Tell them to ask the owner." };
          return;
        }
        if (event.toolName === "site_deploy") {
          const d = deployDecision(event.params ?? {}, role);
          if (d.block) return { block: true, blockReason: d.block };
          log.info?.(`uno-guard: website deploy ${d.ask ? "needs the owner's approval" : "automatic"} for ${ctx?.agentId}`);
          if (d.ask) return routed() ? { requireApproval: d.ask } : { block: true, blockReason: "Deploys need the owner's OK, and approvals aren't set up." };
          return;
        }
        const ship = coderShellDecision(event.toolName, event.params, role);
        if (ship) { log.info?.(`uno-guard: coder ship command blocked for ${ctx?.agentId}`); return ship; }
        if (event.toolName === "sessions_spawn" && role) {
          const d = siteSpawnDecision(event.params ?? {}, role, cleared(ctx?.sessionKey ?? "none"));
          if (d?.block) log.info?.(`uno-guard: start ${event.params?.agentId ?? "?"} blocked for ${ctx?.agentId}`);
          return d ?? undefined;
        }
        if (event.toolName === "purchase_check") {
          const d = purchaseCheck(event.params ?? {}, { mode: purchases, limit: purchaseLimit, freeSites: purchaseFreeSites });
          log.info?.(`uno-guard: purchase ${d.block ? "off" : d.free ? "on a no-approval site" : d.allow ? "under the limit" : "needs the owner's approval"} for ${ctx?.agentId}${d.amount != null ? ` ($${d.amount.toFixed(2)})` : ""}`);
          if (d.block) return { block: true, blockReason: d.block };
          // Any agent's purchase approval goes to the owner when approvals are
          // routed there; otherwise only the admin's chat has an approver.
          if (d.ask) return ctx?.agentId === adminAgentId || routed() ? { requireApproval: d.ask } : { block: true, blockReason: PURCHASES_OFF };
        }
      } catch {}
    }, GUARD);

    // Household setup from config (rules.js householdNote), every chat turn.
    api.on("before_prompt_build", (event, ctx) => {
      try {
        const key = String(ctx?.sessionKey ?? "");
        const agentId = ctx?.agentId ?? agentOfSession(key);
        if (!key.includes(":imessage:") || !agentId || agentId === fallbackAgentId) return;
        const role = siteRole(agentId, sites);
        if (role) return role.role === "chat" ? { appendContext: siteNote({ ownerName, site: role.site }) } : undefined;
        const admin = agentId === adminAgentId;
        const pim = admin ? null : (() => { try { return JSON.parse(readFileSync(join(PIM_ROOT, agentId, "config.json"), "utf8")); } catch { return null; } })();
        const entry = api.config?.agents?.entries?.[agentId] ?? {};
        const denied = [...(entry.tools?.deny ?? []), ...(entry.tools?.sandbox?.tools?.deny ?? [])];
        return { appendContext: householdNote({
          agentId, adminAgentId, ownerName, group: key.includes(":group:"), sharedSites, purchases, purchaseLimit, purchaseFreeSites, asks: askers().includes(agentId),
          textsOutside: entry.tools?.message?.crossContext?.allowWithinProvider !== false, invites: !denied.includes("apple_pim_calendar"), scheduled: !denied.includes("cron"),
          selfAddresses: api.config?.channels?.["apple-mail"]?.selfAddresses ?? [],
          mailAddresses: mailAddresses[agentId] ?? [], mailTool: !denied.includes("apple_pim_mail") && pim?.mail?.enabled !== false,
          familySpaces, spaces: spaces[agentId] ?? {},
          unlocked: admin ? null : unlockedSpaces(pim, api.config?.plugins?.entries?.["uno-apple-tools"]?.config?.agents?.[agentId]),
        }) };
      } catch {}
    });

    // Approvals by iMessage, in plain words (rules.js parseApprovalPrompt):
    // uno-guard's forwarded approval prompt is replaced by one plain question
    // sent with imsg, and a watcher resolves the approval through OpenClaw's
    // approval service when the owner taps 👍 or 👎 on it (the service checks
    // the owner is an approver). OpenClaw's "✅ Plugin approval …" follow-up is
    // cancelled. If the plain question can't be sent, OpenClaw's prompt goes
    // out as is. Pending approvals live in a file: plugin copies share no memory.
    const PENDING_FILE = join(tmpdir(), "uno-approvals-pending.json");
    const readPending = () => { try { return JSON.parse(readFileSync(PENDING_FILE, "utf8")).filter((e) => Date.now() - e.t < 360_000); } catch { return []; } };
    const writePending = (list) => { try { writeFileSync(PENDING_FILE, JSON.stringify(list), { mode: 0o600 }); } catch {} };
    const imsgBin = () => api.config?.plugins?.entries?.["uno-imsg-proxy"]?.config?.imsgPath ?? "/opt/homebrew/bin/imsg";
    const bare = (h) => String(h ?? "").trim().replace(/^(imessage|sms|auto):/i, "").toLowerCase();
    const withChatDb = (fn) => { const db = new DatabaseSync(CHAT_DB, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
    const sendPlainApproval = (to, text) => {
      const chat = withChatDb((db) => db.prepare("SELECT ROWID AS id, guid FROM chat WHERE lower(chat_identifier) = ? ORDER BY ROWID DESC LIMIT 1").get(bare(to)));
      if (!chat?.guid) return null;
      execFileSync(imsgBin(), ["send", "--chat-guid", chat.guid, "--text", text], { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
      for (let i = 0; i < 20; i++) {
        const row = withChatDb((db) => db.prepare(`SELECT m.guid FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
          WHERE j.chat_id = ? AND m.is_from_me = 1 AND m.text = ? ORDER BY m.ROWID DESC LIMIT 1`).get(chat.id, text));
        if (row?.guid) return row.guid;
        execFileSync("sleep", ["0.25"]);
      }
      return null;
    };
    api.on("message_sending", (event, ctx) => {
      if (ctx?.channelId && ctx.channelId !== "imessage") return;
      const text = String(event.content ?? "");
      if (isApprovalFollowUp(text)) { log.info?.("uno-guard: approval follow-up cancelled (the reaction says it)"); return { cancel: true, cancelReason: "approval follow-up" }; }
      const p = parseApprovalPrompt(text);
      if (!p || p.plugin !== "uno-guard") return;
      try {
        const names = api.config?.plugins?.entries?.["uno-family-memory"]?.config?.names ?? {};
        const groupAgents = (api.config?.bindings ?? []).filter((b) => b?.match?.peer?.kind === "group").map((b) => b.agentId);
        const plain = cleanApprovalPrompt(p, approvalFrom(p.agent, { adminAgentId, names, sites, groupAgents }));
        const guid = sendPlainApproval(event.to, plain);
        if (!guid) { log.warn?.("uno-guard: plain approval not sent; OpenClaw's prompt goes out"); return; }
        writePending([...readPending().filter((e) => e.id !== p.id), { id: p.id, guid, owner: bare(event.to), t: Date.now() }]);
        log.info?.(`uno-guard: approval ${p.id.slice(0, 15)} sent as a plain question`);
        return { cancel: true, cancelReason: "sent as a plain approval" };
      } catch (err) {
        log.warn?.(`uno-guard: plain approval failed (${err?.name ?? "error"}); OpenClaw's prompt goes out`);
      }
    }, { priority: 950 });
    let resolveApproval = null;
    const watchApprovals = async () => {
      const pending = readPending();
      if (!pending.length) return;
      for (const e of pending) {
        const r = withChatDb((db) => db.prepare(`SELECT m.associated_message_type AS type, h.id AS handle FROM message m JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.is_from_me = 0 AND m.associated_message_type IN (2001, 2002) AND m.associated_message_guid LIKE ? ORDER BY m.ROWID DESC LIMIT 1`).get(`%${e.guid}`));
        const decision = decisionOfTapback(r?.type);
        if (!decision || bare(r.handle) !== e.owner) continue;
        try { writeFileSync(join(tmpdir(), `uno-approval-${e.id.replace(/[^\w-]/g, "_")}`), "", { flag: "wx" }); } catch { continue; } // another copy has it
        writePending(readPending().filter((x) => x.id !== e.id));
        try {
          resolveApproval ??= (await import("openclaw/plugin-sdk/approval-gateway-runtime")).resolveApprovalOverGateway;
          await resolveApproval({ cfg: api.config, approvalKind: "plugin", approvalId: e.id, decision, channel: "imessage", accountId: "default", senderId: r.handle });
          log.info?.(`uno-guard: approval ${e.id.slice(0, 15)} ${decision} by the owner's tapback`);
        } catch (err) {
          log.error?.(`uno-guard: couldn't resolve approval ${e.id.slice(0, 15)} (${err?.message ?? err})`);
        }
      }
    };
    const approvalTimer = setInterval(() => { watchApprovals().catch(() => {}); }, 1500);
    approvalTimer.unref?.();

    // Test sink: anything addressed to testSinkHandle (a fictional 555-01xx
    // number) is logged, with how many attachments it carried, and never sent.
    api.on("message_sending", (event) => {
      if (!testSink || !String(event.to ?? "").replace(/\D/g, "").endsWith(testSink.replace(/\D/g, ""))) return;
      const media = [event.mediaUrl, ...(event.mediaUrls ?? [])].filter(Boolean);
      log.info?.(`uno-guard: test sink cancelled a message (${String(event.content ?? "").length} chars, ${media.length} attachment(s): ${media.map((m) => String(m).split("/").pop()).join(", ")})`);
      return { cancel: true, cancelReason: "test sink" };
    }, { priority: 1000 });

    // Texting only the family, at the send itself: every outgoing iMessage,
    // however it was sent (rules.js sendDecision), plus anyone the owner
    // approved in the last 10 minutes. The fallback agent sends nothing.
    const chatMembers = (to) => {
      const id = /^chat_id:(\d+)$/.exec(to)?.[1];
      if (!id && !to.includes(";")) return [to];
      const db = new DatabaseSync(CHAT_DB, { readOnly: true });
      try {
        return db.prepare(`SELECT h.id FROM chat_handle_join ch JOIN handle h ON h.ROWID = ch.handle_id
          JOIN chat c ON c.ROWID = ch.chat_id WHERE ${id ? "c.ROWID = ?" : "c.guid = ?"}`).all(id ? Number(id) : to).map((r) => r.id);
      } finally { db.close(); }
    };
    api.on("message_sending", (event, ctx) => {
      if (isFallback(ctx?.sessionKey)) return { cancel: true, cancelReason: "fallback agent" };
      if (ctx?.channelId && ctx.channelId !== "imessage") return;
      try {
        const d = sendDecision(event.to, { household: household(), sink: testSink, members: chatMembers, approved: readApproved().map((e) => e.h) });
        if (d) log.warn?.(`uno-guard: send to someone outside the family cancelled (to=${String(event.to ?? "").replace(/[0-9]/g, "#").replace(/[a-z0-9._%+-]+@/gi, "x@")})`);
        return d ?? undefined;
      } catch {
        log.warn?.("uno-guard: couldn't check a send's recipients; cancelled");
        return { cancel: true, cancelReason: "recipient check failed" };
      }
    }, { priority: 900 });
  },
};
