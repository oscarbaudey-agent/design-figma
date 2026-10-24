import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UnmappedFontsError,
  assertFontsMapped,
  buildImageScripts,
  buildSlideScripts,
  loadFontMap,
  main,
  parseSlideSpec,
  resolveFont,
  splitBySize,
  type IRNode,
  type IRRun,
  type IRSlide,
  type Transform,
} from "./build";
import { linearGradientTransform, normalizeRuns } from "./lib/figma-map";

const here = import.meta.dir;
const fontMap = loadFontMap(join(here, "fonts.json"));
const sample = JSON.parse(readFileSync(join(here, "fixtures", "sample-slide.json"), "utf8")) as IRSlide;
const pixelB64 = readFileSync(join(here, "fixtures", "assets", "pixel.png")).toString("base64");

// ---- a fake `figma` that enforces the rules that bit us: append before x/y, fonts loaded before text ----
function makeFigma() {
  const violations: string[] = [];
  const loaded = new Set<string>();
  const fontLog: string[] = [];
  const rootData = new Map<string, string>();
  let nextId = 1;
  const grid: any[][] = [];
  const fk = (f: any) => `${f.family}/${f.style}`;

  class Node {
    id = `n${nextId++}`;
    type: string;
    parent: Node | null = null;
    children: Node[] = [];
    removed = false;
    name = "";
    opacity = 1;
    fills: any[] = [];
    width = 100;
    height = 100;
    _x = 0;
    _y = 0;
    data = new Map<string, string>();
    ranges: any[] = [];
    _fontName: any = { family: "Inter", style: "Regular" };
    _chars = "";
    textAutoResize = "NONE";
    constructor(type: string) { this.type = type; }
    get x() { return this._x; }
    set x(v: number) { if (!this.parent) violations.push(`${this.type} "${this.name}" x set before appendChild`); this._x = v; }
    get y() { return this._y; }
    set y(v: number) { if (!this.parent) violations.push(`${this.type} "${this.name}" y set before appendChild`); this._y = v; }
    appendChild(c: Node) { c.parent = this; this.children.push(c); }
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    resize(w: number, h: number) { this.width = w; this.height = h; }
    setSharedPluginData(ns: string, k: string, v: string) { this.data.set(ns + k, v); }
    getSharedPluginData(ns: string, k: string) { return this.data.get(ns + k) ?? ""; }
    get fontName() { return this._fontName; }
    set fontName(f: any) { if (!loaded.has(fk(f))) throw new Error(`unloaded font ${fk(f)}`); this._fontName = f; }
    get characters() { return this._chars; }
    set characters(s: string) {
      if (!loaded.has(fk(this._fontName))) throw new Error(`unloaded font ${fk(this._fontName)}`);
      this._chars = s;
      this.width = s.length * 10;
    }
    setRangeFontName(a: number, b: number, f: any) { if (!loaded.has(fk(f))) throw new Error(`unloaded font ${fk(f)}`); this.ranges.push(["font", a, b, f]); }
    setRangeFontSize(a: number, b: number, v: number) { this.ranges.push(["size", a, b, v]); }
    setRangeLineHeight(a: number, b: number, v: any) { this.ranges.push(["lh", a, b, v]); }
    setRangeLetterSpacing(a: number, b: number, v: any) { this.ranges.push(["ls", a, b, v]); }
    setRangeFills(a: number, b: number, v: any) { this.ranges.push(["fills", a, b, v]); }
    setRangeTextDecoration(a: number, b: number, v: any) { this.ranges.push(["deco", a, b, v]); }
  }

  const figma: any = {
    root: { setSharedPluginData: (ns: string, k: string, v: string) => rootData.set(ns + k, v), getSharedPluginData: (ns: string, k: string) => rootData.get(ns + k) ?? "" },
    getSlideGrid: () => grid.map((r) => [...r]),
    createSlide: (row?: number, col?: number) => {
      const s = new Node("SLIDE");
      if (row === undefined) { if (!grid.length) grid.push([]); grid[grid.length - 1].push(s); }
      else { if (!grid[row]) throw new Error("no such row"); grid[row].splice(col ?? grid[row].length, 0, s); }
      s.parent = new Node("ROW");
      return s;
    },
    createRectangle: () => new Node("RECTANGLE"),
    createText: () => new Node("TEXT"),
    createNodeFromSvg: (svg: string) => { const n = new Node("FRAME"); n.width = 100; n.height = 100; n.children = []; return n; },
    createImage: (bytes: Uint8Array) => ({ hash: "hash" + bytes.length }),
    base64Decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
    loadFontAsync: async (f: any) => { loaded.add(fk(f)); fontLog.push(fk(f)); },
  };
  return { figma, violations, grid, fontLog, rootData };
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = (code: string, figma: unknown): Promise<any> => new AsyncFunction("figma", code)(figma);

// ---------------------------------------------------------------------------------------------

describe("gradient angle math", () => {
  const close = (a: Transform, b: Transform) => {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) expect(a[i][j]).toBeCloseTo(b[i][j], 9);
  };
  test("0deg (to top) on a square", () => close(linearGradientTransform(0, 100, 100), [[0, -1, 1], [1, 0, 0]]));
  test("90deg (to right) on a square is the identity", () => close(linearGradientTransform(90, 100, 100), [[1, 0, 0], [0, 1, 0]]));
  test("135deg on a square runs corner to corner", () => close(linearGradientTransform(135, 100, 100), [[0.5, 0.5, 0], [-0.5, 0.5, 0.5]]));
  test("180deg (to bottom) on a square", () => close(linearGradientTransform(180, 100, 100), [[0, 1, 0], [-1, 0, 1]]));
  test("135deg on a wide box still puts the 0% stop on the top-left corner and 100% on the bottom-right", () => {
    const t = linearGradientTransform(135, 800, 400);
    const at = (px: number, py: number) => t[0][0] * px + t[0][1] * py + t[0][2];
    expect(at(0, 0)).toBeCloseTo(0, 9);
    expect(at(1, 1)).toBeCloseTo(1, 9);
    expect(at(1, 0)).toBeGreaterThan(0);
    expect(at(1, 0)).toBeLessThan(1);
  });
  test("90deg on a wide box keeps x' spanning exactly the box width", () => {
    const t = linearGradientTransform(90, 800, 400);
    expect(t[0][0] * 0 + t[0][2]).toBeCloseTo(0, 9);
    expect(t[0][0] * 1 + t[0][2]).toBeCloseTo(1, 9);
  });
});

