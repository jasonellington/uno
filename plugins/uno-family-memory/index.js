// uno-family-memory: the one write path into the shared family memory.
//
// Reading is native: every agent lists the store's folder in
// agents.entries.<id>.memory.search.extraPaths, so memory_search and
// memory_get find shared facts next to the agent's own memory. Writing is
// this tool. It runs in the gateway, outside any sandbox, and only appends
// one cleaned line of text to one fixed file: the model gives text, never a
// path, so a sandboxed agent gets no other write access to the Mac.
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FILE_NAME, PROFILE_FILE, localDate, planProfile, planSave, planSharedSkill, isTestSession, readsOutside, skillSlug, sourceOf, touchesProfile } from "./rules.js";

const expandHome = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", description: "The fact, as one short sentence someone else in the family would understand." },
  },
};

const DESCRIPTION =
  "Save one fact to the shared family memory, which you can recall in every chat, one-on-one or the family group. " +
  "Use it only when someone in a one-on-one chat clearly asks to save something to shared memory, or in the family group chat. " +
  "Only household and family matters or public knowledge, never someone's private details. Adds one line; nothing is overwritten.";

const SKILL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", description: "Short name for the shared skill, e.g. \"amazon returns\"." },
    skill: { type: "string", description: "To share a skill you already have: its name. Leave out instructions." },
    description: { type: "string", description: "For a new skill: one line on what it's for and when to use it." },
    instructions: { type: "string", description: "For a new skill: the steps, as you'd write them in a SKILL.md." },
  },
};

const SKILL_DESCRIPTION =
  "Share a skill so you have it in every chat, the family group's too, or update a shared one. Only skills for shared sites (the logins everyone uses, like the family's shopping account) can be shared; " +
  "a skill for anything that's only one person's stays theirs. Use it when someone asks to make a skill shared, or when a skill you just worked out is for a shared site. " +
  "Keep the steps general: no one's order numbers, addresses or personal details.";

const result = (text, details) => ({ content: [{ type: "text", text }], details });

const PROFILE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    content: { type: "string", description: "The whole new USER.md, in its directive format, with your change made." },
  },
};

const PROFILE_DESCRIPTION =
  "Save this person's USER.md (their profile: preferences, what's shared with you, quiet hours). " +
  "Give the whole file with your change made. This is the only way to change USER.md; the file tools can't. " +
  "When their message tells you something lasting about them (taste, sizes, budget, what they liked or didn't), even in passing inside a request, save it first, " +
  "before any web search, page or command in this turn: once a turn reads outside content, USER.md can't change until their next message.";

