// Calibrates the IR grain -> Figma NOISE mapping (scripts/noise-calibration.json) against real Figma, for any deck.
//
//   bun calibrate-noise.ts ir     --out <dir> [--filter-file <deck file with the grain <filter>>]
//   bun calibrate-noise.ts chrome --out <dir>
//   bun calibrate-noise.ts fit    --out <dir> --shots <dir with slide-1001.png...> [--write scripts/noise-calibration.json]
//   bun calibrate-noise.ts all    --out <dir> [--filter-file f]          (ir + chrome)
//
// Live run (never on the deck's own bridge; use a second port and a separate out dir):
//   1. bun calibrate-noise.ts all --out /tmp/cal
//   2. bun serve.ts --ir /tmp/cal/ir --out /tmp/cal/out --port 4748     (plugin pointed at that port)
//   3. bun serve.ts enqueue --kind build --slides 1000,1001,1002,1003,1004,1005 --scale 1 --port 4748
//   4. bun calibrate-noise.ts fit --out /tmp/cal --shots /tmp/cal/out/shots --write noise-calibration.json
//   5. bun serve.ts enqueue --kind remove --slides 1000,1001,1002,1003,1004,1005 --port 4748
//
// What it does:
//   ir      writes calibration IR slides (indices 1000+). Per gradient field (dark, light, saturated) and per noise
//           colour (black, white) one slide of tiles: the same field with a different raw Figma noise setting
//           (noiseSize x density x alpha) in the CALIBRATION-ONLY node field `figmaNoise`, which the plugin honours
//           instead of any IR noise effect. Tile 0 of every slide is the field with no noise (the baseline).
//   chrome  renders, in headless Chrome, the same fields through grain SVG filters: the deck's own <filter> verbatim
//           when --filter-file is given, plus a sweep of synthesised feTurbulence filters (frequency x amount x blend)
//           so the table covers parameters this deck does not use.
//   fit     measures every tile (mean shift, high-pass std-dev, neighbour-difference "spatial frequency") against the
//           Chrome tile of each filter, picks the Figma setting with the smallest cost per filter and field, then
//           writes two small tables: baseFrequency -> noiseSize and amount -> density, alpha.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------------------------------------
// PNG codec (8-bit, non-interlaced). Enough for Chrome and Figma exports.
// ---------------------------------------------------------------------------------------------

export type Img = { w: number; h: number; data: Uint8Array }; // RGBA

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img: Img): Uint8Array {
  const { w, h, data } = img;
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function decodePng(bytes: Uint8Array): Img {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  let plte: Uint8Array | null = null;
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12);
      depth = bytes[pos + 16]!; ctype = bytes[pos + 17]!; interlace = bytes[pos + 20]!;
    } else if (type === "PLTE") plte = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG not supported");
  if (depth !== 8 && depth !== 16) throw new Error("PNG bit depth " + depth + " not supported");
  const chans = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
  const bpp = chans * (depth / 8);
  const stride = w * bpp;
  const inf = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = inf[y * (stride + 1)]!;
    const src = inf.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp]! : 0;
      let v = src[i]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + i] = v & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  const step = depth / 8;
  for (let i = 0; i < w * h; i++) {
    const o = i * bpp;
    let r: number, g: number, b: number, a = 255;
    if (ctype === 0) r = g = b = px[o]!;
    else if (ctype === 4) { r = g = b = px[o]!; a = px[o + step]!; }
    else if (ctype === 3) { const k = px[o]! * 3; r = plte![k]!; g = plte![k + 1]!; b = plte![k + 2]!; }
    else { r = px[o]!; g = px[o + step]!; b = px[o + 2 * step]!; if (ctype === 6) a = px[o + 3 * step]!; }
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { w, h, data };
}

export function crop(img: Img, x: number, y: number, w: number, h: number): Img {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.w + x) * 4, ((y + r) * img.w + x + w) * 4), r * w * 4);
  return { w, h, data: out };
}

// ---------------------------------------------------------------------------------------------
// Measuring a tile
// ---------------------------------------------------------------------------------------------

