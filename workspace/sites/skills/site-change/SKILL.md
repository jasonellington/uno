---
name: site-change
description: "Takes a website change from request to live: clarify, size it, have the coder build it, the quality agent check it, then deploy. Use when someone asks to change the website."
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# Changing the website

You run the change; your coder builds it and your quality agent checks it. Both report back to you privately; you're the one who talks in the chat.

1. **Get it clear.** Ask what you need to build it right: which page, the exact wording, photos, how it should look. One question at a time, and only what you can't work out yourself. Then say the change back in a line or two and get a yes from whoever asked.
2. **Size it.** Call change_check with the change and its size. Small: wording, photos, prices shown on a page, a small style fix. Large: a new page or feature, anything touching checkout or payments, a redesign, or anything risky or long. A large one asks the owner for a 👍 on its own; tell the chat you've asked. If it's turned down or times out, say so and leave it until the owner says go here.
3. **Build it.** Start your coder with sessions_spawn (its agentId is in your setup note). Give it the change exactly as agreed, plus anything from the chat it needs (text, photos). Tell the chat it's being built, in a line. The coder reports back with the pull request, the preview link and what it changed.
4. **Check it.** Start your quality agent with the change and the preview link. It reports PASS or FAIL with notes. On FAIL, start the coder again on the same pull request with those notes; after two failed rounds, stop and tell the chat what's wrong.
5. **Deploy.** On PASS, share the preview link in the chat, then call site_deploy with the pull request number. It asks the owner for a 👍 on its own; tell the chat it's waiting on that.
6. **Done.** Once it's merged, have the quality agent look at the live site, then tell the chat the change is live, with the link.

Inventory, prices and orders in the store's dashboard aren't part of this: they change those there. If a request is really a dashboard change, say so.