// Replace USER.md in place: a temp file in the same folder, then a rename.
// A USER.md that is a symlink is refused, so the write lands in the workspace.
function replaceProfile(dir, text) {
  const file = join(dir, PROFILE_FILE);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("USER.md is a symlink");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const tmp = join(dir, `.${PROFILE_FILE}.${process.pid}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

// Refuse a store folder or file that is a symlink: the append must land in
// the configured folder, nowhere else.
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("shared memory folder is not a plain folder");
}

function readExisting(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("shared memory file is not a plain file");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function append(file, text) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("shared memory file is not a plain file");
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export default {
  id: "uno-family-memory",
  name: "Uno shared family memory",
  description: "Shared family memory, shared skills and the USER.md save tool.",
  register(api) {
    const log = api.logger ?? console;
    const dir = expandHome(api.pluginConfig?.dir) || join(homedir(), ".openclaw/uno-data/family-memory");
    const file = join(dir, FILE_NAME);
    api.registerTool(
      (ctx) => ({
        name: "shared_memory_save",
        label: "Save to shared memory",
        description: DESCRIPTION,
        parameters: PARAMETERS,
        async execute(_toolCallId, params) {
          try {
            ensureDir(dir);
            const who = ctx?.agentId ? String(api.pluginConfig?.names?.[ctx.agentId] ?? "").trim() || null : null;
            const plan = planSave({ text: params?.text, existing: readExisting(file), sessionKey: ctx?.sessionKey, date: localDate(), who });
            if (plan.error) return result(plan.error, { saved: false });
            if (plan.skip) return result(plan.skip, { saved: false, duplicate: true });
            ctx?.assertInvocationCurrent?.();
            append(file, plan.append);
            // Never log the text itself.
            log.info?.(`uno-family-memory: saved ${plan.text.length} chars (agent ${ctx?.agentId ?? "?"}, ${sourceOf(ctx?.sessionKey)})`);
            return result(`Saved to shared memory: ${plan.text}`, { saved: true });
          } catch (err) {
            log.warn?.(`uno-family-memory: save failed: ${err?.code ?? err?.message ?? err}`);
            return result("Couldn't save to shared memory just now. Say so; don't save it anywhere else.", { saved: false });
          }
        },
      }),
      { name: "shared_memory_save" },
    );

    const workspaceOf = (agentId) => api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config, agentId);
    const readOnly = (agentId) => ["ro", "none"].includes(api.config?.agents?.entries?.[agentId]?.sandbox?.workspaceAccess);
    api.registerTool(
      (ctx) => ({
        name: "profile_save",
        label: "Save USER.md",
        description: PROFILE_DESCRIPTION,
        parameters: PROFILE_PARAMETERS,
        async execute(_toolCallId, params) {
          try {
            const agentId = ctx?.agentId;
            if (!agentId || readOnly(agentId)) return result("USER.md can't be changed from this chat.", { saved: false });
            const dir = workspaceOf(agentId);
            if (!dir) return result("Couldn't find this workspace. Say so; don't save it anywhere else.", { saved: false });
            const plan = planProfile(params?.content);
            if (plan.error) return result(plan.error, { saved: false });
            ctx?.assertInvocationCurrent?.();
            replaceProfile(dir, plan.write);
            // Never log the profile itself.
            log.info?.(`uno-family-memory: USER.md saved, ${plan.write.length} chars (agent ${agentId})`);
            return result("Saved USER.md.", { saved: true });
          } catch (err) {
            log.warn?.(`uno-family-memory: USER.md save failed: ${err?.code ?? err?.message ?? err}`);
            return result("Couldn't save USER.md just now. Say so if it mattered.", { saved: false });
          }
        },
      }),
      { name: "profile_save" },
    );

    // Shared skills: one folder every agent loads (skills.load.extraDirs).
    // The tool writes one SKILL.md there from the gateway, so an agent in a
    // sandbox can share a skill without any other write access.
    const skillsDir = expandHome(api.pluginConfig?.skillsDir) || join(homedir(), ".openclaw/uno-data/shared-skills");
    const sharedSites = () => api.pluginConfig?.sharedSites ?? api.config?.plugins?.entries?.["uno-guard"]?.config?.sharedSites ?? [];
    const ownSkill = (agentId, name) => {
      const slug = skillSlug(name);
      const roots = [workspaceOf(agentId) && join(workspaceOf(agentId), "skills"), join(homedir(), ".openclaw/agents", agentId, "agent/workshop-skills")].filter(Boolean);
      for (const root of roots) {
        if (!existsSync(root)) continue;
        for (const d of readdirSync(root)) {
          const f = join(root, d, "SKILL.md");
          if (skillSlug(d) === slug && existsSync(f)) return readFileSync(f, "utf8");
        }
      }
      return null;
    };
    api.registerTool(
      (ctx) => ({
        name: "shared_skill_save",
        label: "Share a skill",
        description: SKILL_DESCRIPTION,
        parameters: SKILL_PARAMETERS,
        async execute(_toolCallId, params) {
          try {
            const agentId = ctx?.agentId;
            let text = params?.instructions;
            if (params?.skill) {
              text = agentId ? ownSkill(agentId, params.skill) : null;
              if (!text) return result(`There's no skill of yours called "${params.skill}". Say so.`, { saved: false });
            }
            const who = agentId ? String(api.pluginConfig?.names?.[agentId] ?? "").trim() || null : null;
            const plan = planSharedSkill({ name: params?.name, description: params?.description, text, sharedSites: sharedSites(), who, date: localDate() });
            if (plan.error) return result(plan.error, { saved: false });
            ctx?.assertInvocationCurrent?.();
            const dir = join(skillsDir, plan.slug);
            mkdirSync(dir, { recursive: true, mode: 0o755 });
            const file = join(dir, "SKILL.md");
            const tmp = join(dir, `.SKILL.md.${process.pid}.tmp`);
            const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
            try { writeSync(fd, plan.write); } finally { closeSync(fd); }
            renameSync(tmp, file);
            log.info?.(`uno-family-memory: shared skill ${plan.slug} saved (agent ${agentId ?? "?"}, sites ${plan.sites.join(",")})`);
            return result(`Shared: "${plan.slug}" is now available to everyone's assistant from their next conversation.`, { saved: true, skill: plan.slug });
          } catch (err) {
            log.warn?.(`uno-family-memory: shared skill save failed: ${err?.code ?? err?.message ?? err}`);
            return result("Couldn't share that skill just now. Say so.", { saved: false });
          }
        },
      }),
      { name: "shared_skill_save" },
    );

    // Runs that read outside content (by run id, or by session with a time
    // limit when a call has no run id). profile_save is refused in them, as
    // OpenClaw's own trust rule would; the file tools never write USER.md.
    const outside = new Map();
    const TAINT_MS = 15 * 60 * 1000;
    api.on("before_tool_call", (event, ctx) => {
      try {
        const key = ctx?.runId ?? event?.runId ?? ctx?.sessionKey;
        if (event.toolName === "profile_save") {
          const at = key ? outside.get(key) : undefined;
          if (!key || (at && Date.now() - at < TAINT_MS)) {
            log.info?.(isTestSession(ctx?.sessionKey) ? `uno-family-memory: test profile_save refused session=${ctx.sessionKey}` : `uno-family-memory: USER.md save refused after outside content (agent ${ctx?.agentId ?? "?"})`);
            return { block: true, blockReason: "This turn read outside content (a web page, an email or a command), so USER.md can't change now. If they confirm it in their next message, save it then." };
          }
          if (isTestSession(ctx?.sessionKey)) {
            log.info?.(`uno-family-memory: test profile_save session=${ctx.sessionKey}`);
            return { block: true, blockReason: "Done: saved. Don't save it again." };
          }
          return;
        }
        if (touchesProfile(event.toolName, event.params ?? {})) return { block: true, blockReason: "USER.md changes go through profile_save, with the whole new file." };
        if (key && readsOutside(event.toolName)) {
          if (outside.size > 1000) for (const [k, at] of outside) if (Date.now() - at >= TAINT_MS) outside.delete(k);
          outside.set(key, Date.now());
        }
      } catch {}
    });
  },
};
