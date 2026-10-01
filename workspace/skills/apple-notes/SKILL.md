---
name: apple-notes
description: "Creates and reads notes in their shared Apple Notes folder. Use for notes and lists they want to keep."
metadata: { "openclaw": { "emoji": "📝", "os": ["darwin"], "requires": { "bins": ["osascript"] } } }
---

# Notes

If you have the `apple_notes` tool, use it (list, read, create, append): it already knows their folder. Otherwise use the Notes folder your household setup note lists:

- Create: `osascript -e 'tell application "Notes" to make new note at folder "<folder>" of account "iCloud" with properties {name:"<title>", body:"<text>"}'`
- Read: `osascript -e 'tell application "Notes" to get {name, plaintext} of notes of folder "<folder>" of account "iCloud"'`
