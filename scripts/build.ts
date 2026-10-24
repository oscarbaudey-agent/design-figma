#!/usr/bin/env bun
// build.ts: IR JSON (from the extractor) -> JavaScript strings for Figma's use_figma tool.
//
// Usage:
//   bun build.ts --ir <ir dir> --out <out dir> [--slides 0,16,26-28|all] [--max-bytes 50000]
//                [--image-max-bytes 300000] [--fonts fonts.json]
//
// --slides takes 0-based slide indexes (the IR "index" field), comma list with ranges.
//
// Output (all under --out):
//   slide-NNN.js              part 0 of a slide: creates the SLIDE, background, first nodes
//   slide-NNN.partK.js        K >= 1: finds the slide by its index tag (name as fallback), appends nodes
//   images/<hash>.js          one-shot image upload (base64 -> figma.createImage -> shared plugin data)
//   images/<hash>.partK.js    chunked upload for images too big for one script (run in order)
//   manifest.json             run order, node counts, images per slide, fonts, warnings
//
// Every generated script ends with `return {...}` (what the use_figma tool calls the plugin output).
// Run image scripts before the slide scripts that need them.
//
// IR contract (do not change without saying so): see the task brief. One addition this builder
// documents rather than requires: an empty `background` array means a white slide fill, because
// that is what a transparent page looks like in a Chrome screenshot.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  clean,
  hexToRgb,
  linearGradientTransform,
  radialGradientTransform,
  fillToPaint,
  normalizeRuns,
  type IRStop,
  type IRFill,
  type IRRun,
  type IRNode,
  type IRSlide,
  type Transform,
  type FigmaPaint,
} from "./lib/figma-map";

// The pure mapping maths now lives in lib/figma-map.ts (shared with the Figma plugin); re-exported so
// existing callers of build.ts keep working.
export * from "./lib/figma-map";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------


export type FontRule = {
  family: string;
  weight?: number | [number, number];
  italic?: boolean;
  wdth?: number | [number, number];
  figma: { family: string; style: string };
  variable?: boolean;
  axes?: string[];
  status?: string;
  note?: string;
};
export type FontMap = { _status?: string; rules: FontRule[] };

export type ResolvedFont = { family: string; style: string; vs?: Record<string, number> };

// ---------------------------------------------------------------------------------------------
// Colour and paint math
// ---------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------

function inRange(v: number, spec: number | [number, number] | undefined): boolean {
  if (spec === undefined) return true;
  return Array.isArray(spec) ? v >= spec[0] && v <= spec[1] : v === spec;
}

export function loadFontMap(path: string): FontMap {
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (!j || !Array.isArray(j.rules)) throw new Error(`${path}: expected { rules: [...] }`);
  return j as FontMap;
}

export function fontKey(r: Pick<IRRun, "fontFamily" | "fontWeight" | "italic" | "variation">): string {
  const wdth = r.variation?.wdth;
  return `${r.fontFamily} / weight ${r.fontWeight} / ${r.italic ? "italic" : "upright"}${wdth !== undefined ? ` / wdth ${wdth}` : ""}`;
}

export function matchFontRule(map: FontMap, run: IRRun): FontRule | undefined {
  const wdth = run.variation?.wdth;
  return map.rules.find(
    (r) =>
      r.family.toLowerCase() === run.fontFamily.toLowerCase() &&
      inRange(run.fontWeight, r.weight) &&
      (r.italic === undefined || r.italic === !!run.italic) &&
      (r.wdth === undefined || (wdth !== undefined && inRange(wdth, r.wdth))),
  );
}

export function resolveFont(map: FontMap, run: IRRun): ResolvedFont | null {
  const rule = matchFontRule(map, run);
  if (!rule) return null;
  const out: ResolvedFont = { family: rule.figma.family, style: rule.figma.style };
  if (rule.variable) {
    const axes = rule.axes ?? ["wght", "wdth"];
    const vs: Record<string, number> = {};
    for (const ax of axes) {
      const v = ax === "wght" ? (run.variation?.wght ?? run.fontWeight) : (run.variation as Record<string, number> | undefined)?.[ax];
      if (v !== undefined) vs[ax] = v;
    }
    if (Object.keys(vs).length) out.vs = vs;
  }
  return out;
}

