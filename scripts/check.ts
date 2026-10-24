// Checks a Figma build against the IR and the Chrome reference renders.
//
// Usage: bun check.ts --ir <ir dir> --ref <ref dir> --out <serve out dir> [--slides 0,16,26] [--threshold 9]
//        bun check.ts --selftest [--ir <ir dir>] [--ref <ref dir>]
//
// Reads <out>/reports/slide-NNN.json and <out>/shots/slide-NNN.png (written by serve.ts).
// Per slide, nine checks, each PASS or FAIL:
//   diff   pixel score of ref vs shot (scripts/diff.swift, compiled once to scripts/.bin/diff); heatmaps in <out>/heatmaps
//   text   every IR text node's characters equal the report's text node characters, in order (U+2028 line separators
//          removed from the report first, and only those)
//   lines  text nodes with IR `lines`: the report has exactly one U+2028 at each IR index and none elsewhere; every
//          text node's built height is within max(2px, 0.5 x first-run line height) of the IR height (an extra wrapped line)
//   images every IR image node and image fill: the Figma shot crop is not near-flat (luminance std-dev < 2) where the
//          reference crop has detail (scripts/flat.swift, compiled once to scripts/.bin/flat)
//   fills  every IR solid fill (rect fills, text run colours) is found in the report node's fills, +-1 per channel
//   geom   report x/y/w/h within 1px of IR for rect/image/svg; text x/y within 2px; node count and order match
//   fonts  missingFonts empty and errors[] empty (report-level and per node)
//   editable  no report node named "raster:*" (or irType "raster"), and every IR node has a natively built report node
//          (figmaType not "NONE"). Lists each offender. D-008: a raster is a last resort and fails the slide.
//   effects   every IR effect / blendMode / rotation / image filter / group (+mask) is on the matching report node.
//          Report fields read (per node, groups included, children nested under `children` in paint order):
//            effects      [{type}] or ["TYPE"], Figma types NOISE | DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR
//                         (IR noise->NOISE, drop-shadow->DROP_SHADOW, inner-shadow->INNER_SHADOW, layer-blur->LAYER_BLUR,
//                         background-blur->BACKGROUND_BLUR); report must hold at least as many of each type as the IR
//            blendMode    Figma BlendMode string, equal to IR blendMode (absent IR blendMode = not checked)
//            rotation     degrees, clockwise as CSS (the plugin negates Figma's counter-clockwise value), +-0.5; absent = 0
//            imageFilters {exposure,contrast,saturation,temperature,tint,highlights,shadows}: union over the node's image
//                         paints; each IR filter value must be there within 0.02
//            irType "group" + figmaType, `mask` true when the IR group masks, `children` ReportNode[]; child x/y are slide-absolute
// Writes <out>/check-summary.json (adds `zero`, `accepted`, `done`). Exit 0 only when DONE: every slide passes all nine
// checks AND has diff score exactly 0 (zero measurable difference) or is an accepted renderer-only residue (see below). Slides that pass but score above 0 print as OPEN lines
// with the worst 32x32 region and heatmap path. --allow-diff restores the old rule (exit 0 when all nine checks pass).
//
// --selftest builds a perfect fake out dir from the IR (report from IR, shot = copy of ref), confirms all green,
// then applies one fault at a time and confirms the right check goes red and the others stay green.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = import.meta.dir;
const SAMPLE = join(here, "fixtures", "sample"); // neutral sample deck, built by fixtures/make-sample.ts

type Check = "diff" | "text" | "lines" | "images" | "fills" | "geom" | "fonts" | "editable" | "effects";
const CHECKS: Check[] = ["diff", "text", "lines", "images", "fills", "geom", "fonts", "editable", "effects"];
const LS = "\u2028";
const FLAT_STD = 2;     // luminance std-dev (of 255) below which a crop counts as blank
type Result = { pass: boolean; detail: string };
type SlideResult = { file: string; index: number; checks: Record<Check, Result>; score: number | null; pass: boolean };

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const has = (n: string) => argv.includes(n);

// ---------- diff binary ----------
function ensureDiffBin(): string { return ensureBin("diff"); }
function ensureBin(name: string): string {
  const bin = join(here, ".bin", name);
  const src = join(here, name + ".swift");
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(join(here, ".bin"), { recursive: true });
    const p = Bun.spawnSync(["swiftc", "-O", src, "-o", bin], { stderr: "pipe", stdout: "pipe" });
    if (p.exitCode !== 0) throw new Error("swiftc failed: " + p.stderr.toString());
    // keep .bin out of git
    const gi = join(here, ".gitignore");
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!/^\.bin\/?$/m.test(cur)) writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".bin/\n");
  }
  return bin;
}

