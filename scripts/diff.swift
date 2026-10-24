// Slide comparison check: how far is a candidate render from the reference render?
//
//   swift diff.swift <ref.png> <candidate.png> <heatmap-out.png> [--threshold X]
//       prints JSON {score, threshold, pass, worstRegion:{x,y,w,h}}, exits 1 when it fails
//   swift diff.swift --selftest <ref.png>
//       proves the check goes red under real faults and stays green under noise
//
// Method
//   1. Both images are drawn into a 1920x1080 sRGB bitmap (any input size, any colour profile
//      is normalised; the candidate is stretched to the reference frame) and area-averaged 4x4
//      down to 480x270.
//   2. A small blur (four passes of a 1-2-1 kernel, sigma about 1.4 grid px = 6 source px at 1920 wide) is applied so
//      1px anti-aliasing, hinting and sub-pixel text placement do not count.
//   3. Pixels go to CIE Lab; per-pixel difference dE is the Euclidean distance, taken as the minimum over
//      a 3x3 neighbourhood in the other image (both directions) so sub-pixel edge drift is free.
//   4. Two numbers: (a) mean dE over the frame, (b) share of pixels with dE > TOLERANCE.
//      score = 100 * (0.5 * min(1, mean / 10) + 0.5 * min(1, share / 0.05))   0 = identical.
//      Both terms are linear near zero, so small local faults (a missing line of text)
//      still move the score, while a full-frame fault saturates at 100.
//   5. worstRegion: the 8x8 window (stride 1, in the 480x270 grid) with the highest summed dE,
//      reported in source-frame coordinates (x4, so 32x32 px on a 1920x1080 slide).
//
// Scoring (revised after adversarial testing on slides 1, 17, 27, 41, 76)
//   score = max(global, local). Global is the frame-wide mean/share term above. Local is the 8x8 grid
//   window (32x32 source px) with the highest mean excess dE, scaled so 6 dE mean scores 100. The
//   local term is what catches a changed word or a small wrong-colour swatch, which barely move a
//   frame mean. Sub-pixel edge drift is forgiven by subtracting GRAD_K x edge strength from dE.
//   Measured on 5 slides: realistic greens (identical, JPEG q75, 1px, 2x1, 2x2 shifts, 0.8px blur)
//   max 4.2; reds (word swap, other photo, reversed gradient, 60px shift, swatch ~3.2 dE off) all >= 20.8.
//   DEFAULT_THRESHOLD 9 is >= 2x above max green and >= 2x below min red.
//   Known blind spots: a single changed digit or letter in 18px text, and a colour error under about
//   2.5 dE. Assert exact text and hex values from the IR / Figma nodes, not from pixels.
//
// Selftest faults are built from the reference image alone:
//   moved block   a 240x80 region with the most detail is moved 40px right (source hole filled with the
//                 local background colour)
//   missing text  a 300x60 region with the most detail is painted over with the local background colour
//   wrong colour  every pixel pulled 35% toward a saturated blue (a hue-rotate would change nothing on a
//                 neutral slide such as the dark cover, so it would not be a fault at all there)
//   blank         a flat mid-grey image

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let GW = 480, GH = 270
let TOLERANCE: Double = 6.0        // dE above which a pixel counts as "different"
let SLACK: Double = 2.0           // dE below this is invisible; ignored by the mean term
let GRAD_K: Double = 1.0           // edge-drift forgiveness, grid px (4 source px)
let WIN = 8                        // local window, grid px
let LOCAL_FULL: Double = 6.0       // window-mean excess dE that scores 100 on the local term
let DEFAULT_THRESHOLD: Double = 9.0 // see header; confirmed by --selftest margin check

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(2)
}

// MARK: image io

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