export class UnmappedFontsError extends Error {
  constructor(public unmapped: { key: string; slides: number[] }[]) {
    super(
      `Unmapped fonts (add a rule to fonts.json for each):\n` +
        unmapped.map((u) => `  - ${u.key}  (slides ${u.slides.join(", ")})`).join("\n"),
    );
    this.name = "UnmappedFontsError";
  }
}

/** Throws UnmappedFontsError listing every unmapped (family, weight, italic, wdth) across the slides. */
export function assertFontsMapped(slides: IRSlide[], map: FontMap): void {
  const bad = new Map<string, Set<number>>();
  for (const s of slides)
    for (const n of s.nodes)
      if (n.type === "text")
        for (const r of n.runs)
          if (!matchFontRule(map, r)) {
            const k = fontKey(r);
            if (!bad.has(k)) bad.set(k, new Set());
            bad.get(k)!.add(s.index);
          }
  if (bad.size) throw new UnmappedFontsError([...bad].map(([key, set]) => ({ key, slides: [...set].sort((a, b) => a - b) })));
}

// ---------------------------------------------------------------------------------------------
// Text runs: normalizeRuns lives in lib/figma-map.ts
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Compile IR nodes into the compact form embedded in scripts
// ---------------------------------------------------------------------------------------------

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const radiusOf = (r?: number[]) => (r && r.length === 4 ? r.map(r3) : [0, 0, 0, 0]);

export type CompiledNode = Record<string, unknown> & { t: "rect" | "text" | "svg" | "image"; n: string };