export type Metrics = {
  /** Mean luma, 0..1. */
  mean: number;
  /** Std-dev of luma after removing a local mean (9x9 box), 0..1: the noise amplitude, gradient excluded. */
  std: number;
  /** Mean absolute difference between neighbouring pixels (x and y), 0..1: the spatial-frequency proxy. */
  hf: number;
};

function lumaPlane(img: Img, inset: number): { l: Float64Array; w: number; h: number } {
  const w = img.w - 2 * inset, h = img.h - 2 * inset;
  const l = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = ((y + inset) * img.w + x + inset) * 4;
      l[y * w + x] = (0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!) / 255;
    }
  return { l, w, h };
}

export function measure(img: Img, inset = 6): Metrics {
  const { l, w, h } = lumaPlane(img, inset);
  const n = w * h;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += l[i]!;
  // local mean through an integral image
  const R = 4;
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += l[y * w + x]!;
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1]! + row;
    }
  }
  let ss = 0, cnt = 0;
  for (let y = R; y < h - R; y++)
    for (let x = R; x < w - R; x++) {
      const a = I[(y + R + 1) * (w + 1) + x + R + 1]! - I[(y - R) * (w + 1) + x + R + 1]! - I[(y + R + 1) * (w + 1) + x - R]! + I[(y - R) * (w + 1) + x - R]!;
      const d = l[y * w + x]! - a / ((2 * R + 1) * (2 * R + 1));
      ss += d * d;
      cnt++;
    }
  let diff = 0, dn = 0;
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      diff += Math.abs(l[y * w + x + 1]! - l[y * w + x]!) + Math.abs(l[(y + 1) * w + x]! - l[y * w + x]!);
      dn += 2;
    }
  return { mean: sum / n, std: Math.sqrt(ss / Math.max(1, cnt)), hf: diff / Math.max(1, dn) };
}

/**
 * Distance between a Figma tile and a Chrome tile, both relative to their own baseline mean. Each term is the
 * difference over the Chrome value (floored, because real deck grain is subtle: std-dev of 0.003 to 0.01).
 */
export const COST_FLOOR = 0.0015;
export const COST_REL = 0.25;
export function cost(figma: { shift: number; std: number; hf: number }, chrome: { shift: number; std: number; hf: number }): number {
  const term = (f: number, c: number) => Math.abs(f - c) / Math.max(COST_FLOOR, COST_REL * Math.abs(c));
  return term(figma.shift, chrome.shift) + term(figma.std, chrome.std) + term(figma.hf, chrome.hf);
}

// ---------------------------------------------------------------------------------------------
// Grain specs and the Chrome filters
// ---------------------------------------------------------------------------------------------

export type GrainSpec = {
  id: string;
  baseFrequency: number; octaves: number; seed: number;
  amount: number; bias: number; blend: string; monochrome: boolean;
  /** The deck's own <filter> markup (id replaced at render time); absent = synthesised from the numbers. */
  filterSvg?: string;
};

const clean = (n: number) => Math.round(n * 1e6) / 1e6;
const DARK_BLENDS = ["multiply", "darken", "color-burn"];

/**
 * Synthesised grain filter, same shape as a typical deck grain: turbulence -> (desaturate) -> linear transfer ->
 * blend over the source -> clip to the source. Convention for the transfer intercept:
 *   darkening blends (multiply...) intercept = 1 - amount + bias   (noise stays near white, bias lifts it)
 *   lightening blends (screen...)  intercept = bias                (noise stays near black, bias lifts it)
 */
export function grainFilterSvg(id: string, s: GrainSpec): string {
  const icpt = DARK_BLENDS.includes(s.blend) ? 1 - s.amount + s.bias : s.bias;
  const f = (c: string) => `<feFunc${c} type="linear" slope="${s.amount}" intercept="${icpt}"/>`;
  return (
    `<filter id="${id}" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${s.baseFrequency}" numOctaves="${s.octaves}" seed="${s.seed}" result="t"/>` +
    (s.monochrome ? `<feColorMatrix in="t" type="saturate" values="0" result="m"/>` : `<feColorMatrix in="t" type="identity" result="m"/>`) +
    `<feComponentTransfer in="m" result="s">${f("R")}${f("G")}${f("B")}</feComponentTransfer>` +
    `<feBlend in="SourceGraphic" in2="s" mode="${s.blend}" result="b"/><feComposite in="b" in2="SourceGraphic" operator="in"/></filter>`
  );
}

