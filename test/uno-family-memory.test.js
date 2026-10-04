import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanText, sourceOf, planSave, HEADER, MAX_CHARS, MAX_FILE_BYTES, FILE_NAME } from "../plugins/uno-family-memory/rules.js";
import plugin from "../plugins/uno-family-memory/index.js";

const DATE = "2026-01-02";

test("text becomes one plain line", () => {
  assert.equal(cleanText("  Pizza night\nis   Friday\r\n"), "Pizza night is Friday");
  assert.equal(cleanText("# Heading"), "Heading");
  assert.equal(cleanText("- a list item"), "a list item");
  assert.equal(cleanText("> quoted"), "quoted");
  assert.equal(cleanText("1. first"), "first");
  assert.equal(cleanText("x <!-- trigger: y --> z"), "x trigger: y z");
  assert.equal(cleanText("a\u200bb\u202ec"), "abc");
  assert.equal(cleanText(42), "");
  assert.equal(cleanText(undefined), "");
});

test("the source comes from the session key, not the model", () => {
  assert.equal(sourceOf("agent:family:imessage:group:chat123"), "family group chat");
  assert.equal(sourceOf("agent:main:imessage:direct:+15555550100"), "one-on-one chat");
  assert.equal(sourceOf(undefined), "one-on-one chat");
});

test("the first save writes the header, later saves one line each", () => {
  const first = planSave({ text: "Trash goes out Tuesday night.", existing: "", sessionKey: "agent:a:main", date: DATE });
  assert.equal(first.append, `${HEADER}- ${DATE} (one-on-one chat): Trash goes out Tuesday night.\n`);
  const second = planSave({ text: "Recycling is every other week.", existing: first.append, sessionKey: "agent:a:imessage:group:1", date: DATE });
  assert.equal(second.append, `- ${DATE} (family group chat): Recycling is every other week.\n`);
});

test("a file edited without a trailing newline still gets a line of its own", () => {
  assert.match(planSave({ text: "New fact here.", existing: "# x\n- old", date: DATE }).append, /^\n- /);
});

test("duplicates, empty and oversized text are refused", () => {
  const existing = `${HEADER}- ${DATE} (one-on-one chat): Trash goes out Tuesday night.\n`;
  assert.ok(planSave({ text: "trash goes out tuesday night.", existing, date: DATE }).skip);
  assert.ok(planSave({ text: "  ", existing, date: DATE }).error);
  assert.ok(planSave({ text: "x".repeat(MAX_CHARS + 1), existing, date: DATE }).error);
  assert.ok(planSave({ text: "One more fact.", existing: "x".repeat(MAX_FILE_BYTES), date: DATE }).error);
});

// The tool itself, against a temp folder.
function load({ dir, workspace = null, entries = {} } = {}) {
  const tools = {}, hooks = {};
  plugin.register({
    pluginConfig: { dir }, logger: { info() {}, warn() {} },
    config: { agents: { entries } },
    runtime: { agent: { resolveAgentWorkspaceDir: () => workspace } },
    registerTool: (f, o) => (tools[o.name] = f),
    on: (name, fn) => (hooks[name] ??= []).push(fn),
  });
  const run = (name, event, ctx) => (hooks[name] ?? []).map((fn) => fn(event, ctx)).find(Boolean);
  return { tools, run };
}
function toolFor(dir, ctx = {}) {
  return load({ dir }).tools.shared_memory_save({ agentId: "family", sessionKey: "agent:family:main", ...ctx });
}