describe("run splitting", () => {
  const r = (start: number, end: number, color = "#000000", size = 10) => ({ start, end, color, size });
  test("gaps take the previous style; a leading gap takes the next", () => {
    const out = normalizeRuns(10, [r(2, 4, "#111111"), r(6, 8, "#222222")]);
    expect(out.map((x) => [x.start, x.end, x.color])).toEqual([[0, 6, "#111111"], [6, 10, "#222222"]]);
  });
  test("overlap: the later run wins", () => {
    const out = normalizeRuns(10, [r(0, 10, "#111111"), r(3, 6, "#222222")]);
    expect(out.map((x) => [x.start, x.end, x.color])).toEqual([[0, 3, "#111111"], [3, 6, "#222222"], [6, 10, "#111111"]]);
  });
  test("adjacent identical styles merge", () => {
    const out = normalizeRuns(9, [r(0, 3), r(3, 6), r(6, 9)]);
    expect(out).toEqual([{ start: 0, end: 9, color: "#000000", size: 10 }]);
  });
  test("indexes are clamped to the string and an empty string gives no runs", () => {
    expect(normalizeRuns(4, [r(-5, 99)])).toEqual([{ start: 0, end: 4, color: "#000000", size: 10 }]);
    expect(normalizeRuns(0, [r(0, 3)])).toEqual([]);
  });
  test("the output partitions [0,len) with no gaps or overlaps", () => {
    const out = normalizeRuns(20, [r(5, 9, "#1"), r(7, 15, "#2"), r(18, 30, "#3")]);
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBe(20);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBe(out[i - 1].end);
  });
});

describe("max-bytes split", () => {
  const manyTexts = (n: number): IRSlide => ({
    index: 4, label: "Big slide", width: 1920, height: 1080,
    background: [{ type: "solid", color: "#101010", opacity: 1 }],
    nodes: Array.from({ length: n }, (_, i): IRNode => ({
      type: "text", name: `t${i}`, x: i, y: i * 2, w: 300, h: 40, characters: `Line number ${i}`, align: "LEFT", wrap: false, opacity: 1,
      runs: [{ start: 0, end: 20, fontFamily: "Circular XX Mono", fontWeight: 400, italic: false, fontSize: 24, lineHeightPx: 30, letterSpacingPx: 0, color: "#FFFFFF", colorOpacity: 1, decoration: "NONE" } as IRRun],
    })),
  });

  test("splitBySize keeps order, respects the budget, and isolates an oversize node", () => {
    expect(splitBySize([10, 10, 10, 10], 25)).toEqual([[0, 2], [2, 4]]);
    expect(splitBySize([10, 100, 10], 25)).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(splitBySize([], 25)).toEqual([[0, 0]]);
  });

  test("a slide over --max-bytes becomes several parts, each under the limit, nodes in order", () => {
    const ir = manyTexts(60);
    const whole = buildSlideScripts(ir, fontMap, 1_000_000);
    expect(whole.parts.length).toBe(1);
    const max = 9000;
    const split = buildSlideScripts(ir, fontMap, max);
    expect(split.parts.length).toBeGreaterThan(1);
    for (const p of split.parts) expect(Buffer.byteLength(p.code)).toBeLessThanOrEqual(max);
    expect(split.parts.map((p) => p.file.replace(/^slide-005/, ""))).toEqual(split.parts.map((_, k) => (k === 0 ? ".js" : `.part${k}.js`)));
    let next = 0;
    for (const p of split.parts) { expect(p.nodeStart).toBe(next); next = p.nodeEnd; }
    expect(next).toBe(60);
  });

  test("running every part in order builds all nodes in paint order on one slide; out-of-order is refused", async () => {
    const split = buildSlideScripts(manyTexts(40), fontMap, 8000);
    const { figma, violations, grid } = makeFigma();
    const reports = [];
    for (const p of split.parts) reports.push(await run(p.code, figma));
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(grid[0].length).toBe(1);
    const slide = grid[0][0];
    expect(slide.name).toBe("Big slide");
    expect(slide.children.map((c: any) => c.name)).toEqual(Array.from({ length: 40 }, (_, i) => `t${i}`));
    expect(violations).toEqual([]);

    const fresh = makeFigma();
    await run(split.parts[0].code, fresh.figma);
    const skipped = await run(split.parts[2].code, fresh.figma);
    expect(skipped.ok).toBe(false);
    expect(skipped.fatal).toMatch(/out of order/);
  });
});

