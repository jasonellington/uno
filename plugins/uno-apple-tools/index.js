// uno-apple-tools (README.md): Notes, Maps, Music and Files as gateway tools,
// so a sandboxed family agent can use the Mac's Apple apps without a shell.
// - Each tool is a factory (api.registerTool): OpenClaw hands it the agent id
//   of the run, and the plugin config maps that id to the person's Notes
//   folder and iCloud Drive folder. An agent not in the config gets no tools.
// - The model never names the person, a folder, a host path or script text.
//   Scripts are fixed files run with execFile (no shell); the model's values
//   reach them as a single JSON argument. File paths are contained (files.js).
// Settings (plugins.entries.uno-apple-tools.config):
//   agents: { "<agentId>": { notesFolder, filesFolder, maps?, music? } }
//   notesAccount: Notes account holding the folders (default "iCloud").
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ID, TOOL_NAMES, ICLOUD_DRIVE, settings, scopeFor, notesInput, mapsInput, musicInput, scriptFailure, notesError, ToolInputError, NOTES_ACTIONS, MUSIC_ACTIONS, FILES_ACTIONS } from "./rules.js";
import { runFiles } from "./files.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = { notes: join(HERE, "scripts/notes.js"), maps: join(HERE, "scripts/maps.js"), music: join(HERE, "scripts/music.js") };
const TIMEOUT_MS = { notes: 30_000, maps: 15_000, music: 20_000 };

// Runs one fixed script with one JSON argument. The argument always starts
// with "{", after the script path, so osascript never reads it as an option.
export function osascriptRunner({ bin = "/usr/bin/osascript", exec = execFile } = {}) {
  return (script, input, timeoutMs) => new Promise((resolve, reject) => {
    const arg = JSON.stringify(input);
    if (!arg.startsWith("{")) return reject(new Error("bad input"));
    const env = { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
    exec(bin, ["-l", "JavaScript", script, arg], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      resolve(String(stdout ?? ""));
    });
  });
}

// One call at a time per app: Notes and Music handle overlapping Apple
// events badly.
function queued() {
  const tails = new Map();
  return (key, fn) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    tails.set(key, next.catch(() => {}));
    return next;
  };
}

const result = (details) => ({ content: [{ type: "text", text: JSON.stringify(details) }], details });

async function runScript(deps, app, key, input) {
  try {
    const raw = await deps.queue(key, () => deps.run(SCRIPTS[key], input, TIMEOUT_MS[key]));
    try { return JSON.parse(raw); } catch { return { error: `${app} gave an unreadable answer.` }; }
  } catch (err) {
    const f = scriptFailure(app, err);
    return f.timedOut ? { ...f, timeoutMs: TIMEOUT_MS[key] } : f;
  }
}

const inputError = (e) => ({ error: e instanceof ToolInputError ? e.message : "Invalid input." });

// Tool builders, one per app. scope: rules.js scopeFor(); deps: { run, queue,
// driveRoot, log }; ctx: the host's tool context.
export function notesTool(scope, deps) {
  return {
    name: "apple_notes",
    label: "Notes",
    description: "Apple Notes, in this person's shared Notes folder only. list: the notes (id, title, modified). read: one note's text, by id or exact title. create: a new note (title, optional text). append: add text to the end of a note.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: NOTES_ACTIONS },
        note: { type: "string", description: "read/append: the note's id from list, or its exact title." },
        title: { type: "string", description: "create: the note's title." },
        text: { type: "string", description: "create/append: plain text; new lines are kept." },
      },
    },
    async execute(_id, params) {
      let input;
      try { input = notesInput(params, scope.notes); } catch (e) { return result(inputError(e)); }
      const out = await runScript(deps, "Notes", "notes", input);
      if (typeof out?.error === "string" && /^[a-z-]+$/.test(out.error)) return result({ error: notesError(out.error) });
      return result(out);
    },
  };
}

export function mapsTool(_scope, deps) {
  return {
    name: "apple_maps",
    label: "Maps",
    description: "Find places with Apple Maps: name, phone, website, category, address and an Apple Maps link to share. No hours, ratings or reviews.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to find, e.g. \"pizza\" or \"hardware store\"." },
        near: { type: "string", description: "A town or address to search around." },
        max: { type: "integer", minimum: 1, maximum: 10, description: "Most results to return (default 8)." },
      },
    },
    async execute(_id, params) {
      let input;
      try { input = mapsInput(params); } catch (e) { return result(inputError(e)); }
      const out = await runScript(deps, "Maps", "maps", input);
      return result(out?.error === "timeout" ? { error: "Maps didn't answer in time.", timedOut: true, timeoutMs: TIMEOUT_MS.maps } : out);
    },
  };
}

