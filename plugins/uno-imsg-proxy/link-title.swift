// Prints the title Apple's link preview fetcher (LinkPresentation, what
// Messages uses) gets for a URL, as JSON: {"title": "...", "image": true}.
// uno-imsg-proxy compiles this once and runs it before sending a link, so a
// site that answers with a bot check ("Client Challenge") gets a plain link
// instead of a broken preview card.
import Foundation
import LinkPresentation

guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else { exit(2) }
let provider = LPMetadataProvider()
provider.timeout = 8
var done = false
provider.startFetchingMetadata(for: url) { md, _ in
  let out: [String: Any] = ["title": md?.title ?? "", "image": md?.imageProvider != nil]
  if let data = try? JSONSerialization.data(withJSONObject: out) { FileHandle.standardOutput.write(data) }
  done = true
}
while !done { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
