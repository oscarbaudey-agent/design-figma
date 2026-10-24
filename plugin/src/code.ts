// design-figma plugin, main thread. Interprets one IR slide at a time (no eval, no generated code)
// and builds it inside a Figma Slides file. Talks to plugin/ui.html by postMessage:
//   ui -> code  {type:"probe", families}              code -> ui  {type:"probe-result", fonts, axes, editorType}
//   ui -> code  {type:"build", ir, images}            code -> ui  {type:"built", index, report}
//   ui -> code  {type:"export", index, scale}         code -> ui  {type:"png", index, bytes}
//   ui -> code  {type:"remove", indices}              code -> ui  {type:"removed", removed, missing}
//   any failure                                       code -> ui  {type:"error", index?, msg}
//
// Rules this file follows (see docs/FIGMA_CONSTRAINTS.md, figma-use-slides/references/slide-gotchas.md):
//   - appendChild BEFORE x/y or anything else, at every level (new nodes sit on a hidden (240,240) origin).
//   - every font is loaded (loadFontAsync) before any text property is touched.
//   - every node is built in its own try/catch; one bad node never stops the slide.
//   - rebuilding a slide (same IR index) clears its children and rebuilds; it never adds a second slide.
//
// Sandbox syntax: no optional chaining, no nullish coalescing, no optional catch binding. Bundled by
// `bun run build:plugin` into plugin/code.js (IIFE).
import noiseCalibration from "../../scripts/noise-calibration.json";
import {
  blendModeOf,
  clampRadii,
  cleanImageFilters,
  effectToFigma,
  fillToPaint,
  groupRuns,
  paintTag,
  parseCssColor,
  pickStyle,
  pinLines,
  rawNoiseToFigma,
  rotationTransform,
  placeRotated,
  unrotatedIn,
  selectFontStyle,
  tileFactor,
  imagePaintMode,
  transformBox,
  type NoiseCalibration,
  type IRFill,
  type IRNode,
  type IRRun,
  type IRSlide,
} from "../../scripts/lib/figma-map";

declare const figma: any;
declare const __html__: string;

const NS = "designfigma";
const FALLBACK_FAMILY = "Inter";

type FontEntry = { family: string; styles: string[] };
type Resolved = {
  family: string;
  style: string;
  variationSettings?: { [axis: string]: number };
  missing: boolean;
  want: { family: string; style: string; weight: number; wdth: number | null };
};
type ReportNode = {
  name: string;
  irType: string;
  figmaType: string;
  x: number;
  y: number;
  w: number;
  h: number;
  characters?: string;
  fills?: string[];
  fontName?: string;
  error?: string;
  // D-008 fields, read by scripts/check.ts "effects"
  effects?: { type: string }[];
  blendMode?: string;
  rotation?: number; // degrees clockwise as CSS
  imageFilters?: { [k: string]: number };
  mask?: boolean;
  children?: ReportNode[];
};
type Report = {
  index: number;
  slideId: string;
  label: string;
  missingFonts: { family: string; style: string; weight: number; wdth: number | null }[];
  fontsUsed: { family: string; style: string; variationSettings: { [axis: string]: number } | null }[];
  errors: { node: string; msg: string }[];
  nodes: ReportNode[];
  imageHashes: string[];
};

// ---------------------------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------------------------

const imageHashes: { [ref: string]: string } = {};
let fontCache: { at: number; byFamily: { [lower: string]: FontEntry } } | null = null;
const axesCache: { [family: string]: string[] | null } = {};
const FONT_CACHE_MS = 20000; // one font listing per job: a job's slides arrive well inside this window

function errText(e: any): string {
  return String(e && e.message ? e.message : e);
}

async function getFonts(fresh: boolean): Promise<{ [lower: string]: FontEntry }> {
  const now = Date.now();
  if (!fresh && fontCache && now - fontCache.at < FONT_CACHE_MS) return fontCache.byFamily;
  const list = await figma.listAvailableFontsAsync();
  const byFamily: { [lower: string]: FontEntry } = {};
  for (const f of list) {
    const fam = f.fontName.family as string;
    const key = fam.toLowerCase();
    if (!byFamily[key]) byFamily[key] = { family: fam, styles: [] };
    if (byFamily[key].styles.indexOf(f.fontName.style) === -1) byFamily[key].styles.push(f.fontName.style);
  }
  fontCache = { at: now, byFamily };
  for (const k in axesCache) delete axesCache[k];
  return byFamily;
}

// Exact family first; else a local family that extends the name ("Denim INK" -> "Denim INK TRIAL").
function findFamily(fonts: { [lower: string]: FontEntry }, family: string): FontEntry | null {
  const want = String(family).toLowerCase();
  if (fonts[want]) return fonts[want];
  let best: FontEntry | null = null;
  for (const key in fonts) {
    if (key.indexOf(want + " ") === 0 && (!best || key.length < best.family.length)) best = fonts[key];
  }
  return best;
}

