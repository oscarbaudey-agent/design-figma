// Runs the bundled plugin (plugin/code.js, built from plugin/src/code.ts) against a strict mock of the
// Figma plugin API, feeding it the real IR slides. The mock throws on the mistakes that bit us before:
// x/y set before appendChild, text edited before its font is loaded, font styles that do not exist,
// variation axes a family does not have, malformed paints.
//
// Fixture: the 5 slides of the neutral sample deck (fixtures/sample/ir, built by fixtures/make-sample.ts), or FIGMA_WORK_IR.
// If that directory is not there the real-slide tests are skipped loudly, never silently passed.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRuns, selectFontStyle, parseCssColor, rgbToHex, parseStyleName, clampRadii, pinLines, cleanLines } from "./lib/figma-map";

const here = import.meta.dir;
const IR_DIR = process.env.FIGMA_WORK_IR || join(here, "fixtures", "sample", "ir"); // neutral sample deck
const SLIDE_FILES = ["slide-001", "slide-002", "slide-003", "slide-004", "slide-005"];
const haveIR = existsSync(join(IR_DIR, "slide-001.json"));
if (!haveIR) console.warn(`plugin.test.ts: IR dir ${IR_DIR} not found, real-slide tests are skipped`);
const realTest = haveIR ? test : test.skip;

// ---------------------------------------------------------------------------------------------
// Strict mock figma
// ---------------------------------------------------------------------------------------------

import { makeFigma, DEFAULT_FONTS, INTER_STYLES, BLANK_PNG, type FontDef } from "./lib/mock-figma";

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let bundle = "";
beforeAll(async () => {
  const r = await Bun.$`bun run build:plugin`.cwd(here).quiet().nothrow();
  if (r.exitCode !== 0) throw new Error("build:plugin failed: " + r.stderr.toString());
  bundle = readFileSync(join(here, "..", "plugin", "code.js"), "utf8");
});

function loadPlugin(code: string, fonts?: FontDef[], opts?: Parameters<typeof makeFigma>[1]) {
  const m = makeFigma(fonts, opts);
  new Function("figma", "__html__", code)(m.figma, "<html></html>");
  if (typeof m.figma.ui.onmessage !== "function") throw new Error("plugin did not register figma.ui.onmessage");
  const send = async (msg: any) => {
    const before = m.posted.length;
    await m.figma.ui.onmessage(msg);
    return m.posted.slice(before);
  };
  return { ...m, send };
}

const readIR = (f: string) => JSON.parse(readFileSync(join(IR_DIR, f + ".json"), "utf8"));
const DUMMY = new Uint8Array([1, 2, 3, 4]);
function imagesFor(ir: any): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const fromFills = (fs: any[]) => (fs || []).forEach((f) => f.type === "image" && (out[f.ref] = DUMMY));
  fromFills(ir.background);
  for (const n of ir.nodes) {
    if (n.type === "image") out[n.ref] = DUMMY;
    if (n.type === "rect") fromFills(n.fills);
  }
  return out;
}
const r3 = (n: number) => String(Math.round(n * 1000) / 1000);
function expectedFills(n: any): string[] {
  if (n.type === "image") return ["IMAGE"];
  if (n.type === "svg") return [];
  if (n.type === "text") {
    const tags: string[] = [];
    for (const r of normalizeRuns(n.characters.length, n.runs) as any[]) {
      const tag = `${String(r.color).toUpperCase()}@${r3(r.colorOpacity ?? 1)}`;
      if (!tags.length || tags[tags.length - 1] !== tag) tags.push(tag);
    }
    return tags;
  }
  return n.fills.map((f: any) =>
    f.type === "solid" ? `${String(f.color).toUpperCase()}@${r3(f.opacity ?? 1)}` : f.type === "linear" ? "GRADIENT_LINEAR" : f.type === "radial" ? "GRADIENT_RADIAL" : "IMAGE",
  );
}
const close = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

