// Extract a Claude Design HTML slide deck into per-slide JSON (IR) for the Figma Slides builder.
//
// Usage: bun extract.ts --deck "<path to .dc.html>" --out <ir dir> [--slides 0,16,26] [--wait MS] [--ref <ref dir>]
//   Writes <out>/slide-NNN.json (NNN = 1-based), <out>/assets/<hash>.<ext>, <out>/extract-report.json
//   and 1920x1080 reference screenshots of each slide to --ref (default: ../ref next to the ir dir).
//
// The deck is only ever served and opened in headless Chrome; its scripts never run outside the browser.
//
// IR (one JSON file per slide), coordinates in px relative to the slide's top-left, after CSS transforms:
//   { index, label, width:1920, height:1080, background: Fill[], nodes: Node[] }   nodes are in paint order (back to front)
//   Node = rect | text | svg | image | group
//     rect  { type, name, x,y,w,h, fills: Fill[], radius:[tl,tr,br,bl], stroke:{color,opacity,width,align:"INSIDE"}|null, opacity, clipsContent? }
//     text  { type, name, x,y,w,h, characters, lines?, align, wrap, opacity, runs:[{start,end,fontFamily,fontWeight,italic,fontSize,
//             lineHeightPx,letterSpacingPx,color,colorOpacity,variation:{wght?,wdth?},decoration}] }
//           lines?: number[] = indices in `characters` where Chrome started each line after the first (ascending, 1..length-1).
//           Absent = one line, or only hard breaks ("\n"; a start right after one is never listed). The plugin inserts U+2028
//           immediately before each index, so the Figma text is `characters` with U+2028 added and nothing else changed (D-007).
//     svg   { type, name, x,y,w,h, svg, opacity }
//     image { type, name, x,y,w,h, ref, scaleMode:"FILL"|"FIT"|"CROP"|"STRETCH", opacity, radius, filters? }
//           STRETCH = the whole bitmap mapped onto the box (stretched when the aspects differ; Figma CROP + identity imageTransform).
//     group { type, name, x,y,w,h, children: Node[] (paint order), mask?, opacity?, blendMode?, effects? }
//           Children carry SLIDE-ABSOLUTE x/y like every other node; the group's x,y,w,h is the union of its children (the mask shape
//           included). mask:true means children[0] is the mask (alpha) for the rest. blendMode "NORMAL" on a group isolates it.
//   Fill  = {type:"solid",color,opacity} | {type:"linear",angleDeg,stops} | {type:"radial",stops} | {type:"image",ref,scaleMode,scalingFactor?}
//           scaleMode "TILE": the image repeats at (image px * scalingFactor) slide px. Gradient / url() cells smaller than the box
//           (dot rules, stripes, halftone masks) are rendered once to a PNG cell at up to 4x and tiled; the cell is the only raster.
// Fields any node may carry (D-008, everything stays editable):
//   blendMode  Figma BlendMode name (MULTIPLY, SCREEN, OVERLAY, ... LINEAR_DODGE for plus-lighter) from mix-blend-mode.
//   rotation   degrees clockwise as CSS. x,y,w,h then describe the UNROTATED box, rotation is about its centre. A rotated element's
//              whole subtree is moved into its frame (every descendant gets the same rotation about its own centre; drop/inner-shadow
//              offsets are turned with it). Uniform scale in the transform is folded into sizes. Non-uniform scale is supported when the
//              subtree is rects / svgs only; a real skew (shear) after decomposing M = R * diag(sx, sy) falls back to a raster.
//   effects    IREffect[]:
//     {type:"noise", baseFrequency, octaves, seed, amount, bias, blend, monochrome}   SVG feTurbulence grain. amount = swing of the
//                filter's transfer output across noise 0..1 (0..1), bias = mean transfer output minus the blend's neutral value
//                (1 for MULTIPLY/DARKEN/COLOR_BURN, .5 for OVERLAY/SOFT_LIGHT/HARD_LIGHT, 0 otherwise), both measured in sRGB (a
//                linearRGB filter is converted). Parsed from the filter primitives; the element keeps its own native fill.
//     {type:"drop-shadow"|"inner-shadow", color:"#RRGGBB", opacity, x, y, blur, spread}   box-shadow (blur = CSS blur radius, which is
//                what Figma calls blur), CSS filter drop-shadow() (blur = 2 * its std deviation), feDropShadow
//     {type:"layer-blur"|"background-blur", radius}   filter blur() / feGaussianBlur / backdrop-filter blur(); radius = 2 * std deviation
//   filters    (image nodes) Figma ImageFilters in -1..1: saturation (grayscale()/saturate()), contrast, exposure (brightness()).
// Toned photos (SVG filter = luminance colour-matrix + feComponentTransfer table) become a group: the original image with
//   filters {saturation:-1}, then full-size solid rect layers with blendModes (DIFFERENCE, OVERLAY, MULTIPLY, SCREEN) that map black ->
//   dark tone, mid grey -> mid tone, white -> light tone for any tone colours (see toneStack in extract-page.js).
// Masks: mask-image (url / gradient, tiled or not) and clip-path (inset / circle / ellipse / polygon) -> group with mask:true.
// Conventions beyond the bare contract (all inside the existing fields):
//   - fills[] and background[] are ordered bottom to top (Figma order); CSS layer order is reversed to match.
//   - run.fontWeight is the effective weight: the variation `wght` when font-variation-settings sets one, else CSS font-weight.
//   - text x/w: single-line or non-wrapping text uses the glyph box; wrapping text uses the container's content box.
//     text y/h is the line-box span (lines x line-height), so it sits where the browser put the lines.
//   - raster fallback (LAST RESORT, listed in extract-report with the reason) = image node named "raster:<why>", a PNG of just that
//     element on a transparent ground. Only things with no native mapping reach it: <why> is one of css-filter (hue-rotate, sepia, invert,
//     colour filters on non-images), svg-filter (a filter that is not grain / tone / blur / drop-shadow, or applies to part of an svg),
//     mix-blend-mode (a mode Figma lacks), css-mask / clip-path (a mask with no native form), rotated-or-skewed-or-nonuniform (a real
//     shear, or non-uniform scale over text), 3d-transform, canvas/video/iframe/...
//     extract-report.json lists every one under `rasters` with its reason. Text that sits above an effect without being inside the
//     effect's element stays a text node.
import { chromium } from "playwright";
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, extname, dirname, basename } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const deckArg = flag("--deck");
const outArg = flag("--out");
if (!deckArg || !outArg) {
  console.error('Usage: bun extract.ts --deck "<deck.dc.html>" --out <ir dir> [--slides 0,16,26] [--wait MS] [--ref <ref dir>]');
  process.exit(2);
}
const deckPath = resolve(deckArg);
const root = dirname(deckPath);
const outDir = resolve(outArg);
const refDir = flag("--ref") ? resolve(flag("--ref")!) : join(dirname(outDir), "ref");
const assetDir = join(outDir, "assets");
const slideWait = Number(flag("--wait") ?? 500);
mkdirSync(assetDir, { recursive: true });
mkdirSync(refDir, { recursive: true });