describe("unmapped fonts fail loudly", () => {
  test("assertFontsMapped lists every unmapped combination with its slides", () => {
    const ir: IRSlide = JSON.parse(JSON.stringify(sample));
    const t = ir.nodes.find((n) => n.type === "text") as Extract<IRNode, { type: "text" }>;
    t.runs[0].fontFamily = "Comic Sans";
    t.runs[1].fontFamily = "Denim INK";
    t.runs[1].italic = true; // no italic rule for Denim INK
    let err: unknown;
    try { assertFontsMapped([ir], fontMap); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnmappedFontsError);
    const msg = (err as Error).message;
    expect(msg).toContain("Comic Sans");
    expect(msg).toContain("Denim INK / weight 700 / italic");
    expect(msg).toContain("slides 0");
  });

  test("the sample fixture is fully mapped", () => {
    expect(() => assertFontsMapped([sample], fontMap)).not.toThrow();
  });

  test("main() rejects and writes no scripts when a font is unmapped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "build-test-"));
    const ir = join(dir, "ir");
    mkdirSync(join(ir, "assets"), { recursive: true });
    const bad: IRSlide = JSON.parse(JSON.stringify(sample));
    (bad.nodes.find((n) => n.type === "text") as any).runs[0].fontFamily = "Papyrus";
    writeFileSync(join(ir, "slide-001.json"), JSON.stringify(bad));
    const out = join(dir, "figma");
    await expect(main(["--ir", ir, "--out", out])).rejects.toBeInstanceOf(UnmappedFontsError);
    expect(existsSync(out)).toBe(false);
  });

  test("fonts.json marks the two brand fonts unverified and sends variable axes", () => {
    const j = JSON.parse(readFileSync(join(here, "fonts.json"), "utf8"));
    const brand = j.rules.filter((r: any) => r.family === "Denim INK" || r.family === "Circular XX Mono");
    expect(brand.length).toBe(2);
    for (const r of brand) expect(r.status).toContain("UNVERIFIED until probed in Figma");
    const run = { fontFamily: "Denim INK", fontWeight: 700, italic: false, variation: { wght: 700, wdth: 150 } } as IRRun;
    expect(resolveFont(fontMap, run)).toEqual({ family: "Denim INK", style: "Regular", vs: { wght: 700, wdth: 150 } });
  });
});

