// Pure mapping maths shared by the Figma plugin (plugin/src/code.ts) and the superseded use_figma
// generator (build.ts). No node:* imports and no Figma globals: this file is bundled into the plugin
// and imported by bun tests. Moved verbatim from build.ts (tested in build.test.ts), plus the
// helpers the plugin needs (CSS colour parsing, radius clamping, font style selection).
//
// Sandbox syntax rule: no optional chaining, no nullish coalescing, no optional catch binding,
// so the bundle runs in Figma's plugin sandbox without down-levelling.

export type IRStop = { pos: number; color: string; opacity: number };
export type IRFill =
  | { type: "solid"; color: string; opacity: number }
  | { type: "linear"; angleDeg: number; stops: IRStop[] }
  | { type: "radial"; stops: IRStop[] }
  | { type: "image"; ref: string; scaleMode: "FILL" | "FIT" | "TILE"; scalingFactor?: number; filters?: IRImageFilters };

/** Figma ImageFilters units, -1..1 each. */
export type IRImageFilters = { exposure?: number; contrast?: number; saturation?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number };

/** Effects any node may carry (docs/DECISIONS.md D-008). Detected from computed CSS / SVG filter primitives. */
export type IRNoise = {
  type: "noise"; baseFrequency: number; octaves: number; seed: number;
  /** 0..1, how far the noise moves the colour (transfer slope). */
  amount: number;
  /** Transfer-intercept-derived mean shift; sign picks light or dark noise when the blend does not. May be 0. */
  bias: number;
  blend: string; monochrome: boolean;
};
export type IREffect =
  | IRNoise
  | { type: "drop-shadow" | "inner-shadow"; color: string; opacity: number; x: number; y: number; blur: number; spread: number }
  | { type: "layer-blur" | "background-blur"; radius: number };

/** Fields any node may carry. rotation is degrees clockwise as CSS; x,y,w,h then describe the UNROTATED box. */
export type IRCommon = {
  blendMode?: string; rotation?: number; effects?: IREffect[];
  /** CALIBRATION ONLY (scripts/calibrate-noise.ts): raw Figma noise settings, used instead of any IR noise effect. */
  figmaNoise?: FigmaNoiseRaw;
};

export type IRRun = {
  start: number;
  end: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeightPx: number;
  letterSpacingPx: number;
  color: string;
  colorOpacity: number;
  variation?: { wght?: number; wdth?: number };
  decoration: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
};

export type IRNode = IRNodeBase & IRCommon;
export type IRNodeBase =
  | {
      type: "group"; name: string; x: number; y: number; w: number; h: number;
      /** Paint order, bottom to top. Child x/y are SLIDE-absolute, like every other node. */
      children: IRNode[];
      /** true: the first child is a mask for the rest. */
      mask?: boolean; opacity?: number;
    }
  | {
      type: "rect"; name: string; x: number; y: number; w: number; h: number;
      fills: IRFill[]; radius: [number, number, number, number];
      stroke: { color: string; opacity: number; width: number; align: "INSIDE" } | null;
      opacity: number; clipsContent?: boolean;
    }
  | {
      type: "text"; name: string; x: number; y: number; w: number; h: number;
      characters: string; align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"; wrap: boolean;
      opacity: number; runs: IRRun[];
      /** Character indices where Chrome started each line after the first (ascending, 1..len-1). */
      lines?: number[];
    }
  | { type: "svg"; name: string; x: number; y: number; w: number; h: number; svg: string; opacity: number }
  | {
      type: "image"; name: string; x: number; y: number; w: number; h: number; ref: string;
      scaleMode: "FILL" | "FIT" | "CROP" | "TILE" | "STRETCH"; scalingFactor?: number; filters?: IRImageFilters;
      opacity: number; radius: [number, number, number, number];
    };

/**
 * Figma image-paint mode for an IR image node. STRETCH (the whole bitmap mapped onto the box, distorted when the aspects
 * differ) is Figma CROP with the identity imageTransform: the transform picks the image region shown in the node, and
 * identity is the whole image edge to edge. IR CROP (object-fit none / scale-down) stays FILL as before.
 */