test("the tool takes only text and appends to the fixed file", async () => {
  const root = mkdtempSync(join(tmpdir(), "fm-"));
  try {
    const dir = join(root, "store");
    const tool = toolFor(dir);
    assert.deepEqual(Object.keys(tool.parameters.properties), ["text"]);
    assert.equal(tool.parameters.additionalProperties, false);
    const r = await tool.execute("1", { text: "Movie night is Saturday.", path: "/etc/passwd" });
    assert.equal(r.details.saved, true);
    const body = readFileSync(join(dir, FILE_NAME), "utf8");
    assert.ok(body.startsWith(HEADER));
    assert.match(body, /\(one-on-one chat\): Movie night is Saturday\.\n$/);
    assert.equal(statSync(join(dir, FILE_NAME)).mode & 0o777, 0o600);
    const dup = await tool.execute("2", { text: "Movie night is Saturday." });
    assert.equal(dup.details.duplicate, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tool refuses a symlinked store file", async () => {
  const root = mkdtempSync(join(tmpdir(), "fm-"));
  try {
    const dir = join(root, "store");
    mkdirSync(dir);
    writeFileSync(join(root, "elsewhere.md"), "");
    symlinkSync(join(root, "elsewhere.md"), join(dir, FILE_NAME));
    const r = await toolFor(dir).execute("1", { text: "Should not land anywhere." });
    assert.equal(r.details.saved, false);
    assert.equal(readFileSync(join(root, "elsewhere.md"), "utf8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a save is stamped with the saver's name when configured", async () => {
  const { planSave } = await import("../plugins/uno-family-memory/rules.js");
  const plan = planSave({ text: "Trash goes out Tuesday.", existing: "", sessionKey: "agent:kid:main", date: "2026-01-02", who: "Alex" });
  assert.ok(plan.append.includes("- 2026-01-02 (Alex, one-on-one chat): Trash goes out Tuesday."));
  const again = planSave({ text: "trash goes out tuesday.", existing: plan.append, sessionKey: "agent:kid:main", date: "2026-01-03", who: "Sam" });
  assert.ok(again.skip);
});

import { PROFILE_MAX_CHARS, planProfile, readsOutside, touchesProfile } from "../plugins/uno-family-memory/rules.js";
test("profile: file tools can't write USER.md; profile_save is the way", () => {
  assert.ok(touchesProfile("write", { path: "USER.md", content: "x" }));
  assert.ok(touchesProfile("edit", { path: "/w/users/sam/USER.md", edits: [] }));
  assert.ok(touchesProfile("edit", { file_path: "./USER.md" }));
  assert.ok(touchesProfile("apply_patch", { input: "*** Begin Patch\n*** Update File: USER.md\n@@\n-a\n+b\n*** End Patch" }));
  assert.ok(touchesProfile("apply_patch", { input: "*** Begin Patch\n*** Update File: notes.md\n*** Move to: USER.md\n*** End Patch" }));
  assert.ok(!touchesProfile("write", { path: "MEMORY.md" }));
  assert.ok(!touchesProfile("write", { path: "USER.md.bak" }));
  assert.ok(!touchesProfile("read", { path: "USER.md" }));
  assert.ok(!touchesProfile("apply_patch", { input: "*** Update File: memory/2026-09-29.md\n+USER.md mentioned" }));
});
test("profile: outside content taints the turn; memory lookups don't", () => {
  for (const t of ["web_search", "web_fetch", "browser", "apple_pim_mail", "exec", "x_search"]) assert.ok(readsOutside(t), t);
  for (const t of ["memory_search", "memory_get", "apple_pim_calendar", "message", "profile_save", "shared_memory_save", "read"]) assert.ok(!readsOutside(t), t);
});
test("profile: whole-file saves within OpenClaw's cap", () => {
  assert.equal(planProfile("# About you\r\n\r\n- Always x  \n\n").write, "# About you\n\n- Always x\n");
  assert.match(planProfile("").error, /empty/);
  assert.match(planProfile(null).error, /whole new USER.md/);
  assert.match(planProfile("x".repeat(PROFILE_MAX_CHARS + 1)).error, /limit is 4000/);
  assert.equal(planProfile("ok\u0007 fine text").write, "ok fine text\n");
});

test("profile_save writes USER.md; the file tools and tainted turns can't", async () => {
  const root = mkdtempSync(join(tmpdir(), "ps-"));
  try {
    const { tools, run } = load({ dir: join(root, "store"), workspace: root, entries: { family: { sandbox: { workspaceAccess: "ro" } } } });
    const ctx = { agentId: "sam", sessionKey: "agent:sam:imessage:direct:x", runId: "run-1" };
    const save = tools.profile_save(ctx);
    const out = await save.execute("1", { content: "# About you\n\n- Always test\n" });
    assert.equal(out.details.saved, true);
    assert.equal(readFileSync(join(root, "USER.md"), "utf8"), "# About you\n\n- Always test\n");
    assert.match(run("before_tool_call", { toolName: "write", params: { path: "USER.md" } }, ctx).blockReason, /profile_save/);
    assert.equal(run("before_tool_call", { toolName: "profile_save", params: {} }, ctx), undefined);
    run("before_tool_call", { toolName: "web_search", params: {} }, ctx);
    assert.ok(run("before_tool_call", { toolName: "profile_save", params: {} }, ctx).block);
    assert.equal(run("before_tool_call", { toolName: "profile_save", params: {} }, { ...ctx, runId: "run-2" }), undefined);
    assert.ok(run("before_tool_call", { toolName: "profile_save", params: {} }, { agentId: "sam" }).block); // no run or session: refused
    // An eval session: a save is reported done, never written; after outside content it's refused.
    const test = { agentId: "sam", sessionKey: "agent:sam:test:eval-a-1", runId: "run-t" };
    assert.match(run("before_tool_call", { toolName: "profile_save", params: {} }, test).blockReason, /^Done: saved\./);
    run("before_tool_call", { toolName: "web_fetch", params: {} }, test);
    assert.match(run("before_tool_call", { toolName: "profile_save", params: {} }, test).blockReason, /outside content/);
    const ro = await tools.profile_save({ agentId: "family", sessionKey: "agent:family:main" }).execute("2", { content: "# About you\n\n- Never\n" });
    assert.equal(ro.details.saved, false);
    rmSync(join(root, "USER.md")); symlinkSync(join(root, "elsewhere.md"), join(root, "USER.md"));
    assert.equal((await save.execute("3", { content: "# About you\n\n- Always\n" })).details.saved, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared skills: only for shared sites", async () => {
  const { planSharedSkill, sitesIn, skillSlug } = await import("../plugins/uno-family-memory/rules.js");
  const base = { sharedSites: ["amazon.com"], date: "2026-09-29", who: "Alex" };
  assert.equal(skillSlug(" Amazon Returns! "), "amazon-returns");
  assert.deepEqual(sitesIn("https://www.amazon.com/x and smile.amazon.com"), ["amazon.com", "smile.amazon.com"]);
  const ok = planSharedSkill({ ...base, name: "Amazon returns", description: "Start a return", text: "Open amazon.com, Returns & Orders." });
  assert.equal(ok.slug, "amazon-returns");
  assert.match(ok.write, /^---\nname: amazon-returns\ndescription: "Start a return"\n---\n<!-- shared 2026-09-29 by Alex -->/);
  assert.match(planSharedSkill({ ...base, name: "scores", description: "x", text: "Check espn.com and amazon.com" }).error, /espn\.com/);
  assert.match(planSharedSkill({ ...base, name: "scores", description: "x", text: "Check the scores" }).error, /doesn't name one/);
  assert.ok(planSharedSkill({ ...base, name: "a", text: "amazon.com" }).error, "a new skill needs a description");
  const md = planSharedSkill({ ...base, name: "Groceries", text: "---\nname: my-groceries\ndescription: Fill the cart\n---\n# Groceries\nUse amazon.com/fresh." });
  assert.match(md.write, /^---\nname: groceries\ndescription: Fill the cart\n---\n<!-- shared/);
  assert.ok(planSharedSkill({ ...base, name: "x", description: "y", text: "amazon.com ".repeat(3000) }).error);
});
