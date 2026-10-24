import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";

// Runs the real extract.ts (real headless Chrome) on a small fixture deck served from a temp dir, port 0.
// Fixture text is monospace in a `ch`-wide box so Chrome's line breaks are exactly predictable.
const sec = (body: string) => `<section data-label="s" style="position:relative;width:1920px;height:1080px;background:#fff;overflow:hidden">${body}</section>`;
const P = "position:absolute;margin:0;font:24px/32px monospace;color:#111;width:10ch;";
const A = "position:absolute;";

// A deterministic 96x96 colourful "photo" (PNG written by hand: no image library in the repo).
function photoPng(w = 96, h = 96): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1), v = y / (h - 1), o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(255 * (0.5 + 0.5 * Math.sin(6 * u + 2 * v)));
      raw[o + 1] = Math.round(255 * (0.25 + 0.75 * v * (1 - 0.4 * u)));
      raw[o + 2] = Math.round(255 * Math.abs(Math.cos(4 * u * v + 1)));
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const grainFilter = `<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" result="t"/><feColorMatrix in="t" type="saturate" values="0" result="m"/><feComponentTransfer in="m" result="s"><feFuncR type="linear" slope=".5" intercept=".72"/><feFuncG type="linear" slope=".5" intercept=".72"/><feFuncB type="linear" slope=".5" intercept=".72"/></feComponentTransfer><feBlend in="SourceGraphic" in2="s" mode="multiply" result="b"/><feComposite in="b" in2="SourceGraphic" operator="in"/></filter>`;
const lum = `.2126 .7152 .0722 0 0  .2126 .7152 .0722 0 0  .2126 .7152 .0722 0 0  0 0 0 1 0`;
// Tone filters: [id, colour-interpolation-filters, tableValues for R, G, B]. All use the luminance matrix first.
const tones: [string, string, string, string, string][] = [
  ["duo", "sRGB", ".1176 .9765", ".1176 .9725", ".1176 .9569"], // #1E1E1E -> #F9F8F4
  ["tri", "sRGB", ".1176 .8588 .9765", ".1176 .2627 .9725", ".1176 .6588 .9569"], // dark, #DB43A8, light
  ["inv", "sRGB", ".9 .1", ".1 .8", ".2 .95"], // R runs light to dark, G and B dark to light
  ["lin", "linearRGB", ".05 .95", ".02 .9", ".1 .8"], // the SVG default colour space
];
const toneDefs = `<svg width="0" height="0" style="position:absolute">${tones.map(([id, cif, r, g, b]) => `<filter id="${id}" color-interpolation-filters="${cif}"><feColorMatrix type="matrix" values="${lum}"/><feComponentTransfer><feFuncR type="table" tableValues="${r}"/><feFuncG type="table" tableValues="${g}"/><feFuncB type="table" tableValues="${b}"/></feComponentTransfer></filter>`).join("")}</svg>`;