/** Everything a correct build must satisfy. Returns the list of failures (empty = pass). */
function checkBuild(ir: any, report: any, m: ReturnType<typeof loadPlugin>): string[] {
  const bad: string[] = [];
  if (!report) return ["no report"];
  if (report.nodes.length !== ir.nodes.length) bad.push(`report.nodes ${report.nodes.length} != IR ${ir.nodes.length}`);
  if (report.errors.length) bad.push(`report.errors: ${JSON.stringify(report.errors.slice(0, 3))}`);
  if (report.index !== ir.index) bad.push("report.index");
  if (report.label !== ir.label) bad.push("report.label");
  if (m.violations.length) bad.push(`mock violations: ${m.violations.slice(0, 3).join("; ")}`);
  const slide = m.grid.flat().find((s: any) => s.getSharedPluginData("designfigma", "index") === String(ir.index));
  if (!slide) return [...bad, "slide not in grid"];
  if (slide.name !== ir.label) bad.push(`slide name ${slide.name}`);
  if (slide.children.length !== ir.nodes.length) bad.push(`slide children ${slide.children.length} != ${ir.nodes.length}`);
  ir.nodes.forEach((n: any, i: number) => {
    const e = report.nodes[i];
    const kid = slide.children[i];
    const tag = `#${i} ${n.type} "${n.name}"`;
    if (!e) return bad.push(`${tag}: no report entry`);
    if (e.error) bad.push(`${tag}: node error ${e.error}`);
    if (e.name !== n.name || e.irType !== n.type) bad.push(`${tag}: name/type`);
    if (n.type === "group") {
      // groups (masks, toned-photo stacks) are built as FRAMEs and checked node by node by check.ts; here: built, same child count
      if (e.figmaType !== "FRAME" || !kid || kid.type !== "FRAME") bad.push(`${tag}: group built as ${e.figmaType}/${kid && kid.type}`);
      else if (kid.children.length !== (n.children || []).length) bad.push(`${tag}: group children ${kid.children.length} != ${(n.children || []).length}`);
      return;
    }
    const want = n.type === "text" ? "TEXT" : n.type === "svg" ? "FRAME" : n.type === "rect" && n.clipsContent ? "FRAME" : "RECTANGLE";
    if (e.figmaType !== want) bad.push(`${tag}: figmaType ${e.figmaType} != ${want}`);
    if (!kid || kid.type !== want) bad.push(`${tag}: mock child type ${kid && kid.type}`);
    if (JSON.stringify(e.fills) !== JSON.stringify(expectedFills(n))) bad.push(`${tag}: fills ${JSON.stringify(e.fills)} != ${JSON.stringify(expectedFills(n))}`);
    if (n.type === "text") {
      // pinned line breaks (D-007): the built text carries U+2028 before each IR `lines` index, runs shift with it
      const pinned = pinLines(n.characters, normalizeRuns(n.characters.length, n.runs) as any[], n.lines);
      if (e.characters !== pinned.characters) bad.push(`${tag}: report characters`);
      if (!kid || kid.characters !== pinned.characters) bad.push(`${tag}: mock characters ${JSON.stringify(kid && kid.characters)} != ${JSON.stringify(pinned.characters)}`);
      // a rotated node's x/y are its rotated corner in Figma, compared by check.ts geom; unrotated ones here
      if (!n.rotation && !close(e.y, n.y, 1.01)) bad.push(`${tag}: y ${e.y} != ${n.y}`); // vertical drift correction moves y by up to 1px
      if (!n.rotation && (n.wrap || n.align === "LEFT") && !close(e.x, n.x)) bad.push(`${tag}: x ${e.x} != ${n.x}`);
      // every run keeps its size, letter spacing and variable-font axes on the node itself
      for (const r of pinned.runs as any[]) {
        if (!kid || kid.type !== "TEXT") break;
        const f = kid.getRangeFontName(r.start, r.end);
        if (r.fontFamily === "Denim INK") {
          const v = f.variationSettings || {};
          if (v.wght !== (r.variation && r.variation.wght !== undefined ? r.variation.wght : r.fontWeight)) bad.push(`${tag}: wght ${v.wght}`);
          if (r.variation && r.variation.wdth !== undefined && v.wdth !== r.variation.wdth) bad.push(`${tag}: wdth ${v.wdth} != ${r.variation.wdth}`);
        }
        if (kid._charSize[r.start] !== r.fontSize) bad.push(`${tag}: size ${kid._charSize[r.start]} != ${r.fontSize}`);
      }
    } else {
      if (!n.rotation && (!close(e.x, n.x) || !close(e.y, n.y) || !close(e.w, n.w) || !close(e.h, n.h))) bad.push(`${tag}: box ${e.x},${e.y},${e.w},${e.h} != ${n.x},${n.y},${n.w},${n.h}`);
      if (!kid || !close(kid.opacity, n.opacity ?? 1, 0.0005)) bad.push(`${tag}: opacity`);
    }
  });
  return bad;
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("bundle", () => {
  test("is a sandbox-safe IIFE: no ?. ?? optional catch, no import/export, no top-level await", () => {
    expect(bundle.startsWith("(() => {")).toBe(true);
    expect(bundle).not.toMatch(/\?\.[A-Za-z_$(\[]/);
    expect(bundle).not.toMatch(/\?\?/);
    expect(bundle).not.toMatch(/catch\s*\{/);
    expect(bundle).not.toMatch(/^\s*(import|export)\s/m);
    expect(bundle).not.toMatch(/\beval\s*\(|new Function\s*\(/);
  });
  test("registers a message handler and shows the UI", () => {
    const p = loadPlugin(bundle);
    expect(typeof p.figma.ui.onmessage).toBe("function");
  });
});

describe("real slides", () => {
  for (const file of SLIDE_FILES) {
    realTest(`${file}: builds every node, no errors, text and fills match the IR`, async () => {
      const ir = readIR(file);
      const p = loadPlugin(bundle);
      const out = await p.send({ type: "build", ir, images: imagesFor(ir) });
      expect(out.filter((m) => m.type === "error")).toEqual([]);
      const built = out.find((m) => m.type === "built");
      expect(built.index).toBe(ir.index);
      expect(checkBuild(ir, built.report, p)).toEqual([]);
      expect(p.notes.length).toBe(1);
      expect(p.notes[0]).toContain(ir.label);
    });

    realTest(`${file}: rebuilding the same slide is idempotent (same children, same single slide)`, async () => {
      const ir = readIR(file);
      const p = loadPlugin(bundle);
      const images = imagesFor(ir);
      const first = (await p.send({ type: "build", ir, images })).find((m) => m.type === "built");
      const slide = p.grid.flat()[0];
      const kids = slide.children.length;
      const second = (await p.send({ type: "build", ir, images })).find((m) => m.type === "built");
      expect(p.grid.flat().length).toBe(1);
      expect(p.grid.flat()[0]).toBe(slide);
      expect(slide.children.length).toBe(kids);
      expect(second.report.slideId).toBe(first.report.slideId);
      expect(second.report.nodes.length).toBe(first.report.nodes.length);
      expect(checkBuild(ir, second.report, p)).toEqual([]);
    });
  }

  realTest("all 5 slides in one session land in deck order, built out of order", async () => {
    const p = loadPlugin(bundle);
    const order = [3, 0, 4, 2, 1];
    for (const i of order) {
      const ir = readIR(SLIDE_FILES[i]);
      const built = (await p.send({ type: "build", ir, images: imagesFor(ir) })).find((m) => m.type === "built");
      expect(checkBuild(ir, built.report, p)).toEqual([]);
    }
    expect(p.grid.length).toBe(1);
    expect(p.grid[0].map((s: any) => s.name)).toEqual(SLIDE_FILES.map((f) => readIR(f).label));
  });

  realTest("deck order holds even when the grid read is stale (real Figma, 2026-10-24)", async () => {
    const p = loadPlugin(bundle);
    p.figma.getCanvasGrid = () => []; // what real Figma effectively gave createSlideFor on the first live build
    const order = [3, 0, 4, 2, 1];
    for (const i of order) {
      const ir = readIR(SLIDE_FILES[i]);
      await p.send({ type: "build", ir, images: imagesFor(ir) });
    }
    expect(p.grid.length).toBe(1);
    expect(p.grid[0].map((s: any) => s.getSharedPluginData("designfigma", "index"))).toEqual(SLIDE_FILES.map((f) => String(readIR(f).index)));
  });

  realTest("removeBlank drops a fresh file's empty starter slide only when asked, never a slide with content", async () => {
    for (const removeBlank of [false, true]) {
      const p = loadPlugin(bundle);
      p.figma.createSlide(); // the blank slide a new Figma Slides file starts with
      const mine = p.figma.createSlide();
      mine.appendChild(p.figma.createRectangle()); // an owner's slide with content
      for (const f of [SLIDE_FILES[1], SLIDE_FILES[0]]) {
        const ir = readIR(f);
        await p.send({ type: "build", ir, images: imagesFor(ir), removeBlank });
      }
      const tags = p.grid.flat().filter((s: any) => !s.removed).map((s: any) => s.getSharedPluginData("designfigma", "index") || (s.children.length ? "mine" : "blank"));
      const deck = [readIR(SLIDE_FILES[0]).index, readIR(SLIDE_FILES[1]).index].map(String);
      expect(tags).toEqual(removeBlank ? [...deck, "mine"] : [...deck, "blank", "mine"]);
    }
  });

  realTest("images are created once per ref across slides (session cache)", async () => {
    const p = loadPlugin(bundle);
    const ir = readIR("slide-001");
    await p.send({ type: "build", ir, images: imagesFor(ir) });
    const n = p.images.size;
    expect(n).toBeGreaterThan(0);
    await p.send({ type: "build", ir, images: imagesFor(ir) });
    expect(p.images.size).toBe(n);
  });

  realTest("fonts: the sample deck's Helvetica Neue weights map to real styles, Menlo stays static; nothing missing", async () => {
    const ir = readIR("slide-002");
    const p = loadPlugin(bundle);
    const rep = (await p.send({ type: "build", ir, images: imagesFor(ir) })).find((m) => m.type === "built").report;
    expect(rep.missingFonts).toEqual([]);
    const styles = new Set(rep.fontsUsed.filter((f: any) => f.family === "Helvetica Neue").map((f: any) => f.style));
    for (const s of ["Regular", "Bold", "Italic", "Medium"]) expect(styles.has(s)).toBe(true);
    const mono = rep.fontsUsed.filter((f: any) => f.family === "Menlo");
    expect(mono.length).toBe(1);
    expect(mono[0].variationSettings).toBeNull();
  });
});

describe("failure handling", () => {
  realTest("a missing font falls back to Inter, is reported, and the build still completes", async () => {
    const ir = readIR("slide-002");
    const noMenlo = DEFAULT_FONTS.filter((f) => f.family !== "Menlo");
    const p = loadPlugin(bundle, noMenlo);
    const rep = (await p.send({ type: "build", ir, images: imagesFor(ir) })).find((m) => m.type === "built").report;
    expect(rep.missingFonts.length).toBeGreaterThan(0);
    expect(rep.missingFonts.every((f: any) => f.family === "Menlo")).toBe(true);
    expect(rep.errors).toEqual([]);
    expect(rep.nodes.length).toBe(ir.nodes.length);
    expect(rep.fontsUsed.some((f: any) => f.family === "Inter")).toBe(true);
    // text content is intact even though the font is not
    const slide = p.grid.flat()[0];
    const texts = ir.nodes.map((n: any, i: number) => [n, slide.children[i]]).filter(([n]: any) => n.type === "text");
    for (const [n, kid] of texts) expect(kid.characters).toBe(pinLines(n.characters, [], n.lines).characters);
    expect(p.violations).toEqual([]);
  });

  realTest("a missing image is reported per node, the other nodes still build, report length stays equal to the IR", async () => {
    const ir = readIR("slide-001");
    const p = loadPlugin(bundle);
    const out = await p.send({ type: "build", ir, images: {} });
    const rep = out.find((m) => m.type === "built").report;
    expect(rep.nodes.length).toBe(ir.nodes.length);
    expect(rep.errors.length).toBeGreaterThan(0);
    const bad = rep.nodes.filter((n: any) => n.error);
    expect(bad.map((n: any) => n.irType)).toContain("image");
    expect(rep.nodes.filter((n: any) => !n.error).length).toBe(ir.nodes.length - bad.length);
    expect(p.grid.flat()[0].children.length).toBe(ir.nodes.length - bad.length);
  });

  test("a node of an unknown type is an entry in errors, not a crash", async () => {
    const p = loadPlugin(bundle);
    const ir = { index: 0, label: "x", width: 1920, height: 1080, background: [], nodes: [{ type: "wat", name: "w", x: 0, y: 0, w: 1, h: 1, opacity: 1 }] };
    const out = await p.send({ type: "build", ir, images: {} });
    const rep = out.find((m) => m.type === "built").report;
    expect(rep.errors.length).toBe(1);
    expect(rep.nodes.length).toBe(1);
  });

  test("a malformed message posts {type:'error'} and the queue keeps working", async () => {
    const p = loadPlugin(bundle);
    const bad = await p.send({ type: "build", ir: null });
    expect(bad[0].type).toBe("error");
    const ok = await p.send({ type: "probe", families: ["Inter"] });
    expect(ok[0].type).toBe("probe-result");
  });
});

describe("probe and export", () => {
  test("probe lists styles per requested family, axes (null = static or missing) and the editor type", async () => {
    const p = loadPlugin(bundle);
    const [res] = await p.send({ type: "probe", families: ["Denim INK", "Circular XX Mono", "Nope Sans"] });
    expect(res.type).toBe("probe-result");
    expect(res.editorType).toBe("slides");
    expect(res.fonts.filter((f: any) => f.family === "Denim INK TRIAL").length).toBe(24);
    expect(res.fonts.filter((f: any) => f.family !== "Denim INK TRIAL")).toEqual([{ family: "Circular XX Mono", style: "Regular" }]);
    expect(res.axes).toEqual({ "Denim INK": ["wght", "ital", "wdth"], "Circular XX Mono": null, "Nope Sans": null });
  });

  realTest("export returns PNG bytes for a built slide at the requested scale; unknown slide is an error", async () => {
    const ir = readIR("slide-001");
    const p = loadPlugin(bundle);
    await p.send({ type: "build", ir, images: imagesFor(ir) });
    const [png] = await p.send({ type: "export", index: ir.index, scale: 2 });
    expect(png.type).toBe("png");
    expect(png.index).toBe(ir.index);
    expect(png.bytes).toBeInstanceOf(Uint8Array);
    expect(p.exports[0].settings).toEqual({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    const [err] = await p.send({ type: "export", index: 99, scale: 1 });
    expect(err.type).toBe("error");
    expect(err.index).toBe(99);
  });
});

describe("the checks can fail", () => {
  test("the mock throws or records on the mistakes it exists to catch", async () => {
    const m = makeFigma();
    const r = m.figma.createRectangle();
    r.x = 5;
    expect(m.violations.length).toBe(1);
    const t = m.figma.createText();
    expect(() => { t.fontName = { family: "Denim INK TRIAL", style: "Regular" }; }).toThrow(/not loaded/);
    await m.figma.loadFontAsync({ family: "Denim INK TRIAL", style: "Regular" });
    expect(() => { t.fontName = { family: "Denim INK TRIAL", style: "Semi Bold" }; }).toThrow(/unknown font style/);
    expect(() => { t.fontName = { family: "Denim INK TRIAL", style: "Regular", variationSettings: { slnt: 1 } }; }).toThrow(/no axis/);
    t.fontName = { family: "Denim INK TRIAL", style: "Regular", variationSettings: { wght: 700, wdth: 150 } };
    expect(() => { t.fills = []; }).toThrow();
    expect(() => { m.figma.createRectangle().fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }]; }).toThrow(/exactly/);
  });

  realTest("sabotage 1: text characters changed in the bundle -> checkBuild goes red", async () => {
    expect(bundle).toContain("t.characters = plan.chars;");
    const bad = bundle.replace("t.characters = plan.chars;", 't.characters = n.characters + "!";');
    const ir = readIR("slide-001");
    const p = loadPlugin(bad);
    const rep = (await p.send({ type: "build", ir, images: imagesFor(ir) })).find((m) => m.type === "built").report;
    const failures = checkBuild(ir, rep, p);
    expect(failures.some((f) => /characters/.test(f))).toBe(true);
  });

  realTest("sabotage 2: text appended after positioning -> the strict mock reports x/y before appendChild", async () => {
    expect(bundle.split("slide.appendChild(t);").length).toBe(2);
    const bad = bundle.replace("slide.appendChild(t);", "");
    const ir = readIR("slide-001");
    const p = loadPlugin(bad);
    const rep = (await p.send({ type: "build", ir, images: imagesFor(ir) })).find((m) => m.type === "built").report;
    expect(checkBuild(ir, rep, p).length).toBeGreaterThan(0);
    expect(p.violations.length).toBeGreaterThan(0);
  });

  realTest("sabotage 3: fonts never loaded -> every text node errors", async () => {
    expect(bundle).toContain("figma.loadFontAsync({ family: need[k].family, style: need[k].style })");
    const bad = bundle.replace("figma.loadFontAsync({ family: need[k].family, style: need[k].style })", "Promise.resolve()");
    const ir = readIR("slide-001");
    const p = loadPlugin(bad);
    const rep = (await p.send({ type: "build", ir, images: imagesFor(ir) })).find((m) => m.type === "built").report;
    expect(rep.errors.length).toBeGreaterThan(0);
    expect(rep.errors.some((e: any) => /not loaded/.test(e.msg))).toBe(true);
  });

  realTest("sabotage 4: rebuild that does not clear children doubles them -> idempotence check goes red", async () => {
    expect(bundle).toContain("clearChildren(slide);");
    const bad = bundle.replace("clearChildren(slide);", "");
    const ir = readIR("slide-001");
    const p = loadPlugin(bad);
    const images = imagesFor(ir);
    await p.send({ type: "build", ir, images });
    await p.send({ type: "build", ir, images });
    expect(p.grid.flat()[0].children.length).toBe(ir.nodes.length * 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Pinned line breaks, vertical drift, image pre-warm, placeholder starter slide (synthetic IR)
// ---------------------------------------------------------------------------------------------

const SEP = "\u2028";
const RUN = { fontFamily: "Inter", fontWeight: 400, italic: false, fontSize: 40, lineHeightPx: 50, letterSpacingPx: 0, colorOpacity: 1, decoration: "NONE" };
function textNode(o: any = {}): any {
  const characters = o.characters ?? "Hello brave new world";
  return {
    type: "text", name: "t", x: 100, y: 200, w: 300, h: 100, characters, align: "LEFT", wrap: true, opacity: 1,
    runs: [
      { ...RUN, start: 0, end: 6, color: "#111111" },
      { ...RUN, start: 6, end: characters.length, color: "#ff0000", fontWeight: 700 },
    ],
    ...o,
  };
}
const slideOf = (nodes: any[], extra: any = {}) => ({ index: 3, label: "S3", width: 1920, height: 1080, background: [], nodes, ...extra });
async function buildOne(code: string, node: any, opts?: Parameters<typeof makeFigma>[1]) {
  const p = loadPlugin(code, undefined, opts);
  const ir = slideOf([node]);
  const built = (await p.send({ type: "build", ir, images: {} })).find((m) => m.type === "built");
  const t = p.grid.flat()[0].children[0];
  return { p, built, t };
}
const sabotage = (from: string, to: string) => {
  expect(bundle).toContain(from);
  return bundle.replace(from, to);
};

describe("pinned line breaks (D-007)", () => {
  test("pinLines inserts U+2028 before each index and shifts runs so styles stay on the same characters", () => {
    const runs = [{ start: 0, end: 6 }, { start: 6, end: 21 }];
    const out = pinLines("Hello brave new world", runs, [6, 12]);
    expect(out.characters).toBe(`Hello ${SEP}brave ${SEP}new world`);
    expect(out.runs).toEqual([{ start: 0, end: 6 }, { start: 6, end: 23 }]);
    expect(out.characters.replace(/\u2028/g, "")).toBe("Hello brave new world");
    expect(pinLines("abc", runs, undefined).characters).toBe("abc");
    expect(pinLines("abc", runs, []).characters).toBe("abc");
    expect(cleanLines(5, [0, 2, 2, 1, 5, 4, 3.5, -1])).toEqual([2, 4]);
  });

  test("characters get U+2028 at each pin, the report carries them, run styles stay on the right characters", async () => {
    const { built, t } = await buildOne(bundle, textNode({ lines: [6, 12] }));
    expect(t.characters).toBe(`Hello ${SEP}brave ${SEP}new world`);
    expect(built.report.nodes[0].characters).toBe(t.characters);
    expect(built.report.errors).toEqual([]);
    const at = (c: string) => t.characters.indexOf(c);
    for (const ch of ["b", "n", "w"]) expect(t._charFills[at(ch)][0].color.r).toBe(1);
    for (const ch of ["H", "o"]) expect(t._charFills[at(ch)][0].color.r).toBeLessThan(0.1);
    expect(t._charFont[at("b")].style).toBe("Bold");
    expect(t._charFont[at("H")].style).toBe("Regular");
  });

  test("box gets slack, HEIGHT sizing, and the visible edge stays put (LEFT/JUSTIFIED keep x, CENTER keeps centre, RIGHT keeps right)", async () => {
    const slack = 12; // 4% of 300
    for (const [align, x] of [["LEFT", 100], ["JUSTIFIED", 100], ["CENTER", 100 - slack / 2], ["RIGHT", 100 - slack]] as const) {
      const { t } = await buildOne(bundle, textNode({ lines: [6, 12], align }));
      expect(t.width).toBe(300 + slack);
      expect(t.textAutoResize).toBe("HEIGHT");
      expect(t.x).toBeCloseTo(x, 6);
    }
    // slack is at least 2px and at most 16px
    expect((await buildOne(bundle, textNode({ lines: [6], w: 20 }))).t.width).toBe(22);
    expect((await buildOne(bundle, textNode({ lines: [6], w: 1000 }))).t.width).toBe(1016);
  });

  test("without lines nothing changes: exact width, no separators", async () => {
    const { t } = await buildOne(bundle, textNode());
    expect(t.characters).toBe("Hello brave new world");
    expect(t.width).toBe(300);
    expect(t.x).toBe(100);
  });

  test("sabotage: pins not applied -> the separators are missing (test goes red)", async () => {
    const bad = sabotage("pinLines(n.characters, runs, n.lines)", "{ characters: n.characters, runs: runs }");
    const { t } = await buildOne(bad, textNode({ lines: [6, 12] }));
    expect(t.characters).not.toContain(SEP);
  });
});

describe("vertical drift", () => {
  const h = (v: number) => ({ textHeight: () => v });
  test("a built height 0.6px off Chrome's, same line count -> y moves by half the difference", async () => {
    const { t } = await buildOne(bundle, textNode({ h: 100, lines: [6] }), h(100.6));
    expect(t.y).toBeCloseTo(200 - 0.3, 6);
    const lower = await buildOne(bundle, textNode({ h: 100, lines: [6] }), h(99.2));
    expect(lower.t.y).toBeCloseTo(200 + 0.4, 6);
  });
  test("no shift when the difference is over 2px or the line count differs", async () => {
    expect((await buildOne(bundle, textNode({ h: 100, lines: [6] }), h(103))).t.y).toBe(200);
    expect((await buildOne(bundle, textNode({ h: 149.5, lines: [6], runs: [{ ...RUN, start: 0, end: 21, color: "#111111", lineHeightPx: 100 }] }), h(151))).t.y).toBe(200);
    expect((await buildOne(bundle, textNode({ h: 100, lines: [6] }), h(100))).t.y).toBe(200);
  });
  test("sabotage: drift correction removed -> y stays at the IR value (test goes red)", async () => {
    const bad = sabotage("y = n.y + dh / 2", "y = n.y");
    expect((await buildOne(bad, textNode({ h: 100, lines: [6] }), h(100.6))).t.y).toBe(200);
  });
});

describe("image pre-warm before export", () => {
  const imgIR = () => slideOf(
    [{ type: "image", name: "pic", x: 0, y: 0, w: 50, h: 50, ref: "a", scaleMode: "FILL", opacity: 1, radius: [0, 0, 0, 0] }],
    { background: [{ type: "image", ref: "bg", scaleMode: "FILL" }] },
  );
  const images = { a: new Uint8Array([1, 2, 3]), bg: new Uint8Array([4, 5, 6]) };
  test("every image on the slide (background included) is decoded before exportAsync, and recorded in the report", async () => {
    const p = loadPlugin(bundle);
    const built = (await p.send({ type: "build", ir: imgIR(), images })).find((m) => m.type === "built");
    expect(built.report.imageHashes.length).toBe(2);
    expect(p.warmed.size).toBe(0);
    const [png] = await p.send({ type: "export", index: 3, scale: 1 });
    expect(p.warmed.size).toBe(2);
    expect(Array.from(png.bytes)).not.toEqual(Array.from(BLANK_PNG));
  });
  test("sabotage: pre-warm skipped -> the mock exports a blank slide (test goes red)", async () => {
    const bad = sabotage("await img.getBytesAsync();", "");
    const p = loadPlugin(bad);
    await p.send({ type: "build", ir: imgIR(), images });
    const [png] = await p.send({ type: "export", index: 3, scale: 1 });
    expect(Array.from(png.bytes)).toEqual(Array.from(BLANK_PNG));
  });
});

describe("blank starter slide", () => {
  async function run(code: string, setup: (f: any) => void) {
    const p = loadPlugin(code);
    setup(p.figma);
    const ir = slideOf([textNode()]);
    await p.send({ type: "build", ir, images: {}, removeBlank: true });
    return p;
  }
  const starter = (f: any, slide: any) => {
    // what a new Slides file's starter slide may hold: empty text placeholders and an empty frame around one
    const a = f.createText();
    slide.appendChild(a);
    const fr = f.createFrame();
    slide.appendChild(fr);
    const b = f.createText();
    fr.appendChild(b);
  };
  const remaining = (p: any) => p.grid.flat().filter((s: any) => !s.removed).map((s: any) => s.getSharedPluginData("designfigma", "index") || s.name);

  test("placeholder-only starter removed; text with characters, filled shapes and filled frames keep their slide", async () => {
    const p = await run(bundle, (f) => {
      starter(f, f.createSlide());
      const withText = f.createSlide();
      withText.name = "has-text";
      const t = f.createText();
      withText.appendChild(t);
      t._chars = "Real words"; // the mock's characters setter needs a loaded font; set the backing field
      const withFill = f.createSlide();
      withFill.name = "has-fill";
      const fr = f.createFrame();
      withFill.appendChild(fr);
      fr.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
      const nested = f.createSlide();
      nested.name = "has-nested-text";
      const g = f.createFrame();
      nested.appendChild(g);
      const t2 = f.createText();
      g.appendChild(t2);
      t2._chars = "deep";
    });
    expect(remaining(p)).toEqual(["3", "has-text", "has-fill", "has-nested-text"]); // the starter (first) is gone
  });

  test("the layout report lists child count and the first 10 child types/names per slide", async () => {
    const p = loadPlugin(bundle);
    const s = p.figma.createSlide();
    starter(p.figma, s);
    for (let i = 0; i < 12; i++) { const r = p.figma.createRectangle(); s.appendChild(r); r.name = "r" + i; }
    const [res] = await p.send({ type: "probe", families: ["Inter"] });
    const sl = res.layout.slides.find((x: any) => x.id === s.id);
    expect(sl.childCount).toBe(14);
    expect(sl.children.length).toBe(10);
    expect(sl.children[0]).toMatchObject({ type: "TEXT", chars: 0 });
    expect(sl.children[1]).toMatchObject({ type: "FRAME", kids: 1 });
  });

  test("sabotage: the old childless-only rule leaves the placeholder starter in place (test goes red)", async () => {
    const bad = sabotage("if (isBlankSlide(s))", "if (!s.children || s.children.length === 0)");
    const p = await run(bad, (f) => starter(f, f.createSlide()));
    expect(remaining(p).length).toBe(2); // the deck slide and the starter that should have gone
  });
});

describe("shared mapping helpers (lib/figma-map.ts)", () => {
  test("parseCssColor handles hex, rgb(), rgba(), space syntax, transparent", () => {
    expect(rgbToHex(parseCssColor("#1e1e1e"))).toBe("#1E1E1E");
    expect(parseCssColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseCssColor("rgba(0, 0, 255, 0.5)")).toEqual({ r: 0, g: 0, b: 1, a: 0.5 });
    expect(parseCssColor("rgb(0 128 0 / 25%)").a).toBe(0.25);
    expect(parseCssColor("#ff000080").a).toBeCloseTo(0.502, 3);
    expect(parseCssColor("transparent").a).toBe(0);
    expect(() => parseCssColor("blue-ish")).toThrow(/bad colour/);
  });
  test("selectFontStyle picks the nearest weight, prefers italic when asked, falls back to upright", () => {
    expect(selectFontStyle(INTER_STYLES, 600, false)).toBe("Semi Bold");
    expect(selectFontStyle(INTER_STYLES, 700, true)).toBe("Bold Italic");
    expect(selectFontStyle(["Regular", "Bold"], 800, false)).toBe("Bold");
    expect(selectFontStyle(["Regular", "Bold"], 400, true)).toBe("Regular");
    expect(selectFontStyle(["Regular"], 900, false)).toBe("Regular");
    expect(selectFontStyle([], 400, false)).toBeNull();
    expect(selectFontStyle(["Light", "Bold"], 550, false)).toBe("Bold"); // 550 is nearer 700 than 300
    expect(parseStyleName("Extra Bold Italic")).toEqual({ weight: 800, italic: true });
    expect(parseStyleName("Semi Bold").weight).toBe(600);
  });
  test("clampRadii limits each corner to half the shorter side", () => {
    expect(clampRadii([100, 4, 0, 2], 40, 20)).toEqual([10, 4, 0, 2]);
    expect(clampRadii(undefined, 10, 10)).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------------------------
// D-008: blend modes, rotation, effects, image filters, TILE, groups and masks, remove job (synthetic IR)
// ---------------------------------------------------------------------------------------------

import { interp1, noiseToFigma, rotationTransform, transformBox, placeRotated, unrotatedIn, cleanImageFilters, effectToFigma, rawNoiseToFigma, blendModeOf, fillToPaint, type NoiseCalibration } from "./lib/figma-map";
import { checkEffect } from "./lib/mock-figma";
import calibration from "./noise-calibration.json";

const CAL = calibration as NoiseCalibration;
const rect = (o: any = {}): any => ({ type: "rect", name: "r", x: 100, y: 200, w: 300, h: 100, fills: [{ type: "solid", color: "#336699", opacity: 1 }], radius: [0, 0, 0, 0], stroke: null, opacity: 1, ...o });
const imageNode = (o: any = {}): any => ({ type: "image", name: "img", x: 10, y: 20, w: 400, h: 300, ref: "assets/p.png", scaleMode: "FILL", opacity: 1, radius: [0, 0, 0, 0], ...o });
const NOISE = { type: "noise", baseFrequency: 0.85, octaves: 2, seed: 7, amount: 0.5, bias: 0.22, blend: "MULTIPLY", monochrome: true };
async function build(nodes: any[], slideIdx = 3) {
  const p = loadPlugin(bundle);
  const out = await p.send({ type: "build", ir: slideOf(nodes, { index: slideIdx }), images: { "assets/p.png": DUMMY } });
  const built = out.find((m) => m.type === "built");
  return { p, built, rep: built && built.report, kids: p.grid.flat()[0] ? p.grid.flat()[0].children : [] };
}

describe("pure mappings", () => {
  test("rotationTransform keeps the centre and turns clockwise; transformBox reads it back", () => {
    const t = rotationTransform(50, 50, 100, 20, 90);
    // the top-left corner of a box turned 90deg clockwise lands where the top-right was relative to the centre
    expect([t[0][2], t[1][2]]).toEqual([110, 10]);
    expect(transformBox(t, 100, 20)).toEqual({ x: 50, y: 50, deg: 90 });
    const t2 = rotationTransform(0, 0, 40, 40, -30);
    expect(transformBox(t2, 40, 40).deg).toBeCloseTo(-30, 3);
    expect(transformBox(t2, 40, 40).x).toBeCloseTo(0, 3);
  });
  test("placeRotated anchors rotated text on its aligned edge when Figma's width differs from Chrome's", () => {
    const box = { x: 100, y: 100, w: 200, h: 40 };
    for (const deg of [30, -8, 90]) {
      // built 150 wide: left-aligned keeps x 100, right-aligned ends at 300, centred sits at 125; top stays 100
      expect(unrotatedIn(placeRotated(box, 150, 40, deg, "LEFT"), 150, 40, box).x).toBeCloseTo(100, 3);
      expect(unrotatedIn(placeRotated(box, 150, 40, deg, "RIGHT"), 150, 40, box).x).toBeCloseTo(150, 3);
      expect(unrotatedIn(placeRotated(box, 150, 40, deg, "CENTER"), 150, 40, box).x).toBeCloseTo(125, 3);
      expect(unrotatedIn(placeRotated(box, 150, 40, deg, "LEFT"), 150, 40, box).y).toBeCloseTo(100, 3);
      // a node built at its IR size is exactly the centred rotationTransform
      expect(placeRotated(box, 200, 40, deg)).toEqual(rotationTransform(100, 100, 200, 40, deg));
      expect(transformBox(placeRotated(box, 150, 40, deg, "LEFT"), 150, 40).deg).toBeCloseTo(deg, 3);
    }
  });
  test("blendModeOf maps CSS-ish names to Figma names and rejects the rest", () => {
    expect(blendModeOf("multiply")).toBe("MULTIPLY");
    expect(blendModeOf("color-dodge")).toBe("COLOR_DODGE");
    expect(blendModeOf("SOFT LIGHT")).toBe("SOFT_LIGHT");
    expect(blendModeOf("plus-lighter")).toBeNull();
    expect(blendModeOf(undefined)).toBeNull();
  });
  test("cleanImageFilters keeps the seven Figma keys, clamps to -1..1, drops all-zero sets", () => {
    expect(cleanImageFilters({ saturation: -1, contrast: 2, bogus: 1 } as any)).toEqual({ saturation: -1, contrast: 1 });
    expect(cleanImageFilters({ exposure: 0 })).toBeNull();
    expect(cleanImageFilters(undefined)).toBeNull();
  });
  test("interp1 is piecewise linear and clamped", () => {
    const pts = [{ k: 0, v: 0 }, { k: 1, v: 10 }, { k: 3, v: 14 }];
    expect(interp1(pts, "k", 0.5, "v")).toBe(5);
    expect(interp1(pts, "k", 2, "v")).toBe(12);
    expect(interp1(pts, "k", -5, "v")).toBe(0);
    expect(interp1(pts, "k", 99, "v")).toBe(14);
    expect(() => interp1([], "k", 1, "v")).toThrow(/empty/);
  });
  test("noiseToFigma follows the calibration table; colour follows the blend, then the bias", () => {
    const tiny: NoiseCalibration = { status: "t", size: [{ baseFrequency: 0, noiseSize: 10 }, { baseFrequency: 1, noiseSize: 2 }], strength: [{ amount: 0, density: 0, alpha: 0 }, { amount: 1, density: 1, alpha: 0.8 }] };
    const fx: any = noiseToFigma({ ...NOISE, baseFrequency: 0.5, amount: 0.5, blend: "MULTIPLY" } as any, tiny);
    expect([fx.noiseSize, fx.density, fx.color.a, fx.noiseType, fx.blendMode]).toEqual([6, 0.5, 0.4, "MONOTONE", undefined]); // Figma rejects blendMode on NOISE
    expect([fx.color.r, fx.color.g, fx.color.b]).toEqual([0, 0, 0]);
    expect((noiseToFigma({ ...NOISE, blend: "SCREEN" } as any, tiny) as any).color.r).toBe(1);
    expect((noiseToFigma({ ...NOISE, blend: "NORMAL", bias: 0.1 } as any, tiny) as any).color.r).toBe(1);
    expect((noiseToFigma({ ...NOISE, blend: "NORMAL", bias: -0.1 } as any, tiny) as any).color.r).toBe(0);
    const multi: any = noiseToFigma({ ...NOISE, monochrome: false } as any, tiny);
    expect([multi.noiseType, multi.opacity, multi.color.a]).toEqual(["MULTITONE", 0.4, 1]);
    checkEffect(fx, { type: "RECTANGLE" });
    checkEffect(multi, { type: "RECTANGLE" });
  });
  test("the shipped calibration table is well-formed and marked honestly", () => {
    expect(["uncalibrated", "calibrated"]).toContain(CAL.status);
    expect(CAL.size.length).toBeGreaterThanOrEqual(2);
    expect(CAL.strength.length).toBeGreaterThanOrEqual(2);
    for (const s of CAL.strength) { expect(s.density).toBeGreaterThanOrEqual(0); expect(s.density).toBeLessThanOrEqual(1); expect(s.alpha).toBeLessThanOrEqual(1); }
    const sizes = CAL.size.slice().sort((a, b) => a.baseFrequency - b.baseFrequency).map((s) => s.noiseSize);
    expect(sizes.every((v, i) => i === 0 || v <= sizes[i - 1]!)).toBe(true); // higher frequency never means bigger grain
  });
  test("fillToPaint passes TILE, scalingFactor and filters through for image fills", () => {
    const p: any = fillToPaint({ type: "image", ref: "a", scaleMode: "TILE", scalingFactor: 0.5, filters: { saturation: -1 } }, 10, 10);
    expect(p).toEqual({ type: "IMAGE", imageRef: "a", scaleMode: "TILE", scalingFactor: 0.5, filters: { saturation: -1 } });
    const q: any = fillToPaint({ type: "image", ref: "a", scaleMode: "FILL", scalingFactor: 3 } as any, 10, 10);
    expect(q.scalingFactor).toBeUndefined();
  });
});

describe("mock strictness (it must reject what real Figma rejects)", () => {
  const R = { type: "RECTANGLE" };
  const shadow = { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 4 }, radius: 8, visible: true, blendMode: "NORMAL" };
  test("accepts well-formed effects", () => {
    checkEffect(shadow, R);
    checkEffect({ type: "LAYER_BLUR", blurType: "NORMAL", radius: 4, visible: true }, R);
    checkEffect({ ...shadow, type: "INNER_SHADOW" }, { type: "FRAME", clipsContent: true, _fills: [{ type: "SOLID" }] });
  });
  test("rejects unknown fields, wrong ranges, missing fields", () => {
    expect(() => checkEffect({ ...shadow, offset: { x: 0 } }, R)).toThrow(/offset/);
    expect(() => checkEffect({ ...shadow, size: 3 }, R)).toThrow(/unknown field "size"/);
    expect(() => checkEffect({ ...shadow, radius: -1 }, R)).toThrow(/radius/);
    expect(() => checkEffect({ ...shadow, blendMode: "MULTIPLYY" }, R)).toThrow(/blendMode/);
    expect(() => checkEffect({ ...shadow, color: { r: 0, g: 0, b: 0 } }, R)).toThrow(/color/);
    expect(() => checkEffect({ type: "LAYER_BLUR", radius: 4 }, R)).toThrow(/visible/);
    expect(() => checkEffect({ type: "GLOW" }, R)).toThrow(/unknown effect type/);
    const noise = rawNoiseToFigma({ noiseSize: 2, density: 0.5, alpha: 0.5 });
    checkEffect(noise, R);
    expect(() => checkEffect({ ...noise, noiseSize: 0 }, R)).toThrow(/noiseSize/);
    expect(() => checkEffect({ ...noise, density: 2 }, R)).toThrow(/density/);
    expect(() => checkEffect({ ...noise, opacity: 1 }, R)).toThrow(/unknown field "opacity"/); // MONOTONE has none
    expect(() => checkEffect({ ...noise, noiseType: "MULTITONE" }, R)).toThrow(/opacity/);
    expect(() => checkEffect({ ...noise, blendMode: "NOPE" }, R)).toThrow(/blendMode/);
  });
  test("shadow spread is refused on text and on a frame that does not clip", () => {
    expect(() => checkEffect({ ...shadow, spread: 3 }, { type: "TEXT" })).toThrow(/spread/);
    expect(() => checkEffect({ ...shadow, spread: 3 }, { type: "FRAME", clipsContent: false, _fills: [{ type: "SOLID" }] })).toThrow(/spread/);
    checkEffect({ ...shadow, spread: 3 }, R);
  });
  test("node properties: blendMode list, mask needs a parent, scalingFactor only on TILE, filters in range", () => {
    const m = makeFigma();
    const r = m.figma.createRectangle();
    expect(() => { r.blendMode = "MULTIPLYY"; }).toThrow(/blendMode/);
    r.blendMode = "MULTIPLY";
    r.isMask = true;
    expect(m.violations.some((v) => /isMask set before appendChild/.test(v))).toBe(true);
    const img = m.figma.createImage(new Uint8Array([1, 2, 3]));
    expect(() => { r.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash, scalingFactor: 2 }]; }).toThrow(/TILE/);
    expect(() => { r.fills = [{ type: "IMAGE", scaleMode: "TILE", imageHash: img.hash, scalingFactor: 0 }]; }).toThrow(/scalingFactor/);
    expect(() => { r.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash, filters: { saturation: 2 } }]; }).toThrow(/-1\.\.1/);
    expect(() => { r.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash, filters: { vibrance: 1 } }]; }).toThrow(/unknown field/);
    r.fills = [{ type: "IMAGE", scaleMode: "TILE", imageHash: img.hash, scalingFactor: 0.5, filters: { saturation: -1 } }];
  });
});

describe("blend mode and rotation", () => {
  test("blendMode lands on the node and in the report; an unknown one is reported, node still built", async () => {
    const { rep, kids } = await build([rect({ blendMode: "MULTIPLY" }), rect({ name: "r2", blendMode: "plus-lighter" })]);
    expect(kids.length).toBe(2);
    expect(kids[0].blendMode).toBe("MULTIPLY");
    expect(rep.nodes[0].blendMode).toBe("MULTIPLY");
    expect(kids[1].blendMode).toBe("PASS_THROUGH");
    expect(rep.nodes[1].error).toMatch(/unknown blendMode/);
  });
  test("rotation turns the node about the centre of the IR box; the report keeps the unrotated box and clockwise degrees", async () => {
    const { rep, kids } = await build([rect({ x: 50, y: 50, w: 100, h: 20, rotation: 90 }), textNode({ name: "tt", x: 400, y: 300, w: 200, h: 50, wrap: true, rotation: -15, characters: "Hi there" })]);
    expect(rep.errors).toEqual([]);
    const r = kids[0];
    expect(r.rotation).toBeCloseTo(-90, 6); // Figma counts counter-clockwise
    const cx = r.relativeTransform[0][0] * 50 + r.relativeTransform[0][1] * 10 + r.relativeTransform[0][2];
    const cy = r.relativeTransform[1][0] * 50 + r.relativeTransform[1][1] * 10 + r.relativeTransform[1][2];
    expect([cx, cy]).toEqual([100, 60]); // centre of the IR box
    const e = rep.nodes[0];
    expect([e.x, e.y, e.w, e.h]).toEqual([50, 50, 100, 20]);
    expect(e.rotation).toBeCloseTo(90, 6);
    expect(rep.nodes[1].rotation).toBeCloseTo(-15, 3);
    expect(kids[1].rotation).toBeCloseTo(15, 3);
    expect(p0(rep.nodes[1].x)).toBeGreaterThan(300); // text kept near its box
  });
  test("a node without rotation reports none", async () => {
    const { rep } = await build([rect()]);
    expect(rep.nodes[0].rotation).toBeUndefined();
    expect(rep.nodes[0].blendMode).toBeUndefined();
    expect(rep.nodes[0].effects).toBeUndefined();
  });
});
const p0 = (n: number) => n;

describe("effects", () => {
  test("noise -> NOISE effect through the calibration table, on rects, frames and text", async () => {
    const { rep, kids } = await build([
      rect({ effects: [NOISE] }),
      rect({ name: "clip", clipsContent: true, effects: [{ ...NOISE, monochrome: false, blend: "SCREEN" }] }),
      textNode({ name: "tx", effects: [NOISE] }),
    ]);
    expect(rep.errors).toEqual([]);
    const fx: any = kids[0].effects[0];
    const want: any = noiseToFigma(NOISE as any, CAL);
    expect(fx).toEqual(want);
    expect(fx.noiseType).toBe("MONOTONE");
    expect(fx.noiseSize).toBeCloseTo(interp1(CAL.size, "baseFrequency", 0.85, "noiseSize"), 5);
    expect((kids[1].effects[0] as any).noiseType).toBe("MULTITONE");
    expect(kids[2].effects.length).toBe(1);
    expect(rep.nodes.map((n: any) => n.effects)).toEqual([[{ type: "NOISE" }], [{ type: "NOISE" }], [{ type: "NOISE" }]]);
  });
  test("drop and inner shadow, layer and background blur map to the standard Figma effects", async () => {
    const { rep, kids } = await build([
      rect({ effects: [
        { type: "drop-shadow", color: "#112233", opacity: 0.4, x: 2, y: 8, blur: 16, spread: 3 },
        { type: "inner-shadow", color: "#ffffff", opacity: 1, x: 0, y: 1, blur: 2, spread: 0 },
        { type: "layer-blur", radius: 5 },
        { type: "background-blur", radius: 10 },
      ] }),
    ]);
    expect(rep.errors).toEqual([]);
    const [d, i, lb, bb]: any[] = kids[0].effects;
    expect(d.type).toBe("DROP_SHADOW");
    expect([d.color.r, d.color.g, d.color.b].map((v: number, i: number) => Math.round(v * 255) - [0x11, 0x22, 0x33][i]!)).toEqual([0, 0, 0]);
    expect(d.color.a).toBe(0.4);
    expect([d.offset, d.radius, d.spread]).toEqual([{ x: 2, y: 8 }, 16, 3]);
    expect(i.type).toBe("INNER_SHADOW");
    expect(i.spread).toBeUndefined();
    expect([lb.type, lb.radius, bb.type, bb.radius]).toEqual(["LAYER_BLUR", 10, "BACKGROUND_BLUR", 20]); // CSS sigma x2
    expect(rep.nodes[0].effects.map((e: any) => e.type)).toEqual(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]);
  });
  test("shadow spread on text is dropped and reported, not thrown", async () => {
    const { rep, kids } = await build([textNode({ effects: [{ type: "drop-shadow", color: "#000000", opacity: 0.5, x: 0, y: 2, blur: 4, spread: 2 }] })]);
    expect(kids[0].effects[0].spread).toBeUndefined();
    expect(rep.nodes[0].error).toMatch(/spread/);
  });
  test("figmaNoise (calibration only) replaces the IR noise and passes raw Figma parameters", async () => {
    const { rep, kids } = await build([rect({ effects: [NOISE], figmaNoise: { noiseSize: 3, density: 0.4, alpha: 0.25, color: "#ffffff" } })]);
    expect(rep.errors).toEqual([]);
    expect(kids[0].effects.length).toBe(1);
    const fx: any = kids[0].effects[0];
    expect([fx.noiseSize, fx.density, fx.color]).toEqual([3, 0.4, { r: 1, g: 1, b: 1, a: 0.25 }]);
  });
});

describe("image filters and TILE", () => {
  test("STRETCH maps the whole image onto the box: Figma CROP with the identity imageTransform", async () => {
    const { rep, kids } = await build([imageNode({ scaleMode: "STRETCH", w: 204.6, h: 55.5 })]);
    expect(rep.errors).toEqual([]);
    expect(kids[0].fills[0].scaleMode).toBe("CROP");
    expect(kids[0].fills[0].imageTransform).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect([kids[0].width, kids[0].height]).toEqual([204.6, 55.5]);
    const { kids: k2 } = await build([imageNode()]);
    expect(k2[0].fills[0].scaleMode).toBe("FILL");
    expect(k2[0].fills[0].imageTransform).toBeUndefined();
  });
  test("an image node carries filters; they are clamped and reported", async () => {
    const { rep, kids } = await build([imageNode({ filters: { saturation: -1, contrast: 0.3, exposure: 5 } })]);
    expect(rep.errors).toEqual([]);
    expect(kids[0].fills[0].filters).toEqual({ saturation: -1, contrast: 0.3, exposure: 1 });
    expect(rep.nodes[0].imageFilters).toEqual({ saturation: -1, contrast: 0.3, exposure: 1 });
  });
  test("TILE with scalingFactor on an image node and on a rect's image fill", async () => {
    const { rep, kids } = await build([
      imageNode({ scaleMode: "TILE", scalingFactor: 0.5 }),
      rect({ name: "tiled", fills: [{ type: "image", ref: "assets/p.png", scaleMode: "TILE", scalingFactor: 2, filters: { temperature: 0.2 } }] }),
      imageNode({ name: "plain" }),
    ]);
    expect(rep.errors).toEqual([]);
    expect([kids[0].fills[0].scaleMode, kids[0].fills[0].scalingFactor]).toEqual(["TILE", 0.5]);
    expect([kids[1].fills[0].scaleMode, kids[1].fills[0].scalingFactor, kids[1].fills[0].filters]).toEqual(["TILE", 2, { temperature: 0.2 }]);
    expect(kids[2].fills[0].scalingFactor).toBeUndefined();
    expect(kids[2].fills[0].filters).toBeUndefined();
  });
});

describe("groups and masks", () => {
  test("a group is a non-clipping frame; children keep slide-absolute positions in the report and are relative in Figma", async () => {
    const { rep, kids } = await build([
      { type: "group", name: "g", x: 100, y: 100, w: 500, h: 300, opacity: 0.8, blendMode: "OVERLAY", children: [rect({ name: "a", x: 120, y: 130, w: 50, h: 40 }), textNode({ name: "b", x: 300, y: 200, w: 200, h: 60 })] },
    ]);
    expect(rep.errors).toEqual([]);
    const g = kids[0];
    expect(g.type).toBe("FRAME");
    expect(g.clipsContent).toBe(false);
    expect(g.fills).toEqual([]);
    expect(g.opacity).toBe(0.8);
    expect(g.blendMode).toBe("OVERLAY");
    expect([g.children[0].x, g.children[0].y]).toEqual([20, 30]);
    expect(g.children.length).toBe(2);
    const e = rep.nodes[0];
    expect([e.irType, e.figmaType, e.mask]).toEqual(["group", "FRAME", undefined]);
    expect(e.children.length).toBe(2);
    expect([e.children[0].x, e.children[0].y, e.children[0].w, e.children[0].h]).toEqual([120, 130, 50, 40]);
    expect(e.children[1].characters).toBeDefined();
  });
  test("mask:true makes the first child the mask; nested groups resolve coordinates recursively", async () => {
    const { rep, kids } = await build([
      { type: "group", name: "masked", x: 0, y: 0, w: 400, h: 300, mask: true, children: [
        rect({ name: "shape", x: 10, y: 10, w: 100, h: 100, radius: [50, 50, 50, 50] }),
        imageNode({ name: "photo", x: 0, y: 0, w: 400, h: 300 }),
        { type: "group", name: "inner", x: 200, y: 50, w: 100, h: 100, children: [rect({ name: "deep", x: 210, y: 60, w: 20, h: 20 })] },
      ] },
    ]);
    expect(rep.errors).toEqual([]);
    const g = kids[0];
    expect(g.children[0].isMask).toBe(true);
    expect(g.children[1].isMask).toBe(false);
    expect(rep.nodes[0].mask).toBe(true);
    const inner = g.children[2];
    expect([inner.x, inner.y]).toEqual([200, 50]);
    expect([inner.children[0].x, inner.children[0].y]).toEqual([10, 10]);
    expect(rep.nodes[0].children[2].children[0].x).toBe(210);
  });
  test("a group whose mask child fails to build is left unmasked and says so", async () => {
    const { rep, kids } = await build([{ type: "group", name: "g", x: 0, y: 0, w: 100, h: 100, mask: true, children: [imageNode({ name: "gone", ref: "assets/missing.png" }), rect({ name: "b", x: 0, y: 0, w: 10, h: 10 })] }]);
    expect(kids[0].children.length).toBe(1);
    expect(kids[0].children[0].isMask).toBe(false);
    expect(rep.nodes[0].error).toMatch(/mask/);
    expect(rep.nodes[0].mask).toBe(false);
  });
  test("a toned-photo stack (desaturated image plus blend-mode colour layers) builds as one group", async () => {
    const { rep, kids } = await build([
      { type: "group", name: "tritone", x: 0, y: 0, w: 400, h: 300, children: [
        imageNode({ name: "photo", x: 0, y: 0, w: 400, h: 300, filters: { saturation: -1 } }),
        rect({ name: "lights", x: 0, y: 0, w: 400, h: 300, blendMode: "SCREEN", fills: [{ type: "solid", color: "#303030", opacity: 1 }] }),
        rect({ name: "darks", x: 0, y: 0, w: 400, h: 300, blendMode: "MULTIPLY", fills: [{ type: "solid", color: "#f9f8f4", opacity: 1 }] }),
      ] },
    ]);
    expect(rep.errors).toEqual([]);
    expect(kids[0].children.map((c: any) => c.blendMode)).toEqual(["PASS_THROUGH", "SCREEN", "MULTIPLY"]);
    expect(rep.nodes[0].children[0].imageFilters).toEqual({ saturation: -1 });
  });
  test("every IR node still gets exactly one top-level report entry when groups are present", async () => {
    const { rep } = await build([rect(), { type: "group", name: "g", x: 0, y: 0, w: 10, h: 10, children: [rect({ x: 0, y: 0, w: 5, h: 5 })] }, rect({ name: "z" })]);
    expect(rep.nodes.length).toBe(3);
  });
});

describe("remove job", () => {
  test("deletes only the tagged slides with the given indices; the rest of the file is untouched", async () => {
    const p = loadPlugin(bundle);
    for (const idx of [5, 1000, 1001]) await p.send({ type: "build", ir: slideOf([rect()], { index: idx, label: "S" + idx }), images: {} });
    const mine = p.figma.createSlide();
    mine.appendChild(p.figma.createRectangle());
    const [res] = await p.send({ type: "remove", indices: [1000, 1001, 2000] });
    expect(res).toEqual({ type: "removed", removed: [1000, 1001], missing: [2000] });
    const left = p.grid.flat().filter((s: any) => !s.removed).map((s: any) => s.getSharedPluginData("designfigma", "index") || "mine");
    expect(left).toEqual(["5", "mine"]);
    const [again] = await p.send({ type: "remove", indices: [1000] });
    expect(again.missing).toEqual([1000]);
  });
  test("an untagged slide is never removed, even when indices are given", async () => {
    const p = loadPlugin(bundle);
    p.figma.createSlide();
    const [res] = await p.send({ type: "remove", indices: [0, 1, 2] });
    expect(res.removed).toEqual([]);
    expect(p.grid.flat().filter((s: any) => !s.removed).length).toBe(1);
  });
});

describe("the D-008 checks can fail (sabotage the bundle, the tests above must notice)", () => {
  test("rotation sign flipped -> rotation test sees the wrong angle", async () => {
    const bad = sabotage("const a = deg * Math.PI / 180;", "const a = deg * Math.PI / -180;");
    const p = loadPlugin(bad);
    const out = await p.send({ type: "build", ir: slideOf([rect({ x: 50, y: 50, w: 100, h: 20, rotation: 90 })]), images: {} });
    expect(p.grid.flat()[0].children[0].rotation).toBeCloseTo(90, 6); // would be -90 when correct
    expect(out.find((m) => m.type === "built").report.nodes[0].rotation).toBeCloseTo(-90, 6);
  });
  test("effects never applied -> the node has none", async () => {
    const bad = sabotage("node.effects = effects;", "");
    const p = loadPlugin(bad);
    await p.send({ type: "build", ir: slideOf([rect({ effects: [NOISE] })]), images: {} });
    expect(p.grid.flat()[0].children[0].effects.length).toBe(0);
  });
  test("mask never set -> first child is not a mask", async () => {
    const bad = sabotage("node.children[0].isMask = true;", "node.children[0].isMask = false;");
    const p = loadPlugin(bad);
    await p.send({ type: "build", ir: slideOf([{ type: "group", name: "g", x: 0, y: 0, w: 10, h: 10, mask: true, children: [rect({ x: 0, y: 0, w: 5, h: 5 })] }]), images: {} });
    expect(p.grid.flat()[0].children[0].children[0].isMask).toBe(false);
  });
  test("remove deleting untagged slides too -> the guard test sees a removal", async () => {
    const bad = sabotage('if (tag !== "" && wanted[tag]) {', "if (wanted[tag] || tag === '') {");
    const p = loadPlugin(bad);
    p.figma.createSlide();
    const [res] = await p.send({ type: "remove", indices: [0] });
    expect(res.removed.length).toBeGreaterThan(0);
  });
});

describe("calibration slides build in the plugin", () => {
  test("every generated calibration slide builds with one valid NOISE effect per tile (bar the baseline)", async () => {
    const { buildCalibration } = await import("./calibrate-noise");
    const { slides } = buildCalibration();
    const p = loadPlugin(bundle);
    for (const ir of [slides[0], slides[1]]) {
      const rep = (await p.send({ type: "build", ir, images: {} })).find((m) => m.type === "built").report;
      expect(rep.errors).toEqual([]);
      expect(rep.nodes.length).toBe(ir.nodes.length);
      const kids = p.grid.flat().find((s: any) => s.getSharedPluginData("designfigma", "index") === String(ir.index)).children;
      expect(kids[0].effects.length).toBe(0);
      for (let i = 1; i < kids.length; i++) {
        expect(kids[i].effects.length).toBe(1);
        expect(kids[i].effects[0].noiseSize).toBe(ir.nodes[i].figmaNoise.noiseSize);
        expect(kids[i].effects[0].color.r).toBe(ir.index === 1000 ? 0 : 1);
      }
    }
    expect(p.grid.flat().map((s: any) => s.getSharedPluginData("designfigma", "index"))).toEqual(["1000", "1001"]);
  });
});