export function compileNode(node: IRNode, map: FontMap, warnings: string[], where: string): CompiledNode {
  const base = { n: node.name || node.type, x: r3(node.x), y: r3(node.y), w: r3(node.w), h: r3(node.h), o: r3(node.opacity ?? 1) };
  switch (node.type) {
    case "rect": {
      const c: CompiledNode = {
        t: "rect", ...base,
        fills: node.fills.map((f) => fillToPaint(f, node.w, node.h)),
        r: radiusOf(node.radius),
      };
      if (node.stroke && node.stroke.width > 0)
        c.stroke = { color: hexToRgb(node.stroke.color), opacity: r3(node.stroke.opacity ?? 1), width: r3(node.stroke.width) };
      return c;
    }
    case "image": {
      if (node.scaleMode === "CROP") warnings.push(`${where} "${node.name}": scaleMode CROP has no imageTransform in the IR, built as FILL`);
      return {
        t: "image", ...base, ref: node.ref,
        scaleMode: node.scaleMode === "FIT" ? "FIT" : "FILL",
        r: radiusOf(node.radius),
      };
    }
    case "svg":
      return { t: "svg", ...base, svg: node.svg };
    case "text": {
      const runs = normalizeRuns(node.characters.length, node.runs);
      if (runs.length === 0) throw new Error(`${where} "${node.name}": text has no usable runs`);
      return {
        t: "text", ...base,
        chars: node.characters,
        align: node.align,
        wrap: !!node.wrap,
        runs: runs.map((r) => {
          const f = resolveFont(map, r);
          if (!f) throw new UnmappedFontsError([{ key: fontKey(r), slides: [] }]);
          const fill: Record<string, unknown> = { color: hexToRgb(r.color) };
          if (r.colorOpacity !== undefined && r.colorOpacity < 1) fill.opacity = r3(r.colorOpacity);
          const o: Record<string, unknown> = {
            s: r.start, e: r.end, f,
            size: r3(r.fontSize), lh: r3(r.lineHeightPx), ls: r3(r.letterSpacingPx), fill,
          };
          if (r.decoration && r.decoration !== "NONE") o.deco = r.decoration;
          return o;
        }),
      };
    }
    default:
      throw new Error(`${where}: unknown node type ${(node as { type: string }).type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Script generation: the runtime that runs inside Figma
// ---------------------------------------------------------------------------------------------

// Plain string on purpose (no template literal), so nothing in it can be interpolated by accident.
const RUNTIME = [
  'const NS = "designfigma";',
  "const errors = [];",
  "let cur = null;",
  "function errMsg(e) { return String((e && e.message) || e); }",
  "function paintsOf(list, name, quiet) {",
  "  const out = [];",
  "  for (const p of list) {",
  "    if (p.imageRef !== undefined) {",
  '      const h = figma.root.getSharedPluginData(NS, "img:" + p.imageRef);',
  '      if (!h) { if (!quiet) errors.push({ node: name, error: "image not uploaded: " + p.imageRef }); continue; }',
  '      out.push({ type: "IMAGE", scaleMode: p.scaleMode, imageHash: h });',
  "    } else out.push(p);",
  "  }",
  "  return out;",
  "}",
  "function setRadii(n, r) { n.topLeftRadius = r[0]; n.topRightRadius = r[1]; n.bottomRightRadius = r[2]; n.bottomLeftRadius = r[3]; }",
  "function pos(n, d) { n.x = d.x; n.y = d.y; n.opacity = d.o; }",
  "function buildRect(slide, d) {",
  "  const n = figma.createRectangle(); cur = n; slide.appendChild(n);",
  "  n.name = d.n; n.resize(Math.max(0.01, d.w), Math.max(0.01, d.h));",
  "  n.fills = paintsOf(d.fills, d.n); setRadii(n, d.r);",
  "  if (d.stroke) { n.strokes = [{ type: 'SOLID', color: d.stroke.color, opacity: d.stroke.opacity }]; n.strokeWeight = d.stroke.width; n.strokeAlign = 'INSIDE'; }",
  "  pos(n, d);",
  "}",
  "function buildImage(slide, d) {",
  "  const n = figma.createRectangle(); cur = n; slide.appendChild(n);",
  "  n.name = d.n; n.resize(Math.max(0.01, d.w), Math.max(0.01, d.h));",
  "  const ps = paintsOf([{ imageRef: d.ref, scaleMode: d.scaleMode }], d.n, true);",
  '  if (!ps.length) throw new Error("image not uploaded: " + d.ref);',
  "  n.fills = ps; setRadii(n, d.r); pos(n, d);",
  "}",
  "function buildSvg(slide, d) {",
  "  const f = figma.createNodeFromSvg(d.svg); cur = f; slide.appendChild(f);",
  "  f.name = d.n;",
  "  if (Math.abs(f.width - d.w) > 0.5 || Math.abs(f.height - d.h) > 0.5) {",
  "    for (const c of f.children) { try { c.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }; } catch (_) {} }",
  "    f.resize(Math.max(0.01, d.w), Math.max(0.01, d.h));",
  "  }",
  "  pos(f, d);",
  "}",
  "function fontOf(f) { return f.vs ? { family: f.family, style: f.style, variationSettings: f.vs } : { family: f.family, style: f.style }; }",
  "function buildText(slide, d) {",
  "  const t = figma.createText(); cur = t; slide.appendChild(t);",
  "  t.name = d.n;",
  "  t.fontName = fontOf(d.runs[0].f);",
  "  t.characters = d.chars;",
  "  t.textAlignHorizontal = d.align;",
  "  const soft = function (label, fn) { try { fn(); } catch (e) { errors.push({ node: d.n, error: label + ': ' + errMsg(e) }); } };",
  "  for (const r of d.runs) {",
  "    soft('font', function () { t.setRangeFontName(r.s, r.e, fontOf(r.f)); });",
  "    soft('size', function () { t.setRangeFontSize(r.s, r.e, r.size); });",
  "    soft('lineHeight', function () { t.setRangeLineHeight(r.s, r.e, { unit: 'PIXELS', value: r.lh }); });",
  "    soft('letterSpacing', function () { t.setRangeLetterSpacing(r.s, r.e, { unit: 'PIXELS', value: r.ls }); });",
  "    soft('fill', function () { t.setRangeFills(r.s, r.e, [Object.assign({ type: 'SOLID' }, r.fill)]); });",
  "    if (r.deco) soft('decoration', function () { t.setRangeTextDecoration(r.s, r.e, r.deco); });",
  "  }",
  "  let x = d.x;",
  "  if (d.wrap) { t.resize(Math.max(1, d.w), Math.max(1, d.h)); t.textAutoResize = 'HEIGHT'; }",
  "  else {",
  "    t.textAutoResize = 'WIDTH_AND_HEIGHT';",
  "    if (d.align === 'CENTER') x = d.x + (d.w - t.width) / 2;",
  "    else if (d.align === 'RIGHT') x = d.x + d.w - t.width;",
  "  }",
  "  t.x = x; t.y = d.y; t.opacity = d.o;",
  "}",
].join("\n");

const SLIDE_HEAD = [
  "const grid = figma.getSlideGrid();",
  "let slide = null;",
  "for (const row of grid) for (const s of row) if (s.getSharedPluginData(NS, 'index') === String(META.index)) slide = s;",
  "if (!slide) { for (const row of grid) for (const s of row) if (!slide && s.name === META.name && s.getSharedPluginData(NS, 'index') === '') slide = s; }",
  "const base = { index: META.index, name: META.name, part: META.part, parts: META.parts };",
  "if (META.part === 0) {",
  "  if (slide) { for (const c of slide.children.slice()) c.remove(); }",
  "  else {",
  "    let col = 0;",
  "    if (grid.length > 0) for (const s of grid[0]) { const v = s.getSharedPluginData(NS, 'index'); if (v !== '' && Number(v) < META.index) col++; }",
  "    slide = grid.length === 0 ? figma.createSlide() : figma.createSlide(0, col);",
  "  }",
  "  slide.name = META.name;",
  "  slide.setSharedPluginData(NS, 'index', String(META.index));",
  "  slide.fills = paintsOf(META.bg, META.name + ' (background)');",
  "  slide.setSharedPluginData(NS, 'done', '0');",
  "} else {",
  "  if (!slide) return Object.assign({ ok: false, fatal: 'slide not found; run part 0 first' }, base);",
  "  const done = Number(slide.getSharedPluginData(NS, 'done') || '0');",
  "  if (done !== META.start) return Object.assign({ ok: false, fatal: 'out of order: slide has ' + done + ' nodes, this part starts at ' + META.start }, base);",
  "}",
].join("\n");

const SLIDE_LOOP = [
  "const KINDS = { rect: buildRect, text: buildText, svg: buildSvg, image: buildImage };",
  "let created = 0;",
  "for (const d of NODES) {",
  "  cur = null;",
  "  try { KINDS[d.t](slide, d); created++; }",
  "  catch (e) {",
  "    errors.push({ node: d.n, type: d.t, error: errMsg(e) });",
  "    try { if (cur && !cur.removed) cur.remove(); } catch (_) {}",
  "  }",
  "}",
  "slide.setSharedPluginData(NS, 'done', String(META.start + NODES.length));",
  "return Object.assign({ ok: errors.length === 0 && fontErrors.length === 0, slideId: slide.id, expected: NODES.length, created: created, childCount: slide.children.length, errors: errors, fontErrors: fontErrors }, base);",
].join("\n");

const FONT_LOAD = [
  "const fontErrors = [];",
  "await Promise.all(",
  "  [{ family: 'Inter', style: 'Regular' }].concat(FONTS).map(function (f) {",
  "    return figma.loadFontAsync(f).catch(function (e) { fontErrors.push({ font: f.family + ' / ' + f.style, error: errMsg(e) }); });",
  "  })",
  ");",
].join("\n");

export type Part = { file: string; code: string; nodeStart: number; nodeEnd: number };

function fontsOf(nodes: CompiledNode[]): { family: string; style: string }[] {
  const seen = new Map<string, { family: string; style: string }>();
  for (const n of nodes)
    if (n.t === "text")
      for (const r of n.runs as { f: ResolvedFont }[])
        seen.set(`${r.f.family}\u0000${r.f.style}`, { family: r.f.family, style: r.f.style });
  return [...seen.values()];
}

function renderPart(meta: Record<string, unknown>, nodes: CompiledNode[]): string {
  const header = `// design-figma build.ts (generated, do not edit): slide ${meta.index} "${String(meta.name).replace(/[\r\n]+/g, " ")}" part ${meta.part} of ${meta.parts}`;
  return [
    header,
    `const META = ${JSON.stringify(meta)};`,
    `const FONTS = ${JSON.stringify(fontsOf(nodes))};`,
    `const NODES = ${JSON.stringify(nodes)};`,
    RUNTIME,
    FONT_LOAD,
    SLIDE_HEAD,
    SLIDE_LOOP,
    "",
  ].join("\n");
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Greedy split of node sizes into runs of consecutive nodes whose sizes sum to <= budget. A node bigger than the budget gets its own part. */
export function splitBySize(sizes: number[], budget: number): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (i > start && sum + sizes[i] > budget) {
      out.push([start, i]);
      start = i;
      sum = 0;
    }
    sum += sizes[i];
  }
  if (sizes.length === 0 || start < sizes.length) out.push([start, sizes.length]);
  return out;
}

const pad3 = (n: number) => String(n).padStart(3, "0");

export function slideFileName(index: number, part: number): string {
  return part === 0 ? `slide-${pad3(index + 1)}.js` : `slide-${pad3(index + 1)}.part${part}.js`;
}

export function buildSlideScripts(
  ir: IRSlide,
  map: FontMap,
  maxBytes: number,
  warnings: string[] = [],
): { parts: Part[]; compiled: CompiledNode[] } {
  const where = `slide ${ir.index}`;
  const compiled = ir.nodes.map((n) => compileNode(n, map, warnings, where));
  const bg = (ir.background?.length ? ir.background : [{ type: "solid", color: "#FFFFFF", opacity: 1 } as IRFill]).map((f) =>
    fillToPaint(f, ir.width, ir.height),
  );
  const label = ir.label && ir.label.trim() ? ir.label.trim() : `Slide ${pad3(ir.index + 1)}`;
  const mk = (part: number, parts: number, start: number, nodes: CompiledNode[]) =>
    renderPart({ index: ir.index, name: label, part, parts, start, bg }, nodes);

  const sizes = compiled.map((n) => bytes(JSON.stringify(n)) + 1);
  const overhead = bytes(mk(0, 1, 0, [])) + 400; // fonts list and part numbers vary a little
  let budget = maxBytes - overhead;
  if (budget < 200) throw new Error(`--max-bytes ${maxBytes} is smaller than the ${overhead} byte script runtime`);

  for (let attempt = 0; attempt < 12; attempt++) {
    const ranges = splitBySize(sizes, budget);
    const parts: Part[] = ranges.map(([a, b], k) => ({
      file: slideFileName(ir.index, k),
      code: mk(k, ranges.length, a, compiled.slice(a, b)),
      nodeStart: a,
      nodeEnd: b,
    }));
    const tooBig = parts.filter((p) => bytes(p.code) > maxBytes && p.nodeEnd - p.nodeStart > 1);
    if (tooBig.length === 0) {
      for (const p of parts)
        if (bytes(p.code) > maxBytes)
          warnings.push(`${where}: ${p.file} is ${bytes(p.code)} bytes (> ${maxBytes}); a single node (${JSON.stringify(compiled[p.nodeStart].n)}) cannot be split`);
      return { parts, compiled };
    }
    budget = Math.floor(budget * 0.85);
  }
  throw new Error(`${where}: could not split under ${maxBytes} bytes`);
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

const B64_FALLBACK = [
  "function b64(s) {",
  "  if (typeof figma.base64Decode === 'function') return figma.base64Decode(s);",
  "  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';",
  "  const out = []; let acc = 0, bits = 0;",
  "  for (let i = 0; i < s.length; i++) { const v = A.indexOf(s[i]); if (v < 0) continue; acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }",
  "  return new Uint8Array(out);",
  "}",
].join("\n");

export function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [""];
}

export function imageKey(ref: string): string {
  return basename(ref, extname(ref));
}

/** One script when the base64 fits, otherwise chunked scripts (stash in plugin data, last one assembles). */
export function buildImageScripts(ref: string, b64: string, maxBytes: number): { file: string; code: string }[] {
  const key = imageKey(ref);
  const finish = (dataExpr: string) =>
    [
      B64_FALLBACK,
      `const REF = ${JSON.stringify(ref)};`,
      `const bytes = b64(${dataExpr});`,
      "const img = figma.createImage(bytes);",
      "figma.root.setSharedPluginData('designfigma', 'img:' + REF, img.hash);",
      "return { ok: true, ref: REF, hash: img.hash, bytes: bytes.length };",
      "",
    ].join("\n");
  const single = `// design-figma image upload: ${ref}\nconst B64 = ${JSON.stringify(b64)};\n${finish("B64")}`;
  if (bytes(single) <= maxBytes) return [{ file: `${key}.js`, code: single }];

  const chunkSize = Math.max(1000, maxBytes - 2500);
  const chunks = chunkString(b64, chunkSize);
  const total = chunks.length;
  return chunks.map((c, k) => {
    const n = k + 1;
    const head = `// design-figma image upload: ${ref} part ${n} of ${total} (run in order)\nconst CHUNK = ${JSON.stringify(c)};\nconst K = 'chunk:${ref}:';\n`;
    if (n < total)
      return {
        file: `${key}.part${n}.js`,
        code: head + "figma.root.setSharedPluginData('designfigma', K + " + n + ", CHUNK);\nreturn { ok: true, ref: " + JSON.stringify(ref) + ", stashed: " + n + ", of: " + total + " };\n",
      };
    const assemble = [
      "let all = '';",
      `for (let i = 1; i < ${total}; i++) { const p = figma.root.getSharedPluginData('designfigma', K + i); if (!p) return { ok: false, ref: ${JSON.stringify(ref)}, fatal: 'missing chunk ' + i }; all += p; }`,
      "all += CHUNK;",
      `for (let i = 1; i < ${total}; i++) figma.root.setSharedPluginData('designfigma', K + i, '');`,
    ].join("\n");
    return { file: `${key}.part${n}.js`, code: head + assemble + "\n" + finish("all") };
  });
}

type Prepared = { path: string; bytes: number; width: number; height: number; note: string };

async function sipsDims(path: string): Promise<{ w: number; h: number }> {
  const proc = Bun.spawn(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const w = /pixelWidth:\s*(\d+)/.exec(out)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(out)?.[1];
  if (!w || !h) throw new Error(`sips could not read dimensions of ${path}`);
  return { w: +w, h: +h };
}

async function sipsRun(args: string[]): Promise<void> {
  const proc = Bun.spawn(["sips", ...args], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`sips ${args.join(" ")} failed: ${err.trim()}`);
}

/** Downscale/re-encode (macOS sips) when an image is above 4096px or above maxBytes. */
export async function prepareImage(src: string, workDir: string, maxBytes: number, warnings: string[]): Promise<Prepared> {
  const ext = extname(src).toLowerCase();
  const raw = await Bun.file(src).arrayBuffer();
  let w = 0;
  let h = 0;
  try {
    ({ w, h } = await sipsDims(src));
  } catch (e) {
    warnings.push(`image ${basename(src)}: ${(e as Error).message}; uploaded as is`);
    return { path: src, bytes: raw.byteLength, width: 0, height: 0, note: "unmeasured" };
  }
  const needsWork = Math.max(w, h) > 4096 || raw.byteLength > maxBytes || ext === ".webp";
  if (!needsWork) return { path: src, bytes: raw.byteLength, width: w, height: h, note: "as is" };

  mkdirSync(workDir, { recursive: true });
  const isPng = ext === ".png" || ext === ".webp";
  const outExt = isPng ? ".png" : ".jpg";
  const out = join(workDir, basename(src, ext) + outExt);
  let dim = Math.min(4096, Math.max(w, h));
  const qualities = isPng ? [0] : [80, 65];
  let best: { size: number; dim: number; q: number } | null = null;
  for (let round = 0; round < 12; round++) {
    for (const q of qualities) {
      const args = ["-Z", String(dim)];
      if (!isPng) args.push("-s", "format", "jpeg", "-s", "formatOptions", String(q));
      else args.push("-s", "format", "png");
      args.push(src, "--out", out);
      await sipsRun(args);
      const size = Bun.file(out).size;
      best = { size, dim, q };
      if (size <= maxBytes) {
        const d = await sipsDims(out);
        return { path: out, bytes: size, width: d.w, height: d.h, note: `re-encoded ${w}x${h} -> ${d.w}x${d.h}${isPng ? "" : ` q${q}`}, ${raw.byteLength} -> ${size} bytes` };
      }
    }
    dim = Math.floor(dim * 0.8);
    if (dim < 128) break;
  }
  const d = await sipsDims(out);
  warnings.push(`image ${basename(src)}: still ${best?.size} bytes after shrinking to ${d.w}x${d.h} (> ${maxBytes}); uploading anyway as chunked scripts`);
  return { path: out, bytes: best?.size ?? 0, width: d.w, height: d.h, note: "best effort" };
}

// ---------------------------------------------------------------------------------------------
// IR loading and CLI
// ---------------------------------------------------------------------------------------------

export function parseSlideSpec(spec: string | undefined, available: number[]): number[] {
  if (!spec || spec === "all") return [...available].sort((a, b) => a - b);
  const want = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad --slides entry "${part}" (use 0-based indexes: 0,16,26-28)`);
    const a = +m[1];
    const b = m[2] !== undefined ? +m[2] : a;
    for (let i = a; i <= b; i++) want.add(i);
  }
  const missing = [...want].filter((i) => !available.includes(i));
  if (missing.length) throw new Error(`--slides asks for ${missing.join(", ")} but no IR file exists for ${missing.length > 1 ? "them" : "it"}`);
  return [...want].sort((a, b) => a - b);
}

export function loadIR(irDir: string): Map<number, { slide: IRSlide; file: string }> {
  const out = new Map<number, { slide: IRSlide; file: string }>();
  for (const f of readdirSync(irDir)) {
    if (!/^slide-\d{3}\.json$/.test(f)) continue;
    const slide = JSON.parse(readFileSync(join(irDir, f), "utf8")) as IRSlide;
    if (typeof slide.index !== "number" || !Array.isArray(slide.nodes)) throw new Error(`${f}: not an IR slide (needs index and nodes)`);
    out.set(slide.index, { slide, file: f });
  }
  return out;
}

export function imageRefsOf(ir: IRSlide): string[] {
  const refs = new Set<string>();
  const fromFills = (fs: IRFill[] | undefined) => (fs ?? []).forEach((f) => f.type === "image" && refs.add(f.ref));
  fromFills(ir.background);
  for (const n of ir.nodes) {
    if (n.type === "rect") fromFills(n.fills);
    if (n.type === "image") refs.add(n.ref);
  }
  return [...refs].sort();
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const irDir = arg(argv, "--ir");
  const outDir = arg(argv, "--out");
  if (!irDir || !outDir) {
    console.error("usage: bun build.ts --ir <ir dir> --out <out dir> [--slides 0,16,26-28|all] [--max-bytes 50000] [--image-max-bytes 300000] [--fonts fonts.json]");
    return 2;
  }
  const maxBytes = Number(arg(argv, "--max-bytes") ?? 50000);
  const imageMax = Number(arg(argv, "--image-max-bytes") ?? 300000);
  const fontsPath = arg(argv, "--fonts") ?? join(dirname(new URL(import.meta.url).pathname), "fonts.json");
  const map = loadFontMap(fontsPath);

  const all = loadIR(resolve(irDir));
  const wanted = parseSlideSpec(arg(argv, "--slides"), [...all.keys()]);
  const slides = wanted.map((i) => all.get(i)!.slide);
  if (slides.length === 0) throw new Error(`no slide-NNN.json files found in ${irDir}`);

  assertFontsMapped(slides, map); // fails loudly before anything is written

  const out = resolve(outDir);
  mkdirSync(join(out, "images"), { recursive: true });
  const warnings: string[] = [];
  const manifest: Record<string, any> = {
    generatedAt: new Date().toISOString(), maxBytes, fontsFile: fontsPath, fontsStatus: map._status ?? "",
    note: "Run images first (images[].scripts in order), then slides (slides[].scripts in order). Each script's return value is its report.",
    images: [], slides: [], fonts: [], warnings,
  };

  // Stale part files from an earlier, more finely split run would be confusing.
  for (const s of slides) {
    const prefix = `slide-${pad3(s.index + 1)}`;
    for (const f of readdirSync(out)) if (f === `${prefix}.js` || new RegExp(`^${prefix}\\.part\\d+\\.js$`).test(f)) rmSync(join(out, f));
  }

  const fontSet = new Map<string, { family: string; style: string; variationSettings?: unknown }>();
  const refs = new Set<string>();
  for (const s of slides) {
    const { parts, compiled } = buildSlideScripts(s, map, maxBytes, warnings);
    for (const p of parts) writeFileSync(join(out, p.file), p.code);
    for (const n of compiled)
      if (n.t === "text")
        for (const r of n.runs as { f: ResolvedFont }[]) fontSet.set(JSON.stringify(r.f), { family: r.f.family, style: r.f.style, variationSettings: r.f.vs });
    const imgs = imageRefsOf(s);
    imgs.forEach((r) => refs.add(r));
    manifest.slides.push({
      index: s.index, label: s.label, nodeCount: s.nodes.length, images: imgs,
      scripts: parts.map((p) => ({ file: p.file, bytes: bytes(p.code), nodes: [p.nodeStart, p.nodeEnd] })),
    });
  }
  manifest.fonts = [...fontSet.values()];

  for (const ref of [...refs].sort()) {
    const src = join(resolve(irDir), ref);
    if (!existsSync(src)) {
      warnings.push(`image ${ref}: file not found at ${src}; no upload script written`);
      continue;
    }
    const prep = await prepareImage(src, join(out, "images", "_prepared"), imageMax, warnings);
    const b64 = Buffer.from(await Bun.file(prep.path).arrayBuffer()).toString("base64");
    const scripts = buildImageScripts(ref, b64, maxBytes);
    for (const sc of scripts) writeFileSync(join(out, "images", sc.file), sc.code);
    manifest.images.push({ ref, note: prep.note, bytes: prep.bytes, scripts: scripts.map((sc) => `images/${sc.file}`) });
  }

  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(
    `built ${slides.length} slide(s) -> ${manifest.slides.reduce((a: number, s: any) => a + s.scripts.length, 0)} script(s), ${manifest.images.length} image(s), ${warnings.length} warning(s) in ${out}`,
  );
  for (const w of warnings) console.warn(`warning: ${w}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof UnmappedFontsError ? e.message : `build failed: ${(e as Error).stack ?? e}`);
      process.exit(1);
    },
  );
}
