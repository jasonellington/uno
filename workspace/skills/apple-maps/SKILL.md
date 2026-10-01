---
name: apple-maps
description: "Finds places with Apple Maps and shares them as map links. Use for \"where's a good…\", \"find a … near…\" or sharing a place."
metadata: { "openclaw": { "emoji": "🗺️", "os": ["darwin"], "requires": { "bins": ["osascript"] } } }
---

# Apple Maps

If you have the `apple_maps` tool, search with it. Otherwise search: `osascript -l JavaScript {baseDir}/places.js "<what> near <town>" [max]` (default 8 results). Use their town from USER.md unless they name another. It returns JSON with name, phone, website, category, address and a `maps` link.

- Apple Maps has no hours, ratings or reviews here. When they ask for those, search the web for that place.
- To share a place, send its `maps` link as its own message so it shows a map preview.