const slides = [
  // 0: two-line paragraph, source whitespace collapses (indices in the DOM differ from indices in `characters`)
  sec(`<p style="${P}left:100px;top:100px">
      aaaa   bbbb
      cccc dddd
    </p>`),
  // 1: one line
  sec(`<p style="${P}left:100px;top:100px;width:30ch">hello world</p>`),
  // 2: soft wraps + a <br> + a styled run: the start right after the hard break must not be listed
  sec(`<p style="${P}left:100px;top:100px">aaaa <b>bbbb</b> cccc<br>dddd eeee ffff</p>`),
  // 3: blur, grain on an svg rect, soft + inset shadow card with text inside, backdrop blur, text above the blur
  sec(`<div data-name="blob" style="${A}left:100px;top:100px;width:200px;height:200px;background:#f00;filter:blur(12px)"></div>
    <p style="${P}left:120px;top:150px;width:20ch">Over blur</p>
    <svg data-name="grainsvg" style="${A}left:500px;top:100px" width="300" height="200"><defs><linearGradient id="gg" x1="0%" y1="50%" x2="100%" y2="50%"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>${grainFilter}</defs><rect data-name="grain" width="100%" height="100%" fill="url(#gg)" filter="url(#g)"/></svg>
    <div data-name="card" style="${A}left:100px;top:500px;width:300px;height:160px;background:#eee;box-shadow:0 10px 30px rgba(0,0,0,.5), inset 0 0 0 4px #f00"><p style="${P}left:20px;top:20px;width:20ch">Card text</p></div>
    <div data-name="frame" style="${A}left:100px;top:800px;width:300px;height:100px;box-shadow:0 0 0 1px #CFCCC4"></div>
    <div data-name="inframe" style="${A}left:500px;top:800px;width:300px;height:100px;box-shadow:inset 0 0 0 2px #00f"></div>
    <div data-name="glass" style="${A}left:900px;top:100px;width:300px;height:160px;background:rgba(255,255,255,.3);backdrop-filter:blur(8px)"><p style="${P}left:20px;top:20px;width:20ch">Glass text</p></div>`),
  // 4: CSS filters on a subtree, mix-blend-mode, image adjustments, and one filter Figma cannot do (must stay a listed raster)
  sec(`<div data-name="pair" style="${A}left:100px;top:100px;width:300px;height:100px;filter:drop-shadow(6px 8px 6px rgba(30,30,30,.6))"><div style="${A}left:0;top:0;width:100px;height:100px;background:#0a0"></div><div style="${A}left:150px;top:20px;width:100px;height:60px;background:#a0a"></div></div>
    <div data-name="solo" style="${A}left:500px;top:100px;width:120px;height:80px;background:#06c;filter:drop-shadow(0 4px 8px #000)"></div>
    <div data-name="mult" style="${A}left:700px;top:100px;width:120px;height:80px;background:#c00;mix-blend-mode:multiply"></div>
    <img data-name="gray" src="photo.png" style="${A}left:100px;top:400px;width:96px;height:96px;filter:grayscale(1) contrast(1.5)">
    <div data-name="hue" style="${A}left:500px;top:400px;width:120px;height:80px;background:#f00;filter:hue-rotate(90deg)"></div>
    <svg data-name="noiseonly" style="${A}left:900px;top:400px" width="100" height="60"><defs><filter id="pn"><feTurbulence type="fractalNoise" baseFrequency=".5"/></filter></defs><rect width="100%" height="100%" fill="#888" filter="url(#pn)"/></svg>`),
  // 5: rotation, uniform + non-uniform scale, a real skew
  sec(`<div data-name="spin" style="${A}left:300px;top:300px;width:200px;height:100px;background:#00f;transform:rotate(30deg)"><p style="${P}left:10px;top:10px;width:12ch">Spin</p></div>
    <div data-name="quarter" style="${A}left:700px;top:300px;width:100px;height:50px;background:#080;transform:rotate(90deg)"></div>
    <div data-name="big" style="${A}left:1000px;top:300px;width:100px;height:50px;background:#808;transform:rotate(-10deg) scale(2)"></div>
    <div data-name="wide" style="${A}left:1300px;top:300px;width:100px;height:50px;background:#880;transform:scale(2,1);transform-origin:0 0"></div>
    <div data-name="slant" style="${A}left:300px;top:700px;width:100px;height:50px;background:#088;transform:skewX(20deg)"></div>
    <div data-name="widetext" style="${A}left:700px;top:700px;width:200px;height:50px;background:#eee;transform:scale(2,1);transform-origin:0 0"><p style="${P}left:0;top:0;width:12ch">Stretch</p></div>
    <img data-name="squash" src="photo.png" style="${A}left:1000px;top:700px;width:96px;height:96px;transform:scale(.5,1.5);transform-origin:0 0">
    <img data-name="squashfit" src="photo.png" style="${A}left:1300px;top:700px;width:192px;height:96px;object-fit:contain;transform:scale(.5,2);transform-origin:0 0">
    <img data-name="fillwide" src="photo.png" style="${A}left:1500px;top:300px;width:192px;height:48px">`),
  // 6: tiled backgrounds
  sec(`<div data-name="dots" style="${A}left:96px;top:100px;width:480px;height:12px;background-image:radial-gradient(circle at 6px 6px,#111 5.6px,transparent 6.2px);background-size:24px 12px;background-repeat:repeat-x"></div>
    <div data-name="half" style="${A}left:96px;top:200px;width:300px;height:100px;background:#eee linear-gradient(#f00,#00f) no-repeat 0 0/50% 100%"></div>
    <div data-name="stripes" style="${A}left:96px;top:400px;width:300px;height:100px;background:linear-gradient(90deg,#f0f 50%,transparent 50%);background-size:20px 20px"></div>`),
  // 7: masks and clip-paths
  sec(`<div data-name="fade" style="${A}left:100px;top:100px;width:300px;height:100px;background:#DB43A8;-webkit-mask-image:linear-gradient(#000,transparent);mask-image:linear-gradient(#000,transparent)"></div>
    <img data-name="screen" src="photo.png" style="${A}left:500px;top:100px;width:96px;height:96px;-webkit-mask-image:radial-gradient(circle at 7.5px 7.5px,#000 5.2px,transparent 5.8px);mask-image:radial-gradient(circle at 7.5px 7.5px,#000 5.2px,transparent 5.8px);-webkit-mask-size:15px 15px;mask-size:15px 15px">
    <div data-name="round" style="${A}left:100px;top:400px;width:200px;height:200px;background:#06c;clip-path:circle(50% at 50% 50%)"></div>
    <div data-name="noop" style="${A}left:500px;top:400px;width:200px;height:100px;background:#c60;clip-path:inset(0)"></div>
    <div data-name="logo" style="${A}left:900px;top:100px;width:330px;height:37px;background:#DB43A8;-webkit-mask:url('photo.png') center/contain no-repeat;mask:url('photo.png') center/contain no-repeat"></div>`),
  // 8: toned photos: css filter url(#id) on an <img>, and on an svg <image>
  sec(`${toneDefs}
    ${tones.map(([id], i) => `<img data-name="tone-${id}" src="photo.png" style="${A}left:${100 + i * 200}px;top:100px;width:96px;height:96px;filter:url(#${id})">`).join("")}
    <svg data-name="svgphoto" style="${A}left:100px;top:400px" width="96" height="96"><image data-name="svgimg" href="photo.png" width="96" height="96" filter="url(#tri)"/></svg>
    <img data-name="plain" src="photo.png" style="${A}left:500px;top:400px;width:96px;height:96px">`),
];
const deck = `<!doctype html><meta charset="utf-8"><body style="margin:0"><deck-stage>${slides.join("")}</deck-stage>
<script>customElements.define("deck-stage", class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>"; }
  connectedCallback() { this.goTo(0); }
  goTo(k) { [...this.querySelectorAll(":scope > section")].forEach((s, i) => { s.toggleAttribute("data-deck-active", i === k); s.style.display = i === k ? "block" : "none"; }); }
});</script>`;

