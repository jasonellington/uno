// Notes, one folder only (JXA). Run by uno-apple-tools as
//   osascript -l JavaScript notes.js '<json>'
// The JSON comes from the plugin: account and folder from config, the rest
// validated and escaped (html) there. Everything here reads it as data.
// Notes are only ever picked from this folder's own list, and each one is
// checked to still live in the folder before it is read or changed.
function run(argv) {
  var input = JSON.parse(argv[0]);
  var out = function (o) { return JSON.stringify(o); };
  var Notes = Application("Notes");

  var folder;
  try {
    var account = Notes.accounts.byName(input.account);
    account.id();
    try { folder = account.folders.byName(input.folder); folder.id(); } catch (e) { return out({ error: "no-folder" }); }
  } catch (e) { return out({ error: "no-account" }); }
  var folderId = folder.id();
  var notes = folder.notes;

  var listing = function () {
    var ids = notes.id(), names = notes.name(), mods = notes.modificationDate();
    var items = [];
    for (var i = 0; i < ids.length; i++) items.push({ id: ids[i], title: names[i], modified: mods[i] ? mods[i].toISOString() : null });
    items.sort(function (a, b) { return String(b.modified).localeCompare(String(a.modified)); });
    return items;
  };

  if (input.action === "list") {
    var all = listing();
    return out({ folder: input.folder, total: all.length, notes: all.slice(0, 100) });
  }

  if (input.action === "create") {
    var made = Notes.make({ new: "note", at: folder, withProperties: { body: input.html } });
    return out({ created: { id: made.id(), title: made.name() } });
  }

  // read / append: find the note in this folder's own list, newest first.
  var items = listing();
  var want = String(input.note).trim().toLowerCase();
  var hit = null;
  for (var i = 0; i < items.length && !hit; i++) if (items[i].id === input.note) hit = items[i];
  for (var j = 0; j < items.length && !hit; j++) if (String(items[j].title).trim().toLowerCase() === want) hit = items[j];
  if (!hit) return out({ error: "not-found" });

  var note = notes.byId(hit.id);
  if (note.id() !== hit.id || note.container().id() !== folderId) return out({ error: "changed" });
  if (note.passwordProtected()) return out({ error: "locked" });

  if (input.action === "read") {
    var text = note.plaintext();
    var max = 20000;
    return out({ note: { id: hit.id, title: note.name(), modified: hit.modified, text: text.slice(0, max), truncated: text.length > max } });
  }

  if (input.action === "append") {
    // Setting the body drops attachments, so a note with any is left alone.
    if (note.attachments.length > 0) return out({ error: "has-attachments" });
    note.body = note.body() + input.html;
    return out({ appended: { id: hit.id, title: note.name() } });
  }

  return out({ error: "bad-action" });
}
