// Apple Maps place search (MapKit, no key), JXA. Run by uno-apple-tools as
//   osascript -l JavaScript maps.js '{"query":"pizza near Anytown","max":8}'
// Prints JSON: { places: [{ name, phone, website, category, address, maps }] }.
ObjC.import("MapKit"); ObjC.import("Foundation");
function run(argv) {
  var input = JSON.parse(argv[0]);
  var req = $.MKLocalSearchRequest.alloc.init;
  req.naturalLanguageQuery = String(input.query);
  var out = null, err = null;
  $.MKLocalSearch.alloc.initWithRequest(req).startWithCompletionHandler(function (res, e) {
    if (e && !e.isNil()) err = ObjC.unwrap(e.localizedDescription); else out = res;
  });
  var until = $.NSDate.dateWithTimeIntervalSinceNow(10);
  while (!out && !err && $.NSDate.date.compare(until) < 0) $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.1));
  if (err) return JSON.stringify({ places: [], note: "no-results" });
  if (!out) return JSON.stringify({ error: "timeout" });
  var s = function (x) { return x.isNil() ? null : ObjC.unwrap(x); };
  var items = [], arr = out.mapItems, max = Math.min(arr.count, Number(input.max) || 8);
  for (var i = 0; i < max; i++) {
    var m = arr.objectAtIndex(i), pm = m.placemark;
    var address = [pm.subThoroughfare, pm.thoroughfare, pm.locality, pm.administrativeArea, pm.postalCode].map(s).filter(Boolean).join(" ");
    var name = s(m.name);
    var cat = s(m.pointOfInterestCategory);
    items.push({
      name: name, phone: s(m.phoneNumber), website: m.url.isNil() ? null : s(m.url.absoluteString),
      category: cat ? cat.replace("MKPOICategory", "") : null, address: address,
      maps: "https://maps.apple.com/?q=" + encodeURIComponent(name || "") + "&address=" + encodeURIComponent(address),
    });
  }
  return JSON.stringify({ places: items });
}