export function imagePaintMode(mode: string): { scaleMode: "FILL" | "FIT" | "TILE" | "CROP"; imageTransform?: number[][] } {
  if (mode === "STRETCH") return { scaleMode: "CROP", imageTransform: [[1, 0, 0], [0, 1, 0]] };
  return { scaleMode: mode === "FIT" ? "FIT" : mode === "TILE" ? "TILE" : "FILL" };
}

export type IRSlide = {
  index: number; label: string; width: number; height: number;
  background: IRFill[]; nodes: IRNode[];
};

export const clean = (n: number): number => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`bad colour "${hex}" (expected #RRGGBB)`);
  const n = parseInt(m[1], 16);
  return { r: clean(((n >> 16) & 255) / 255), g: clean(((n >> 8) & 255) / 255), b: clean((n & 255) / 255) };
}

export type Transform = [[number, number, number], [number, number, number]];

/**
 * CSS linear-gradient angle -> Figma gradientTransform for a box of w x h pixels.
 *
 * Figma convention (matches the well-known identity = left-to-right and
 * [[0,1,0],[-1,0,1]] = top-to-bottom): the matrix maps a point in the node's normalised
 * (0..1) box into gradient space, where the gradient runs from x'=0 to x'=1 at y'=0.5.
 * CSS: 0deg points up, 90deg right, 180deg down; the gradient line has length
 * |w sin| + |h cos| and is centred on the box.
 */
export function linearGradientTransform(angleDeg: number, w: number, h: number): Transform {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const L = Math.abs(w * dx) + Math.abs(h * dy);
  if (!(L > 0)) return [[1, 0, 0], [0, 1, 0]];
  const nx = -dy;
  const ny = dx;
  return [
    [clean((w * dx) / L), clean((h * dy) / L), clean(0.5 - ((w / 2) * dx + (h / 2) * dy) / L)],
    [clean((w * nx) / L), clean((h * ny) / L), clean(0.5 - ((w / 2) * nx + (h / 2) * ny) / L)],
  ];
}

/** CSS default radial-gradient is a farthest-corner ellipse centred in the box. */
export function radialGradientTransform(): Transform {
  const s = 1 / Math.SQRT2;
  const c = clean(0.5 - 0.5 * s);
  return [[clean(s), 0, c], [0, clean(s), c]];
}

export type FigmaPaint =
  | { type: "SOLID"; color: { r: number; g: number; b: number }; opacity?: number }
  | {
      type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL";
      gradientStops: { position: number; color: { r: number; g: number; b: number; a: number } }[];
      gradientTransform: Transform;
    }
  | { type: "IMAGE"; imageRef: string; scaleMode: "FILL" | "FIT" | "TILE"; scalingFactor?: number; filters?: IRImageFilters };

function stopsOf(stops: IRStop[]) {
  if (!stops || stops.length < 2) throw new Error("gradient needs at least 2 stops");
  return stops.map((s) => ({
    position: clean(Math.min(1, Math.max(0, s.pos))),
    color: { ...hexToRgb(s.color), a: clean(s.opacity === undefined || s.opacity === null ? 1 : s.opacity) },
  }));
}

/** IR Fill -> Figma paint descriptor. Image paints keep `imageRef`; the slide script swaps in the hash. */
export function fillToPaint(fill: IRFill, w: number, h: number): FigmaPaint {
  switch (fill.type) {
    case "solid": {
      const p: FigmaPaint = { type: "SOLID", color: hexToRgb(fill.color) };
      if (fill.opacity !== undefined && fill.opacity < 1) p.opacity = clean(fill.opacity);
      return p;
    }
    case "linear":
      return { type: "GRADIENT_LINEAR", gradientStops: stopsOf(fill.stops), gradientTransform: linearGradientTransform(fill.angleDeg, w, h) };
    case "radial":
      return { type: "GRADIENT_RADIAL", gradientStops: stopsOf(fill.stops), gradientTransform: radialGradientTransform() };
    case "image": {
      const p: FigmaPaint = { type: "IMAGE", imageRef: fill.ref, scaleMode: fill.scaleMode === "FIT" ? "FIT" : fill.scaleMode === "TILE" ? "TILE" : "FILL" };
      if (p.scaleMode === "TILE" && fill.scalingFactor !== undefined) p.scalingFactor = tileFactor(fill.scalingFactor);
      const f = cleanImageFilters(fill.filters);
      if (f) p.filters = f;
      return p;
    }
    default:
      throw new Error(`unknown fill type ${(fill as { type: string }).type}`);
  }
}