const MUSIC_ERRORS = { "no-playlist": "No playlist by that name. Use action playlists to see them.", "no-song": "Nothing in the music library matches that.", "no-speaker": "No speaker by that name." };
export function musicTool(_scope, deps) {
  return {
    name: "apple_music",
    label: "Music",
    description: "The Music app on this Mac and its AirPlay speakers. status: what's playing. play, pause, next, previous. volume (level 0-100). shuffle (on). playlists, then play_playlist (name). play_song (query: a song, artist or album in the library). speakers, then set_speakers (speakers: exact names).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: MUSIC_ACTIONS },
        level: { type: "integer", minimum: 0, maximum: 100 },
        on: { type: "boolean" },
        name: { type: "string", description: "play_playlist: the playlist's exact name." },
        query: { type: "string", description: "play_song: words from the song, artist or album." },
        speakers: { type: "array", items: { type: "string" }, description: "set_speakers: speaker names exactly as listed." },
      },
    },
    async execute(_id, params) {
      let input;
      try { input = musicInput(params); } catch (e) { return result(inputError(e)); }
      const out = await runScript(deps, "Music", "music", input);
      if (out?.error && MUSIC_ERRORS[out.error]) return result({ ...out, error: MUSIC_ERRORS[out.error] });
      return result(out);
    },
  };
}

export function filesTool(scope, deps, ctx) {
  return {
    name: "apple_files",
    label: "Files",
    description: "This person's shared iCloud Drive folder (it shows in their Files app). Paths are inside that folder, like \"Plans/trip.txt\". list (path: a subfolder, optional). read (a text file). write (path, text; overwrite: true to replace). save (from: a file in your workspace, e.g. a photo they sent; path: where to put it, optional). fetch (path): copy a file into your workspace under files/ so you can look at it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: FILES_ACTIONS },
        path: { type: "string", description: "A path inside the shared folder." },
        text: { type: "string", description: "write: the file's text." },
        from: { type: "string", description: "save: a file in your workspace." },
        overwrite: { type: "boolean", description: "write/save: replace an existing file." },
      },
    },
    async execute(_id, params) {
      const out = await runFiles(params, scope.files, { driveRoot: deps.driveRoot, workspaceDir: ctx?.workspaceDir });
      return result(out);
    },
  };
}

const BUILDERS = { apple_notes: [notesTool, (s) => s.notes], apple_maps: [mapsTool, (s) => s.maps], apple_music: [musicTool, (s) => s.music], apple_files: [filesTool, (s) => s.files] };

// Factory for one tool name: the agent id comes from the host's tool context,
// the config from the live runtime config (falling back to the plugin's).
export function toolFactory(name, api, deps) {
  const [build, enabled] = BUILDERS[name];
  return (ctx) => {
    try {
      const config = ctx?.runtimeConfig?.plugins?.entries?.[PLUGIN_ID]?.config ?? api.pluginConfig ?? {};
      const scope = scopeFor(settings(config), ctx?.agentId);
      if (!scope || !enabled(scope)) return null;
      return build(scope, deps, ctx);
    } catch (e) {
      deps.log?.warn?.(`${PLUGIN_ID}: ${name} unavailable (${e?.message ?? "error"})`);
      return null;
    }
  };
}

// overrides (tests): run (the osascript runner), queue, driveRoot.
export function registerTools(api, overrides = {}) {
  const deps = {
    run: overrides.run ?? osascriptRunner(),
    queue: overrides.queue ?? queued(),
    driveRoot: overrides.driveRoot ?? join(homedir(), ICLOUD_DRIVE),
    log: api.logger ?? console,
  };
  for (const name of TOOL_NAMES) api.registerTool(toolFactory(name, api, deps), { name, optional: true });
}

export default {
  id: PLUGIN_ID,
  name: "Uno Apple tools",
  description: "Notes, Maps, Music and Files for scoped agents, run on the gateway.",
  register(api) { registerTools(api); },
};