/** Finds the <filter> elements with an feTurbulence in any text (HTML, JS template string, SVG). */
export function extractGrainFilters(text: string): string[] {
  const out: string[] = [];
  const re = /<filter\b[^>]*>[\s\S]*?<\/filter>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (/feTurbulence/.test(m[0])) out.push(m[0]);
  return out;
}

/** Reads grain parameters off a filter's primitives (the same convention grainFilterSvg writes). */
export function parseGrainSpec(id: string, svg: string): GrainSpec {
  const num = (re: RegExp, d: number) => { const m = re.exec(svg); return m ? parseFloat(m[1]!) : d; };
  const blend = (/<feBlend\b[^>]*\bmode="([\w-]+)"/.exec(svg) || [0, "normal"])[1] as string;
  const amount = num(/feFuncR\b[^>]*\bslope="([-\d.]+)"/, 1);
  const intercept = num(/feFuncR\b[^>]*\bintercept="([-\d.]+)"/, 0);
  return {
    id,
    baseFrequency: num(/baseFrequency="([\d.]+)/, 0.5),
    octaves: num(/numOctaves="(\d+)"/, 1),
    seed: num(/seed="([-\d.]+)"/, 0),
    amount,
    bias: clean(DARK_BLENDS.includes(blend) ? intercept - (1 - amount) : intercept),
    blend,
    monochrome: /feColorMatrix[^>]*type="saturate"[^>]*values="0"/.test(svg),
    filterSvg: svg,
  };
}

export const SWEEP = {
  baseFrequencies: [0.2, 0.5, 0.85, 1.5],
  amounts: [0.15, 0.35, 0.5, 0.8],
  // multiply only by default: a lightening sweep is not comparable on one amount scale (see header of fit()).
  blends: ["multiply"],
};

export function sweepSpecs(sw = SWEEP): GrainSpec[] {
  const out: GrainSpec[] = [];
  for (const blend of sw.blends)
    for (const bf of sw.baseFrequencies)
      for (const amount of sw.amounts)
        out.push({ id: `${blend}-f${bf}-a${amount}`, baseFrequency: bf, octaves: 2, seed: 7, amount, bias: clean(0.44 * amount), blend, monochrome: true });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Calibration slides (the IR for Figma)
// ---------------------------------------------------------------------------------------------

export const BASE_INDEX = 1000;
export const TILE = { w: 150, h: 120, gap: 8, cols: 12, rows: 8, x0: 12, y0: 28 };
export const FIELDS = [
  { name: "dark", from: "#0b1020", to: "#243256" },
  { name: "light", from: "#e8ebf2", to: "#fbfbfd" },
  { name: "saturated", from: "#c8102e", to: "#ff7a00" },
];
export const GRID = { noiseSizes: [0.5, 1, 1.5, 2, 3, 4, 6], densities: [0.2, 0.5, 0.8], alphas: [0.1, 0.25, 0.5, 1] };
export const NOISE_COLORS = [
  { name: "black", hex: "#000000" },
  { name: "white", hex: "#ffffff" },
];

export type Setting = { noiseSize: number; density: number; alpha: number };
export type ManifestTile = { id: number; slide: number; field: string; color: string; rect: { x: number; y: number; w: number; h: number }; setting: Setting | null };
export type Manifest = { tile: typeof TILE; fields: typeof FIELDS; slides: { index: number; field: string; color: string }[]; tiles: ManifestTile[] };

const fieldFill = (f: { from: string; to: string }) => ({
  type: "linear" as const, angleDeg: 135,
  stops: [{ pos: 0, color: f.from, opacity: 1 }, { pos: 1, color: f.to, opacity: 1 }],
});

export function settingsGrid(g = GRID): Setting[] {
  const out: Setting[] = [];
  for (const noiseSize of g.noiseSizes) for (const density of g.densities) for (const alpha of g.alphas) out.push({ noiseSize, density, alpha });
  return out;
}

export function buildCalibration(grid = GRID, fields = FIELDS): { slides: any[]; manifest: Manifest } {
  const settings = settingsGrid(grid);
  if (settings.length + 1 > TILE.cols * TILE.rows) throw new Error(`${settings.length + 1} tiles do not fit ${TILE.cols}x${TILE.rows}`);
  const slides: any[] = [];
  const manifest: Manifest = { tile: TILE, fields, slides: [], tiles: [] };
  let index = BASE_INDEX;
  for (const field of fields) {
    for (const color of NOISE_COLORS) {
      const nodes: any[] = [];
      for (let t = 0; t <= settings.length; t++) {
        const col = t % TILE.cols, row = Math.floor(t / TILE.cols);
        const rect = { x: TILE.x0 + col * (TILE.w + TILE.gap), y: TILE.y0 + row * (TILE.h + TILE.gap), w: TILE.w, h: TILE.h };
        const setting = t === 0 ? null : settings[t - 1]!;
        const node: any = { type: "rect", name: `tile ${t}`, ...rect, fills: [fieldFill(field)], radius: [0, 0, 0, 0], stroke: null, opacity: 1 };
        if (setting) node.figmaNoise = { ...setting, noiseType: "MONOTONE", color: color.hex, blendMode: "NORMAL" };
        nodes.push(node);
        manifest.tiles.push({ id: t, slide: index, field: field.name, color: color.name, rect, setting });
      }
      slides.push({ index, label: `noise-cal ${field.name} ${color.name}`, width: 1920, height: 1080, background: [{ type: "solid", color: "#ffffff", opacity: 1 }], nodes });
      manifest.slides.push({ index, field: field.name, color: color.name });
      index++;
    }
  }
  return { slides, manifest };
}

// ---------------------------------------------------------------------------------------------
// Chrome references
// ---------------------------------------------------------------------------------------------

export function chromeHtml(cells: { id: string; css: string; filterId?: string }[], filters: string[]): string {
  const pos = (i: number) => {
    const col = i % TILE.cols, row = Math.floor(i / TILE.cols);
    return `left:${TILE.x0 + col * (TILE.w + TILE.gap)}px;top:${TILE.y0 + row * (TILE.h + TILE.gap)}px`;
  };
  return (
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}div.c{position:absolute;width:${TILE.w}px;height:${TILE.h}px}</style>` +
    `<svg width="0" height="0" style="position:absolute"><defs>${filters.join("")}</defs></svg>` +
    cells.map((c, i) => `<div class="c" id="${c.id}" style="${pos(i)};background:${c.css}${c.filterId ? `;filter:url(#${c.filterId})` : ""}"></div>`).join("")
  );
}

export const cssGradient = (f: { from: string; to: string }) => `linear-gradient(135deg,${f.from},${f.to})`;

/** Renders every field x spec (and each field's baseline) in headless Chrome to <out>/chrome/<field>__<spec|base>.png. */
export async function renderChrome(out: string, specs: GrainSpec[], fields = FIELDS): Promise<string[]> {
  const { chromium } = await import("playwright");
  const dir = join(out, "chrome");
  mkdirSync(dir, { recursive: true });
  const cells: { id: string; file: string; css: string; filterId?: string }[] = [];
  const filters: string[] = [];
  specs.forEach((s, si) => {
    const markup = s.filterSvg ? s.filterSvg.replace(/\bid="[^"]*"/, `id="f${si}"`) : grainFilterSvg(`f${si}`, s);
    filters.push(markup);
  });
  for (const f of fields) {
    cells.push({ id: `${f.name}__base`, file: `${f.name}__base.png`, css: cssGradient(f) });
    specs.forEach((s, si) => cells.push({ id: `${f.name}__${s.id}`, file: `${f.name}__${s.id}.png`, css: cssGradient(f), filterId: `f${si}` }));
  }
  const browser = await chromium.launch({ channel: "chrome" });
  const written: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const per = TILE.cols * TILE.rows;
    for (let at = 0; at < cells.length; at += per) {
      const chunk = cells.slice(at, at + per);
      await page.setContent(chromeHtml(chunk.map((c) => ({ id: c.id.replace(/[^\w-]/g, "_"), css: c.css, filterId: c.filterId })), filters));
      const shot = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
      chunk.forEach((c, i) => {
        const col = i % TILE.cols, row = Math.floor(i / TILE.cols);
        const tile = crop(shot, TILE.x0 + col * (TILE.w + TILE.gap), TILE.y0 + row * (TILE.h + TILE.gap), TILE.w, TILE.h);
        writeFileSync(join(dir, c.file), encodePng(tile));
        written.push(c.file);
      });
    }
  } finally {
    await browser.close();
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------------------------

export type FitInput = {
  manifest: Manifest;
  specs: GrainSpec[];
  /** Chrome tile for a field and a spec id, or "base" for the field without grain. */
  chrome: (field: string, spec: string) => Img;
  /** The Figma export of a calibration slide (1920x1080). */
  figma: (slideIndex: number) => Img;
};
export type SpecFit = { spec: string; field: string; color: string; tile: number; setting: Setting; cost: number };

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

/**
 * A higher feTurbulence frequency is finer grain, so its Figma noise can never be larger than a lower frequency's.
 * Picks at the grid floor are noisy (the first live fit put 1.5 -> 1 above 0.85 -> 0.5); this caps each size by the
 * one before it. Rows must be sorted by baseFrequency.
 */
export function monotoneSize(rows: { baseFrequency: number; noiseSize: number }[]) {
  let cap = Infinity;
  return rows.map((r) => ({ baseFrequency: r.baseFrequency, noiseSize: (cap = Math.min(cap, r.noiseSize)) }));
}

/**
 * Picks, per grain spec and field, the Figma tile with the smallest cost (noise colour chosen by the sign of the
 * Chrome mean shift), then reduces those picks to two tables by the median: baseFrequency -> noiseSize and
 * amount -> density, alpha. The tables assume one amount scale for darkening and lightening grain, which is why
 * the default sweep is darkening (multiply) only.
 */
export function fit(inp: FitInput): { calibration: any; perSpec: SpecFit[] } {
  const { manifest } = inp;
  // Figma metrics for every tile, relative to the baseline tile (id 0) of the same slide.
  const figmaMetrics = new Map<number, { base: Metrics; tiles: { t: ManifestTile; m: Metrics }[] }>();
  for (const sl of manifest.slides) {
    const img = inp.figma(sl.index);
    const tiles = manifest.tiles.filter((t) => t.slide === sl.index);
    const ms = tiles.map((t) => ({ t, m: measure(crop(img, t.rect.x, t.rect.y, t.rect.w, t.rect.h)) }));
    const base = ms.find((x) => x.t.id === 0)!.m;
    figmaMetrics.set(sl.index, { base, tiles: ms.filter((x) => x.t.id !== 0) });
  }
  const perSpec: SpecFit[] = [];
  for (const spec of inp.specs) {
    for (const f of manifest.fields) {
      const cBase = measure(inp.chrome(f.name, "base"));
      const cm = measure(inp.chrome(f.name, spec.id));
      const cRel = { shift: cm.mean - cBase.mean, std: cm.std, hf: cm.hf };
      const color = cRel.shift < -0.002 || Math.abs(cRel.shift) <= 0.002 ? "black" : "white";
      let best: { t: ManifestTile; c: number } | null = null;
      for (const sl of manifest.slides.filter((s) => s.field === f.name && s.color === color)) {
        const fm = figmaMetrics.get(sl.index)!;
        for (const { t, m } of fm.tiles) {
          const c = cost({ shift: m.mean - fm.base.mean, std: m.std, hf: m.hf }, cRel);
          if (!best || c < best.c) best = { t, c };
        }
      }
      if (best) perSpec.push({ spec: spec.id, field: f.name, color, tile: best.t.id, setting: best.t.setting!, cost: best.c });
    }
  }
  // Tables: size by frequency, density and alpha by amount, each the median over everything sharing that key.
  const byId = new Map(inp.specs.map((s) => [s.id, s]));
  const sizeBy = new Map<number, number[]>();
  const strBy = new Map<number, { d: number[]; a: number[] }>();
  for (const r of perSpec) {
    const s = byId.get(r.spec)!;
    if (!sizeBy.has(s.baseFrequency)) sizeBy.set(s.baseFrequency, []);
    sizeBy.get(s.baseFrequency)!.push(r.setting.noiseSize);
    if (!strBy.has(s.amount)) strBy.set(s.amount, { d: [], a: [] });
    strBy.get(s.amount)!.d.push(r.setting.density);
    strBy.get(s.amount)!.a.push(r.setting.alpha);
  }
  const calibration = {
    status: "calibrated",
    note: "Fitted by scripts/calibrate-noise.ts against real Figma exports; see fit for the residual.",
    fittedAt: new Date().toISOString(),
    size: monotoneSize([...sizeBy.entries()].sort((a, b) => a[0] - b[0]).map(([baseFrequency, v]) => ({ baseFrequency, noiseSize: clean(median(v)) }))),
    strength: [...strBy.entries()].sort((a, b) => a[0] - b[0]).map(([amount, v]) => ({ amount, density: clean(median(v.d)), alpha: clean(median(v.a)) })),
    fit: { specs: inp.specs.length, fields: manifest.fields.length, meanCost: clean(perSpec.reduce((n, r) => n + r.cost, 0) / Math.max(1, perSpec.length)) },
  };
  return { calibration, perSpec };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const nnn = (i: number) => String(i + 1).padStart(3, "0");

export function writeIr(out: string, filterFile?: string): { specs: GrainSpec[]; manifest: Manifest } {
  const { slides, manifest } = buildCalibration();
  mkdirSync(join(out, "ir"), { recursive: true });
  for (const s of slides) writeFileSync(join(out, "ir", `slide-${nnn(s.index)}.json`), JSON.stringify(s));
  const specs = sweepSpecs();
  if (filterFile) {
    const found = extractGrainFilters(readFileSync(filterFile, "utf8"));
    if (!found.length) throw new Error(`no <filter> with feTurbulence in ${filterFile}`);
    found.forEach((svg, i) => specs.unshift(parseGrainSpec(`deck${i}`, svg)));
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  writeFileSync(join(out, "specs.json"), JSON.stringify(specs, null, 1));
  return { specs, manifest };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const arg = (n: string) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = resolve(arg("out") || "");
  if (!arg("out") || !["ir", "chrome", "fit", "all"].includes(cmd || "")) {
    console.error("usage: bun calibrate-noise.ts ir|chrome|fit|all --out <dir> [--filter-file f] [--shots dir] [--write file]");
    process.exit(1);
  }
  if (cmd === "ir" || cmd === "all") {
    const { specs, manifest } = writeIr(out, arg("filter-file"));
    console.log(`wrote ${manifest.slides.length} calibration slides (indices ${BASE_INDEX}..${BASE_INDEX + manifest.slides.length - 1}) and ${specs.length} grain specs to ${out}`);
  }
  if (cmd === "chrome" || cmd === "all") {
    const specs: GrainSpec[] = JSON.parse(readFileSync(join(out, "specs.json"), "utf8"));
    const files = await renderChrome(out, specs);
    console.log(`rendered ${files.length} Chrome tiles to ${join(out, "chrome")}`);
  }
  if (cmd === "fit") {
    const shots = arg("shots");
    if (!shots) { console.error("fit needs --shots <dir>"); process.exit(1); }
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const specs: GrainSpec[] = JSON.parse(readFileSync(join(out, "specs.json"), "utf8"));
    for (const s of manifest.slides) if (!existsSync(join(shots, `slide-${nnn(s.index)}.png`))) { console.error(`missing Figma shot slide-${nnn(s.index)}.png in ${shots}`); process.exit(1); }
    const res = fit({
      manifest, specs,
      chrome: (field, spec) => decodePng(new Uint8Array(readFileSync(join(out, "chrome", `${field}__${spec}.png`)))),
      figma: (i) => decodePng(new Uint8Array(readFileSync(join(shots, `slide-${nnn(i)}.png`)))),
    });
    const target = arg("write") ? resolve(arg("write")!) : join(out, "noise-calibration.fitted.json");
    writeFileSync(target, JSON.stringify(res.calibration, null, 2) + "\n");
    writeFileSync(join(out, "fit-detail.json"), JSON.stringify(res.perSpec, null, 1));
    console.log(`wrote ${target}: ${res.calibration.size.length} size anchors, ${res.calibration.strength.length} strength anchors, mean cost ${res.calibration.fit.meanCost}`);
  }
}