/**
 * Turns possibly messy runs into a clean, gapless, non-overlapping partition of [0, len).
 * Later runs win on overlap. Gaps take the previous run's style (leading gap: the next run's).
 * Adjacent runs with identical style are merged. Indexes are clamped to the string.
 */
export function normalizeRuns<T extends { start: number; end: number }>(len: number, runs: T[]): T[] {
  if (len <= 0 || !runs || runs.length === 0) return [];
  const owner = new Array<number>(len).fill(-1);
  runs.forEach((r, i) => {
    const s = Math.max(0, Math.floor(r.start));
    const e = Math.min(len, Math.floor(r.end));
    for (let c = s; c < e; c++) owner[c] = i;
  });
  let prev = -1;
  for (let c = 0; c < len; c++) {
    if (owner[c] >= 0) prev = owner[c];
    else if (prev >= 0) owner[c] = prev;
  }
  let next = -1;
  for (let c = len - 1; c >= 0; c--) {
    if (owner[c] >= 0) next = owner[c];
    else if (next >= 0) owner[c] = next;
  }
  if (owner[0] < 0) return [];
  const styleOf = (i: number) => {
    const { start: _s, end: _e, ...rest } = runs[i];
    return JSON.stringify(rest);
  };
  const out: T[] = [];
  let segStart = 0;
  for (let c = 1; c <= len; c++) {
    if (c === len || styleOf(owner[c]) !== styleOf(owner[segStart])) {
      out.push({ ...runs[owner[segStart]], start: segStart, end: c });
      segStart = c;
    }
  }
  return out;
}


// ---------------------------------------------------------------------------------------------
// Added for the plugin
// ---------------------------------------------------------------------------------------------

export type RGBA = { r: number; g: number; b: number; a: number };

/** CSS colour string -> {r,g,b,a} in 0..1. Accepts #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space form), transparent. */
export function parseCssColor(input: string): RGBA {
  const s = String(input).trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) throw new Error('bad colour "' + input + '"');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: clean(((n >> 16) & 255) / 255), g: clean(((n >> 8) & 255) / 255), b: clean((n & 255) / 255), a: clean(a) };
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) throw new Error('bad colour "' + input + '"');
    const ch = (t: string) => {
      const v = t.endsWith("%") ? (parseFloat(t) / 100) * 255 : parseFloat(t);
      if (!isFinite(v)) throw new Error('bad colour "' + input + '"');
      return clean(Math.min(255, Math.max(0, v)) / 255);
    };
    let a = 1;
    if (parts.length === 4) {
      const t = parts[3];
      a = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
      if (!isFinite(a)) throw new Error('bad colour "' + input + '"');
      a = Math.min(1, Math.max(0, a));
    }
    return { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: clean(a) };
  }
  throw new Error('bad colour "' + input + '"');
}

/** {r,g,b} 0..1 -> "#RRGGBB". */
export function rgbToHex(c: { r: number; g: number; b: number }): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** Per-corner radius [tl,tr,br,bl], each clamped to half the shorter side (CSS clamps; Figma may not). */
export function clampRadii(radius: number[] | undefined, w: number, h: number): [number, number, number, number] {
  const max = Math.max(0, Math.min(w, h) / 2);
  const r = radius && radius.length === 4 ? radius : [0, 0, 0, 0];
  const f = (v: number) => clean(Math.min(max, Math.max(0, isFinite(v) ? v : 0)));
  return [f(r[0]), f(r[1]), f(r[2]), f(r[3])];
}

