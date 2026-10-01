// Pure rules for uno-apple-tools, unit-tested in uno/test/uno-apple-tools.test.js.
//
// The model calling these tools is treated as adversarial. It never picks the
// person (the host supplies the agent id), a folder (plugin config does), or
// any script text (the scripts are fixed files; the model's values reach them
// as one JSON argument and are only ever data).

export const PLUGIN_ID = "uno-apple-tools";
export const TOOL_NAMES = ["apple_notes", "apple_maps", "apple_music", "apple_files"];
export const DEFAULT_NOTES_ACCOUNT = "iCloud";
export const ICLOUD_DRIVE = "Library/Mobile Documents/com~apple~CloudDocs";

export const LIMITS = {
  title: 200,
  noteText: 20_000,
  query: 200,
  name: 200,
  path: 1024,
  component: 255,
  depth: 8,
  fileText: 1_000_000,
  readText: 256 * 1024,
  copyBytes: 50 * 1024 * 1024,
  listEntries: 200,
};

export class ToolInputError extends Error {}
const bad = (msg) => { throw new ToolInputError(msg); };

const str = (v) => (typeof v === "string" ? v : null);
const trimmed = (v, max, what) => {
  const s = str(v);
  if (s == null || !s.trim()) bad(`${what} is required.`);
  if (s.includes("\0")) bad(`${what} has an invalid character.`);
  if (s.length > max) bad(`${what} is too long (max ${max} characters).`);
  return s.trim();
};
const optionalText = (v, max, what) => {
  if (v == null || v === "") return "";
  const s = str(v);
  if (s == null) bad(`${what} must be text.`);
  if (s.includes("\0")) bad(`${what} has an invalid character.`);
  if (s.length > max) bad(`${what} is too long (max ${max} characters).`);
  return s;
};

// Plugin config -> per-agent scope. Only agents listed under `agents` get
// anything. notesFolder: a folder name in the Notes account. filesFolder: a
// folder inside iCloud Drive (relative, no "..", no leading "/" or "~").
export function settings(config = {}) {
  const agents = config && typeof config.agents === "object" && !Array.isArray(config.agents) ? config.agents : {};
  return {
    agents,
    notesAccount: str(config?.notesAccount)?.trim() || DEFAULT_NOTES_ACCOUNT,
  };
}

export function scopeFor(cfg, agentId) {
  if (typeof agentId !== "string" || !agentId || !Object.hasOwn(cfg.agents, agentId)) return null;
  const entry = cfg.agents[agentId];
  if (!entry || typeof entry !== "object") return null;
  const notesFolder = str(entry.notesFolder)?.trim() || null;
  let filesFolder = null;
  if (str(entry.filesFolder)?.trim()) {
    try { filesFolder = cleanRel(entry.filesFolder, { allowDots: true }).join("/") || null; } catch { filesFolder = null; }
  }
  return {
    agentId,
    notes: notesFolder ? { account: cfg.notesAccount, folder: notesFolder } : null,
    files: filesFolder ? { folder: filesFolder } : null,
    maps: entry.maps !== false,
    music: entry.music !== false,
  };
}

// A model-supplied path inside a folder -> its components. No absolute paths,
// no "~", no "..", no hidden names, nothing a shell or AppleScript could read
// as syntax (the path never reaches either).
export function cleanRel(input, { allowDots = false } = {}) {
  const s = str(input);
  if (s == null) bad("path must be text.");
  if (s.includes("\0")) bad("path has an invalid character.");
  if (s.length > LIMITS.path) bad("path is too long.");
  const t = s.trim();
  if (t.startsWith("/") || t.startsWith("~")) bad("Use a path inside the folder, like \"Plans/list.txt\".");
  const parts = t.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length > LIMITS.depth) bad("path is too deep.");
  for (const p of parts) {
    if (p === "..") bad("path can't go outside the folder.");
    if (!allowDots && p.startsWith(".")) bad("Hidden names aren't allowed.");
    if (Buffer.byteLength(p) > LIMITS.component) bad("A name in the path is too long.");
  }
  return parts;
}

// A path the sandboxed agent sees in its own workspace: relative, or under the
// sandbox mount (/workspace) or the host workspace path. Anything else is out.
export function workspaceRel(input, workspaceDir, mounts = ["/workspace"]) {
  const s = str(input);
  if (s == null || !s.trim()) bad("from is required (a file in your workspace).");
  let t = s.trim();
  for (const m of [...mounts, workspaceDir].filter(Boolean)) {
    const base = m.endsWith("/") ? m : `${m}/`;
    if (t.startsWith(base)) { t = t.slice(base.length); break; }
  }
  const parts = cleanRel(t);
  if (!parts.length) bad("from must name a file.");
  return parts;
}

