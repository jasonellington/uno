---
name: files-and-photos
description: "Saves files, plans and photos into their shared iCloud Drive folder. Use when someone sends a file or photo to keep."
metadata: { "openclaw": { "emoji": "📁", "os": ["darwin"] } }
---

# Files and photos

If you have the `apple_files` tool, use it: it already knows their folder (list, read, write text, save a file from your workspace into the folder, fetch one back). Otherwise their iCloud Drive folder's exact path is in your household setup note; use it as is, don't search for it. It shows up in their Files app.

- Text files (txt, html, notes): write them with `apply_patch`, adding the file at that path.
- Other files: `cp "<source>" "<path>/<name>"`.
- Photos they send reach you with their message. To save one, find the newest attachment with `imsg history --chat-id <chat id> --limit 5 --attachments --json`, then copy it with `cp "<attachment path>" "<path>/<name>.<same extension>"`. Not the Photos app.

Check it with `ls "<path>"` before confirming, and name what you saved (the photo, the plan), not its file name.