/** Text run grouping: clean partition of [0,len) (see normalizeRuns). Alias with the name the plugin uses. */
export const groupRuns = normalizeRuns;

export const LINE_SEP = "\u2028";

/** Valid pin indices: integers in 1..len-1, ascending, no repeats. Anything else is dropped. */
export function cleanLines(len: number, lines: number[] | undefined): number[] {
  const out: number[] = [];
  if (!lines) return out;
  for (const v of lines) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= len - 1 && (out.length === 0 || v > out[out.length - 1])) out.push(v);
  }
  return out;
}

/**
 * Inserts U+2028 before each pinned index (D-007) and moves the run indices with the characters. A run
 * that starts at a pin owns the separator in front of it, so styles stay contiguous and on the right text.
 */
export function pinLines<T extends { start: number; end: number }>(characters: string, runs: T[], lines: number[] | undefined): { characters: string; runs: T[] } {
  const pins = cleanLines(characters.length, lines);
  if (pins.length === 0) return { characters, runs };
  const before = (i: number) => {
    let c = 0;
    for (const p of pins) if (p < i) c++;
    return c;
  };
  let out = "";
  let last = 0;
  for (const p of pins) {
    out += characters.slice(last, p) + LINE_SEP;
    last = p;
  }
  out += characters.slice(last);
  return { characters: out, runs: runs.map((r) => ({ ...r, start: r.start + before(r.start), end: r.end + before(r.end) })) };
}

const WEIGHT_WORDS: [RegExp, number][] = [
  [/^(thin|hairline)/, 100],
  [/^(extralight|ultralight)/, 200],
  [/^(light)/, 300],
  [/^(regular|normal|book|roman|text)/, 400],
  [/^(medium)/, 500],
  [/^(semibold|demibold|demi)/, 600],
  [/^(extrabold|ultrabold)/, 800],
  [/^(bold)/, 700],
  [/^(black|heavy)/, 900],
];

/** A Figma style name ("Semi Bold Italic") -> numeric weight and italic flag. Unknown words count as Regular 400. */
export function parseStyleName(style: string): { weight: number; italic: boolean } {
  const flat = String(style).toLowerCase().replace(/[\s_-]+/g, "");
  const italic = /italic|oblique/.test(flat);
  const base = flat.replace(/italic|oblique/g, "");
  if (base === "") return { weight: 400, italic };
  for (const [re, w] of WEIGHT_WORDS) if (re.test(base)) return { weight: w, italic };
  const num = /(\d{3,4})/.exec(base);
  if (num) return { weight: parseInt(num[1], 10), italic };
  return { weight: 400, italic };
}

/**
 * Pick the style of one family nearest to a wanted weight and italic. Italic is preferred when asked
 * for but falls back to upright when the family has no italic; ties go to the lighter style.
 * Returns null only when the family has no styles at all.
 */
export function selectFontStyle(styles: string[], weight: number, italic: boolean): string | null {
  if (!styles || styles.length === 0) return null;
  const parsed = styles.map((s) => ({ s, ...parseStyleName(s) }));
  const pool = italic && parsed.some((p) => p.italic) ? parsed.filter((p) => p.italic) : parsed.filter((p) => !p.italic);
  const use = pool.length ? pool : parsed;
  let best = use[0];
  for (const p of use) {
    const d = Math.abs(p.weight - weight);
    const bd = Math.abs(best.weight - weight);
    if (d < bd || (d === bd && p.weight < best.weight)) best = p;
  }
  return best.s;
}

