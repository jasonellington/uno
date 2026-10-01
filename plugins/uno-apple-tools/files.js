// apple_files: one person's iCloud Drive folder, contained.
//
// Containment, assuming the model is adversarial and its sandbox can plant
// symlinks in its own workspace at any moment:
// - model paths are cleaned first (rules.js cleanRel: relative, no "..", no
//   hidden names);
// - each root is realpath'd, so the root itself has no symlinks;
// - every open uses O_NOFOLLOW_ANY (macOS): the kernel refuses a symlink in
//   any component of the path, atomically, so a symlink swapped in after a
//   check still can't redirect the open;
// - reads open O_NONBLOCK and must be regular files (a FIFO can't hang the
//   gateway); new files are O_EXCL unless overwrite is asked for;
// - results name files relative to the folder, never by host path.
import { constants as C, realpathSync, mkdirSync, lstatSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, sep, extname, basename } from "node:path";
import { cleanRel, workspaceRel, LIMITS, ToolInputError, FILES_ACTIONS } from "./rules.js";

export const O_NOFOLLOW_ANY = 0x20000000; // <sys/fcntl.h>, macOS 11+
const READ = C.O_RDONLY | C.O_NONBLOCK | O_NOFOLLOW_ANY;
const DIR = C.O_RDONLY | C.O_DIRECTORY | O_NOFOLLOW_ANY;
const writeFlags = (overwrite) => C.O_WRONLY | C.O_CREAT | C.O_NONBLOCK | O_NOFOLLOW_ANY | (overwrite ? C.O_TRUNC : C.O_EXCL);

const TEXT_EXT = new Set(["", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".html", ".htm", ".xml", ".ics", ".vcf", ".log", ".yaml", ".yml"]);

class FilesError extends Error {}
const fail = (msg) => { throw new FilesError(msg); };

// Real path of a root folder, or null when it doesn't exist.
function realRoot(dir) {
  try {
    const r = realpathSync(dir);
    return lstatSync(r).isDirectory() ? r : null;
  } catch { return null; }
}

const inside = (root, parts) => {
  const p = join(root, ...parts);
  if (p !== root && !p.startsWith(root + sep)) fail("That path is outside the folder.");
  return p;
};

function explain(e, rel) {
  if (e instanceof FilesError || e instanceof ToolInputError) return e.message;
  switch (e?.code) {
    case "ENOENT": return `Nothing at "${rel}".`;
    case "EEXIST": return `"${rel}" already exists. Pick another name, or pass overwrite: true to replace it.`;
    case "ELOOP": return `"${rel}" goes through a link, which isn't allowed.`;
    case "ENOTDIR": return `Part of "${rel}" isn't a folder.`;
    case "EISDIR": return `"${rel}" is a folder.`;
    case "EACCES": case "EPERM": return `Not allowed to open "${rel}".`;
    case "ENXIO": return `"${rel}" isn't a regular file.`;
    default: return "The file couldn't be opened.";
  }
}

async function openFile(path, flags, mode) {
  const fh = await open(path, flags, mode);
  try {
    const st = await fh.stat();
    if (!st.isFile()) fail("Only regular files are allowed.");
    return { fh, st };
  } catch (e) { await fh.close().catch(() => {}); throw e; }
}