// ---------- helpers ----------
const pad = (i: number) => String(i + 1).padStart(3, "0");
const hexToRgb = (h: string) => { const m = /^#?([0-9a-f]{6})/i.exec(h); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
function parseFill(s: string): { rgb: number[]; op: number } | null {
  const [h, o] = String(s).split("@");
  const rgb = hexToRgb(h);
  return rgb ? { rgb, op: o === undefined ? 1 : Number(o) } : null;
}
function irSolids(n: any): { hex: string; op: number }[] {
  if (n.type === "rect") return (n.fills || []).filter((f: any) => f.type === "solid").map((f: any) => ({ hex: f.color, op: f.opacity ?? 1 }));
  if (n.type === "text") {
    const seen = new Map<string, number>();
    for (const r of n.runs || []) seen.set(String(r.color).toUpperCase(), r.colorOpacity ?? 1);
    return [...seen].map(([hex, op]) => ({ hex, op }));
  }
  return [];
}

// IR and report trees pair up by position; `group` nodes hold their children in paint order. Leaves are the non-group
// pairs in paint order (what text/fills/geom/images check); `all` also holds the groups.
type Pair = [any, any];
function pairUp(irN: any[], repN: any[] | undefined, out: Pair[]) {
  for (let i = 0; i < irN.length; i++) {
    const a = irN[i], b = repN ? repN[i] : undefined;
    out.push([a, b]);
    if (a.type === "group") pairUp(a.children || [], b && b.irType === "group" ? b.children : undefined, out);
  }
}
const pairsOf = (ir: any, rep: any): Pair[] => { const o: Pair[] = []; pairUp(ir.nodes || [], rep ? rep.nodes : undefined, o); return o; };
const flatIr = (nodes: any[]): any[] => (nodes || []).flatMap((n) => n.type === "group" ? flatIr(n.children || []) : [n]);
const flatRep = (nodes: any[]): any[] => (nodes || []).flatMap((n) => n.irType === "group" ? flatRep(n.children || []) : [n]);

// ---------- the per-slide checks (pure, take IR + report) ----------
function checkText(ir: any, rep: any): Result {
  const a = flatIr(ir.nodes).filter((n: any) => n.type === "text").map((n: any) => n.characters);
  const b = flatRep(rep.nodes).filter((n: any) => n.irType === "text").map((n: any) => typeof n.characters === "string" ? n.characters.split(LS).join("") : n.characters);
  const bad: string[] = [];
  if (a.length !== b.length) bad.push(`text node count IR ${a.length} vs report ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i] && bad.length < 4) bad.push(`#${i} expected ${JSON.stringify(a[i])} got ${JSON.stringify(b[i])}`);
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: `${a.length} text nodes exact` };
}
// IR coordinates: the report's characters are the IR characters with U+2028 inserted before each line start.
function lineBreaksOf(chars: string): number[] {
  const out: number[] = []; let i = 0;
  for (const c of chars) { if (c === LS) out.push(i); else i++; }
  return out;
}
function checkLines(ir: any, rep: any): Result {
  const a = flatIr(ir.nodes).filter((n: any) => n.type === "text");
  const b = flatRep(rep.nodes).filter((n: any) => n.irType === "text");
  const bad: string[] = []; let pinned = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const n = a[i], r = b[i];
    const want: number[] = Array.isArray(n.lines) ? n.lines : [];
    if (want.length) {
      pinned++;
      const got = lineBreaksOf(String(r.characters ?? ""));
      if (got.join(",") !== want.join(",") && bad.length < 4)
        bad.push(`"${n.name}" line breaks (U+2028) IR at [${want.join(",")}] vs built at [${got.join(",")}]`);
    }
    const lh = Number(n.runs?.[0]?.lineHeightPx) || 0;
    const tol = Math.max(2, 0.5 * lh);
    const d = Math.abs(Number(r.h) - n.h);
    if (!(d <= tol) && bad.length < 4) bad.push(`"${n.name}" built height ${r.h} vs IR ${n.h} (off ${Number.isNaN(d) ? "NaN" : d.toFixed(1)}, tol ${tol}): extra or missing wrapped line`);
  }
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: `${pinned} pinned text nodes exact, ${Math.min(a.length, b.length)} heights in tolerance` };
}
// Every image node and image fill as a slide-coordinate box. Boxes under 12px or nearly transparent are skipped.
function irImageBoxes(ir: any): { name: string; x: number; y: number; w: number; h: number }[] {
  const out: any[] = [];
  for (const n of flatIr(ir.nodes)) {
    const isImg = n.type === "image" || (n.type === "rect" && (n.fills || []).some((f: any) => f.type === "image"));
    // Crop 4px inside the box so a neighbour's edge or an anti-aliased border row does not count as detail.
    if (isImg && n.w >= 12 && n.h >= 12 && (n.opacity ?? 1) >= 0.2) out.push({ name: n.name, x: n.x + 4, y: n.y + 4, w: n.w - 8, h: n.h - 8 });
  }
  return out;
}
function checkImages(flat: string, ir: any, refPng: string, shot: string): Result {
  const boxes = irImageBoxes(ir);
  if (!boxes.length) return { pass: true, detail: "no images" };
  if (!existsSync(refPng) || !existsSync(shot)) return { pass: false, detail: "missing ref or shot, cannot crop images" };
  const p = Bun.spawnSync([flat, refPng, shot, ...boxes.map((b) => [b.x, b.y, b.w, b.h].join(","))], { stdout: "pipe", stderr: "pipe" });
  let res: { refStd: number | null; shotStd: number | null }[];
  try { res = JSON.parse(p.stdout.toString()); } catch { return { pass: false, detail: "flat failed: " + (p.stderr.toString() || p.stdout.toString()).trim().slice(0, 200) }; }
  const bad: string[] = [];
  res.forEach((r, i) => {
    if (r.refStd === null || r.shotStd === null) return;
    if (r.shotStd < FLAT_STD && r.refStd >= FLAT_STD && bad.length < 4)
      bad.push(`image blank: ${boxes[i].name} at ${boxes[i].x},${boxes[i].y} ${boxes[i].w}x${boxes[i].h} (shot std ${r.shotStd.toFixed(1)}, ref std ${r.refStd.toFixed(1)})`);
  });
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: `${boxes.length} images not blank` };
}
function checkFills(ir: any, rep: any): Result {
  const bad: string[] = []; let n = 0;
  pairsOf(ir, rep).forEach(([node, rn], i) => {
    if (node.type === "group") return;
    const want = irSolids(node);
    if (!want.length) return;
    const got = ((rn?.fills) || []).map(parseFill).filter(Boolean) as { rgb: number[]; op: number }[];
    for (const w of want) {
      n++;
      const wr = hexToRgb(w.hex)!;
      const ok = got.some((g) => g.rgb.every((c, k) => Math.abs(c - wr[k]) <= 1) && Math.abs(g.op - w.op) <= 0.02);
      if (!ok && bad.length < 4) bad.push(`node ${i} "${node.name}" wants ${w.hex}@${w.op}, report has [${(rn?.fills || []).join(",")}]`);
    }
  });
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: `${n} solid fills within +-1` };
}
function checkGeom(ir: any, rep: any): Result {
  const bad: string[] = [];
  const countAll = (ns: any[]): number => (ns || []).reduce((t, x) => t + 1 + (x.irType === "group" || x.type === "group" ? countAll(x.children || []) : 0), 0);
  const pr = pairsOf(ir, rep);
  const nIr = countAll(ir.nodes), nRep = countAll(rep.nodes || []);
  if (nRep !== nIr) bad.push(`node count IR ${nIr} vs report ${nRep}`);
  let n = 0;
  for (let i = 0; i < pr.length; i++) {
    const a = pr[i][0], b = pr[i][1];
    if (!b) { if (bad.length < 4) bad.push(`node ${i} "${a.name}" has no report node`); continue; }
    if (b.irType && b.irType !== a.type) { if (bad.length < 4) bad.push(`node ${i} type IR ${a.type} vs report ${b.irType}`); continue; }
    const keys = a.type === "text" ? ["x", "y"] : ["x", "y", "w", "h"];
    const tol = a.type === "text" ? 2 : 1;
    n++;
    // Unwrapped centre/right text is re-anchored by the plugin after Figma sizes the glyphs, so compare the aligned
    // edge (centre or right edge) instead of the left x. Wrapped and left text compare x directly.
    const anchored = a.type === "text" && !a.wrap && (a.align === "CENTER" || a.align === "RIGHT");
    const mul = a.align === "CENTER" ? 0.5 : 1;
    for (const k of keys) {
      const av = k === "x" && anchored ? a.x + a.w * mul : a[k];
      const bv = k === "x" && anchored ? b.x + (b.w ?? NaN) * mul : b[k];
      const d = Math.abs((bv ?? NaN) - av);
      if (!(d <= tol) && bad.length < 4) bad.push(`node ${i} "${a.name}" ${k}${k === "x" && anchored ? " (" + a.align + " anchor)" : ""} IR ${av} vs ${bv} (off ${Number.isNaN(d) ? "NaN" : d.toFixed(2)}, tol ${tol})`);
    }
  }
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: `${n} nodes in tolerance` };
}
function checkFonts(rep: any): Result {
  const bad: string[] = [];
  const mf = rep.missingFonts || [];
  if (mf.length) bad.push("missing fonts: " + mf.map((f: any) => `${f.family}/${f.style ?? f.weight}`).join(", "));
  const errs = [...(rep.errors || []), ...(rep.nodes || []).filter((n: any) => n.error).map((n: any) => ({ node: n.name, msg: n.error }))];
  if (errs.length) bad.push(`${errs.length} errors, first: ${errs[0].node}: ${errs[0].msg}`);
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: "no missing fonts, no errors" };
}
const FX_TYPE: Record<string, string> = { noise: "NOISE", "drop-shadow": "DROP_SHADOW", "inner-shadow": "INNER_SHADOW", "layer-blur": "LAYER_BLUR", "background-blur": "BACKGROUND_BLUR" };
const FILTER_TOL = 0.02, ROT_TOL = 0.5;
const countBy = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return m; };
const fxTypes = (e: any): string[] => (Array.isArray(e) ? e : []).map((x: any) => (typeof x === "string" ? x : x && x.type)).filter(Boolean);
function irFilters(n: any): Record<string, number> {
  const o: Record<string, number> = {};
  for (const f of [n.filters, ...(n.fills || []).map((f: any) => f.filters)]) if (f) for (const k of Object.keys(f)) if (typeof f[k] === "number" && f[k] !== 0) o[k] = f[k];
  return o;
}
function checkEditable(ir: any, rep: any): Result {
  const bad: string[] = []; let n = 0, total = 0;
  const note = (m: string) => { total++; if (bad.length < 6) bad.push(m); };
  const walk = (ns: any[]) => { for (const r of ns || []) { n++;
    if (String(r.name || "").startsWith("raster:") || r.irType === "raster") note(`raster in build: "${r.name}"`);
    else if (r.figmaType === "NONE") note(`not built natively: "${r.name}" (${r.error || "no node"})`);
    if (r.irType === "group") walk(r.children || []); } };
  walk(rep.nodes || []);
  for (const [a, b] of pairsOf(ir, rep)) if (!b) note(`IR node "${a.name}" (${a.type}) has no report node`);
  return total ? { pass: false, detail: `${total} not native/editable: ` + bad.join("; ") } : { pass: true, detail: `${n} nodes native, no rasters` };
}
function checkEffects(ir: any, rep: any): Result {
  const bad: string[] = []; let n = 0;
  const note = (m: string) => { if (bad.length < 6) bad.push(m); };
  for (const [a, b] of pairsOf(ir, rep)) {
    if (!b) continue; // a missing node is the editable/geom checks' job
    const name = `"${a.name}"`;
    const want = countBy((a.effects || []).map((e: any) => FX_TYPE[e.type] || String(e.type).toUpperCase()));
    const got = countBy(fxTypes(b.effects));
    for (const [t, c] of want) { n++; if ((got.get(t) || 0) < c) note(`${name} wants ${c} ${t} effect(s), report has ${got.get(t) || 0} [${[...got.keys()].join(",")}]`); }
    if (a.blendMode && a.blendMode !== "NORMAL" && a.blendMode !== "PASS_THROUGH") { n++; if (b.blendMode !== a.blendMode) note(`${name} blendMode IR ${a.blendMode} vs report ${b.blendMode ?? "none"}`); }
    if (typeof a.rotation === "number" && Math.abs(a.rotation) > 0.01) { n++; const d = Math.abs(((Number(b.rotation) || 0) - a.rotation) % 360); if (!(Math.min(d, 360 - d) <= ROT_TOL)) note(`${name} rotation IR ${a.rotation} vs report ${b.rotation ?? 0}`); }
    const f = irFilters(a);
    for (const k of Object.keys(f)) { n++; const g = b.imageFilters ? b.imageFilters[k] : undefined; if (!(typeof g === "number" && Math.abs(g - f[k]) <= FILTER_TOL)) note(`${name} image filter ${k} IR ${f[k]} vs report ${g ?? "none"}`); }
    if (a.type === "group") {
      n++;
      if (b.irType !== "group") note(`${name} is a group in the IR but report irType is ${b.irType}`);
      else if (!!a.mask !== !!b.mask) note(`${name} group mask IR ${!!a.mask} vs report ${!!b.mask}`);
    }
  }
  return bad.length ? { pass: false, detail: bad.join("; ") } : { pass: true, detail: `${n} effect/blend/rotation/filter/group properties present` };
}
function checkDiff(bin: string, refPng: string, shot: string, heat: string, threshold: number): { r: Result; score: number | null } {
  if (!existsSync(refPng)) return { r: { pass: false, detail: "missing ref " + refPng }, score: null };
  if (!existsSync(shot)) return { r: { pass: false, detail: "missing shot " + shot }, score: null };
  mkdirSync(dirname(heat), { recursive: true });
  const p = Bun.spawnSync([bin, refPng, shot, heat, "--threshold", String(threshold)], { stdout: "pipe", stderr: "pipe" });
  try {
    const j = JSON.parse(p.stdout.toString());
    return { r: { pass: !!j.pass, detail: `score ${j.score} (threshold ${threshold}) worst ${JSON.stringify(j.worstRegion)}` }, score: j.score };
  } catch {
    return { r: { pass: false, detail: "diff failed: " + (p.stderr.toString() || p.stdout.toString()).trim().slice(0, 200) }, score: null };
  }
}

