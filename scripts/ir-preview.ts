// Render IR JSON back to HTML in Chrome and score it against the reference screenshot.
// This checks the EXTRACTOR (is the IR faithful?), independent of the Figma builder.
// Usage: bun ir-preview.ts --ir <ir dir> [--slides 0,16] [--limit 0.02] [--tile-limit 0.12] [--nudge] [--fonts <deck assets/fonts>]
//   Writes ../preview/slide-NNN.png and ../preview/diff-NNN.png. Exit 1 if any slide scores over --limit.
//   Two scores: whole-slide share of pixels off, and the worst 120x120 tile (catches a local fault a whole-slide average hides).
//   Score = share of pixels whose largest channel difference exceeds 32 (0 = identical, 1 = everything differs).
//   --nudge moves the first node 24px right before rendering: the score must go red (proves the check can fail).
import { chromium } from "playwright";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const irDir = resolve(flag("--ir") ?? ".");
const limit = Number(flag("--limit") ?? 0.02);
const tileLimit = Number(flag("--tile-limit") ?? 0.12);
const nudge = args.includes("--nudge");
const fontsDir = flag("--fonts") ? resolve(flag("--fonts")!) : null; // deck's assets/fonts folder (the deck's own @font-face files)
const refDir = join(dirname(irDir), "ref");
const outDir = join(dirname(irDir), "preview");
mkdirSync(outDir, { recursive: true });
const files = readdirSync(irDir).filter((f) => /^slide-\d+\.json$/.test(f)).sort();
const only = flag("--slides")?.split(",").map((s) => parseInt(s, 10));

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (fontsDir && path.startsWith("/__fonts/")) { const fp = resolve(join(fontsDir, path.slice(9))); return fp.startsWith(fontsDir) && existsSync(fp) ? new Response(Bun.file(fp)) : new Response(null, { status: 404 }); }
    const p = resolve(join(irDir, path));
    if (!p.startsWith(irDir) || !existsSync(p)) return new Response(null, { status: 404 });
    return new Response(Bun.file(p));
  },
});
const base = `http://localhost:${server.port}/`;

