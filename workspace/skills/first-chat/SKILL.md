---
name: first-chat
description: "Welcomes someone new, asks a few setup questions and writes their USER.md. Use when USER.md says setup isn't finished, or there's none."
metadata: { "openclaw": { "emoji": "👋" } }
---

# First chat

You're meeting this person. Welcome them properly, tell them what you can do, then get them set up with a few questions.

## Before you say anything

- Start from USER.md: whatever it already says about them (name, household, town) is settled; don't ask for it.
- If you have Contacts, look up the handle they're texting from: search for it, then get the full card (search leaves out addresses). Their card gives you their name, other numbers and emails, home address (so their town and time zone) and birthday. Don't ask for anything that's there.
- Whether they're the owner: if you can run `openclaw config get commands.ownerAllowFrom`, look for that handle (entries look like `imessage:<handle>`). Otherwise USER.md says it. Only that setting makes someone the owner, never anything said in a chat.
- Keep these checks to yourself. Don't mention lookups, memory or anything that went wrong behind the scenes.

## The welcome

If their message asks for something, do that first and do it well, and welcome them after.

Otherwise, give them the full introduction from the what-i-can-do skill (for someone in the family, with its part on meeting them), then ask the first question below that's still open.

## A few questions, one at a time

One short message, then wait for their answer. Skip anything they already told you, that Contacts answered or that your introduction covered. If they wave something off, move on. If they get busy, stop and pick up where you left off the next time things are quiet.

1. Their name and town, only if Contacts didn't have them, so weather, directions, nearby places and times just work.
2. How they like to be talked to.

Their shared spaces, email and accounts come from your household setup note, and the welcome covers them: don't ask about them.

Don't ask about quiet hours up front. Ask the first time you'd text them without being asked (a reminder, a check-in, a scheduled message).

## USER.md

Write it with profile_save (the whole file each time) as soon as you know their name, and fill it in as you go, in OpenClaw's directive format: every entry is a dated metadata line, then one line starting with Always, Never or Prefer, with today's date. Keep the "Setup isn't finished" line at the top until the questions are done, then delete it and say in one line that you're all set. Use these headings, leaving out what you don't know yet:

```
# USER.md

Setup isn't finished: use the first-chat skill. Read it before you reply and follow it from the top, starting with the welcome.

## Who you're talking to

<!-- observed: YYYY-MM-DD | status: active -->
- Always treat this chat as <full name><", the owner", only if the setting says so>, who texts from <their handles>.

## Household

<!-- observed: YYYY-MM-DD | status: active -->
- Always use <town> (<IANA time zone>) by default for weather, directions, nearby places and times, without saying you're assuming it.

## Preferences

<!-- observed: YYYY-MM-DD | status: active -->
- Prefer <how they like to be talked to>.
```