let dir = "";
const ir = (n: number) => JSON.parse(readFileSync(join(dir, "ir", `slide-${String(n).padStart(3, "0")}.json`), "utf8"));
const flat = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...(n.children ? flat(n.children) : [])]);
const all = (n: number) => flat(ir(n).nodes);
const texts = (n: number) => all(n).filter((x: any) => x.type === "text");
const rasters = (n: number) => all(n).filter((x: any) => x.name?.startsWith("raster:"));
const named = (n: number, name: string) => all(n).find((x: any) => x.name === name);
const report = () => JSON.parse(readFileSync(join(dir, "ir", "extract-report.json"), "utf8"));
const fx = (node: any, type: string) => (node.effects ?? []).find((e: any) => e.type === type);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "extract-test-"));
  writeFileSync(join(dir, "deck.html"), deck);
  writeFileSync(join(dir, "photo.png"), photoPng());
  const p = Bun.spawn(["bun", join(import.meta.dir, "extract.ts"), "--deck", join(dir, "deck.html"), "--out", join(dir, "ir"), "--ref", join(dir, "ref"), "--wait", "100"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error("extract.ts failed: " + out + err);
}, 240000);

describe("line starts (IR `lines`)", () => {
  test("a 2-line paragraph records the index of the first char of line 2 in `characters`", () => {
    const [t] = texts(1);
    expect(t.characters).toBe("aaaa bbbb cccc dddd");
    expect(t.lines).toEqual([10]);
    expect(t.characters[10]).toBe("c");
  });
  test("a single line has no `lines`", () => {
    const [t] = texts(2);
    expect(t.characters).toBe("hello world");
    expect("lines" in t).toBe(false);
  });
  test("soft wraps are listed, the start right after a <br> is not", () => {
    const [t] = texts(3);
    expect(t.characters).toBe("aaaa bbbb cccc\ndddd eeee ffff");
    expect(t.lines).toEqual([10, 25]);
    expect(t.runs.length).toBeGreaterThan(1);
  });
});