const types: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".jsx": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".json": "application/json",
};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = resolve(join(root, decodeURIComponent(new URL(req.url).pathname)));
    if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) return new Response(null, { status: 404 });
    return new Response(Bun.file(p), { headers: { "Content-Type": types[extname(p).toLowerCase()] ?? "application/octet-stream" } });
  },
});
const origin = `http://localhost:${server.port}`;

// ---------- assets ----------
const mimeExt: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const assetCache = new Map<string, string>();
function writeAsset(buf: Uint8Array, ext: string): string {
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const name = `${hash}.${ext}`;
  const p = join(assetDir, name);
  if (!existsSync(p)) writeFileSync(p, buf);
  return `assets/${name}`;
}
type Loaded = { kind: "raster"; ref: string } | { kind: "svg"; text: string } | { kind: "fail"; why: string };
async function loadSrc(src: string): Promise<Loaded> {
  const hit = assetCache.get(src);
  if (hit) return hit.startsWith("svg:") ? { kind: "svg", text: hit.slice(4) } : { kind: "raster", ref: hit };
  let buf: Uint8Array, mime: string;
  try {
    if (src.startsWith("data:")) {
      const m = src.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
      if (!m) return { kind: "fail", why: "bad data url" };
      mime = m[1] || "application/octet-stream";
      buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    } else if (src.startsWith(origin + "/")) {
      const p = resolve(join(root, decodeURIComponent(new URL(src).pathname)));
      if (!p.startsWith(root) || !existsSync(p)) return { kind: "fail", why: "missing file " + p };
      buf = new Uint8Array(readFileSync(p));
      mime = types[extname(p).toLowerCase()] ?? "application/octet-stream";
    } else {
      const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { kind: "fail", why: `http ${res.status}` };
      buf = new Uint8Array(await res.arrayBuffer());
      mime = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    }
  } catch (e) {
    return { kind: "fail", why: String(e) };
  }
  if (mime.includes("svg")) {
    const text = new TextDecoder().decode(buf);
    assetCache.set(src, "svg:" + text);
    return { kind: "svg", text };
  }
  const ext = mimeExt[mime];
  if (!ext) return { kind: "fail", why: "unsupported type " + mime };
  const ref = writeAsset(buf, ext);
  assetCache.set(src, ref);
  return { kind: "raster", ref };
}

