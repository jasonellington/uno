import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, osascriptRunner, SCRIPTS } from "../plugins/uno-apple-tools/index.js";
import { cleanRel, workspaceRel, scopeFor, settings, textToHtml, TOOL_NAMES } from "../plugins/uno-apple-tools/rules.js";
import { runFiles } from "../plugins/uno-apple-tools/files.js";

const AGENT = "family-test";
const CONFIG = { agents: { [AGENT]: { notesFolder: "Test Family", filesFolder: "Test Family" }, "notes-only": { notesFolder: "Other", music: false } } };

// A fake OpenClaw api: records the factories; `run` is the stubbed osascript.
function setup({ config = CONFIG, reply = () => "{}", driveRoot } = {}) {
  const calls = [];
  const factories = new Map();
  const api = { pluginConfig: config, logger: { warn() {}, info() {} }, registerTool: (f, opts) => factories.set(opts.name, { f, opts }) };
  const run = async (script, input, timeoutMs) => { calls.push({ script, input, timeoutMs }); return reply(input, script); };
  registerTools(api, { run, driveRoot: driveRoot ?? "/nonexistent" });
  const tool = (name, ctx = { agentId: AGENT }) => factories.get(name).f(ctx);
  const call = async (name, params, ctx) => (await tool(name, ctx).execute("call-1", params)).details;
  return { calls, factories, tool, call };
}

test("registers the four tools by name, all optional", () => {
  const { factories } = setup();
  assert.deepEqual([...factories.keys()], TOOL_NAMES);
  for (const { opts } of factories.values()) assert.equal(opts.optional, true);
});

test("an agent not in the config gets no tools, whatever it's called", () => {
  const { tool, factories } = setup();
  for (const agentId of [undefined, null, "", "main", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
    for (const name of TOOL_NAMES) assert.equal(tool(name, { agentId }), null, `${name} for ${agentId}`);
  }
  for (const { f } of factories.values()) { assert.equal(f(undefined), null); assert.equal(f({}), null); }
});

test("a configured agent gets only what its entry sets", () => {
  const { tool } = setup();
  for (const name of TOOL_NAMES) assert.ok(tool(name), name);
  assert.ok(tool("apple_notes", { agentId: "notes-only" }));
  assert.ok(tool("apple_maps", { agentId: "notes-only" }));
  assert.equal(tool("apple_music", { agentId: "notes-only" }), null);
  assert.equal(tool("apple_files", { agentId: "notes-only" }), null);
});

test("the live runtime config wins over the load-time config", () => {
  const { tool } = setup();
  const runtimeConfig = { plugins: { entries: { "uno-apple-tools": { config: { agents: {} } } } } };
  assert.equal(tool("apple_notes", { agentId: AGENT, runtimeConfig }), null);
});

test("a bad iCloud Drive folder in config turns files off", () => {
  for (const filesFolder of ["../Me", "/Users/x", "~/Library", "a/../../b"]) {
    assert.equal(scopeFor(settings({ agents: { a: { filesFolder } } }), "a").files, null, filesFolder);
  }
});

test("notes: folder and account come from config, never from the model", async () => {
  const { calls, call } = setup({ reply: () => JSON.stringify({ folder: "Test Family", total: 0, notes: [] }) });
  await call("apple_notes", { action: "list", folder: "Someone Else", account: "Other" });
  await call("apple_notes", { action: "read", note: "x", folder: "Someone Else" });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.script, SCRIPTS.notes);
    assert.equal(c.input.folder, "Test Family");
    assert.equal(c.input.account, "iCloud");
  }
  assert.deepEqual(Object.keys(calls[1].input).sort(), ["account", "action", "folder", "note"]);
});