describe("effects stay native (D-008)", () => {
  test("blur() becomes a layer-blur effect on the element's own rect, radius = 2 x std deviation", () => {
    const b = named(4, "blob");
    expect(b.type).toBe("rect");
    expect(fx(b, "layer-blur").radius).toBe(24);
    expect(b.fills[0].color).toBe("#FF0000");
  });
  test("SVG grain: a rect with its own linear gradient fill + a noise effect parsed from the filter, no raster", () => {
    const g = named(4, "grain");
    expect(g.type).toBe("rect");
    expect(g.fills[0].type).toBe("linear");
    expect(g.fills[0].angleDeg).toBe(90);
    expect(g.fills[0].stops.map((s: any) => s.color)).toEqual(["#FF0000", "#0000FF"]);
    expect(g.w).toBe(300);
    const n = fx(g, "noise");
    expect(n).toMatchObject({ type: "noise", baseFrequency: 0.85, octaves: 2, seed: 7, blend: "MULTIPLY", monochrome: true });
    // transfer 0.5 * n + 0.72 clamped to 1, measured in sRGB because the filter runs in linearRGB: swing 0.135, mean 0.97 -> 0.9867
    expect(n.amount).toBeCloseTo(0.135, 2);
    expect(n.bias).toBeCloseTo(-0.0133, 3);
  });
  test("box-shadow: outer + inset become drop-shadow / inner-shadow with offset, blur, spread, opacity", () => {
    const c = named(4, "card");
    expect(fx(c, "drop-shadow")).toMatchObject({ color: "#000000", opacity: 0.5, x: 0, y: 10, blur: 30, spread: 0 });
    expect(fx(c, "inner-shadow")).toMatchObject({ color: "#FF0000", opacity: 1, x: 0, y: 0, blur: 0, spread: 4 });
  });
  test("a hairline ring around a box with no fill is a native inside-stroke rect (Figma casts no shadow from an empty layer)", () => {
    const r = named(4, "frame ring");
    expect(r).toMatchObject({ type: "rect", x: 99, y: 799, w: 302, h: 102, fills: [] });
    expect(r.stroke).toMatchObject({ color: "#CFCCC4", width: 1, align: "INSIDE" });
    expect(named(4, "frame")).toBeUndefined();
    const i = named(4, "inframe ring");
    expect(i).toMatchObject({ x: 500, y: 800, w: 300, h: 100 });
    expect(i.stroke).toMatchObject({ color: "#0000FF", width: 2 });
  });
  test("backdrop-filter blur is a background-blur effect on the element's rect", () => {
    const g = named(4, "glass");
    expect(fx(g, "background-blur").radius).toBe(16);
    expect(g.fills[0].opacity).toBe(0.3);
  });
  test("slide 4 has no raster at all, and text above or inside the effect box stays text", () => {
    expect(rasters(4)).toEqual([]);
    expect(texts(4).map((t: any) => t.characters).sort()).toEqual(["Card text", "Glass text", "Over blur"]);
    expect(report()["004"].rasters).toBe(0);
  });
  test("drop-shadow() on a subtree: a group of its children carries the effect; on a single node the node carries it", () => {
    const pair = named(5, "pair");
    expect(pair.type).toBe("group");
    expect(pair.children.length).toBe(2);
    expect(fx(pair, "drop-shadow")).toMatchObject({ x: 6, y: 8, blur: 12, opacity: 0.6, color: "#1E1E1E" });
    const solo = named(5, "solo");
    expect(solo.type).toBe("rect");
    expect(fx(solo, "drop-shadow")).toMatchObject({ y: 4, blur: 16, color: "#000000" });
  });
  test("mix-blend-mode becomes blendMode", () => {
    expect(named(5, "mult").blendMode).toBe("MULTIPLY");
  });
  test("grayscale() + contrast() on an <img> become Figma image filters", () => {
    expect(named(5, "gray").filters).toEqual({ saturation: -1, contrast: 0.5 });
  });
  test("what has no native mapping stays a raster, named and listed in extract-report with the reason", () => {
    expect(rasters(5).map((r: any) => r.name).sort()).toEqual(["raster:css-filter", "raster:svg-filter"]);
    const list = report()["005"].rasterList;
    expect(list.map((r: any) => r.reason).join("|")).toMatch(/hue-rotate/);
    expect(list.map((r: any) => r.reason).join("|")).toMatch(/pure noise/);
    for (const r of rasters(5)) expect(statSync(join(dir, "ir", r.ref)).size).toBeGreaterThan(100);
  });
  test("reference screenshots go to --ref", () => {
    expect(existsSync(join(dir, "ref", "slide-004.png"))).toBe(true);
  });
});

