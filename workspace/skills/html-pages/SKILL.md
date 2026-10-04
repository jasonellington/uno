---
name: html-pages
description: "Builds an HTML page someone will read, such as a comparison's details, a shortlist or a plan, from your page design. Use whenever you make an HTML page or file for someone."
metadata: { "openclaw": { "emoji": "📄" } }
---

# HTML pages

People open your pages on their phone, from Files or a link, after the short answer already came by text. A glance should give them the answer and a scroll the rest. The look is a well-made iPhone app screen: the system font, a white ground, photos in rounded frames, small pills, hairline rows, and color only where it points at something.

Start from `page.html` next to this file: copy it, fill it in and keep its styles. It already handles phone width, photos, and the parts most pages need: a photo cover with the title over it, the pick, two-up cards, a side-by-side table that stars the best value, an entry per option with sizes, specs and a buy button, a note on what you couldn't check, and a footer.

- Fill every `{{…}}`, repeat cards and entries per option, then delete every `<!-- template: … -->` note. The cover, the pick, the cards and the entries are always there; the side-by-side table, sizes, specs and the note only when you have something real for them. Use the template's classes as they are, no new parts.
- Set the two accents to colors that suit the topic: `--accent` marks the pick (its pill, badge and price, best values); `--accent-2` marks drops, sales, sold out and warnings. Keep both deep enough to carry white text. Add CSS only for something the design can't show yet, using its colors and type, and no other colors.
- The verdict leads: what to pick, and when to pick something else instead. Everything below backs it up.
- Write it the way you text: short sentences, plain words, each thing said once. Product names in the store's own words, title case. No label that repeats the title, no repeated disclaimers, no made-up brand, masthead or slogan.
- Numbers people compare (price, size, battery) go under each card and in the side-by-side table, same unit everywhere. Date anything that changes, once, on the cover and in the footer.
- Photos only of the exact item, from its own product page; they fill rounded frames on the cover and the cards. Shrink each first (`sips -Z 800 -s format jpeg -s formatOptions 70 <photo> --out <small.jpg>`) and embed it as a `data:image/jpeg;base64,…` URI so the page works offline. Without a verified photo, the card is a short blank tile and the cover leaves that photo out (no photos at all: the plain dark cover); never an illustration in its place.
- Every option links to where to see or buy it.
- Redoing an older page: keep its facts, links and photos, but rewrite its words to these rules rather than carrying them over.

Before handing it over, read it once the way they will on a phone: the answer at the top, nothing left from the template, nothing said twice.