// Many families ship width cuts as separately named styles ("WD Bold", "Condensed Medium",
// "Extended Black"). Each style gets a nominal width from its name; the picker keeps the styles whose
// width is nearest the run's wdth (100 when none), then matches weight with the width words removed.
const WIDTH_WORDS: [RegExp, number][] = [
  [/\b(ultra|extra)[\s-]?(condensed|compressed|narrow)\b/i, 62.5],
  [/\b(condensed|compressed|narrow|cond|cn)\b/i, 75],
  [/\b(semi[\s-]?condensed)\b/i, 87.5],
  [/\b(semi[\s-]?(expanded|extended))\b/i, 112.5],
  [/\b(ultra|extra)[\s-]?(expanded|extended|wide)\b/i, 150],
  [/\b(expanded|extended|wide|wd|ext)\b/i, 125],
];
export function styleWidth(style: string): number {
  for (const [re, w] of WIDTH_WORDS) if (re.test(style)) return w;
  return 100;
}
function stripWidth(style: string): string {
  let out = style;
  for (const [re] of WIDTH_WORDS) out = out.replace(new RegExp(re.source, "gi"), " ");
  return out.replace(/\s+/g, " ").trim();
}
export function pickStyle(styles: string[], weight: number, italic: boolean, wdth: number | null): string {
  const want = wdth === null ? 100 : wdth;
  let bestGap = Infinity;
  for (const s of styles) bestGap = Math.min(bestGap, Math.abs(styleWidth(s) - want));
  const pool = styles.filter((s) => Math.abs(styleWidth(s) - want) === bestGap);
  const bare = pool.map(stripWidth);
  const chosen = selectFontStyle(bare, weight, italic);
  const i = chosen === null ? 0 : bare.indexOf(chosen);
  return pool[i < 0 ? 0 : i];
}

/** Compact paint tag used in plugin reports: "#RRGGBB@opacity" for solids, the paint type otherwise. */
export function paintTag(p: { type: string; color?: { r: number; g: number; b: number }; opacity?: number; visible?: boolean }): string {
  if (p.type === "SOLID" && p.color) {
    const o = p.opacity === undefined ? 1 : p.opacity;
    return rgbToHex(p.color) + "@" + String(Math.round(o * 1000) / 1000);
  }
  return p.type === "IMAGE" ? "IMAGE" : p.type;
}

// ---------------------------------------------------------------------------------------------
// Blend modes, rotation, image filters, effects (D-008)
// ---------------------------------------------------------------------------------------------

export const BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
  "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
];

/** IR blend name (any case, "-" or space for "_") -> Figma BlendMode, or null when it is not one. */
export function blendModeOf(s: string | undefined | null): string | null {
  if (typeof s !== "string") return null;
  const k = s.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return BLEND_MODES.indexOf(k) >= 0 ? k : null;
}

export function tileFactor(v: number): number {
  return typeof v === "number" && isFinite(v) && v > 0 ? clean(v) : 1;
}

const FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
/** Keeps only Figma's seven image filters, clamped to -1..1; null when none is non-zero. */
export function cleanImageFilters(f: IRImageFilters | undefined | null): IRImageFilters | null {
  if (!f || typeof f !== "object") return null;
  const out: { [k: string]: number } = {};
  let any = false;
  for (const k of FILTER_KEYS) {
    const v = (f as { [k: string]: unknown })[k];
    if (typeof v === "number" && isFinite(v)) {
      out[k] = clean(Math.min(1, Math.max(-1, v)));
      if (out[k] !== 0) any = true;
    }
  }
  return any ? (out as IRImageFilters) : null;
}

/**
 * relativeTransform for a w x h box whose UNROTATED top-left is (x,y), turned `deg` degrees clockwise (CSS) about
 * its centre. y runs down, so clockwise is [[cos,-sin],[sin,cos]]; the translation keeps the centre where it was.
 */
export function rotationTransform(x: number, y: number, w: number, h: number, deg: number): Transform {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [
    [clean(c), clean(-s), clean(cx - (c * (w / 2) - s * (h / 2)))],
    [clean(s), clean(c), clean(cy - (s * (w / 2) + c * (h / 2)))],
  ];
}

