// Flatness probe: how much does each box vary in luminance, in the reference and in the candidate?
//
//   swift flat.swift <ref.png> <candidate.png> x,y,w,h [x,y,w,h ...]
//       prints JSON [{refStd, shotStd}, ...] in box order; std-dev of luminance (0-255) over the box.
//   swift flat.swift blank <in.png> <out.png> x,y,w,h
//       writes <in.png> as a 1920x1080 PNG with the box painted flat grey (selftest fault: an image that landed blank)
//
// Both images are drawn into a 1920x1080 sRGB frame over white (same normalisation as diff.swift), so boxes
// are in slide coordinates. A box that falls outside the frame is clipped; an empty clip reports null.
// check.ts uses it to spot images that landed blank (near-flat) in Figma while the reference has detail.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(2) }

func luma(_ path: String, _ w: Int, _ h: Int) -> [Double] {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read image: \(path)") }
    var buf = [UInt8](repeating: 255, count: w * h * 4)
    buf.withUnsafeMutableBytes { p in
        let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: srgb, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(CGColor(colorSpace: srgb, components: [1, 1, 1, 1])!)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var y = [Double](repeating: 0, count: w * h)
    for i in 0..<(w * h) { y[i] = 0.2126 * Double(buf[i*4]) + 0.7152 * Double(buf[i*4+1]) + 0.0722 * Double(buf[i*4+2]) }
    return y
}

func std(_ l: [Double], _ W: Int, _ H: Int, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> Double? {
    let x0 = max(0, x), y0 = max(0, y), x1 = min(W, x + w), y1 = min(H, y + h)
    if x1 <= x0 || y1 <= y0 { return nil }
    var s = 0.0, s2 = 0.0
    for yy in y0..<y1 { for xx in x0..<x1 { let v = l[yy*W+xx]; s += v; s2 += v*v } }
    let n = Double((x1-x0)*(y1-y0)), m = s / n
    return max(0, s2 / n - m * m).squareRoot()
}

func blank(_ inPath: String, _ outPath: String, _ box: [Int]) {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: inPath) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read image: \(inPath)") }
    let ctx = CGContext(data: nil, width: 1920, height: 1080, bitsPerComponent: 8, bytesPerRow: 1920 * 4, space: srgb, bitmapInfo: bitmapInfo)!
    ctx.setFillColor(CGColor(colorSpace: srgb, components: [1, 1, 1, 1])!)
    ctx.fill(CGRect(x: 0, y: 0, width: 1920, height: 1080))
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: 1920, height: 1080))
    ctx.setFillColor(CGColor(colorSpace: srgb, components: [0.5, 0.5, 0.5, 1])!)
    ctx.fill(CGRect(x: box[0], y: 1080 - box[1] - box[3], width: box[2], height: box[3]))  // CG origin is bottom-left
    guard let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(outPath)") }
    CGImageDestinationAddImage(d, ctx.makeImage()!, nil)
    if !CGImageDestinationFinalize(d) { fail("cannot write \(outPath)") }
}

let a = Array(CommandLine.arguments.dropFirst())
if a.first == "blank" {
    if a.count != 4 { fail("usage: flat blank <in.png> <out.png> x,y,w,h") }
    blank(a[1], a[2], a[3].split(separator: ",").map { Int($0)! })
    exit(0)
}
if a.count < 3 { fail("usage: flat <ref.png> <candidate.png> x,y,w,h [...]") }
let W = 1920, H = 1080
let ref = luma(a[0], W, H), shot = luma(a[1], W, H)
var out: [String] = []
for b in a.dropFirst(2) {
    let p = b.split(separator: ",").compactMap { Int(Double($0)!.rounded()) }
    if p.count != 4 { fail("bad box \(b)") }
    let r = std(ref, W, H, p[0], p[1], p[2], p[3]), s = std(shot, W, H, p[0], p[1], p[2], p[3])
    out.append("{\"refStd\":\(r.map { String($0) } ?? "null"),\"shotStd\":\(s.map { String($0) } ?? "null")}")
}
print("[" + out.joined(separator: ",") + "]")
