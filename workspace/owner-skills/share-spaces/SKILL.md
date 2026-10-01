---
name: share-spaces
description: "Creates and shares someone's Reminders list, calendar, Notes folder and iCloud Drive folder with them. Use when the owner asks to set these up."
metadata: { "openclaw": { "emoji": "🤝", "os": ["darwin"] } }
---

# Shared spaces for someone

Each person gets four spaces in your own iCloud account, shared with them so what you save shows up on their phone: a Reminders list, a calendar, a Notes folder and an iCloud Drive folder. Only the owner asks for this, and only for someone they name.

## What you need first

- Their first name, for the space names: "<first name> and Uno".
- The email of their Apple account, the one the invites go to. Take it from the owner or their card in Contacts; never guess it. If it isn't clear which address is their Apple account, ask the owner.

## Create what's missing

Check first; reuse a space that already has the name.

- Notes folder: `osascript -e 'tell application "Notes" to make new folder at account "iCloud" with properties {name:"<name>"}'`
- Reminders list: `osascript -e 'tell application "Reminders" to make new list with properties {name:"<name>"}'` (it lands in iCloud; confirm with apple_pim_reminder lists).
- iCloud Drive folder: `mkdir "$HOME/Library/Mobile Documents/com~apple~CloudDocs/<name>"`
- Calendar: with the computer tool, in the Calendar app: File → New Calendar, in the iCloud account (not On My Mac), and name it. If an extra calendar appears on the way, delete it.

## Share each one

Sharing has no script: use the computer tool and each app's own Share option.

- Reminders: the list's Share List option.
- Notes: the folder's Share Folder option.
- Calendar: the calendar's Share Calendar option.
- iCloud Drive: in Finder, the folder's Share option, only people you invite, able to make changes.

Add only the address the owner gave you, send, and check that each one now shows them as invited. If a step doesn't look the way you expect, stop and tell the owner which one; don't click around to find another way.

## Then

Tell the owner in a line or two which spaces are shared and with whom. The person gets four invites to accept. Their own assistant can use the spaces once the owner gives it access.