func loadCG(_ path: String) -> CGImage {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let src = CGImageSourceCreateWithURL(url, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { fail("cannot read image: \(path)") }
    return img
}

/// Draw into a w x h sRGB RGBA buffer, flattened over white.
func rgba(_ img: CGImage, _ w: Int, _ h: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 255, count: w * h * 4)
    buf.withUnsafeMutableBytes { p in
        let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: srgb, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(CGColor(colorSpace: srgb, components: [1, 1, 1, 1])!)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return buf
}

/// Exact 4x4 area average from a 1920x1080 buffer to the 480x270 grid. CoreGraphics' own downscale
/// aliases 1px lines, so a 1px shift would score as a fault; an area average does not.
func boxDown(_ src: [UInt8]) -> [UInt8] {
    let W = GW * 4
    var out = [UInt8](repeating: 255, count: GW * GH * 4)
    for y in 0..<GH { for x in 0..<GW { for c in 0..<3 {
        var t = 0
        for dy in 0..<4 { for dx in 0..<4 { t += Int(src[((y*4+dy)*W + x*4+dx)*4 + c]) } }
        out[(y*GW+x)*4+c] = UInt8((t + 8) / 16)
    } } }
    return out
}
func gridOf(_ img: CGImage) -> [UInt8] { boxDown(rgba(img, GW * 4, GH * 4)) }

func makeCG(_ buf: [UInt8], _ w: Int, _ h: Int) -> CGImage {
    var b = buf
    let img: CGImage? = b.withUnsafeMutableBytes { p in
        CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                  space: srgb, bitmapInfo: bitmapInfo)!.makeImage()
    }
    return img!
}

func writePNG(_ img: CGImage, _ path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let d = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { fail("cannot write \(path)") }
    CGImageDestinationAddImage(d, img, nil)
    if !CGImageDestinationFinalize(d) { fail("cannot write \(path)") }
}