describe("rotation and scale", () => {
  test("a rotated element keeps its unrotated box and carries rotation in degrees clockwise", () => {
    const s = named(6, "spin");
    expect(s).toMatchObject({ type: "rect", x: 300, y: 300, w: 200, h: 100, rotation: 30 });
  });
  test("its content moves with it: the text keeps its unrotated size, is turned 30 degrees, and its centre is carried round the element centre", () => {
    const t = texts(6)[0];
    expect(t.rotation).toBe(30);
    // unrotated text centre (relative to the element centre 400,350) -> rotated by 30 degrees
    const rx = t.x + t.w / 2 - 400, ry = t.y + t.h / 2 - 350;
    const un = { x: 300 + 10 + t.w / 2 - 400, y: 300 + 10 + t.h / 2 - 350 };
    const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
    expect(rx).toBeCloseTo(un.x * c - un.y * sn, 0);
    expect(ry).toBeCloseTo(un.x * sn + un.y * c, 0);
  });
  test("rotate(90deg) is exact", () => {
    expect(named(6, "quarter")).toMatchObject({ x: 700, y: 300, w: 100, h: 50, rotation: 90 });
  });
  test("uniform scale folds into the box: rotate(-10deg) scale(2) doubles w/h about the centre", () => {
    expect(named(6, "big")).toMatchObject({ x: 1000 - 50, y: 300 - 25, w: 200, h: 100, rotation: -10 });
  });
  test("non-uniform scale of plain shapes needs no raster: scale(2,1) from the left edge doubles the width", () => {
    const w = named(6, "wide");
    expect(w).toMatchObject({ type: "rect", x: 1300, y: 300, w: 200, h: 50 });
    expect(w.rotation).toBeUndefined();
  });
  test("an <img> under a non-uniform scale is a native STRETCH image, not a raster", () => {
    expect(named(6, "squash")).toMatchObject({ type: "image", scaleMode: "STRETCH", x: 1000, y: 700, w: 48, h: 144 });
    // contain: the box shrinks to the drawn 96x96 bitmap (centred at x+48), then stretches
    expect(named(6, "squashfit")).toMatchObject({ type: "image", scaleMode: "STRETCH", x: 1324, y: 700, w: 48, h: 192 });
  });
  test("object-fit:fill with a different aspect is STRETCH, not a crop", () => {
    expect(named(6, "fillwide")).toMatchObject({ type: "image", scaleMode: "STRETCH", x: 1500, y: 300, w: 192, h: 48 });
  });
  test("a real skew falls back to a listed raster; so does a non-uniform scale over text", () => {
    const r = rasters(6);
    expect(r.length).toBe(2);
    const reasons = report()["006"].rasterList.map((x: any) => x.reason).join("|");
    expect(reasons).toMatch(/shear/);
    expect(reasons).toMatch(/non-uniform scale/);
  });
});