function axesOf(family: string): string[] | null {
  if (Object.prototype.hasOwnProperty.call(axesCache, family)) return axesCache[family];
  let axes: string[] | null = null;
  try {
    axes = figma.getFontFamilyVariationAxes(family);
  } catch (e) {
    axes = null;
  }
  axesCache[family] = axes;
  return axes;
}

function toBytes(v: any): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v && typeof v === "object") return Uint8Array.from(Object.keys(v).map((k) => v[k]));
  throw new Error("image bytes missing");
}

// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------

function weightName(w: number): string {
  if (w <= 150) return "Thin";
  if (w <= 250) return "Extra Light";
  if (w <= 350) return "Light";
  if (w <= 450) return "Regular";
  if (w <= 550) return "Medium";
  if (w <= 650) return "Semi Bold";
  if (w <= 750) return "Bold";
  if (w <= 850) return "Extra Bold";
  return "Black";
}

function resolveRunFont(run: IRRun, fonts: { [lower: string]: FontEntry }): Resolved {
  const wdth = run.variation && run.variation.wdth !== undefined ? run.variation.wdth : null;
  const want = {
    family: run.fontFamily,
    style: weightName(run.fontWeight) + (run.italic ? " Italic" : ""),
    weight: run.fontWeight,
    wdth,
  };
  const entry = findFamily(fonts, run.fontFamily);
  if (!entry) {
    const inter = fonts[FALLBACK_FAMILY.toLowerCase()];
    const style = inter ? selectFontStyle(inter.styles, run.fontWeight, run.italic) || "Regular" : "Regular";
    return { family: inter ? inter.family : FALLBACK_FAMILY, style, missing: true, want };
  }
  const style = pickStyle(entry.styles, run.fontWeight, run.italic, wdth);
  const out: Resolved = { family: entry.family, style, missing: false, want };
  const axes = axesOf(entry.family);
  if (axes && axes.length) {
    const vs: { [axis: string]: number } = {};
    const given: any = run.variation || {};
    for (const ax of axes) {
      const v = ax === "wght" ? (given.wght !== undefined ? given.wght : run.fontWeight) : given[ax];
      if (typeof v === "number" && isFinite(v)) vs[ax] = v;
    }
    if (Object.keys(vs).length) out.variationSettings = vs;
  }
  return out;
}

function fontNameOf(r: Resolved): any {
  return r.variationSettings
    ? { family: r.family, style: r.style, variationSettings: r.variationSettings }
    : { family: r.family, style: r.style };
}

