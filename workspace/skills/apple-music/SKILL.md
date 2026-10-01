---
name: apple-music
description: "Plays and controls music in the Music app, on this Mac or AirPlay speakers around the house. Use for \"play…\", \"turn it up\" or \"what's playing\"."
metadata: { "openclaw": { "emoji": "🎶", "os": ["darwin"], "requires": { "bins": ["osascript"] } } }
---

# Apple Music

If you have the `apple_music` tool, use it for all of this. Otherwise, all through `osascript -e 'tell application "Music" to …'`:

- What's playing: `get {name, artist, album} of current track` and `get player state`.
- Controls: `playpause`, `pause`, `next track`, `previous track`, `set sound volume to <0-100>`, `set shuffle enabled to true`.
- Playlists: `get name of playlists`, then `play playlist "<name>"`.
- A song or artist in the library: `play (first track of library playlist 1 whose name contains "<words>")` (or `artist contains`).
- Speakers: `get name of AirPlay devices`, then `set current AirPlay devices to (AirPlay devices whose name is "<room>")`. For several rooms, pass a list of devices. Use the names exactly as listed.

If what they asked for isn't in the library or a playlist, say so and offer the closest thing (a playlist, or Spotify if that's set up). After a change, check `player state` and the current track before confirming what's playing and where.