test("notes: text is escaped into HTML, never passed raw", async () => {
  const { calls, call } = setup({ reply: () => JSON.stringify({ created: { id: "n1", title: "t" } }) });
  await call("apple_notes", { action: "create", title: "<script>x</script>", text: "a & b\n<img src=x onerror=y>" });
  const { html } = calls[0].input;
  assert.ok(!/<script|<img/i.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
  assert.equal(textToHtml("one\n\ntwo"), "<div>one</div><div><br></div><div>two</div>");
});

test("notes: bad input never reaches osascript", async () => {
  const { calls, call } = setup();
  for (const params of [{ action: "delete", note: "x" }, { action: "run", script: "do shell script \"id\"" }, { action: "read" }, { action: "create", title: "" }, { action: "append", note: "x" }, { action: "read", note: "a\0b" }, { action: "create", title: "x".repeat(201) }, null]) {
    const out = await call("apple_notes", params);
    assert.ok(out.error, JSON.stringify(params));
  }
  assert.equal(calls.length, 0);
});

test("notes: script codes and failures become plain words", async () => {
  let reply = () => JSON.stringify({ error: "no-folder" });
  const { call } = setup({ reply: (...a) => reply(...a) });
  assert.match((await call("apple_notes", { action: "list" })).error, /folder .* isn't set up/);
  reply = () => JSON.stringify({ error: "not-found" });
  assert.match((await call("apple_notes", { action: "read", note: "x" })).error, /No note/);
  reply = () => { throw Object.assign(new Error("Command failed"), { stderr: "execution error: Not authorized to send Apple events to Notes. (-1743)" }); };
  assert.match((await call("apple_notes", { action: "list" })).error, /hasn't allowed Uno to control Notes/);
  reply = () => { throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "/Users/secret/path" }); };
  const t = await call("apple_notes", { action: "list" });
  assert.equal(t.timedOut, true);
  assert.equal(t.timeoutMs, 30_000);
  assert.ok(!JSON.stringify(t).includes("/Users"));
  reply = () => "not json";
  assert.match((await call("apple_notes", { action: "list" })).error, /unreadable/);
});

test("maps: query and town are combined, max is clamped", async () => {
  const { calls, call } = setup({ reply: () => JSON.stringify({ places: [] }) });
  await call("apple_maps", { query: "pizza", near: "Anytown", max: 50 });
  await call("apple_maps", { query: "hardware store", max: 0 });
  assert.deepEqual(calls.map((c) => c.input), [{ query: "pizza near Anytown", max: 10 }, { query: "hardware store", max: 1 }]);
  assert.ok((await call("apple_maps", {})).error);
  assert.equal(calls.length, 2);
});

test("music: only validated fields reach the script", async () => {
  const { calls, call } = setup({ reply: () => JSON.stringify({ state: "playing" }) });
  await call("apple_music", { action: "volume", level: 40, script: "x" });
  await call("apple_music", { action: "set_speakers", speakers: ["Kitchen", "Kitchen", " Den "] });
  await call("apple_music", { action: "play_playlist", name: "Road Trip" });
  assert.deepEqual(calls.map((c) => c.input), [{ action: "volume", level: 40 }, { action: "set_speakers", speakers: ["Kitchen", "Den"] }, { action: "play_playlist", name: "Road Trip" }]);
  for (const params of [{ action: "volume", level: 101 }, { action: "volume", level: "5; do shell script" }, { action: "shuffle", on: "yes" }, { action: "set_speakers", speakers: [] }, { action: "eval" }]) {
    assert.ok((await call("apple_music", params)).error, JSON.stringify(params));
  }
  assert.equal(calls.length, 3);
});

test("music: script codes become plain words", async () => {
  const { call } = setup({ reply: () => JSON.stringify({ error: "no-playlist" }) });
  assert.match((await call("apple_music", { action: "play_playlist", name: "x" })).error, /No playlist/);
});

test("osascript runner: fixed script, one JSON argument, no shell, minimal env", async () => {
  const seen = [];
  const exec = (bin, args, opts, cb) => { seen.push({ bin, args, opts }); cb(null, "{\"ok\":1}", ""); };
  const run = osascriptRunner({ exec });
  assert.equal(await run(SCRIPTS.notes, { action: "read", note: "-e" }, 1000), "{\"ok\":1}");
  const [{ bin, args, opts }] = seen;
  assert.equal(bin, "/usr/bin/osascript");
  assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", SCRIPTS.notes]);
  assert.equal(args.length, 4);
  assert.ok(args[3].startsWith("{"));
  assert.deepEqual(JSON.parse(args[3]), { action: "read", note: "-e" });
  assert.deepEqual(Object.keys(opts.env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(opts.timeout, 1000);
  assert.equal(opts.shell, undefined);
});

test("osascript runner: failures carry stderr for classification only", async () => {
  const run = osascriptRunner({ exec: (b, a, o, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", "boom (-600)") });
  await assert.rejects(run(SCRIPTS.music, { action: "status" }, 1000), (e) => e.stderr === "boom (-600)");
});

test("paths: relative only, no .., no hidden names", () => {
  assert.deepEqual(cleanRel("Plans/./trip.txt"), ["Plans", "trip.txt"]);
  assert.deepEqual(cleanRel(""), []);
  for (const p of ["../x", "a/../../x", "/etc/passwd", "~/x", "~", ".ssh/id", "a/.git/config", "a\0b", "a/".repeat(10) + "x", 5, null]) {
    assert.throws(() => cleanRel(p), undefined, String(p));
  }
  assert.deepEqual(workspaceRel("/workspace/media/a.jpg", "/host/ws"), ["media", "a.jpg"]);
  assert.deepEqual(workspaceRel("/host/ws/a.jpg", "/host/ws"), ["a.jpg"]);
  assert.deepEqual(workspaceRel("a.jpg", "/host/ws"), ["a.jpg"]);
  for (const p of ["/etc/passwd", "/host/wsx/a", "/workspace/../x", "/workspace/", ""]) assert.throws(() => workspaceRel(p, "/host/ws"), undefined, p);
});

// A real temp tree: drive/Test Family (the person's folder), drive/Private
// (someone else's), ws (the agent's workspace), secret (outside everything).
function tree() {
  const base = mkdtempSync(join(tmpdir(), "uno-apple-tools-"));
  const drive = join(base, "drive"), family = join(drive, "Test Family"), priv = join(drive, "Private"), ws = join(base, "ws"), secret = join(base, "secret");
  for (const d of [family, priv, ws, secret]) mkdirSync(d, { recursive: true });
  writeFileSync(join(priv, "private.txt"), "PRIVATE");
  writeFileSync(join(secret, "token.txt"), "SECRET");
  writeFileSync(join(family, "list.txt"), "milk\neggs");
  writeFileSync(join(ws, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  const scope = { folder: "Test Family" };
  const files = (params) => runFiles(params, scope, { driveRoot: drive, workspaceDir: ws });
  return { base, drive, family, priv, ws, secret, files };
}
const leaked = (out) => /PRIVATE|SECRET/.test(JSON.stringify(out));

test("files: list, read, write inside the folder", async () => {
  const t = tree();
  const list = await t.files({ action: "list" });
  assert.deepEqual(list.entries.map((e) => e.name), ["list.txt"]);
  assert.equal((await t.files({ action: "read", path: "list.txt" })).text, "milk\neggs");
  assert.equal((await t.files({ action: "write", path: "Plans/trip.md", text: "# Trip" })).saved, "Plans/trip.md");
  assert.equal(readFileSync(join(t.family, "Plans/trip.md"), "utf8"), "# Trip");
  assert.match((await t.files({ action: "write", path: "list.txt", text: "x" })).error, /already exists/);
  assert.equal(readFileSync(join(t.family, "list.txt"), "utf8"), "milk\neggs");
  await t.files({ action: "write", path: "list.txt", text: "bread", overwrite: true });
  assert.equal(readFileSync(join(t.family, "list.txt"), "utf8"), "bread");
  assert.match((await t.files({ action: "read", path: "photo.jpg" })).error, /Only text files/);
  assert.ok(!JSON.stringify(list).includes(t.base));
});

test("files: .. and absolute paths can't leave the folder", async () => {
  const t = tree();
  for (const params of [
    { action: "read", path: "../Private/private.txt" },
    { action: "read", path: "/etc/passwd" },
    { action: "read", path: `${t.priv}/private.txt` },
    { action: "list", path: ".." },
    { action: "list", path: "~" },
    { action: "write", path: "../Private/x.txt", text: "x" },
    { action: "fetch", path: "../Private/private.txt" },
  ]) {
    const out = await t.files(params);
    assert.ok(out.error, JSON.stringify(params));
    assert.ok(!leaked(out));
  }
  assert.deepEqual(readdirSync(t.priv), ["private.txt"]);
});

test("files: symlinks inside the folder are never followed", async () => {
  const t = tree();
  symlinkSync(join(t.priv, "private.txt"), join(t.family, "link.txt"));
  symlinkSync(t.priv, join(t.family, "linkdir"));
  symlinkSync(t.secret, join(t.family, "Plans"));
  assert.match((await t.files({ action: "read", path: "link.txt" })).error, /link/);
  assert.ok((await t.files({ action: "read", path: "linkdir/private.txt" })).error);
  assert.ok((await t.files({ action: "list", path: "linkdir" })).error);
  assert.ok((await t.files({ action: "write", path: "linkdir/new.txt", text: "x" })).error);
  assert.ok((await t.files({ action: "write", path: "link.txt", text: "x", overwrite: true })).error);
  assert.ok((await t.files({ action: "write", path: "Plans/new.txt", text: "x" })).error);
  assert.ok((await t.files({ action: "fetch", path: "link.txt" })).error);
  const list = await t.files({ action: "list" });
  assert.equal(list.entries.find((e) => e.name === "linkdir").type, "other");
  assert.ok(!leaked(list));
  assert.deepEqual(readdirSync(t.priv), ["private.txt"]);
  assert.deepEqual(readdirSync(t.secret), ["token.txt"]);
  assert.equal(readFileSync(join(t.priv, "private.txt"), "utf8"), "PRIVATE");
});

test("files: save copies from the workspace only, and refuses planted links", async () => {
  const t = tree();
  assert.equal((await t.files({ action: "save", from: "photo.jpg" })).saved, "photo.jpg");
  assert.deepEqual(readFileSync(join(t.family, "photo.jpg")), readFileSync(join(t.ws, "photo.jpg")));
  assert.equal((await t.files({ action: "save", from: "/workspace/photo.jpg", path: "Photos/beach.jpg" })).saved, "Photos/beach.jpg");
  assert.equal((await t.files({ action: "save", from: join(t.ws, "photo.jpg"), path: "p2.jpg" })).saved, "p2.jpg");
  // What a sandboxed model could plant in its own workspace.
  symlinkSync(join(t.secret, "token.txt"), join(t.ws, "innocent.jpg"));
  symlinkSync(t.secret, join(t.ws, "media"));
  mkdirSync(join(t.ws, "real"));
  symlinkSync(join(t.secret, "token.txt"), join(t.ws, "real", "x.txt"));
  for (const from of ["innocent.jpg", "media/token.txt", "real/x.txt", "/workspace/innocent.jpg", join(t.secret, "token.txt"), "../secret/token.txt", `${t.ws}/../secret/token.txt`]) {
    const out = await t.files({ action: "save", from, path: "stolen.txt" });
    assert.ok(out.error, from);
    assert.ok(!leaked(out));
  }
  assert.ok(!existsSync(join(t.family, "stolen.txt")));
});

test("files: a FIFO in the workspace is refused, not waited on", async () => {
  const t = tree();
  execFileSync("mkfifo", [join(t.ws, "pipe.jpg")]);
  const out = await t.files({ action: "save", from: "pipe.jpg" });
  assert.match(out.error, /regular files|isn't a regular file/);
});

test("files: fetch copies into files/ in the workspace, never overwriting", async () => {
  const t = tree();
  writeFileSync(join(t.family, "plan.pdf"), "%PDF-1.4");
  assert.equal((await t.files({ action: "fetch", path: "plan.pdf" })).workspacePath, "files/plan.pdf");
  assert.equal((await t.files({ action: "fetch", path: "plan.pdf" })).workspacePath, "files/plan 2.pdf");
  assert.equal(readFileSync(join(t.ws, "files/plan.pdf"), "utf8"), "%PDF-1.4");
});

test("files: a planted files/ link in the workspace can't redirect fetch", async () => {
  const t = tree();
  symlinkSync(t.secret, join(t.ws, "files"));
  const out = await t.files({ action: "fetch", path: "list.txt" });
  assert.ok(out.error);
  assert.deepEqual(readdirSync(t.secret), ["token.txt"]);
});

test("files: a missing folder or workspace says so", async () => {
  const t = tree();
  assert.match((await runFiles({ action: "list" }, { folder: "Nope" }, { driveRoot: t.drive, workspaceDir: t.ws })).error, /isn't set up/);
  assert.match((await runFiles({ action: "save", from: "photo.jpg" }, { folder: "Test Family" }, { driveRoot: t.drive })).error, /workspace/);
  assert.ok((await t.files({ action: "delete", path: "list.txt" })).error);
  assert.ok(existsSync(join(t.family, "list.txt")));
});

test("files tool: the workspace comes from the host context", async () => {
  const t = tree();
  const { tool } = setup({ driveRoot: t.drive });
  const f = tool("apple_files", { agentId: AGENT, workspaceDir: t.ws });
  assert.equal((await f.execute("c", { action: "save", from: "photo.jpg", path: "x.jpg" })).details.saved, "x.jpg");
  assert.equal(realpathSync(join(t.family, "x.jpg")), join(realpathSync(t.family), "x.jpg"));
});
