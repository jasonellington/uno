// Apple Maps place search (MapKit), no key: osascript -l JavaScript places.js "<what> near <town>" [max]
// Prints JSON: name, phone, website, category, address, maps (an Apple Maps link to share).
ObjC.import('MapKit'); ObjC.import('Foundation');
function run(argv) {
  const req = $.MKLocalSearchRequest.alloc.init;
  req.naturalLanguageQuery = argv[0];
  let out = null, err = null;
  $.MKLocalSearch.alloc.initWithRequest(req).startWithCompletionHandler((res, e) => { if (e && !e.isNil()) err = ObjC.unwrap(e.localizedDescription); else out = res; });
  const until = $.NSDate.dateWithTimeIntervalSinceNow(10);
  while (!out && !err && $.NSDate.date.compare(until) < 0) $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.1));
  if (err || !out) return JSON.stringify({ error: err || "timeout" });
  const s = (x) => (x.isNil() ? null : ObjC.unwrap(x));
  const items = [], arr = out.mapItems, max = Math.min(arr.count, +(argv[1] || 8));
  for (let i = 0; i < max; i++) {
    const m = arr.objectAtIndex(i), pm = m.placemark;
    const address = [pm.subThoroughfare, pm.thoroughfare, pm.locality, pm.administrativeArea, pm.postalCode].map(s).filter(Boolean).join(" ");
    const name = s(m.name);
    items.push({ name, phone: s(m.phoneNumber), website: m.url.isNil() ? null : s(m.url.absoluteString),
      category: s(m.pointOfInterestCategory)?.replace("MKPOICategory", "") ?? null, address,
      maps: `https://maps.apple.com/?q=${encodeURIComponent(name)}&address=${encodeURIComponent(address)}` });
  }
  return JSON.stringify(items, null, 1);
}