const rgba = (c: string, o: number) => { const n = parseInt(c.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${o})`; };
const fillCss = (f: any, bounds?: any): string | null => {
  if (f.type === "solid") return `linear-gradient(${rgba(f.color, f.opacity)},${rgba(f.color, f.opacity)})`;
  if (f.type === "linear") return `linear-gradient(${f.angleDeg}deg,${f.stops.map((s: any) => `${rgba(s.color, s.opacity)} ${s.pos * 100}%`).join(",")})`;
  if (f.type === "radial") return `radial-gradient(${f.stops.map((s: any) => `${rgba(s.color, s.opacity)} ${s.pos * 100}%`).join(",")})`;
  if (f.type === "image") return `url(${base}${f.ref}) center/${f.scaleMode === "FIT" ? "contain" : "cover"} no-repeat`;
  return null;
};
const fillsCss = (fills: any[]) => fills.map((f) => fillCss(f)).filter(Boolean).reverse().join(",") || "none";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function nodeHtml(n: any): string {
  const pos = `position:absolute;left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;opacity:${n.opacity};`;
  if (n.type === "rect") {
    const r = n.radius.map((v: number) => v + "px").join(" ");
    const st = n.stroke ? `box-shadow:inset 0 0 0 ${n.stroke.width}px ${rgba(n.stroke.color, n.stroke.opacity)};` : "";
    return `<div style="${pos}background:${fillsCss(n.fills)};border-radius:${r};${st}box-sizing:border-box"></div>`;
  }
  if (n.type === "image") {
    const r = n.radius.map((v: number) => v + "px").join(" ");
    const size = n.scaleMode === "FIT" ? "contain" : n.scaleMode === "CROP" ? "auto" : "cover";
    return `<div style="${pos}background:url(${base}${n.ref}) center/${size} no-repeat;border-radius:${r}"></div>`;
  }
  if (n.type === "svg") return `<div style="${pos}">${n.svg}</div>`;
  if (n.type === "text") {
    const spans = n.runs.map((r: any) => {
      const v = Object.entries(r.variation ?? {}).map(([k, x]) => `'${k}' ${x}`).join(",");
      return `<span style="font-family:'${r.fontFamily}';font-weight:${r.fontWeight};font-style:${r.italic ? "italic" : "normal"};font-size:${r.fontSize}px;line-height:${r.lineHeightPx}px;letter-spacing:${r.letterSpacingPx}px;color:${rgba(r.color, r.colorOpacity)};${v ? `font-variation-settings:${v};` : ""}text-decoration:${r.decoration === "UNDERLINE" ? "underline" : r.decoration === "STRIKETHROUGH" ? "line-through" : "none"}">${esc(n.characters.slice(r.start, r.end))}</span>`;
    }).join("");
    const ta = n.align === "JUSTIFIED" ? "justify" : n.align.toLowerCase();
    const r0 = n.runs[0];
    const strut = `font:${r0.fontSize}px/${r0.lineHeightPx}px '${r0.fontFamily}';`; // no stray strut from the default font
    return `<div style="${pos}${strut}white-space:${n.wrap ? "pre-wrap" : "pre"};text-align:${ta};overflow:visible">${spans}</div>`;
  }
  return "";
}

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let failed = 0;
for (const f of files) {
  const ir = JSON.parse(readFileSync(join(irDir, f), "utf8"));
  if (only && !only.includes(ir.index)) continue;
  const nnn = f.match(/\d+/)![0];
  if (nudge) { // move the biggest text node 24px right: the score must go red
    const big = ir.nodes.filter((n: any) => n.type === "text").sort((a: any, b: any) => b.w * b.h - a.w * a.h)[0] ?? ir.nodes[0];
    big.x += 24;
  }
  const html = `<!doctype html><meta charset="utf-8"><style>
${fontsDir ? `@font-face{font-family:'Denim INK';src:url(${base}__fonts/DenimINKTRIALVF.ttf);font-weight:100 900;font-stretch:50% 200%}@font-face{font-family:'Circular XX Mono';src:url(${base}__fonts/CircularXXMono-Regular.otf)}` : ""}
html,body{margin:0;background:#fff}#s{position:relative;width:1920px;height:1080px;overflow:hidden;background:${fillsCss(ir.background)}}</style>
<div id="s">${ir.nodes.map(nodeHtml).join("\n")}</div>`;
  writeFileSync(join(irDir, "__preview.html"), html);
  await page.goto(base + "__preview.html", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const shot = join(outDir, `slide-${nnn}.png`);
  await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  // score
  const ref = `data:image/png;base64,${readFileSync(join(refDir, `slide-${nnn}.png`)).toString("base64")}`;
  const got = `data:image/png;base64,${readFileSync(shot).toString("base64")}`;
  const { score, worst, diff } = await page.evaluate(async ([a, b]) => {
    const load = (s: string) => new Promise<HTMLImageElement>((r) => { const i = new Image(); i.onload = () => r(i); i.src = s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const mk = (i: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const g = c.getContext("2d")!; g.drawImage(i, 0, 0); return g.getImageData(0, 0, 1920, 1080); };
    const A = mk(ia), B = mk(ib);
    const out = new ImageData(1920, 1080);
    let bad = 0;
    const tiles = new Array(16 * 9).fill(0);
    for (let p = 0; p < A.data.length; p += 4) {
      const d = Math.max(Math.abs(A.data[p] - B.data[p]), Math.abs(A.data[p + 1] - B.data[p + 1]), Math.abs(A.data[p + 2] - B.data[p + 2]));
      if (d > 32) { bad++; tiles[Math.floor(((p >> 2) / 1920 | 0) / 120) * 16 + Math.floor(((p >> 2) % 1920) / 120)]++; out.data.set([255, 0, 0, 255], p); } else out.data.set([A.data[p] >> 1 | 128, A.data[p + 1] >> 1 | 128, A.data[p + 2] >> 1 | 128, 255], p);
    }
    const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; c.getContext("2d")!.putImageData(out, 0, 0);
    return { score: bad / (1920 * 1080), worst: Math.max(...tiles) / (120 * 120), diff: c.toDataURL("image/png") };
  }, [ref, got]);
  writeFileSync(join(outDir, `diff-${nnn}.png`), Buffer.from(diff.split(",")[1], "base64"));
  const ok = score <= limit && worst <= tileLimit;
  if (!ok) failed++;
  console.log(`slide-${nnn} [${ir.index}] ${ir.label}: score ${score.toFixed(4)} worst-tile ${worst.toFixed(3)} ${ok ? "PASS" : "FAIL"} (limits ${limit} / ${tileLimit})${nudge ? " [nudged]" : ""}`);
}
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