/**
 * Transform for a node whose built size (nodeW x nodeH) may differ from its IR box (text: Figma measures its own
 * width). The IR box turns about its own centre. The node sits inside that unrotated box anchored as CSS lays it out:
 * text on its aligned edge and its top, anything else centred. Centring text instead would move a left-aligned
 * label sideways by half the width difference.
 */
export function placeRotated(box: { x: number; y: number; w: number; h: number }, nodeW: number, nodeH: number, deg: number, textAlign?: string): Transform {
  const left = textAlign === undefined ? box.x + (box.w - nodeW) / 2
    : textAlign === "RIGHT" ? box.x + box.w - nodeW
    : textAlign === "CENTER" ? box.x + (box.w - nodeW) / 2
    : box.x;
  const top = textAlign === undefined ? box.y + (box.h - nodeH) / 2 : box.y;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = left + nodeW / 2 - cx, dy = top + nodeH / 2 - cy;
  const rx = cx + c * dx - s * dy, ry = cy + s * dx + c * dy;
  return rotationTransform(rx - nodeW / 2, ry - nodeH / 2, nodeW, nodeH, deg);
}

/** Inverse of placeRotated: the node's unrotated top-left inside the frame of the IR box it was turned with. */
export function unrotatedIn(t: Transform, nodeW: number, nodeH: number, box: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  const tb = transformBox(t, nodeW, nodeH);
  const a = (tb.deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = tb.x + nodeW / 2 - cx, dy = tb.y + nodeH / 2 - cy;
  return { x: clean(cx + c * dx + s * dy - nodeW / 2), y: clean(cy - s * dx + c * dy - nodeH / 2) };
}

/** The unrotated top-left and the clockwise angle (degrees) a relativeTransform stands for. */
export function transformBox(t: Transform, w: number, h: number): { x: number; y: number; deg: number } {
  const cx = t[0][0] * (w / 2) + t[0][1] * (h / 2) + t[0][2];
  const cy = t[1][0] * (w / 2) + t[1][1] * (h / 2) + t[1][2];
  return { x: clean(cx - w / 2), y: clean(cy - h / 2), deg: clean((Math.atan2(t[1][0], t[0][0]) * 180) / Math.PI) };
}

/**
 * CSS blur() takes a standard deviation; Figma's blur radius is twice that. UNVERIFIED in live Figma: the first
 * live run of a layer-blur / background-blur node must confirm it (scripts/noise-calibration.json is only noise).
 */
export const BLUR_SCALE = 2;

export type NoiseCalibration = {
  /** "uncalibrated" = principled first guess; "calibrated" = written by scripts/calibrate-noise.ts from a live Figma run. */
  status: string;
  /** IR baseFrequency (cycles per px) -> Figma noiseSize (px). Piecewise linear, clamped at the ends. */
  size: { baseFrequency: number; noiseSize: number }[];
  /** IR amount (0..1) -> Figma density (0..1) and colour alpha (0..1). Piecewise linear, clamped at the ends. */
  strength: { amount: number; density: number; alpha: number }[];
};

/** Piecewise-linear lookup through anchor points sorted by `key`; clamped outside the table. */
export function interp1<T extends { [k: string]: number }>(points: T[], key: keyof T & string, x: number, field: keyof T & string): number {
  if (!points || points.length === 0) throw new Error("empty calibration table");
  const pts = points.slice().sort((a, b) => a[key] - b[key]);
  if (!isFinite(x) || x <= pts[0][key]) return pts[0][field];
  const last = pts[pts.length - 1];
  if (x >= last[key]) return last[field];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][key]) {
      const lo = pts[i - 1];
      const hi = pts[i];
      const span = hi[key] - lo[key];
      const t = span > 0 ? (x - lo[key]) / span : 0;
      return lo[field] + (hi[field] - lo[field]) * t;
    }
  }
  return last[field];
}

export type FigmaNoiseRaw = {
  noiseSize: number; density: number; alpha: number;
  noiseType?: "MONOTONE" | "DUOTONE" | "MULTITONE"; color?: string; blendMode?: string;
};
export type FigmaColor = { r: number; g: number; b: number; a: number };
export type FigmaEffect = { [k: string]: unknown; type: string };