function fitSvg(text: string, w: number, h: number, mode: string): string {
  let s = text.replace(/^<\?xml[^>]*\?>\s*/, "");
  const open = s.match(/<svg\b[^>]*>/);
  if (!open) return s;
  let tag = open[0];
  const attr = (n: string) => tag.match(new RegExp(`\\s${n}=["']([^"']*)["']`))?.[1];
  const vb = attr("viewBox") ?? (attr("width") && attr("height") ? `0 0 ${parseFloat(attr("width")!)} ${parseFloat(attr("height")!)}` : `0 0 ${w} ${h}`);
  tag = tag.replace(/\s(width|height|viewBox|preserveAspectRatio)=["'][^"']*["']/g, "");
  if (!/xmlns=/.test(tag)) tag = tag.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  tag = tag.replace("<svg", `<svg width="${w}" height="${h}" viewBox="${vb}" preserveAspectRatio="${mode === "FIT" ? "xMidYMid meet" : mode === "STRETCH" ? "none" : "xMidYMid slice"}"`);
  return s.replace(open[0], tag);
}

// ---------- browser ----------
const pageSrc = await Bun.file(join(import.meta.dir, "extract-page.js")).text();
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(120000);
await page.goto(`${origin}/${encodeURI(basename(deckPath))}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("deck-stage")?.querySelectorAll(":scope > section").length);
await page.waitForTimeout(1000);
await page.addScriptTag({ content: pageSrc });

const total = await page.evaluate(() => {
  const st = document.querySelector("deck-stage") as any;
  st.setAttribute("noscale", ""); // 1:1 geometry, rail hidden
  const root = st.shadowRoot as ShadowRoot;
  const style = document.createElement("style");
  style.textContent = ".rail,.rail-resize,.overlay,.ctxmenu,.confirm-backdrop,.export-hidden{display:none!important}";
  root.appendChild(style);
  return st.querySelectorAll(":scope > section").length as number;
});
await page.setViewportSize({ width: 1920, height: 1080 });

const wanted = flag("--slides") ? flag("--slides")!.split(",").map((s) => parseInt(s.trim(), 10)) : Array.from({ length: total }, (_, i) => i);
for (const i of wanted) if (!(i >= 0 && i < total)) throw new Error(`slide ${i} out of range 0..${total - 1}`);

// Everything painted: fonts, <img> in light and shadow DOM, SVG <image> filled by async code.
const readyProbe = () => {
  const bad: string[] = [];
  const scan = (root: ParentNode) => {
    root.querySelectorAll("*").forEach((e: any) => {
      if (e.tagName === "IMG" && !(e.complete && e.naturalWidth > 0)) bad.push("img " + (e.getAttribute("src") || "").slice(0, 50));
      if (e.localName === "image" && e instanceof SVGElement && !(e.getAttribute("href") || e.getAttribute("xlink:href"))) bad.push("svg image");
      if (e.shadowRoot) scan(e.shadowRoot);
    });
  };
  const sec = document.querySelector("deck-stage > section[data-deck-active]");
  if (sec) scan(sec);
  return bad;
};

// ---------- tiles: a repeating background / mask cell rendered once, at up to 4x, as the PNG a TILE image fill repeats ----------
const tileCache = new Map<string, { ref: string; scalingFactor: number }>();
const tileCtx = new Map<number, any>();
async function renderTile(t: { layer: string; cw: number; ch: number; size: string; pos: string; repeat: string; scale: number }) {
  const key = JSON.stringify(t);
  const hit = tileCache.get(key);
  if (hit) return hit;
  const dpr = Math.max(1, Math.min(4, Math.sqrt(4_000_000 / Math.max(1, t.cw * t.ch))));
  let ctx = tileCtx.get(dpr);
  if (!ctx) { ctx = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 64, height: 64 } }); tileCtx.set(dpr, ctx); }
  const p = await ctx.newPage();
  await p.setContent('<!doctype html><body style="margin:0;background:transparent"><div id="t"></div>');
  await p.evaluate(async (a) => {
    const d = document.getElementById("t")!;
    Object.assign(d.style, { width: a.cw + "px", height: a.ch + "px", backgroundImage: a.layer, backgroundSize: a.size, backgroundPosition: a.pos, backgroundRepeat: a.repeat });
    for (const m of a.layer.matchAll(/url\(["']?([^"')]+)["']?\)/g)) { const im = new Image(); im.src = m[1]; await im.decode().catch(() => {}); }
  }, t);
  const png = await p.screenshot({ clip: { x: 0, y: 0, width: t.cw, height: t.ch }, omitBackground: true });
  await p.close();
  const buf = new Uint8Array(png);
  const imgW = new DataView(buf.buffer, buf.byteOffset).getUint32(16); // PNG IHDR width
  const out = { ref: writeAsset(buf, "png"), scalingFactor: Math.round(((t.cw * t.scale) / imgW) * 10000) / 10000 };
  tileCache.set(key, out);
  return out;
}

const reportPath = join(outDir, "extract-report.json");
const report: Record<string, any> = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : {};

for (const idx of wanted) {
  const nnn = String(idx + 1).padStart(3, "0");
  await page.evaluate((k) => (document.querySelector("deck-stage") as any).goTo(k), idx);
  await page.evaluate(() => (window as any).OCWakeAll?.()); // optional hook: a deck may define it to draw lazy graphics
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(slideWait);
  let bad: string[] = [];
  for (let t = 0; t < 40; t++) {
    bad = await page.evaluate(readyProbe);
    if (!bad.length) break;
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(refDir, `slide-${nnn}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } });

  const res: any = await page.evaluate((k) => (window as any).__fxExtract(k), idx);
  const warnings: Record<string, number> = res.warnings;
  if (bad.length) warnings["not ready after 10s: " + bad.slice(0, 3).join("; ")] = bad.length;

  const rasterList: { name: string; x: number; y: number; w: number; h: number; reason: string }[] = [];
  const fixFill = async (f: any) => {
    if (f.type !== "image") return f;
    if (f.tile) {
      const r = await renderTile(f.tile);
      return { type: "image", ref: r.ref, scaleMode: "TILE", scalingFactor: r.scalingFactor };
    }
    const l = await loadSrc(f.src);
    if (l.kind === "raster") return { type: "image", ref: l.ref, scaleMode: f.scaleMode, ...(f.scalingFactor != null ? { scalingFactor: f.scalingFactor } : {}) };
    warnings["background-image dropped: " + (l.kind === "svg" ? "svg" : l.why)] = (warnings["background-image dropped"] ?? 0) + 1;
    return null;
  };
  const background = (await Promise.all(res.background.map(fixFill))).filter(Boolean);

  // Turns one page node into the IR nodes it becomes: fills resolved to assets, rasters screenshotted, groups recursed.
  const proc = async (n: any): Promise<any[]> => {
    if (n.type === "rect") {
      n.fills = (await Promise.all(n.fills.map(fixFill))).filter(Boolean);
      if (!n.fills.length && !n.stroke && !n.effects?.length) return [];
      return [n];
    }
    if (n.type === "group") {
      const kids: any[] = [];
      for (let i = 0; i < n.children.length; i++) {
        const out = await proc(n.children[i]);
        if (i === 0 && n.mask && !out.length) {
          n.mask = false;
          warnings["mask shape dropped (its image is an svg or failed to load): content drawn unmasked"] = (warnings["mask shape dropped (its image is an svg or failed to load): content drawn unmasked"] ?? 0) + 1;
        }
        kids.push(...out);
      }
      if (!kids.length) return [];
      n.children = kids;
      return [n];
    }
    if (n.type === "image") {
      if (n.rasterEl != null) {
        await page.evaluate(({ el, mode }) => {
          const w = window as any;
          const target = w.__fxEls[el] as HTMLElement;
          const sec = document.querySelector("deck-stage > section[data-deck-active]") as HTMLElement;
          const st = document.querySelector("deck-stage") as any;
          const undo: [Element, string | null][] = [];
          const put = (e: Element, props: Record<string, string>) => {
            undo.push([e, e.getAttribute("style")]);
            for (const k in props) (e as HTMLElement).style.setProperty(k, props[k], "important");
          };
          const kids = (e: Element): Element[] => {
            const out: Element[] = [];
            const add = (n: Node) => {
              if (n.nodeType !== 1) return;
              if ((n as Element).localName === "slot") { const a = (n as HTMLSlotElement).assignedNodes({ flatten: true }); (a.length ? a : [...n.childNodes]).forEach(add); }
              else out.push(n as Element);
            };
            (e.shadowRoot ?? e).childNodes.forEach(add);
            return out;
          };
          const hideBelow = (e: Element) => kids(e).forEach((c) => { put(c, { visibility: "hidden" }); hideBelow(c); });
          let iso: HTMLStyleElement | null = null;
          if (mode === "composite" || mode === "backdrop") {
            // keep the page as painted (the effect needs what is behind it) but drop everything after the target in tree order
            let seen = false;
            const dfs = (e: Element) => {
              if (e === target) { seen = true; if (mode === "backdrop") hideBelow(e); return; }
              if (seen) put(e, { visibility: "hidden" });
              kids(e).forEach(dfs);
            };
            dfs(sec);
          } else {
            put(sec, { visibility: "hidden", background: "transparent" });
            put(target, { visibility: "visible" });
            for (const e of [document.documentElement, document.body, st]) put(e, { background: "transparent" });
            iso = document.createElement("style");
            iso.textContent = ".stage,.canvas,:host{background:transparent!important}";
            st.shadowRoot.appendChild(iso);
          }
          w.__fxRestore = () => {
            iso?.remove();
            for (const [e, v] of undo.reverse()) v == null ? e.removeAttribute("style") : e.setAttribute("style", v);
          };
        }, { el: n.rasterEl, mode: n.rasterMode ?? "isolate" });
        const png = await page.screenshot({ clip: { x: n.x, y: n.y, width: n.w, height: n.h }, omitBackground: true });
        await page.evaluate(() => (window as any).__fxRestore());
        n.ref = writeAsset(new Uint8Array(png), "png");
        n.opacity = 1;
        rasterList.push({ name: n.name, x: n.x, y: n.y, w: n.w, h: n.h, reason: n.rasterWhy ?? n.name.slice(7) });
        delete n.rasterEl;
        delete n.rasterMode;
        delete n.rasterWhy;
        delete n.src;
        return [n];
      }
      const l = await loadSrc(n.src);
      if (l.kind === "raster") {
        n.ref = l.ref;
        delete n.src;
        return [n];
      }
      if (l.kind === "svg") return [{ type: "svg", name: n.name, x: n.x, y: n.y, w: n.w, h: n.h, svg: fitSvg(l.text, n.w, n.h, n.scaleMode), opacity: n.opacity, ...(n.effects ? { effects: n.effects } : {}), ...(n.blendMode ? { blendMode: n.blendMode } : {}), ...(n.rotation ? { rotation: n.rotation } : {}) }];
      warnings["image dropped: " + l.why] = (warnings["image dropped: " + l.why] ?? 0) + 1;
      return [];
    }
    return [n];
  };
  const nodes: any[] = [];
  for (const n of res.nodes) nodes.push(...(await proc(n)));

  const ir = { index: idx, label: res.label, width: 1920, height: 1080, background, nodes };
  writeFileSync(join(outDir, `slide-${nnn}.json`), JSON.stringify(ir, null, 1));
  const counts: Record<string, number> = {};
  const fx: Record<string, number> = {};
  const walk = (list: any[]) => {
    for (const n of list) {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      for (const e of n.effects ?? []) fx["effect:" + e.type] = (fx["effect:" + e.type] ?? 0) + 1;
      if (n.blendMode && n.blendMode !== "NORMAL") fx["blendMode"] = (fx["blendMode"] ?? 0) + 1;
      if (n.rotation) fx["rotation"] = (fx["rotation"] ?? 0) + 1;
      if (n.filters) fx["imageFilters"] = (fx["imageFilters"] ?? 0) + 1;
      if (n.mask) fx["mask"] = (fx["mask"] ?? 0) + 1;
      for (const f of n.fills ?? []) if (f.scaleMode === "TILE") fx["tileFill"] = (fx["tileFill"] ?? 0) + 1;
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rasters = rasterList.length;
  report[nnn] = { index: idx, label: res.label, total, counts, native: fx, rasters, rasterList, scale: res.scale, warnings };
  console.log(`slide-${nnn} [${idx}] "${res.label}": ${total} nodes ${JSON.stringify(counts)}${Object.keys(fx).length ? " " + JSON.stringify(fx) : ""}${rasters ? ` (${rasters} raster: ${[...new Set(rasterList.map((r) => r.reason))].join("; ")})` : ""}`);
  for (const [w, c] of Object.entries(warnings)) console.log(`    warn x${c}: ${w}`);
}
writeFileSync(reportPath, JSON.stringify(report, null, 1));
for (const c of tileCtx.values()) await c.close();
await browser.close();
server.stop();