// ---------- run ----------
function runChecks(irDir: string, refDir: string, outDir: string, files: string[], threshold: number): SlideResult[] {
  const bin = ensureDiffBin(), flat = ensureBin("flat");
  return files.map((file) => {
    const base = file.replace(/\.json$/, "");
    const ir = JSON.parse(readFileSync(join(irDir, file), "utf8"));
    const repPath = join(outDir, "reports", file);
    const checks = {} as Record<Check, Result>;
    let score: number | null = null;
    const d = checkDiff(bin, join(refDir, base + ".png"), join(outDir, "shots", base + ".png"), join(outDir, "heatmaps", base + ".png"), threshold);
    checks.diff = d.r; score = d.score;
    checks.images = checkImages(flat, ir, join(refDir, base + ".png"), join(outDir, "shots", base + ".png"));
    if (!existsSync(repPath)) {
      const miss = { pass: false, detail: "no report at " + repPath };
      checks.text = checks.lines = checks.fills = checks.geom = checks.fonts = checks.editable = checks.effects = miss;
    } else {
      let rep: any;
      try { rep = JSON.parse(readFileSync(repPath, "utf8")); } catch (e) { rep = null; }
      if (!rep) { const bad = { pass: false, detail: "report is not valid JSON" }; checks.text = checks.lines = checks.fills = checks.geom = checks.fonts = checks.editable = checks.effects = bad; }
      else { checks.text = checkText(ir, rep); checks.lines = checkLines(ir, rep); checks.fills = checkFills(ir, rep); checks.geom = checkGeom(ir, rep); checks.fonts = checkFonts(rep); checks.editable = checkEditable(ir, rep); checks.effects = checkEffects(ir, rep); }
    }
    return { file, index: ir.index, checks, score, pass: CHECKS.every((c) => checks[c].pass) };
  });
}
function printResults(rs: SlideResult[]) {
  for (const r of rs) {
    const cells = CHECKS.map((c) => `${c} ${r.checks[c].pass ? "PASS" : "FAIL"}`).join("  ");
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.file.replace(".json", "")}  ${cells}  score ${r.score ?? "n/a"}`);
    for (const c of CHECKS) if (!r.checks[c].pass) console.log(`        ${c}: ${r.checks[c].detail}`);
  }
}
function listFiles(irDir: string, slides?: string): string[] {
  if (slides) return slides.split(",").map((s) => `slide-${pad(Number(s))}.json`);
  return [...new Bun.Glob("slide-*.json").scanSync(irDir)].sort();
}

// ---------- selftest ----------
function perfectReport(ir: any) {
  const figmaType: Record<string, string> = { text: "TEXT", rect: "RECTANGLE", image: "RECTANGLE", svg: "FRAME", group: "GROUP" };
  const one = (n: any): any => {
    const sol = irSolids(n);
    const o: any = { name: n.name, irType: n.type, figmaType: figmaType[n.type], x: n.x, y: n.y, w: n.w, h: n.h };
    if (n.type === "text") {
      const at = new Set<number>(n.lines || []);
      o.characters = [...n.characters].map((c: string, i: number) => (at.has(i) ? LS : "") + c).join("");
    }
    if (sol.length) o.fills = sol.map((s) => `${s.hex.toUpperCase()}@${s.op}`);
    if (n.effects && n.effects.length) o.effects = n.effects.map((e: any) => ({ type: FX_TYPE[e.type] }));
    if (n.blendMode) o.blendMode = n.blendMode;
    if (n.rotation) o.rotation = n.rotation;
    const f = irFilters(n); if (Object.keys(f).length) o.imageFilters = { ...f };
    if (n.type === "group") { o.mask = !!n.mask; o.children = (n.children || []).map(one); }
    return o;
  };
  return { index: ir.index, slideId: "0:" + ir.index, label: ir.label, missingFonts: [], fontsUsed: [], errors: [], nodes: ir.nodes.map(one) };
}
// sips ignores a crop offset of 0 (it centres instead), so pad px+1 each side and crop at offset 1: net shift is px to the right.
function shiftedCopy(src: string, dst: string, px: number) {
  const tmp = dst + ".pad.png";
  Bun.spawnSync(["sips", "--padToHeightWidth", "1080", String(1920 + 2 * (px + 1)), "--padColor", "FF00FF", src, "-o", tmp], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["sips", "-c", "1080", "1920", "--cropOffset", "0", "1", tmp, "-o", dst], { stdout: "pipe", stderr: "pipe" });
  rmSync(tmp, { force: true });
  if (!existsSync(dst)) throw new Error("sips could not make shifted copy");
}

let selfBox = "";
function selftest(irDir: string, refDir: string, threshold: number): boolean {
  const root = mkdtempSync(join(tmpdir(), "design-figma-check-"));
  const out = join(root, "out");
  mkdirSync(join(out, "reports"), { recursive: true });
  mkdirSync(join(out, "shots"), { recursive: true });
  const srcIrDir = irDir;
  const files = listFiles(srcIrDir).filter((f) => existsSync(join(refDir, f.replace(".json", ".png"))));
  if (!files.length) { console.log("FAIL  no IR files with a ref image"); return false; }
  // Work on a private copy of the IR: the target slide gets a pinned line break and one synthetic image box, so the
  // new checks have something to bite on whatever IR the selftest is pointed at.
  irDir = join(root, "ir");
  mkdirSync(irDir, { recursive: true });
  const target = files.includes("slide-002.json") ? "slide-002.json" : files[0];
  const flat = ensureBin("flat");
  const irs: Record<string, any> = {};
  for (const f of files) {
    irs[f] = JSON.parse(readFileSync(join(srcIrDir, f), "utf8"));
    if (f === target) {
      const t = irs[f].nodes.find((n: any) => n.type === "text" && n.characters.length >= 6 && !(n.lines || []).length);
      if (t) t.lines = [3];
      // most detailed 160x160 box of the ref becomes an image node
      const refPng = join(refDir, f.replace(".json", ".png"));
      const grid: string[] = [];
      for (let y = 0; y + 160 <= 1080; y += 160) for (let x = 0; x + 160 <= 1920; x += 160) grid.push(`${x},${y},160,160`);
      const sd = JSON.parse(Bun.spawnSync([flat, refPng, refPng, ...grid], { stdout: "pipe" }).stdout.toString());
      let best = 0; sd.forEach((r: any, i: number) => { if (r.refStd > sd[best].refStd) best = i; });
      const [bx, by] = grid[best].split(",").map(Number);
      irs[f].nodes.push({ type: "image", name: "selftest-image", x: bx, y: by, w: 160, h: 160, ref: "assets/none.png", scaleMode: "FILL", opacity: 1, radius: [0, 0, 0, 0], filters: { saturation: -1, contrast: 0.2 } });
      // synthetic effect node and a masked group, so the editable/effects checks and the group walk have something to bite on
      const sol = (c: string) => [{ type: "solid", color: c, opacity: 1 }];
      irs[f].nodes.push({ type: "rect", name: "selftest-fx", x: 100, y: 100, w: 300, h: 200, fills: sol("#336699"), radius: [0, 0, 0, 0], opacity: 1,
        blendMode: "MULTIPLY", rotation: 12,
        effects: [{ type: "noise", baseFrequency: 0.8, octaves: 2, seed: 3, amount: 0.3, bias: 0, blend: "MULTIPLY", monochrome: true },
                  { type: "drop-shadow", color: "#000000", opacity: 0.25, x: 0, y: 8, blur: 16, spread: 0 }] });
      irs[f].nodes.push({ type: "group", name: "selftest-group", x: 500, y: 100, w: 300, h: 200, mask: true, opacity: 1, children: [
        { type: "rect", name: "selftest-mask", x: 500, y: 100, w: 300, h: 200, fills: sol("#222222"), radius: [0, 0, 0, 0], opacity: 1 },
        { type: "rect", name: "selftest-masked", x: 500, y: 100, w: 300, h: 200, fills: sol("#AA5533"), radius: [0, 0, 0, 0], opacity: 1, blendMode: "SCREEN" }] });
      selfBox = grid[best];
    }
    writeFileSync(join(irDir, f), JSON.stringify(irs[f]));
    writeFileSync(join(out, "reports", f), JSON.stringify(perfectReport(irs[f])));
    copyFileSync(join(refDir, f.replace(".json", ".png")), join(out, "shots", f.replace(".json", ".png")));
  }
  const reportPath = (f: string) => join(out, "reports", f);
  const shotPath = (f: string) => join(out, "shots", f.replace(".json", ".png"));

  let allOk = true;
  const say = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) allOk = false; };

  // baseline
  const base = runChecks(irDir, refDir, out, files, threshold);
  printResults(base);
  say(base.every((r) => r.pass), `baseline: perfect build is green on all ${files.length} slides`);

  type Case = { name: string; expectRed: Check; alsoRed?: Check[]; mutate: () => () => void };
  const editReport = (f: string, fn: (rep: any) => void) => () => {
    const orig = readFileSync(reportPath(f), "utf8"); const rep = JSON.parse(orig); fn(rep);
    writeFileSync(reportPath(f), JSON.stringify(rep));
    return () => writeFileSync(reportPath(f), orig);
  };
  const ir = irs[target];
  const textIdx = ir.nodes.findIndex((n: any) => n.type === "text" && n.characters.length >= 3 && n.characters.length <= 14);
  const rectIdx = ir.nodes.findIndex((n: any) => n.type === "rect" && n.w >= 20 && n.h >= 20);
  const fillIdx = ir.nodes.findIndex((n: any) => n.type === "rect" && (n.fills || []).some((f: any) => f.type === "solid"));
  const byName = (nm: string) => ir.nodes.findIndex((n: any) => n.name === nm);
  const fxIdx = byName("selftest-fx"), grpIdx = byName("selftest-group"), imgIdx = byName("selftest-image");
  const lineIdx = ir.nodes.findIndex((n: any) => n.type === "text" && (n.lines || []).length);
  const cases: Case[] = [
    { name: `one character changed in label "${ir.nodes[textIdx]?.characters}"`, expectRed: "text",
      mutate: editReport(target, (rep) => { const c: string = rep.nodes[textIdx].characters; rep.nodes[textIdx].characters = (c[0] === "Z" ? "Y" : "Z") + c.slice(1); }) },
    { name: `rect "${ir.nodes[rectIdx]?.name}" shifted 3px`, expectRed: "geom",
      mutate: editReport(target, (rep) => { rep.nodes[rectIdx].x += 3; }) },
    { name: "one fill channel changed by 6", expectRed: "fills",
      mutate: editReport(target, (rep) => {
        const [h, o] = rep.nodes[fillIdx].fills[0].split("@"); const n = parseInt(h.slice(1), 16);
        const r = (n >> 16 & 255); const nr = r > 128 ? r - 6 : r + 6;
        rep.nodes[fillIdx].fills[0] = "#" + ((nr << 16) | (n & 0xffff)).toString(16).padStart(6, "0").toUpperCase() + "@" + o;
      }) },
    { name: "missing font added", expectRed: "fonts",
      mutate: editReport(target, (rep) => { rep.missingFonts.push({ family: "Acme Sans", style: "Heavy", weight: 800, wdth: 150 }); }) },
    { name: "U+2028 moved one character later", expectRed: "lines",
      mutate: editReport(target, (rep) => { const c: string = rep.nodes[lineIdx].characters; const k = c.indexOf(LS); rep.nodes[lineIdx].characters = c.slice(0, k) + c[k + 1] + LS + c.slice(k + 2); }) },
    { name: "U+2028 dropped", expectRed: "lines",
      mutate: editReport(target, (rep) => { rep.nodes[lineIdx].characters = rep.nodes[lineIdx].characters.split(LS).join(""); }) },
    { name: "extra wrapped line (built height + one line)", expectRed: "lines",
      mutate: editReport(target, (rep) => { rep.nodes[lineIdx].h += ir.nodes[lineIdx].runs[0].lineHeightPx; }) },
    { name: "a raster node injected (rect renamed raster:svg-filter)", expectRed: "editable",
      mutate: editReport(target, (rep) => { rep.nodes[rectIdx].name = "raster:svg-filter"; }) },
    { name: "a node not built (figmaType NONE)", expectRed: "editable",
      mutate: editReport(target, (rep) => { rep.nodes[rectIdx].figmaType = "NONE"; }) },
    { name: "noise effect dropped", expectRed: "effects",
      mutate: editReport(target, (rep) => { rep.nodes[fxIdx].effects = rep.nodes[fxIdx].effects.filter((e: any) => e.type !== "NOISE"); }) },
    { name: "drop-shadow effect dropped", expectRed: "effects",
      mutate: editReport(target, (rep) => { rep.nodes[fxIdx].effects = rep.nodes[fxIdx].effects.filter((e: any) => e.type !== "DROP_SHADOW"); }) },
    { name: "blendMode changed MULTIPLY -> NORMAL", expectRed: "effects",
      mutate: editReport(target, (rep) => { rep.nodes[fxIdx].blendMode = "NORMAL"; }) },
    { name: "rotation dropped", expectRed: "effects",
      mutate: editReport(target, (rep) => { delete rep.nodes[fxIdx].rotation; }) },
    { name: "image filter saturation dropped", expectRed: "effects",
      mutate: editReport(target, (rep) => { delete rep.nodes[imgIdx].imageFilters.saturation; }) },
    { name: "group mask flag lost", expectRed: "effects",
      mutate: editReport(target, (rep) => { rep.nodes[grpIdx].mask = false; }) },
    { name: "blendMode lost on a node inside a group", expectRed: "effects",
      mutate: editReport(target, (rep) => { delete rep.nodes[grpIdx].children[1].blendMode; }) },
    { name: "fill wrong on a node inside a group", expectRed: "fills",
      mutate: editReport(target, (rep) => { rep.nodes[grpIdx].children[1].fills = ["#AA5539@1"]; }) },
    { name: "group child moved 3px", expectRed: "geom",
      mutate: editReport(target, (rep) => { rep.nodes[grpIdx].children[0].x += 3; }) },
    { name: "image box blanked in the shot", expectRed: "images", alsoRed: ["diff"],
      mutate: () => {
        const orig = shotPath(target) + ".orig"; copyFileSync(shotPath(target), orig);
        const p = Bun.spawnSync([flat, "blank", orig, shotPath(target), selfBox], { stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error("blank failed: " + p.stderr.toString());
        return () => { copyFileSync(orig, shotPath(target)); rmSync(orig); };
      } },
    { name: "shot replaced with a 40px-shifted copy", expectRed: "diff",
      mutate: () => {
        const orig = shotPath(target) + ".orig"; copyFileSync(shotPath(target), orig);
        shiftedCopy(join(refDir, target.replace(".json", ".png")), shotPath(target), 40);
        return () => { copyFileSync(orig, shotPath(target)); rmSync(orig); };
      } },
  ];
  for (const c of cases) {
    const restore = c.mutate();
    const rs = runChecks(irDir, refDir, out, [target], threshold)[0];
    restore();
    const red = CHECKS.filter((k) => !rs.checks[k].pass);
    const ok = red.includes(c.expectRed) && red.every((k) => k === c.expectRed || (c.alsoRed || []).includes(k));
    say(ok, `${c.name}: expected only ${c.expectRed} red, got [${red.join(",") || "none"}]${rs.checks[c.expectRed].pass ? "" : "  (" + rs.checks[c.expectRed].detail.slice(0, 110) + ")"}`);
  }
  // restored state must be green again, so a mutation can't have leaked
  const after = runChecks(irDir, refDir, out, [target], threshold)[0];
  say(after.pass, "after restoring every mutation the slide is green again");
  rmSync(root, { recursive: true, force: true });
  console.log(allOk ? "SELFTEST OK" : "SELFTEST FAILED");
  return allOk;
}

// ---------- main ----------
const threshold = Number(flag("--threshold") ?? 9);
if (has("--selftest")) {
  const ok = selftest(resolve(flag("--ir") ?? join(SAMPLE, "ir")), resolve(flag("--ref") ?? join(SAMPLE, "ref")), threshold);
  process.exit(ok ? 0 : 1);
}
const irA = flag("--ir"), refA = flag("--ref"), outA = flag("--out");
if (!irA || !refA || !outA) {
  console.error("Usage: bun check.ts --ir <ir dir> --ref <ref dir> --out <serve out dir> [--slides 0,16] [--threshold 9] [--allow-diff] [--accept <file>] | --selftest");
  process.exit(2);
}
const irDir = resolve(irA), refDir = resolve(refA), outDir = resolve(outA);
const results = runChecks(irDir, refDir, outDir, listFiles(irDir, flag("--slides")), threshold);
printResults(results);
mkdirSync(outDir, { recursive: true });
// The goal is zero measurable difference (D-010). A slide is done when it passes all nine checks AND either scores
// exactly 0, or is listed in the accepted file (<out>/accepted.json, or --accept <file>) as a renderer-only residue:
// {"slide-043": {"score": 8.077, "reason": "..."}}. An accepted slide goes OPEN again if its score rises above the
// recorded one (+0.01), so a later regression is still caught. Never accept a slide whose nodes differ from the IR.
const acceptPath = flag("--accept") ?? join(outDir, "accepted.json");
const accepted: Record<string, { score: number; reason: string }> = existsSync(acceptPath) ? JSON.parse(readFileSync(acceptPath, "utf8")) : {};
const keyOf = (r: SlideResult) => r.file.replace(".json", "");
const isAccepted = (r: SlideResult) => r.score !== null && accepted[keyOf(r)] !== undefined && r.score <= accepted[keyOf(r)].score + 0.01;
const open = results.filter((r) => r.pass && r.score !== 0 && !isAccepted(r));
const zero = results.filter((r) => r.pass && r.score === 0).length;
const acc = results.filter((r) => r.pass && r.score !== 0 && isAccepted(r));
const done = results.every((r) => r.pass) && open.length === 0;
writeFileSync(join(outDir, "check-summary.json"), JSON.stringify({ threshold, pass: results.every((r) => r.pass), zero, accepted: acc.map(keyOf), done, slides: results }, null, 2));
for (const r of acc) console.log(`ACCEPTED  ${keyOf(r)}  score ${r.score} (ceiling ${accepted[keyOf(r)].score})  ${accepted[keyOf(r)].reason}`);
for (const r of open) {
  const base = keyOf(r), a = accepted[base];
  console.log(`OPEN  ${base}  score ${r.score}${a ? ` ABOVE accepted ceiling ${a.score}` : ""}  ${r.checks.diff.detail.replace(/^score \S+ \(threshold \S+\) /, "")}  heatmap ${join(outDir, "heatmaps", base + ".png")}`);
}
console.log(`${results.filter((r) => r.pass).length}/${results.length} slides pass, ${zero}/${results.length} at zero difference, ${acc.length} accepted renderer-only${done ? " - DONE" : " - NOT DONE"}`);
if (has("--allow-diff")) process.exit(results.every((r) => r.pass) ? 0 : 1);
process.exit(done ? 0 : 1);