const rgba = (hex: string, a: number): FigmaColor => ({ ...hexToRgb(hex), a: clean(Math.min(1, Math.max(0, a))) });
const unit = (v: number) => clean(Math.min(1, Math.max(0, v)));

/** Raw Figma noise settings (calibration slides) -> a NOISE effect. */
export function rawNoiseToFigma(f: FigmaNoiseRaw): FigmaEffect {
  const noiseType = f.noiseType || "MONOTONE";
  const color = rgba(f.color || "#000000", noiseType === "MULTITONE" ? 1 : f.alpha);
  const out: FigmaEffect = {
    type: "NOISE", noiseType, color,
    noiseSize: clean(Math.max(0.01, f.noiseSize)), density: unit(f.density), visible: true,
  };
  // Real Figma (2026-10-24) rejects blendMode on NOISE ("Unrecognized key"), though the docs list it. The IR blend
  // only picks the noise colour (see noiseToFigma).
  if (noiseType === "MULTITONE") out.opacity = unit(f.alpha);
  if (noiseType === "DUOTONE") out.secondaryColor = rgba("#ffffff", f.alpha);
  return out;
}

const DARKENING = ["MULTIPLY", "DARKEN", "COLOR_BURN", "LINEAR_BURN"];
const LIGHTENING = ["SCREEN", "LIGHTEN", "COLOR_DODGE", "LINEAR_DODGE"];

/**
 * IR grain parameters -> Figma NOISE effect through the calibration table. Size comes from the feTurbulence
 * frequency, density and colour alpha from the amount; the noise colour is black for darkening blends, white for
 * lightening ones, else by the sign of the bias.
 */
export function noiseToFigma(e: IRNoise, calib: NoiseCalibration): FigmaEffect {
  const blend = blendModeOf(e.blend) || "NORMAL";
  const raw: FigmaNoiseRaw = {
    noiseSize: interp1(calib.size, "baseFrequency", e.baseFrequency, "noiseSize"),
    density: interp1(calib.strength, "amount", e.amount, "density"),
    alpha: interp1(calib.strength, "amount", e.amount, "alpha"),
    noiseType: e.monochrome === false ? "MULTITONE" : "MONOTONE",
    color: DARKENING.indexOf(blend) >= 0 ? "#000000" : LIGHTENING.indexOf(blend) >= 0 ? "#ffffff" : e.bias > 0 ? "#ffffff" : "#000000",
    blendMode: blend,
  };
  return rawNoiseToFigma(raw);
}

/**
 * One IR effect -> a Figma Effect. `spreadOk` says whether this node accepts shadow spread (rectangles, ellipses, or
 * clipping frames with a fill); when it does not a non-zero spread is dropped and `note` says so.
 */
export function effectToFigma(e: IREffect, calib: NoiseCalibration, spreadOk: boolean): { effect: FigmaEffect | null; note?: string } {
  switch (e.type) {
    case "noise":
      return { effect: noiseToFigma(e, calib) };
    case "drop-shadow":
    case "inner-shadow": {
      const fx: FigmaEffect = {
        type: e.type === "drop-shadow" ? "DROP_SHADOW" : "INNER_SHADOW",
        color: rgba(e.color, e.opacity),
        offset: { x: clean(e.x), y: clean(e.y) },
        radius: clean(Math.max(0, e.blur)),
        visible: true,
        blendMode: "NORMAL",
      };
      let note: string | undefined;
      if (e.spread) {
        if (spreadOk) fx.spread = clean(e.spread);
        else note = e.type + " spread " + e.spread + " dropped: this node type does not accept spread";
      }
      return { effect: fx, note };
    }
    case "layer-blur":
    case "background-blur":
      return { effect: { type: e.type === "layer-blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR", blurType: "NORMAL", radius: clean(Math.max(0, e.radius) * BLUR_SCALE), visible: true } };
    default:
      return { effect: null, note: "unknown effect type " + (e as { type: string }).type };
  }
}
