// Music app on this Mac (JXA). Run by uno-apple-tools as
//   osascript -l JavaScript music.js '{"action":"status"}'
// Actions and values are validated by the plugin; names are matched exactly
// against what Music lists, never used as script text.
function run(argv) {
  var input = JSON.parse(argv[0]);
  var out = function (o) { return JSON.stringify(o); };
  var Music = Application("Music");

  var devices = function () { return Music.airplayDevices !== undefined ? Music.airplayDevices : Music.airPlayDevices; };
  var currentDevices = function () { try { return Music.currentAirplayDevices(); } catch (e) { return Music.currentAirPlayDevices(); } };
  var setCurrentDevices = function (list) { try { Music.currentAirplayDevices = list; } catch (e) { Music.currentAirPlayDevices = list; } };

  var status = function () {
    var track = null;
    try { var t = Music.currentTrack; track = { name: t.name(), artist: t.artist(), album: t.album() }; } catch (e) {}
    var speakers = [];
    try { speakers = currentDevices().map(function (d) { return d.name(); }); } catch (e) {}
    return { state: String(Music.playerState()), track: track, volume: Music.soundVolume(), shuffle: Music.shuffleEnabled(), speakers: speakers };
  };
  var pick = function (names, want) {
    var w = String(want).trim().toLowerCase();
    for (var i = 0; i < names.length; i++) if (String(names[i]).trim().toLowerCase() === w) return i;
    return -1;
  };

  switch (input.action) {
    case "status": return out(status());
    case "play": Music.play(); return out(status());
    case "pause": Music.pause(); return out(status());
    case "next": Music.nextTrack(); return out(status());
    case "previous": Music.previousTrack(); return out(status());
    case "volume": Music.soundVolume = input.level; return out(status());
    case "shuffle": Music.shuffleEnabled = input.on; return out(status());
    case "playlists": return out({ playlists: Music.playlists.name().slice(0, 200) });
    case "play_playlist": {
      var names = Music.playlists.name();
      var i = pick(names, input.name);
      if (i < 0) return out({ error: "no-playlist" });
      Music.playlists[i].play();
      return out(status());
    }
    case "play_song": {
      var found = Music.search(Music.libraryPlaylists[0], { for: input.query, only: "all" }) || [];
      if (!found.length) return out({ error: "no-song" });
      found[0].play();
      return out(status());
    }
    case "speakers": {
      var all = devices();
      return out({ speakers: all.name(), selected: currentDevices().map(function (d) { return d.name(); }) });
    }
    case "set_speakers": {
      var all = devices(), names = all.name(), chosen = [], missing = [];
      input.speakers.forEach(function (n) { var k = pick(names, n); if (k < 0) missing.push(n); else chosen.push(all[k]); });
      if (missing.length) return out({ error: "no-speaker", available: names });
      setCurrentDevices(chosen);
      return out(status());
    }
  }
  return out({ error: "bad-action" });
}