// Create the missing folders of `parts` (not the last one) under root. mkdir
// never follows a symlink in its last component, and the O_NOFOLLOW_ANY open
// that follows catches one anywhere else.
function makeParents(root, parts) {
  for (let i = 1; i < parts.length; i++) {
    try { mkdirSync(inside(root, parts.slice(0, i)), { mode: 0o755 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
}

async function copy(src, dst, limit) {
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  for (;;) {
    const { bytesRead } = await src.read(buf, 0, buf.length, null);
    if (!bytesRead) return total;
    total += bytesRead;
    if (total > limit) fail("That file is too big.");
    let off = 0;
    while (off < bytesRead) off += (await dst.write(buf, off, bytesRead - off)).bytesWritten;
  }
}

// params: the model's; scope: { folder } from config; ctx: { driveRoot, workspaceDir }.
export async function runFiles(params, scope, { driveRoot, workspaceDir } = {}) {
  const p = params ?? {};
  const action = p.action;
  let rel = "";
  try {
    if (!FILES_ACTIONS.includes(action)) fail(`action must be one of: ${FILES_ACTIONS.join(", ")}.`);
    const root = realRoot(join(driveRoot, ...scope.folder.split("/")));
    if (!root) fail("This person's iCloud Drive folder isn't set up yet.");

    if (action === "list") {
      const parts = cleanRel(p.path ?? "");
      rel = parts.join("/") || ".";
      const dir = inside(root, parts);
      const dh = await open(dir, DIR); // proves no link on the way
      await dh.close();
      if (realpathSync(dir) !== dir) fail("That path is outside the folder.");
      const entries = [];
      for (const d of await readdir(dir, { withFileTypes: true })) {
        if (d.name.startsWith(".")) continue;
        const type = d.isDirectory() ? "folder" : d.isFile() ? "file" : "other";
        let size, modified;
        if (type === "file") {
          try { const st = lstatSync(join(dir, d.name)); size = st.size; modified = st.mtime.toISOString(); } catch {}
        }
        entries.push({ name: d.name, type, ...(size != null ? { size } : {}), ...(modified ? { modified } : {}) });
        if (entries.length >= LIMITS.listEntries) break;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { folder: rel, entries };
    }

    if (action === "read") {
      const parts = cleanRel(p.path);
      rel = parts.join("/");
      if (!parts.length) fail("path must name a file.");
      if (!TEXT_EXT.has(extname(rel).toLowerCase())) fail("Only text files can be read here. Use fetch to bring it into your workspace.");
      const { fh, st } = await openFile(inside(root, parts), READ);
      try {
        const n = Math.min(st.size, LIMITS.readText);
        const buf = Buffer.alloc(n);
        let off = 0;
        while (off < n) { const { bytesRead } = await fh.read(buf, off, n - off, off); if (!bytesRead) break; off += bytesRead; }
        return { path: rel, text: buf.subarray(0, off).toString("utf8"), ...(st.size > n ? { truncated: true } : {}) };
      } finally { await fh.close(); }
    }

    if (action === "write") {
      const parts = cleanRel(p.path);
      rel = parts.join("/");
      if (!parts.length) fail("path must name a file.");
      if (!TEXT_EXT.has(extname(rel).toLowerCase())) fail("write is for text files (.txt, .md, .csv, .html and similar).");
      if (typeof p.text !== "string") fail("text is required.");
      const data = Buffer.from(p.text, "utf8");
      if (data.length > LIMITS.fileText) fail("text is too long.");
      makeParents(root, parts);
      const { fh } = await openFile(inside(root, parts), writeFlags(p.overwrite === true), 0o644);
      try { await fh.write(data, 0, data.length, 0); } finally { await fh.close(); }
      return { saved: rel, bytes: data.length };
    }

    if (action === "save") {
      if (!workspaceDir) fail("No workspace to copy from.");
      const ws = realRoot(workspaceDir);
      if (!ws) fail("No workspace to copy from.");
      const from = workspaceRel(p.from, workspaceDir);
      const parts = p.path ? cleanRel(p.path) : [from[from.length - 1]];
      rel = parts.join("/");
      if (!parts.length) fail("path must name a file.");
      const src = await openFile(inside(ws, from), READ).catch((e) => { throw new FilesError(explain(e, from.join("/"))); });
      try {
        if (src.st.size > LIMITS.copyBytes) fail("That file is too big.");
        makeParents(root, parts);
        const { fh } = await openFile(inside(root, parts), writeFlags(p.overwrite === true), 0o644);
        try { const bytes = await copy(src.fh, fh, LIMITS.copyBytes); return { saved: rel, bytes }; } finally { await fh.close(); }
      } finally { await src.fh.close(); }
    }

    // fetch: shared folder -> the agent's workspace (files/<name>), so its own
    // sandboxed tools can look at a photo or PDF. Never overwrites.
    const parts = cleanRel(p.path);
    rel = parts.join("/");
    if (!parts.length) fail("path must name a file.");
    if (!workspaceDir) fail("No workspace to copy into.");
    const ws = realRoot(workspaceDir);
    if (!ws) fail("No workspace to copy into.");
    const src = await openFile(inside(root, parts), READ);
    try {
      if (src.st.size > LIMITS.copyBytes) fail("That file is too big.");
      try { mkdirSync(join(ws, "files"), { mode: 0o755 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
      const name = basename(rel);
      const ext = extname(name);
      const stem = name.slice(0, name.length - ext.length);
      for (let i = 0; i < 50; i++) {
        const candidate = i ? `${stem} ${i + 1}${ext}` : name;
        let dst;
        try { dst = await openFile(inside(ws, ["files", candidate]), writeFlags(false), 0o644); } catch (e) { if (e.code === "EEXIST") continue; throw new FilesError(explain(e, `files/${candidate}`)); }
        try { const bytes = await copy(src.fh, dst.fh, LIMITS.copyBytes); return { fetched: rel, workspacePath: `files/${candidate}`, bytes }; } finally { await dst.fh.close(); }
      }
      fail("Too many copies of that file in files/ already.");
    } finally { await src.fh.close(); }
  } catch (e) {
    return { error: explain(e, rel || "that path") };
  }
}