describe("generated scripts run against a strict fake figma", () => {
  test("sample fixture: no append-order violations, no node errors, fonts loaded before use", async () => {
    const { figma, violations, grid, fontLog } = makeFigma();
    const up = buildImageScripts("assets/pixel.png", pixelB64, 50000);
    expect(up.length).toBe(1);
    expect((await run(up[0].code, figma)).ok).toBe(true);

    const { parts } = buildSlideScripts(sample, fontMap, 50000);
    expect(parts.length).toBe(1);
    const rep = await run(parts[0].code, figma);
    expect(rep.errors).toEqual([]);
    expect(rep.fontErrors).toEqual([]);
    expect(rep.created).toBe(sample.nodes.length);
    expect(violations).toEqual([]);
    expect(fontLog).toContain("Denim INK/Regular");
    expect(fontLog).toContain("Circular XX Mono/Regular");

    const slide = grid[0][0];
    expect(slide.name).toBe("001 Sample");
    expect(slide.children.map((c: any) => c.name)).toEqual(sample.nodes.map((n) => n.name));
    const grad = slide.children[0];
    expect(grad.fills[0].type).toBe("GRADIENT_LINEAR");
    expect(grad.fills[0].gradientTransform).toEqual(linearGradientTransform(135, 800, 400));
    expect(slide.children[2].fills[0]).toEqual({ type: "IMAGE", scaleMode: "FILL", imageHash: "hash" + Buffer.from(pixelB64, "base64").length });
    const headline = slide.children[3];
    expect(headline.textAutoResize).toBe("HEIGHT");
    expect(headline.ranges.filter((r: any) => r[0] === "deco").length).toBe(1);
    const caption = slide.children[4];
    expect(caption.textAutoResize).toBe("WIDTH_AND_HEIGHT");
    expect(caption.x).toBe(100 + (600 - caption.width) / 2); // centred text re-centres after auto-resize
  });

  test("a missing image upload is reported per node and does not kill the slide", async () => {
    const { figma } = makeFigma();
    const { parts } = buildSlideScripts(sample, fontMap, 50000);
    const rep = await run(parts[0].code, figma);
    expect(rep.ok).toBe(false);
    expect(rep.errors.map((e: any) => e.node).sort()).toEqual(["image fill", "photo"]);
    expect(rep.created).toBe(sample.nodes.length - 1); // "photo" is dropped, "image fill" keeps its shape
  });

  test("the fake can fail: x set before appendChild is caught", async () => {
    const { figma, violations } = makeFigma();
    await run("const r = figma.createRectangle(); r.x = 5; return 1;", figma);
    expect(violations.length).toBe(1);
  });

  test("the fake can fail: text set before its font is loaded throws", async () => {
    const { figma } = makeFigma();
    await expect(run("const t = figma.createText(); t.fontName = {family:'Denim INK', style:'Regular'};", figma)).rejects.toThrow(/unloaded font/);
  });

  test("slides built out of order land in deck order by index", async () => {
    const { figma, grid } = makeFigma();
    for (const idx of [5, 2, 9]) {
      const ir: IRSlide = { ...JSON.parse(JSON.stringify(sample)), index: idx, label: `S${idx}`, nodes: [] };
      await run(buildSlideScripts(ir, fontMap, 50000).parts[0].code, figma);
    }
    expect(grid[0].map((s: any) => s.name)).toEqual(["S2", "S5", "S9"]);
  });

  test("re-running part 0 reuses the slide instead of duplicating it", async () => {
    const { figma, grid } = makeFigma();
    const code = buildSlideScripts({ ...sample, nodes: [] }, fontMap, 50000).parts[0].code;
    await run(code, figma);
    await run(code, figma);
    expect(grid[0].length).toBe(1);
  });
});

describe("images and CLI", () => {
  test("a big image is chunked; running the parts in order creates it once", async () => {
    const big = Buffer.alloc(30000, 7).toString("base64");
    const scripts = buildImageScripts("assets/big.jpg", big, 9000);
    expect(scripts.length).toBeGreaterThan(2);
    for (const s of scripts) expect(Buffer.byteLength(s.code)).toBeLessThanOrEqual(9000);
    const { figma, rootData } = makeFigma();
    let last: any;
    for (const s of scripts) last = await run(s.code, figma);
    expect(last.ok).toBe(true);
    expect(last.bytes).toBe(30000);
    expect(rootData.get("designfigmaimg:assets/big.jpg")).toBe("hash30000");
    expect([...rootData].filter(([k, v]) => k.includes("chunk:") && v !== "")).toEqual([]);
  });

  test("parseSlideSpec", () => {
    expect(parseSlideSpec("0,16,26-28", [0, 16, 26, 27, 28, 40])).toEqual([0, 16, 26, 27, 28]);
    expect(parseSlideSpec("all", [3, 1, 2])).toEqual([1, 2, 3]);
    expect(() => parseSlideSpec("99", [0])).toThrow(/99/);
  });

  test("end to end on the fixture: writes scripts, image upload and manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "build-test-"));
    const ir = join(dir, "ir");
    mkdirSync(join(ir, "assets"), { recursive: true });
    writeFileSync(join(ir, "slide-001.json"), JSON.stringify(sample));
    copyFileSync(join(here, "fixtures", "assets", "pixel.png"), join(ir, "assets", "pixel.png"));
    const out = join(dir, "figma");
    expect(await main(["--ir", ir, "--out", out])).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["images", "manifest.json", "slide-001.js"]);
    expect(readdirSync(join(out, "images")).filter((f) => f.endsWith(".js"))).toEqual(["pixel.js"]);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(m.slides[0].images).toEqual(["assets/pixel.png"]);
    expect(m.fonts.map((f: any) => f.family).sort()).toEqual(["Circular XX Mono", "Denim INK"]);
  });
});