func jpegRoundTrip(_ buf: [UInt8], _ w: Int, _ h: Int, quality: Double) -> [UInt8] {
    let data = NSMutableData()
    let d = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, makeCG(buf, w, h), [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    CGImageDestinationFinalize(d)
    let src = CGImageSourceCreateWithData(data, nil)!
    return rgba(CGImageSourceCreateImageAtIndex(src, 0, nil)!, w, h)
}

// MARK: comparison

/// Blur (4 passes of 1-2-1, separable) on an RGBA buffer, in place on the RGB channels.
func blur(_ buf: inout [UInt8], _ w: Int, _ h: Int) {
    var f = buf.map { Float($0) }
    var tmp = f
    for _ in 0..<4 {
        for y in 0..<h { for x in 0..<w {
            let xl = max(0, x - 1), xr = min(w - 1, x + 1)
            for c in 0..<3 { tmp[(y*w+x)*4+c] = (f[(y*w+xl)*4+c] + 2*f[(y*w+x)*4+c] + f[(y*w+xr)*4+c]) / 4 }
        } }
        for y in 0..<h { for x in 0..<w {
            let yu = max(0, y - 1), yd = min(h - 1, y + 1)
            for c in 0..<3 { f[(y*w+x)*4+c] = (tmp[(yu*w+x)*4+c] + 2*tmp[(y*w+x)*4+c] + tmp[(yd*w+x)*4+c]) / 4 }
        } }
    }
    for i in 0..<buf.count where i % 4 != 3 { buf[i] = UInt8(max(0, min(255, f[i].rounded()))) }
}

func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
func toLab(_ buf: [UInt8], _ n: Int) -> [Double] {
    var out = [Double](repeating: 0, count: n * 3)
    func f(_ t: Double) -> Double { t > 216.0/24389.0 ? cbrt(t) : (24389.0/27.0 * t + 16) / 116 }
    for i in 0..<n {
        let r = lin(Double(buf[i*4]) / 255), g = lin(Double(buf[i*4+1]) / 255), b = lin(Double(buf[i*4+2]) / 255)
        let x = (0.4124564*r + 0.3575761*g + 0.1804375*b) / 0.95047
        let y = 0.2126729*r + 0.7151522*g + 0.0721750*b
        let z = (0.0193339*r + 0.1191920*g + 0.9503041*b) / 1.08883
        out[i*3] = 116 * f(y) - 16; out[i*3+1] = 500 * (f(x) - f(y)); out[i*3+2] = 200 * (f(y) - f(z))
    }
    return out
}

struct Result {
    var score: Double; var mean: Double; var share: Double; var local: Double
    var worst: (x: Int, y: Int, w: Int, h: Int); var dE: [Double]
}

/// Per-pixel Lab gradient magnitude (dE per grid pixel), central differences with clamped edges.
func gradMag(_ l: [Double]) -> [Double] {
    var g = [Double](repeating: 0, count: GW * GH)
    for y in 0..<GH { for x in 0..<GW {
        let xl = max(0, x - 1), xr = min(GW - 1, x + 1), yu = max(0, y - 1), yd = min(GH - 1, y + 1)
        var s = 0.0
        for c in 0..<3 {
            let gx = (l[(y*GW+xr)*3+c] - l[(y*GW+xl)*3+c]) / Double(xr - xl)
            let gy = (l[(yd*GW+x)*3+c] - l[(yu*GW+x)*3+c]) / Double(yd - yu)
            s += gx*gx + gy*gy
        }
        g[y*GW+x] = s.squareRoot()
    } }
    return g
}

/// 3x3 maximum filter.
func max3(_ v: [Double]) -> [Double] {
    var o = v
    for y in 0..<GH { for x in 0..<GW {
        var m = v[y*GW+x]
        for oy in -1...1 { for ox in -1...1 {
            let xx = x + ox, yy = y + oy
            if xx < 0 || yy < 0 || xx >= GW || yy >= GH { continue }
            m = max(m, v[yy*GW+xx])
        } }
        o[y*GW+x] = m
    } }
    return o
}

/// Compare two source-size RGBA buffers (already decoded) by normalising both to the 480x270 grid.
func compareGrid(_ a: [UInt8], _ b: [UInt8]) -> Result {
    var a = a, b = b
    blur(&a, GW, GH); blur(&b, GW, GH)
    let la = toLab(a, GW * GH), lb = toLab(b, GW * GH)
    var d = [Double](repeating: 0, count: GW * GH)
    // Misregistration tolerance, two parts:
    //  (1) a pixel's difference is the smallest dE between it and the other image's 3x3 neighbourhood
    //      (both directions), so whole-pixel drift is free;
    //  (2) sub-pixel drift on a high-contrast edge cannot be found by integer offsets (a 0.5 grid px
    //      shift of a dark/light edge still leaves ~12 dE), so the difference is reduced by
    //      GRAD_K x the local edge strength (dE per grid px, max of both images, 3x3 max-filtered).
    //      That forgives about GRAD_K grid px (4 source px) of drift at an edge and nothing on flat
    //      colour, so a wrong swatch colour keeps its full dE.
    func de(_ i: Int, _ j: Int) -> Double {
        let dl = la[i*3] - lb[j*3], da = la[i*3+1] - lb[j*3+1], db = la[i*3+2] - lb[j*3+2]
        return dl*dl + da*da + db*db
    }
    func de2(_ i: Int, _ j: Int) -> Double {   // a at j, b at i
        let dl = la[j*3] - lb[i*3], da = la[j*3+1] - lb[i*3+1], db = la[j*3+2] - lb[i*3+2]
        return dl*dl + da*da + db*db
    }
    let ga = gradMag(la), gb = gradMag(lb)
    var g = [Double](repeating: 0, count: GW * GH)
    for i in 0..<GW*GH { g[i] = max(ga[i], gb[i]) }
    let G = max3(g)
    var sum = 0.0, over = 0
    var over2 = [Double](repeating: 0, count: GW * GH)   // max(0, d - SLACK)
    for y in 0..<GH { for x in 0..<GW {
        let i = y * GW + x
        var m = Double.infinity
        for oy in -1...1 { for ox in -1...1 {
            let xx = x + ox, yy = y + oy
            if xx < 0 || yy < 0 || xx >= GW || yy >= GH { continue }
            let j = yy * GW + xx
            m = min(m, de(i, j), de2(i, j))
        } }
        d[i] = max(0, m.squareRoot() - GRAD_K * G[i])
        over2[i] = max(0, d[i] - SLACK)
        sum += over2[i]; if d[i] > TOLERANCE { over += 1 }
    } }
    let mean = sum / Double(GW * GH), share = Double(over) / Double(GW * GH)
    let globalScore = 100 * (0.5 * min(1, mean / 10) + 0.5 * min(1, share / 0.05))
    // Local term: the WIN x WIN window (grid px, 32x32 source px) with the highest mean excess dE.
    // A changed word or a small wrong-colour block barely moves the frame mean but fills a window.
    var ii = [Double](repeating: 0, count: (GW + 1) * (GH + 1))
    for y in 0..<GH { var row = 0.0; for x in 0..<GW {
        row += over2[y*GW+x]; ii[(y+1)*(GW+1)+x+1] = ii[y*(GW+1)+x+1] + row } }
    var best = -1.0, bx = 0, by = 0
    for y in 0...(GH - WIN) { for x in 0...(GW - WIN) {
        let s = ii[(y+WIN)*(GW+1)+x+WIN] - ii[y*(GW+1)+x+WIN] - ii[(y+WIN)*(GW+1)+x] + ii[y*(GW+1)+x]
        if s > best { best = s; bx = x; by = y }
    } }
    let localMean = best / Double(WIN * WIN)
    let localScore = 100 * min(1, localMean / LOCAL_FULL)
    return Result(score: max(globalScore, localScore), mean: mean, share: share, local: localScore,
                  worst: (bx * 4, by * 4, WIN * 4, WIN * 4), dE: d)
}

func compare(_ ref: CGImage, _ cand: CGImage) -> (Result, [UInt8]) {
    let candBuf = gridOf(cand)
    return (compareGrid(gridOf(ref), candBuf), candBuf)
}

func heatmap(_ cand: [UInt8], _ dE: [Double]) -> CGImage {
    var out = cand
    for i in 0..<GW*GH {
        let lum = (0.3 * Double(cand[i*4]) + 0.59 * Double(cand[i*4+1]) + 0.11 * Double(cand[i*4+2])) * 0.55
        let a = max(0, min(1, (dE[i] - TOLERANCE / 2) / (TOLERANCE * 2)))   // 0 below half tolerance
        out[i*4]   = UInt8(min(255, lum * (1 - a) + 255 * a))
        out[i*4+1] = UInt8(lum * (1 - a) + 40 * a)
        out[i*4+2] = UInt8(lum * (1 - a) + 40 * a)
        out[i*4+3] = 255
    }
    return makeCG(out, GW, GH)
}

// MARK: selftest fault builders (operate on a full-size RGBA buffer)

/// Find the cw x ch window with the most local detail (sum of horizontal+vertical gradients), stride 8.
func detailiest(_ buf: [UInt8], _ w: Int, _ h: Int, _ cw: Int, _ ch: Int, maxX: Int? = nil) -> (Int, Int) {
    var g = [Double](repeating: 0, count: w * h)
    for y in 1..<h-1 { for x in 1..<w-1 {
        let i = (y*w+x)*4
        func l(_ j: Int) -> Double { Double(buf[j]) + Double(buf[j+1]) + Double(buf[j+2]) }
        g[y*w+x] = abs(l(i) - l(i-4)) + abs(l(i) - l(i-w*4))
    } }
    var ii = [Double](repeating: 0, count: (w+1)*(h+1))
    for y in 0..<h { var row = 0.0; for x in 0..<w { row += g[y*w+x]; ii[(y+1)*(w+1)+x+1] = ii[y*(w+1)+x+1] + row } }
    var best = -1.0, bx = 0, by = 0
    let xLimit = min(w - cw, maxX ?? (w - cw))
    for y in stride(from: 0, through: h - ch, by: 8) { for x in stride(from: 0, through: xLimit, by: 8) {
        let s = ii[(y+ch)*(w+1)+x+cw] - ii[y*(w+1)+x+cw] - ii[(y+ch)*(w+1)+x] + ii[y*(w+1)+x]
        if s > best { best = s; bx = x; by = y }
    } }
    return (bx, by)
}

/// Most common colour on the 6px ring just outside the rect.
func localBackground(_ buf: [UInt8], _ w: Int, _ h: Int, _ x0: Int, _ y0: Int, _ rw: Int, _ rh: Int) -> (UInt8, UInt8, UInt8) {
    var counts: [UInt32: Int] = [:]
    for y in max(0, y0 - 6)..<min(h, y0 + rh + 6) { for x in max(0, x0 - 6)..<min(w, x0 + rw + 6) {
        if x >= x0 && x < x0 + rw && y >= y0 && y < y0 + rh { continue }
        let i = (y*w+x)*4
        let key = (UInt32(buf[i] >> 2) << 16) | (UInt32(buf[i+1] >> 2) << 8) | UInt32(buf[i+2] >> 2)
        counts[key, default: 0] += 1
    } }
    let k = counts.max { $0.value < $1.value }!.key
    return (UInt8((k >> 16) << 2), UInt8(((k >> 8) & 255) << 2), UInt8((k & 255) << 2))
}

func fillRect(_ buf: inout [UInt8], _ w: Int, _ x0: Int, _ y0: Int, _ rw: Int, _ rh: Int, _ c: (UInt8, UInt8, UInt8)) {
    for y in y0..<y0+rh { for x in x0..<x0+rw { let i = (y*w+x)*4; buf[i] = c.0; buf[i+1] = c.1; buf[i+2] = c.2 } }
}

/// Pull every pixel `amount` of the way toward a target colour (a wrong-colour fault that is visible
/// even on a neutral slide, where hue-rotate would change nothing).
func tint(_ buf: [UInt8], toward t: (Double, Double, Double), amount: Double) -> [UInt8] {
    var out = buf
    for i in 0..<(buf.count / 4) {
        out[i*4]   = UInt8(Double(buf[i*4])   + amount * (t.0 - Double(buf[i*4])))
        out[i*4+1] = UInt8(Double(buf[i*4+1]) + amount * (t.1 - Double(buf[i*4+1])))
        out[i*4+2] = UInt8(Double(buf[i*4+2]) + amount * (t.2 - Double(buf[i*4+2])))
    }
    return out
}

/// Soften like a different text rasteriser would: 50% original, 50% 3x3 box average.
func softened(_ buf: [UInt8], _ w: Int, _ h: Int) -> [UInt8] {
    var out = buf
    for y in 0..<h { for x in 0..<w { for c in 0..<3 {
        var t = 0
        for oy in -1...1 { for ox in -1...1 {
            t += Int(buf[(min(h-1, max(0, y+oy))*w + min(w-1, max(0, x+ox)))*4 + c])
        } }
        out[(y*w+x)*4+c] = UInt8((Int(buf[(y*w+x)*4+c]) * 9 + t + 9) / 18)
    } } }
    return out
}

/// The cw x ch window with the least detail (flattest area), stride 8.
func flattest(_ buf: [UInt8], _ w: Int, _ h: Int, _ cw: Int, _ ch: Int) -> (Int, Int, Double) {
    var g = [Double](repeating: 0, count: w * h)
    for y in 1..<h-1 { for x in 1..<w-1 {
        let i = (y*w+x)*4
        func l(_ j: Int) -> Double { Double(buf[j]) + Double(buf[j+1]) + Double(buf[j+2]) }
        g[y*w+x] = abs(l(i) - l(i-4)) + abs(l(i) - l(i-w*4))
    } }
    var ii = [Double](repeating: 0, count: (w+1)*(h+1))
    for y in 0..<h { var row = 0.0; for x in 0..<w { row += g[y*w+x]; ii[(y+1)*(w+1)+x+1] = ii[y*(w+1)+x+1] + row } }
    var best = Double.infinity, bx = 0, by = 0
    for y in stride(from: 0, through: h - ch, by: 8) { for x in stride(from: 0, through: w - cw, by: 8) {
        let s = ii[(y+ch)*(w+1)+x+cw] - ii[y*(w+1)+x+cw] - ii[(y+ch)*(w+1)+x] + ii[y*(w+1)+x]
        if s < best { best = s; bx = x; by = y }
    } }
    return (bx, by, best / Double(cw * ch))
}

func selftest(_ refPath: String) -> Never {
    let refImg = loadCG(refPath)
    let W = 1920, H = 1080   // faults are built at slide size; any reference is normalised to this
    let ref = rgba(refImg, W, H)
    let refGrid = boxDown(ref)

    func score(_ buf: [UInt8]) -> Double { let r = compareGrid(refGrid, boxDown(buf)); if CommandLine.arguments.contains("--debug") { print("  debug mean \(r.mean) share \(r.share) worst \(r.worst)") }; return r.score }

    // greens
    let identical = ref
    let jpeg = jpegRoundTrip(ref, W, H, quality: 0.75)
    var shifted = ref   // copy shifted 1px right, edge column repeated
    for y in 0..<H { for x in 0..<W {
        let sx = max(0, x - 1)
        for c in 0..<4 { shifted[(y*W+x)*4+c] = ref[(y*W+sx)*4+c] }
    } }

    var diag = ref      // 2px right + 2px down: realistic renderer misregistration
    for y in 0..<H { for x in 0..<W {
        let sx = max(0, x - 2), sy = max(0, y - 2)
        for c in 0..<4 { diag[(y*W+x)*4+c] = ref[(sy*W+sx)*4+c] }
    } }
    let soft = softened(ref, W, H)

    // reds
    var moved = ref
    let (mx, my) = detailiest(ref, W, H, 240, 80, maxX: W - 240 - 40)
    let bgMove = localBackground(ref, W, H, mx, my, 240, 80)
    fillRect(&moved, W, mx, my, 240, 80, bgMove)
    for y in 0..<80 { for x in 0..<240 {
        for c in 0..<4 { moved[((my+y)*W+mx+40+x)*4+c] = ref[((my+y)*W+mx+x)*4+c] }
    } }
    var missing = ref
    let (tx, ty) = detailiest(ref, W, H, 300, 60)
    fillRect(&missing, W, tx, ty, 300, 60, localBackground(ref, W, H, tx, ty, 300, 60))
    var vshift = ref    // whole slide 60px down, top rows repeated
    for y in 0..<H { for x in 0..<W {
        let sy = max(0, y - 60)
        for c in 0..<4 { vshift[(y*W+x)*4+c] = ref[(sy*W+x)*4+c] }
    } }
    // A swatch-sized flat area whose colour is off by roughly 4 dE (a wrong brand colour).
    var swatch = ref
    let (fx, fy, flatness) = flattest(ref, W, H, 200, 160)
    for y in fy..<fy+160 { for x in fx..<fx+200 { let i = (y*W+x)*4
        for c in 0..<3 { swatch[i+c] = UInt8(max(0, min(255, Int(ref[i+c]) + (c == 0 ? 12 : -4)))) } } }
    // A detailed 300x200 region replaced by a vertically flipped copy (different pictures or words).
    var flipped = ref
    let (px, py) = detailiest(ref, W, H, 300, 200)
    for y in 0..<200 { for x in 0..<300 { for c in 0..<4 {
        flipped[((py+y)*W+px+x)*4+c] = ref[((py+199-y)*W+px+x)*4+c] } } }
    let recolour = tint(ref, toward: (30, 60, 200), amount: 0.35)
    var blank = ref
    fillRect(&blank, W, 0, 0, W, H, (128, 128, 128))

    // The wrong-colour fault must actually change the reference, or the case proves nothing.
    var changedPx = 0
    for i in 0..<(W*H) where abs(Int(recolour[i*4]) - Int(ref[i*4])) + abs(Int(recolour[i*4+1]) - Int(ref[i*4+1])) + abs(Int(recolour[i*4+2]) - Int(ref[i*4+2])) > 30 { changedPx += 1 }

    let greens: [(String, [UInt8])] = [("identical copy", identical), ("JPEG q75 re-encode", jpeg), ("1px shift", shifted),
                                     ("2px diagonal shift", diag), ("softened render (3x3 mix)", soft)]
    let reds: [(String, [UInt8])] = [("240x80 block moved 40px right", moved), ("300x60 text-sized block erased", missing),
                                     ("wrong colour (frame pulled 35% to blue)", recolour), ("blank grey image", blank),
                                     ("whole slide 60px down", vshift), ("flat 200x160 area ~4 dE off", swatch),
                                     ("300x200 region flipped (other picture)", flipped)]
    let gs = greens.map { score($0.1) }, rs = reds.map { score($0.1) }
    let maxGreen = gs.max()!, minRed = rs.min()!
    let chosen = max(0.05, (maxGreen * minRed).squareRoot())
    let rounded = (chosen * 20).rounded() / 20
    print("selftest on \(refPath)")
    print(String(format: "flat area at (%d,%d) roughness %.2f; flipped region at (%d,%d)", fx, fy, flatness, px, py))
    print(String(format: "moved block at (%d,%d); erased block at (%d,%d); recolour changed %.1f%% of pixels", mx, my, tx, ty, 100 * Double(changedPx) / Double(W*H)))
    var ok = true
    func line(_ n: String, _ s: Double, _ expectRed: Bool, _ thr: Double) {
        let red = s > thr
        let good = red == expectRed
        if !good { ok = false }
        print(String(format: "%@  %-46@ score %7.3f  expect %@  got %@", good ? "PASS" : "FAIL", n as NSString, s, expectRed ? "RED  " : "GREEN", red ? "RED" : "GREEN"))
    }
    print(String(format: "default threshold %.3f (suggested from this run: %.3f = geometric mean of max green %.3f and min red %.3f)", DEFAULT_THRESHOLD, rounded, maxGreen, minRed))
    for (i, g) in greens.enumerated() { line(g.0, gs[i], false, DEFAULT_THRESHOLD) }
    for (i, r) in reds.enumerated() { line(r.0, rs[i], true, DEFAULT_THRESHOLD) }
    // margin: default threshold must sit clear of both groups (at least 2x above green, 2x below red)
    let margin = DEFAULT_THRESHOLD >= 2 * maxGreen && DEFAULT_THRESHOLD * 2 <= minRed
    print(String(format: "%@  threshold margin (>=2x above max green %.3f, >=2x below min red %.3f)", margin ? "PASS" : "FAIL", maxGreen, minRed))
    if !margin { ok = false }
    if changedPx * 50 < W * H {   // recolour must touch at least 2% of pixels
        print("FAIL  wrong-colour fault changed under 2% of pixels; this reference cannot exercise it"); ok = false
    }
    print(ok ? "SELFTEST OK" : "SELFTEST FAILED")
    exit(ok ? 0 : 1)
}

// MARK: main

var args = Array(CommandLine.arguments.dropFirst())
if args.first == "--selftest" {
    guard args.count >= 2 else { fail("usage: swift diff.swift --selftest <ref.png>") }
    selftest(args[1])
}
var threshold = DEFAULT_THRESHOLD
if let i = args.firstIndex(of: "--threshold") {
    guard i + 1 < args.count, let t = Double(args[i + 1]) else { fail("--threshold needs a number") }
    threshold = t; args.removeSubrange(i...i+1)
}
guard args.count == 3 else { fail("usage: swift diff.swift <ref.png> <candidate.png> <heatmap-out.png> [--threshold X]") }
let (res, candBuf) = compare(loadCG(args[0]), loadCG(args[1]))
writePNG(heatmap(candBuf, res.dE), args[2])
let pass = res.score <= threshold
print(String(format: "{\"score\":%.3f,\"threshold\":%.3f,\"pass\":%@,\"worstRegion\":{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d},\"meanDE\":%.3f,\"shareOverTolerance\":%.5f,\"localScore\":%.3f}",
             res.score, threshold, pass ? "true" : "false", res.worst.x, res.worst.y, res.worst.w, res.worst.h, res.mean, res.share, res.local))
exit(pass ? 0 : 1)