function fontTag(r: { family: string; style: string; variationSettings?: any }): string {
  let s = r.family + " " + r.style;
  if (r.variationSettings) {
    const vs = r.variationSettings;
    s += " " + Object.keys(vs).sort().map((k) => k + "=" + vs[k]).join(" ");
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Build context for one slide
// ---------------------------------------------------------------------------------------------

// chars/runs are the Figma-side text: the IR characters with U+2028 pinned in (runs shifted to match).
type TextPlan = { chars: string; runs: IRRun[]; fonts: Resolved[]; pinned: boolean } | { error: string };

type Ctx = {
  images: { [ref: string]: any };
  errors: { node: string; msg: string }[];
  fontsUsed: { [key: string]: Report["fontsUsed"][0] };
  missing: { [key: string]: Report["missingFonts"][0] };
};

function imageHash(ctx: Ctx, ref: string): string {
  if (imageHashes[ref]) return imageHashes[ref];
  const raw = ctx.images ? ctx.images[ref] : undefined;
  if (raw === undefined || raw === null) throw new Error("image not supplied: " + ref);
  const hash = figma.createImage(toBytes(raw)).hash;
  imageHashes[ref] = hash;
  return hash;
}

/** IR fills (bottom to top) -> Figma paints. A missing image drops only that paint and records an error. */
function paintsFor(ctx: Ctx, fills: IRFill[], w: number, h: number, nodeName: string, noteMissing: (m: string) => void): any[] {
  const out: any[] = [];
  for (const f of fills || []) {
    try {
      const p: any = fillToPaint(f, w, h);
      if (p.type === "IMAGE") {
        const hash = imageHash(ctx, p.imageRef);
        const ip: any = { type: "IMAGE", scaleMode: p.scaleMode, imageHash: hash };
        if (p.scaleMode === "TILE" && p.scalingFactor !== undefined) ip.scalingFactor = p.scalingFactor;
        if (p.filters) ip.filters = p.filters;
        out.push(ip);
      } else out.push(p);
    } catch (e) {
      const m = "fill: " + errText(e);
      ctx.errors.push({ node: nodeName, msg: m });
      noteMissing(m);
    }
  }
  return out;
}

function paintTags(node: any): string[] {
  const fills = node.fills;
  if (!fills || fills === figma.mixed) return [];
  return fills.map((p: any) => paintTag(p));
}

// Every image hash a node or any descendant paints with (fills only; text has no image fills).
function collectImageHashes(node: any, out: { [hash: string]: boolean }) {
  try {
    const fills = node.fills;
    if (fills && fills !== figma.mixed) for (const p of fills) if (p && p.type === "IMAGE" && p.imageHash) out[p.imageHash] = true;
  } catch (e) {
    /* a node without readable fills has no images */
  }
  if (node.children) for (const k of node.children) collectImageHashes(k, out);
}

function imageHashesOf(slide: any): string[] {
  const out: { [hash: string]: boolean } = {};
  collectImageHashes(slide, out);
  return Object.keys(out).sort();
}

// A freshly created image is not decoded yet; exporting a slide before it is returned it blank in real Figma
// (2026-10-24, a 3840x2160 PNG). Reading size and bytes first forces the decode.
async function prewarmImages(hashes: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const h of hashes) {
    try {
      const img = figma.getImageByHash(h);
      if (!img) {
        failed.push(h + ": not found");
        continue;
      }
      await img.getSizeAsync();
      await img.getBytesAsync();
    } catch (e) {
      failed.push(h + ": " + errText(e));
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------------------------
// Node builders. Each returns { node, extra } where extra feeds the report entry.
// ---------------------------------------------------------------------------------------------

function applyBox(node: any, n: { x: number; y: number; opacity?: number }) {
  node.x = n.x;
  node.y = n.y;
  node.opacity = n.opacity === undefined ? 1 : n.opacity;
}

function setRadii(node: any, r: number[]) {
  node.topLeftRadius = r[0];
  node.topRightRadius = r[1];
  node.bottomRightRadius = r[2];
  node.bottomLeftRadius = r[3];
}

function buildRect(slide: any, n: any, ctx: Ctx, soft: string[]): any {
  const node = n.clipsContent ? figma.createFrame() : figma.createRectangle();
  slide.appendChild(node);
  node.name = n.name;
  node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  node.fills = paintsFor(ctx, n.fills, n.w, n.h, n.name, (m) => soft.push(m));
  if (n.clipsContent) node.clipsContent = true;
  setRadii(node, clampRadii(n.radius, n.w, n.h));
  if (n.stroke && n.stroke.width > 0) {
    const c = parseCssColor(n.stroke.color);
    const op = (n.stroke.opacity === undefined ? 1 : n.stroke.opacity) * c.a;
    const sp: any = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
    if (op < 1) sp.opacity = op;
    node.strokes = [sp];
    node.strokeWeight = n.stroke.width;
    node.strokeAlign = "INSIDE";
  }
  applyBox(node, n);
  return node;
}

function buildImage(slide: any, n: any, ctx: Ctx): any {
  const hash = imageHash(ctx, n.ref); // throws before any node exists when the bytes are missing
  const node = figma.createRectangle();
  slide.appendChild(node);
  node.name = n.name;
  node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  const paint: any = { type: "IMAGE", ...imagePaintMode(n.scaleMode), imageHash: hash };
  if (paint.scaleMode === "TILE") paint.scalingFactor = tileFactor(n.scalingFactor === undefined ? 1 : n.scalingFactor);
  const filters = cleanImageFilters(n.filters);
  if (filters) paint.filters = filters;
  node.fills = [paint];
  setRadii(node, clampRadii(n.radius, n.w, n.h));
  applyBox(node, n);
  return node;
}

function buildSvg(slide: any, n: any): any {
  const node = figma.createNodeFromSvg(n.svg);
  slide.appendChild(node);
  node.name = n.name;
  if (Math.abs(node.width - n.w) > 0.5 || Math.abs(node.height - n.h) > 0.5) {
    for (const c of node.children) {
      try {
        c.constraints = { horizontal: "SCALE", vertical: "SCALE" };
      } catch (e) {
        /* leaf without constraints */
      }
    }
    node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  }
  applyBox(node, n);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Blend mode, rotation, effects (D-008)
// ---------------------------------------------------------------------------------------------

// Shadow spread is only accepted on rectangles, ellipses, and frames with a visible fill that clip their content.
function spreadAllowed(node: any): boolean {
  if (node.type === "RECTANGLE" || node.type === "ELLIPSE") return true;
  if (node.type === "FRAME") return !!node.clipsContent && visiblePaints(node.fills);
  return false;
}

/** Applies blendMode, rotation about the IR box centre, and effects to a built node. Problems go to `soft`. */
function applyCommon(node: any, n: any, soft: string[]) {
  if (n.blendMode !== undefined && n.blendMode !== null) {
    const bm = blendModeOf(n.blendMode);
    if (bm) node.blendMode = bm;
    else soft.push("unknown blendMode " + n.blendMode);
  }
  const effects: any[] = [];
  if (n.figmaNoise) effects.push(rawNoiseToFigma(n.figmaNoise)); // calibration only
  const irFx: any[] = n.effects || [];
  for (let i = 0; i < irFx.length; i++) {
    if (n.figmaNoise && irFx[i].type === "noise") continue;
    try {
      const r = effectToFigma(irFx[i], noiseCalibration as NoiseCalibration, spreadAllowed(node));
      if (r.effect) effects.push(r.effect);
      if (r.note) soft.push(r.note);
    } catch (e) {
      soft.push("effect " + irFx[i].type + ": " + errText(e));
    }
  }
  if (effects.length) node.effects = effects;
  if (typeof n.rotation === "number" && isFinite(n.rotation) && Math.abs(n.rotation) > 1e-6) {
    // x,y,w,h in the IR are the unrotated box, rotation is about its centre. Keep the node's own size (text may differ)
    // and anchor text on its aligned edge inside that box, as CSS does.
    node.relativeTransform = placeRotated(n, node.width, node.height, n.rotation, n.type === "text" ? n.align || "LEFT" : undefined);
  }
}

// A group is a frame that does not clip. Its children carry slide-absolute x/y (buildNodes shifts them by the origin).
function buildGroup(parent: any, n: any): any {
  const g = figma.createFrame();
  parent.appendChild(g);
  g.name = n.name;
  g.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  g.fills = [];
  g.clipsContent = false;
  g.x = n.x;
  g.y = n.y;
  g.opacity = n.opacity === undefined ? 1 : n.opacity;
  return g;
}

function runPaint(r: IRRun): any {
  const c = parseCssColor(r.color);
  const op = (r.colorOpacity === undefined ? 1 : r.colorOpacity) * c.a;
  const p: any = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
  if (op < 1) p.opacity = op;
  return p;
}

// A variationSettings value outside the font's real axis range can throw in Figma. Retry with the named
// style alone so the text still lands, and say so in the report.
function setRangeFont(t: any, r: IRRun, f: Resolved, soft: string[]) {
  try {
    t.setRangeFontName(r.start, r.end, fontNameOf(f));
  } catch (e) {
    if (!f.variationSettings) throw e;
    t.setRangeFontName(r.start, r.end, { family: f.family, style: f.style });
    soft.push("variationSettings rejected (" + errText(e) + "); used named style " + f.style);
  }
}

function buildText(slide: any, n: any, plan: { chars: string; runs: IRRun[]; fonts: Resolved[]; pinned: boolean }, soft: string[]): any {
  const t = figma.createText();
  slide.appendChild(t);
  t.name = n.name;
  // Fonts are already loaded (see loadPlannedFonts). Set a loaded font before the characters.
  t.fontName = { family: plan.fonts[0].family, style: plan.fonts[0].style };
  t.characters = plan.chars;
  t.textAlignHorizontal = n.align || "LEFT";
  for (let i = 0; i < plan.runs.length; i++) {
    const r = plan.runs[i];
    setRangeFont(t, r, plan.fonts[i], soft);
    t.setRangeFontSize(r.start, r.end, r.fontSize);
    t.setRangeLineHeight(r.start, r.end, { unit: "PIXELS", value: r.lineHeightPx });
    t.setRangeLetterSpacing(r.start, r.end, { unit: "PIXELS", value: r.letterSpacingPx });
    t.setRangeFills(r.start, r.end, [runPaint(r)]);
    if (r.decoration && r.decoration !== "NONE") t.setRangeTextDecoration(r.start, r.end, r.decoration);
  }
  let x = n.x;
  if (plan.pinned) {
    // Chrome's line breaks are pinned with U+2028, so give the box slack and Figma never wraps inside a
    // pinned line. The visible text edge stays where Chrome put it.
    const slack = Math.min(16, Math.max(2, n.w * 0.04));
    t.resize(Math.max(1, n.w + slack), Math.max(1, n.h));
    t.textAutoResize = "HEIGHT";
    if (n.align === "CENTER") x = n.x - slack / 2;
    else if (n.align === "RIGHT") x = n.x - slack;
  } else if (n.wrap) {
    t.resize(Math.max(1, n.w), Math.max(1, n.h)); // resize resets sizing to FIXED, so set the mode after
    t.textAutoResize = "HEIGHT";
  } else {
    t.textAutoResize = "WIDTH_AND_HEIGHT";
    // IR x/w is Chrome's glyph box; Figma's glyphs may be a different width, so keep the aligned edge.
    if (n.align === "CENTER") x = n.x + (n.w - t.width) / 2;
    else if (n.align === "RIGHT") x = n.x + n.w - t.width;
  }
  // Figma's line box can differ from Chrome's by a fraction of a pixel; keep the text centred in Chrome's box.
  let y = n.y;
  const lh = plan.runs[0].lineHeightPx;
  const dh = n.h - t.height;
  if (lh > 0 && dh !== 0 && Math.abs(dh) <= 2 && Math.round(n.h / lh) === Math.round(t.height / lh)) y = n.y + dh / 2;
  t.x = x;
  t.y = y;
  t.opacity = n.opacity === undefined ? 1 : n.opacity;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------------------------

function slidesInGrid(): any[][] {
  return typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid() : figma.getSlideGrid();
}

// Every SLIDE in the file. The grid alone missed slides in real Figma (2026-10-24), so rows that are
// SLIDE_ROW nodes are opened and the page is searched as well.
function allSlides(): any[] {
  const out: any[] = [];
  const seen: { [id: string]: boolean } = {};
  const add = (n: any) => {
    if (!n || seen[n.id]) return;
    if (n.type === "SLIDE") { seen[n.id] = true; out.push(n); }
    else if (n.type === "SLIDE_ROW" && n.children) for (const k of n.children) add(k);
  };
  try { for (const row of slidesInGrid()) for (const n of row) add(n); } catch (e) { /* fall through to page search */ }
  try {
    const page = figma.currentPage;
    if (page && typeof page.findAllWithCriteria === "function") for (const n of page.findAllWithCriteria({ types: ["SLIDE"] })) add(n);
  } catch (e) { /* grid result stands */ }
  return out;
}

function gridShape(): string {
  try {
    const g = slidesInGrid();
    const types = g.map((r: any) => (Array.isArray(r) ? r.map((n: any) => (n && n.type) || typeof n).join(",") : typeof r)).join(" | ");
    return "grid " + g.length + " rows [" + types.slice(0, 200) + "], slides found " + allSlides().length;
  } catch (e) {
    return "grid unreadable: " + errText(e);
  }
}

// Where things sit in the file: pages, the grid, and each SLIDE's parent chain. Probe-only diagnostics.
function fileLayout(): any {
  const chain = (n: any) => {
    const out: string[] = [];
    for (let p = n.parent; p; p = p.parent) out.push(p.type + ":" + p.name + (p.id ? "#" + p.id : ""));
    return out;
  };
  const pages: any[] = [];
  try {
    for (const pg of figma.root.children) pages.push({ id: pg.id, name: pg.name, current: pg === figma.currentPage, kids: (pg.children || []).map((k: any) => k.type + ":" + k.name).slice(0, 20) });
  } catch (e) { pages.push({ error: errText(e) }); }
  const kidsOf = (sl: any) => (sl.children || []).slice(0, 10).map((k: any) => {
    const e: any = { type: k.type, name: k.name };
    if (k.type === "TEXT") e.chars = String(k.characters || "").length;
    if (k.children) e.kids = k.children.length;
    return e;
  });
  const slides = allSlides().map((sl: any) => ({ id: sl.id, name: sl.name, index: sl.getSharedPluginData(NS, "index"), skipped: sl.isSkippedSlide, childCount: (sl.children || []).length, children: kidsOf(sl), chain: chain(sl) }));
  let gridOrder: string[] = [];
  try { gridOrder = slidesInGrid().map((r: any) => r.map((n: any) => (n && n.getSharedPluginData ? n.getSharedPluginData(NS, "index") || "-" : "?")).join(",")); } catch (e) { gridOrder = ["unreadable"]; }
  return { pages, grid: gridShape(), gridOrder, slides };
}

function findSlide(index: number): any {
  for (const s of allSlides()) if (s.getSharedPluginData(NS, "index") === String(index)) return s;
  return null;
}

function visiblePaints(paints: any): boolean {
  if (paints === figma.mixed) return true; // unreadable: treat as content
  if (!paints) return false;
  for (const p of paints) if (p && p.visible !== false && (p.opacity === undefined || p.opacity > 0)) return true;
  return false;
}

// A node with nothing to see: empty text, or a container with no visible fill or stroke whose children are
// all the same. Real Figma's starter slide held untagged placeholders, not zero children (2026-10-24).
function isEmptyPlaceholder(n: any): boolean {
  try {
    if (n.type === "TEXT") return String(n.characters || "").replace(/\s+/g, "") === "";
    if (n.type === "SVG" || n.type === "IMAGE" || n.type === "VIDEO") return false;
    if (visiblePaints(n.fills) || visiblePaints(n.strokes)) return false;
    if (n.children && (n.type === "FRAME" || n.type === "GROUP" || n.type === "SECTION")) {
      for (const k of n.children) if (!isEmptyPlaceholder(k)) return false;
      return true;
    }
    return false; // a leaf shape (rectangle, vector, ...) is content even without a fill
  } catch (e) {
    return false;
  }
}

function isBlankSlide(s: any): boolean {
  if (!s.children) return true;
  for (const k of s.children) if (!isEmptyPlaceholder(k)) return false;
  return true;
}

// Put tagged slides in deck order, untagged ones (the owner's own) after them, in a single-row deck.
// removeBlank (asked for per job, e.g. a fresh file's starter slide) deletes untagged slides that are empty.
// Uses allSlides() because the grid read alone returned stale rows in real Figma (2026-10-24), which
// left slides inserted in reverse.
function orderSlides(removeBlank: boolean) {
  const setGrid = typeof figma.setCanvasGrid === "function" ? figma.setCanvasGrid : figma.setSlideGrid;
  if (typeof setGrid !== "function") return;
  let grid: any[][] = [];
  try { grid = slidesInGrid(); } catch (e) { grid = []; }
  if (grid.length > 1) return; // owner arranged rows; leave them alone
  const slides = allSlides();
  const tag = (s: any) => s.getSharedPluginData(NS, "index");
  const tagged = slides.filter((s) => tag(s) !== "").sort((a, b) => Number(tag(a)) - Number(tag(b)));
  let rest = slides.filter((s) => tag(s) === "");
  if (removeBlank && tagged.length) {
    for (const s of rest) if (isBlankSlide(s)) s.remove();
    rest = rest.filter((s) => !s.removed);
  }
  const want = tagged.concat(rest);
  const have = grid.length ? grid[0] : [];
  if (have.length === want.length && have.every((s: any, i: number) => s.id === want[i].id)) return;
  setGrid.call(figma, [want]);
}

function createSlideFor(index: number): any {
  const grid = slidesInGrid();
  if (grid.length === 0) return figma.createSlide();
  // Insert after the last slide in row 0 whose tagged index is lower, so the grid stays in deck order.
  let col = 0;
  for (let c = 0; c < grid[0].length; c++) {
    const v = grid[0][c].getSharedPluginData(NS, "index");
    if (v !== "" && Number(v) < index) col = c + 1;
  }
  return figma.createSlide(0, col);
}

function clearChildren(slide: any) {
  const kids = slide.children.slice();
  for (const k of kids) k.remove();
}

type PlanMap = { list: (TextPlan | null)[]; byNode: Map<any, TextPlan> };

function planText(n: any, fonts: { [lower: string]: FontEntry }): TextPlan {
  try {
    const runs = groupRuns(n.characters.length, n.runs);
    if (runs.length === 0) return { error: "text has no usable runs" };
    const pinned = pinLines(n.characters, runs, n.lines);
    return { chars: pinned.characters, runs: pinned.runs, fonts: runs.map((r) => resolveRunFont(r, fonts)), pinned: pinned.characters !== n.characters };
  } catch (e) {
    return { error: errText(e) };
  }
}

// Text plans for every text node on the slide, groups included (list feeds the font loader, byNode the builder).
function collectTextPlans(ir: IRSlide, fonts: { [lower: string]: FontEntry }): PlanMap {
  const out: PlanMap = { list: [], byNode: new Map() };
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === "text") {
        const plan = planText(n, fonts);
        out.list.push(plan);
        out.byNode.set(n, plan);
      } else if (n.type === "group" && n.children) walk(n.children);
    }
  };
  walk(ir.nodes);
  return out;
}

/** Loads every planned font before any text is touched. A font that fails to load falls back to Inter. */
async function loadPlannedFonts(plans: (TextPlan | null)[], fonts: { [lower: string]: FontEntry }): Promise<void> {
  const need: { [key: string]: Resolved } = {};
  const add = (r: Resolved) => {
    need[r.family + "\u0000" + r.style] = r;
  };
  add({ family: FALLBACK_FAMILY, style: "Regular", missing: false, want: { family: FALLBACK_FAMILY, style: "Regular", weight: 400, wdth: null } });
  for (const p of plans) if (p && !("error" in p)) for (const f of p.fonts) add(f);
  const keys = Object.keys(need);
  const failed: { [key: string]: boolean } = {};
  await Promise.all(
    keys.map((k) =>
      figma.loadFontAsync({ family: need[k].family, style: need[k].style }).then(
        () => undefined,
        () => {
          failed[k] = true;
        },
      ),
    ),
  );
  if (!keys.some((k) => failed[k])) return;
  // Re-resolve failures to Inter (already loaded above unless Inter itself failed, which is fatal).
  if (failed[FALLBACK_FAMILY + "\u0000Regular"]) throw new Error("cannot load fallback font Inter Regular");
  const inter = fonts[FALLBACK_FAMILY.toLowerCase()];
  for (const p of plans) {
    if (!p || "error" in p) continue;
    for (let i = 0; i < p.fonts.length; i++) {
      const f = p.fonts[i];
      if (!failed[f.family + "\u0000" + f.style]) continue;
      const style = inter ? selectFontStyle(inter.styles, f.want.weight, /Italic$/.test(f.want.style)) || "Regular" : "Regular";
      const fb: Resolved = { family: FALLBACK_FAMILY, style, missing: true, want: f.want };
      try {
        await figma.loadFontAsync({ family: fb.family, style: fb.style });
      } catch (e) {
        fb.style = "Regular";
      }
      p.fonts[i] = fb;
    }
  }
}

function describeNode(irNode: IRNode, node: any, plan: TextPlan | null): ReportNode {
  const entry: ReportNode = {
    name: irNode.name,
    irType: irNode.type,
    figmaType: node.type,
    x: node.x,
    y: node.y,
    w: node.width,
    h: node.height,
  };
  if (irNode.type === "text") {
    entry.characters = node.characters;
    const tags: string[] = [];
    if (plan && !("error" in plan)) {
      for (const r of plan.runs) {
        let tag = "";
        try {
          const fills = node.getRangeFills(r.start, r.end);
          tag = fills === figma.mixed || !fills.length ? "MIXED" : paintTag(fills[0]);
        } catch (e) {
          tag = "UNREADABLE";
        }
        if (tags.length === 0 || tags[tags.length - 1] !== tag) tags.push(tag);
      }
      entry.fontName = fontTag(plan.fonts[0]);
    }
    entry.fills = tags;
  } else {
    entry.fills = paintTags(node);
  }
  describeCommon(entry, node, irNode);
  return entry;
}

// D-008 fields for the checker: effects, blend mode, rotation (clockwise), image filters; rotated nodes report the
// UNROTATED box like the IR.
function describeCommon(entry: ReportNode, node: any, irNode: any) {
  try {
    if (node.effects && node.effects !== figma.mixed && node.effects.length) entry.effects = node.effects.map((f: any) => ({ type: f.type }));
  } catch (e) { /* no effects */ }
  try {
    if (node.blendMode && node.blendMode !== "PASS_THROUGH" && node.blendMode !== "NORMAL") entry.blendMode = node.blendMode;
  } catch (e) { /* no blend mode */ }
  try {
    if (node.rotation && Math.abs(node.rotation) > 1e-6 && node.relativeTransform) {
      const tb = typeof irNode.w === "number" ? unrotatedIn(node.relativeTransform, node.width, node.height, irNode) : transformBox(node.relativeTransform, node.width, node.height);
      entry.x = tb.x;
      entry.y = tb.y;
      entry.rotation = -node.rotation; // Figma counts counter-clockwise, CSS clockwise
    }
  } catch (e) { /* no rotation */ }
  try {
    const fills = node.fills;
    if (fills && fills !== figma.mixed) {
      const union: { [k: string]: number } = {};
      for (const p of fills) if (p && p.type === "IMAGE" && p.filters) for (const k in p.filters) union[k] = p.filters[k];
      if (Object.keys(union).length) entry.imageFilters = union;
    }
  } catch (e) { /* no fills */ }
}

// Builds `nodes` (slide-absolute coordinates) into `parent`, whose top-left sits at (ox,oy) in slide space.
// Returns one report entry per IR node, in order; a group's children are nested under `children`.
function buildNodes(parent: any, nodes: any[], ox: number, oy: number, ctx: Ctx, plans: PlanMap): ReportNode[] {
  const out: ReportNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const orig: any = nodes[i];
    const n: any = ox || oy ? Object.assign({}, orig, { x: orig.x - ox, y: orig.y - oy }) : orig;
    const plan = plans.byNode.get(orig) || null;
    let node: any = null;
    const soft: string[] = [];
    try {
      let kids: ReportNode[] | null = null;
      if (n.type === "rect") node = buildRect(parent, n, ctx, soft);
      else if (n.type === "image") node = buildImage(parent, n, ctx);
      else if (n.type === "svg") node = buildSvg(parent, n);
      else if (n.type === "text") {
        if (!plan || "error" in plan) throw new Error(plan ? plan.error : "no text plan");
        node = buildText(parent, n, plan, soft);
      } else if (n.type === "group") {
        node = buildGroup(parent, n);
        kids = buildNodes(node, orig.children || [], orig.x, orig.y, ctx, plans);
        if (orig.mask) {
          // The mask is the first IR child; if it failed to build, masking the next layer instead would be wrong.
          if (node.children.length && kids[0] && kids[0].figmaType !== "NONE") node.children[0].isMask = true;
          else soft.push("mask: first child did not build, group left unmasked");
        }
      } else throw new Error("unknown node type " + n.type);
      applyCommon(node, n, soft);
      const entry = describeNode(n, node, plan);
      entry.x += ox;
      entry.y += oy;
      if (kids) {
        entry.children = kids;
        if (orig.mask) entry.mask = !!(node.children.length && node.children[0].isMask);
      }
      if (soft.length) entry.error = soft[0];
      out.push(entry);
    } catch (e) {
      const msg = errText(e);
      ctx.errors.push({ node: n.name, msg });
      try {
        if (node && !node.removed) node.remove();
      } catch (e2) {
        /* already gone */
      }
      out.push({ name: n.name, irType: n.type, figmaType: "NONE", x: 0, y: 0, w: 0, h: 0, error: msg });
    }
  }
  return out;
}

async function buildSlide(ir: IRSlide, images: { [ref: string]: any }): Promise<Report> {
  const fonts = await getFonts(false);
  const ctx: Ctx = { images, errors: [], fontsUsed: {}, missing: {} };
  const plans = collectTextPlans(ir, fonts);
  await loadPlannedFonts(plans.list, fonts);

  let slide = findSlide(ir.index);
  if (!slide) slide = createSlideFor(ir.index);
  clearChildren(slide);
  slide.name = ir.label;
  slide.setSharedPluginData(NS, "index", String(ir.index));
  const bg = paintsFor(ctx, ir.background, ir.width, ir.height, "(background)", () => undefined);
  // An empty background array is a transparent page, which Chrome shows as white.
  slide.fills = ir.background && ir.background.length ? bg : [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];

  const nodes = buildNodes(slide, ir.nodes, 0, 0, ctx, plans);

  const fontsUsed: Report["fontsUsed"] = [];
  const missingFonts: Report["missingFonts"] = [];
  const seenUsed: { [k: string]: boolean } = {};
  const seenMissing: { [k: string]: boolean } = {};
  for (const p of plans.list) {
    if (!p || "error" in p) continue;
    for (const f of p.fonts) {
      const uk = fontTag(f);
      if (!seenUsed[uk]) {
        seenUsed[uk] = true;
        fontsUsed.push({ family: f.family, style: f.style, variationSettings: f.variationSettings || null });
      }
      if (f.missing) {
        const mk = f.want.family + "|" + f.want.style + "|" + f.want.wdth;
        if (!seenMissing[mk]) {
          seenMissing[mk] = true;
          missingFonts.push({ family: f.want.family, style: f.want.style, weight: f.want.weight, wdth: f.want.wdth });
        }
      }
    }
  }
  return {
    index: ir.index,
    slideId: slide.id,
    label: ir.label,
    missingFonts,
    fontsUsed,
    errors: ctx.errors,
    nodes,
    imageHashes: imageHashesOf(slide),
  };
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

function notify(text: string) {
  try {
    figma.notify(text, { timeout: 3000 });
  } catch (e) {
    /* notify is cosmetic */
  }
}

async function handleProbe(msg: any) {
  const families: string[] = msg.families || [];
  const byFamily = await getFonts(true);
  const fonts: { family: string; style: string }[] = [];
  const axes: { [family: string]: string[] | null } = {};
  for (const fam of families) {
    const entry = findFamily(byFamily, fam);
    if (!entry) {
      axes[fam] = null;
      continue;
    }
    for (const style of entry.styles) fonts.push({ family: entry.family, style });
    axes[fam] = axesOf(entry.family);
  }
  // Local fonts often carry suffixes ("Denim INK TRIAL Light"), so also list every family that
  // contains the first word of a requested name.
  const similar: { [family: string]: { family: string; styles: string[]; axes: string[] | null }[] } = {};
  for (const fam of families) {
    const word = String(fam).toLowerCase().split(" ")[0];
    similar[fam] = [];
    for (const key in byFamily) {
      if (key.indexOf(word) >= 0) similar[fam].push({ family: byFamily[key].family, styles: byFamily[key].styles, axes: axesOf(byFamily[key].family) });
    }
  }
  figma.ui.postMessage({ type: "probe-result", fonts, axes, similar, layout: fileLayout(), editorType: figma.editorType });
  notify("design-figma: probed " + families.length + " font families");
}

async function handleBuild(msg: any) {
  const ir: IRSlide = msg.ir;
  const report = await buildSlide(ir, msg.images || {});
  try {
    orderSlides(!!msg.removeBlank);
  } catch (e) {
    report.errors.push({ node: "slide-order", msg: errText(e) } as any);
  }
  figma.ui.postMessage({ type: "built", index: ir.index, report });
  const bad = report.errors.length;
  notify(
    "design-figma: " + ir.label + " built, " + report.nodes.length + " nodes, " + bad + " error" + (bad === 1 ? "" : "s") +
      (report.missingFonts.length ? ", " + report.missingFonts.length + " missing font" + (report.missingFonts.length === 1 ? "" : "s") : ""),
  );
}

async function handleExport(msg: any) {
  const slide = findSlide(msg.index);
  if (!slide) throw new Error("no slide with index " + msg.index + " (build it first); " + gridShape());
  const scale = typeof msg.scale === "number" && msg.scale > 0 ? msg.scale : 1;
  await prewarmImages(imageHashesOf(slide)); // a failed warm-up still exports; the checker catches a blank slide
  const bytes = await slide.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  figma.ui.postMessage({ type: "png", index: msg.index, bytes });
}

// Deletes the slides this plugin tagged with the given indices (calibration slides, indices >= 1000). Slides it did
// not tag are never touched.
async function handleRemove(msg: any) {
  const wanted: { [idx: string]: boolean } = {};
  for (const i of msg.indices || []) wanted[String(i)] = true;
  const removed: number[] = [];
  for (const s of allSlides()) {
    const tag = s.getSharedPluginData(NS, "index");
    if (tag !== "" && wanted[tag]) {
      s.remove();
      removed.push(Number(tag));
    }
  }
  const missing = (msg.indices || []).filter((i: number) => removed.indexOf(i) === -1);
  figma.ui.postMessage({ type: "removed", removed, missing });
  notify("design-figma: removed " + removed.length + " slide" + (removed.length === 1 ? "" : "s"));
}

async function handle(msg: any) {
  if (!msg || typeof msg.type !== "string") return;
  try {
    if (msg.type === "probe") await handleProbe(msg);
    else if (msg.type === "build") await handleBuild(msg);
    else if (msg.type === "export") await handleExport(msg);
    else if (msg.type === "remove") await handleRemove(msg);
  } catch (e) {
    const index = msg.type === "build" && msg.ir ? msg.ir.index : msg.index;
    figma.ui.postMessage({ type: "error", index, msg: errText(e) });
    notify("design-figma: " + msg.type + " failed: " + errText(e));
  }
}

figma.showUI(__html__, { width: 360, height: 220 });
// One message at a time: builds mutate the document and share the font cache.
let chain: Promise<void> = Promise.resolve();
figma.ui.onmessage = (msg: any) => {
  chain = chain.then(() => handle(msg));
  return chain;
};