// Plain text -> Notes HTML. Everything the model sends is escaped.
export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function textToHtml(text) {
  return String(text).split(/\r?\n/).map((line) => `<div>${line ? escapeHtml(line) : "<br>"}</div>`).join("");
}

// Notes: the folder always comes from scope; the model picks an action and
// a note inside that folder (by id or exact title).
export const NOTES_ACTIONS = ["list", "read", "create", "append"];
export function notesInput(params, scope) {
  const p = params ?? {};
  const action = p.action;
  if (!NOTES_ACTIONS.includes(action)) bad(`action must be one of: ${NOTES_ACTIONS.join(", ")}.`);
  const base = { action, account: scope.account, folder: scope.folder };
  if (action === "list") return base;
  if (action === "create") {
    const title = trimmed(p.title, LIMITS.title, "title");
    const text = optionalText(p.text, LIMITS.noteText, "text");
    return { ...base, title, html: `<div><h1>${escapeHtml(title)}</h1></div>${text ? textToHtml(text) : ""}` };
  }
  const note = trimmed(p.note, LIMITS.name, "note");
  if (action === "read") return { ...base, note };
  const text = trimmed(p.text, LIMITS.noteText, "text");
  return { ...base, note, html: textToHtml(text) };
}

export function mapsInput(params) {
  const p = params ?? {};
  const what = trimmed(p.query, LIMITS.query, "query");
  const near = optionalText(p.near, LIMITS.query, "near").trim();
  let max = p.max == null ? 8 : Number(p.max);
  if (!Number.isInteger(max)) bad("max must be a whole number.");
  max = Math.min(10, Math.max(1, max));
  return { query: near ? `${what} near ${near}` : what, max };
}

export const MUSIC_ACTIONS = ["status", "play", "pause", "next", "previous", "volume", "shuffle", "playlists", "play_playlist", "play_song", "speakers", "set_speakers"];
export function musicInput(params) {
  const p = params ?? {};
  const action = p.action;
  if (!MUSIC_ACTIONS.includes(action)) bad(`action must be one of: ${MUSIC_ACTIONS.join(", ")}.`);
  if (action === "volume") {
    const level = Number(p.level);
    if (!Number.isInteger(level) || level < 0 || level > 100) bad("level must be a whole number from 0 to 100.");
    return { action, level };
  }
  if (action === "shuffle") {
    if (typeof p.on !== "boolean") bad("on must be true or false.");
    return { action, on: p.on };
  }
  if (action === "play_playlist") return { action, name: trimmed(p.name, LIMITS.name, "name") };
  if (action === "play_song") return { action, query: trimmed(p.query, LIMITS.query, "query") };
  if (action === "set_speakers") {
    const list = Array.isArray(p.speakers) ? p.speakers : [];
    if (!list.length || list.length > 20) bad("speakers must list 1 to 20 speaker names from the speakers action.");
    return { action, speakers: [...new Set(list.map((s) => trimmed(s, LIMITS.name, "speaker name")))] };
  }
  return { action };
}

export const FILES_ACTIONS = ["list", "read", "write", "save", "fetch"];

// Human-readable text for an osascript failure. Never includes stderr itself
// (it can carry paths); the codes are Apple's.
export function scriptFailure(app, err) {
  const text = `${err?.stderr ?? ""} ${err?.message ?? ""}`;
  if (err?.killed || err?.signal === "SIGTERM" || /timed? ?out/i.test(text)) return { error: `${app} didn't answer in time. Try again in a moment.`, timedOut: true };
  if (/-1743\b|not authori[sz]ed/i.test(text)) return { error: `This Mac hasn't allowed Uno to control ${app} yet.` };
  if (/-600\b|isn.t running/i.test(text)) return { error: `${app} isn't running.` };
  return { error: `${app} couldn't do that.` };
}

// Errors from the Notes script -> plain words.
const NOTES_ERRORS = {
  "no-account": "The Notes account for this person isn't set up on this Mac.",
  "no-folder": "The Notes folder for this person isn't set up yet.",
  "not-found": "No note with that title or id in this person's folder. Use action list to see them.",
  locked: "That note is locked.",
  "has-attachments": "That note has photos or attachments, which appending would drop. Create a new note instead.",
  changed: "The notes changed while reading; try again.",
};
export const notesError = (code) => NOTES_ERRORS[code] ?? "Notes couldn't do that.";
