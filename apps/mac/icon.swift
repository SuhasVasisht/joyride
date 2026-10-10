import AppKit
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor(calibratedRed: 0.93, green: 0.95, blue: 0.96, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 24, y: 24, width: 976, height: 976), xRadius: 190, yRadius: 190).fill()
NSColor(calibratedRed: 0.12, green: 0.21, blue: 0.30, alpha: 1).setStroke()
let ring = NSBezierPath(ovalIn: NSRect(x: 220, y: 220, width: 584, height: 584)); ring.lineWidth = 72; ring.stroke()
NSColor(calibratedRed: 0.88, green: 0.36, blue: 0.16, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 400, y: 400, width: 224, height: 224)).fill()
NSGraphicsContext.restoreGraphicsState()
let png = rep.representation(using: .png, properties: [:])!
var icns = Data("icns".utf8)
func append32(_ n: Int, to data: inout Data) { var big = UInt32(n).bigEndian; withUnsafeBytes(of: &big) { data.append(contentsOf: $0) } }
append32(16 + png.count, to: &icns)
icns.append(Data("ic10".utf8)); append32(8 + png.count, to: &icns); icns.append(png)
try icns.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