describe("tiled backgrounds", () => {
  test("a repeating gradient cell is a TILE image fill with a 4x cell and scalingFactor 1/4, not a raster", () => {
    const d = named(7, "dots");
    expect(d.type).toBe("rect");
    expect(d.fills[0]).toMatchObject({ type: "image", scaleMode: "TILE", scalingFactor: 0.25 });
    const png = readFileSync(join(dir, "ir", d.fills[0].ref));
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(48);
    expect(rasters(7)).toEqual([]);
  });
  test("a non-repeating sized gradient is a native rect with a native gradient, not a tile", () => {
    const h = named(7, "half layer");
    expect(h.w).toBe(150);
    expect(h.h).toBe(100);
    expect(h.fills[0].type).toBe("linear");
  });
  test("a 2D repeat tiles both ways", () => {
    const s = named(7, "stripes");
    expect(s.fills[0]).toMatchObject({ scaleMode: "TILE", scalingFactor: 0.25 });
    const png = readFileSync(join(dir, "ir", s.fills[0].ref));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([80, 80]);
  });
});

describe("masks", () => {
  test("mask-image gradient: a group with mask:true, mask shape first (rect with the gradient), then the content", () => {
    const g = named(8, "mask fade");
    expect(g.type).toBe("group");
    expect(g.mask).toBe(true);
    expect(g.children[0]).toMatchObject({ type: "rect", name: "mask" });
    expect(g.children[0].fills[0].type).toBe("linear");
    expect(g.children[1]).toMatchObject({ type: "rect", name: "fade", x: 100, y: 100, w: 300, h: 100 });
    expect(g).toMatchObject({ x: 100, y: 100, w: 300, h: 100 });
  });
  test("a mask-image tile on an <img> masks the image node with a TILE fill", () => {
    const g = named(8, "mask screen");
    expect(g.mask).toBe(true);
    expect(g.children[0].fills[0]).toMatchObject({ scaleMode: "TILE" });
    expect(g.children[1].type).toBe("image");
  });
  test("clip-path circle() is an svg mask shape; clip-path inset(0) is nothing", () => {
    const g = named(8, "mask round");
    expect(g.mask).toBe(true);
    expect(g.children[0].type).toBe("svg");
    expect(g.children[0].svg).toMatch(/<circle[^>]*r="100"/);
    expect(named(8, "noop").type).toBe("rect");
    expect(all(8).filter((n: any) => n.name === "mask noop").length).toBe(0);
  });
  test("mask: url() with contain is a rect whose fill is the mask image, FIT", () => {
    const g = named(8, "mask logo");
    expect(g.children[0].fills[0]).toMatchObject({ type: "image", scaleMode: "FIT" });
    expect(g.children[0].fills[0].ref).toMatch(/^assets\//);
  });
  test("no raster on the mask slide", () => {
    expect(rasters(8)).toEqual([]);
  });
});

// ---- toned photos ----
// The real thing is the browser's own render of <img style="filter:url(#id)"> (slide 9 reference screenshot). The approximation is the IR
// group drawn with plain CSS: the image with filter:grayscale(1) and the solid layers with mix-blend-mode, which follows the same
// W3C compositing formulas Figma uses. The score is the mean absolute difference per channel (0..255) over the photo.
function emulate(group: any): string {
  const css = (b: string) => b.toLowerCase().replace(/_/g, "-");
  const kids = group.children.map((c: any) => {
    const pos = `position:absolute;left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;`;
    if (c.type === "image") return `<img src="data:image/png;base64,${readFileSync(join(dir, "ir", c.ref)).toString("base64")}" style="${pos}object-fit:cover;${c.filters?.saturation === -1 ? "filter:grayscale(1);" : ""}">`;
    return `<div style="${pos}background:${c.fills[0].color};mix-blend-mode:${css(c.blendMode)}"></div>`;
  });
  return `<body style="margin:0;background:#fff"><div style="position:absolute;left:0;top:0;width:1920px;height:1080px;isolation:isolate">${kids.join("")}</div>`;
}
async function toneError(group: any): Promise<number[]> {
  const b = await chromium.launch({ channel: "chrome" });
  try {
    const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(emulate(group));
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    const clip = { x: group.x, y: group.y, width: group.w, height: group.h };
    const emu = (await page.screenshot({ clip })).toString("base64");
    const ref = readFileSync(join(dir, "ref", "slide-009.png")).toString("base64");
    return await page.evaluate(async ({ emu, ref, clip }) => {
      const load = async (b64: string) => { const im = new Image(); im.src = "data:image/png;base64," + b64; await im.decode(); return im; };
      const [a, r] = [await load(emu), await load(ref)];
      const ca = document.createElement("canvas"); ca.width = clip.width; ca.height = clip.height;
      const cr = document.createElement("canvas"); cr.width = clip.width; cr.height = clip.height;
      ca.getContext("2d")!.drawImage(a, 0, 0);
      cr.getContext("2d")!.drawImage(r, clip.x, clip.y, clip.width, clip.height, 0, 0, clip.width, clip.height);
      const da = ca.getContext("2d")!.getImageData(0, 0, clip.width, clip.height).data, dr = cr.getContext("2d")!.getImageData(0, 0, clip.width, clip.height).data;
      const s = [0, 0, 0];
      for (let i = 0; i < da.length; i += 4) for (let c = 0; c < 3; c++) s[c] += Math.abs(da[i + c] - dr[i + c]);
      return s.map((v) => Math.round((v / (da.length / 4)) * 100) / 100);
    }, { emu, ref, clip });
  } finally { await b.close(); }
}

describe("toned photos", () => {
  test("a luminance + table filter on an <img> becomes a group: the original image with saturation -1, then blend layers; no raster", () => {
    const g = named(9, "tone tone-duo");
    expect(g.type).toBe("group");
    const [img, ...layers] = g.children;
    expect(img).toMatchObject({ type: "image", name: "tone-duo", filters: { saturation: -1 } });
    expect(img.ref).toBe(named(9, "plain").ref); // the original photo, untouched
    expect(layers.map((l: any) => l.blendMode)).toEqual(["MULTIPLY", "SCREEN"]);
    expect(layers[1].fills[0].color).toBe("#1E1E1E"); // SCREEN colour = dark tone: black maps to it
    expect(g.blendMode).toBe("NORMAL");
    expect(rasters(9)).toEqual([]);
  });
  test("a three-stop tone adds an OVERLAY layer for the mid colour; a reversed channel adds DIFFERENCE", () => {
    expect(named(9, "tone tone-tri").children.slice(1).map((l: any) => l.blendMode)).toEqual(["OVERLAY", "MULTIPLY", "SCREEN"]);
    expect(named(9, "tone tone-inv").children.slice(1)[0]).toMatchObject({ blendMode: "DIFFERENCE" });
    expect(named(9, "tone tone-inv").children.slice(1)[0].fills[0].color).toBe("#FF0000"); // only R is reversed
  });
  test("a filter on an svg <image> is the same group", () => {
    const g = named(9, "tone svgimg");
    expect(g.type).toBe("group");
    expect(g.children[0]).toMatchObject({ type: "image", filters: { saturation: -1 } });
  });
  test("an untouched photo stays a plain image node", () => {
    expect(named(9, "plain")).toMatchObject({ type: "image" });
    expect(named(9, "plain").filters).toBeUndefined();
  });
  // Mean abs error per channel of the blend stack vs the real filter render (0..255). Figma's own desaturate may differ from
  // CSS grayscale(); this measures the stack.
  const limit: Record<string, number> = { "tone-duo": 2, "tone-tri": 3, "tone-inv": 3, "tone-lin": 9, svgimg: 3 };
  for (const name of Object.keys(limit)) {
    test(`Chrome render of the stack matches the real filter: ${name} (limit ${limit[name]})`, async () => {
      const g = named(9, "tone " + name);
      const err = await toneError(g);
      console.log(`tone error ${name}: mean abs R/G/B = ${err.join(" / ")} (of 255)`);
      for (const e of err) expect(e).toBeLessThan(limit[name]);
    }, 60000);
  }
});
