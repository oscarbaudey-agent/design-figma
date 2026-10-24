// Builds the neutral sample deck the tests, check.ts --selftest and e2e-mock.ts run on, then extracts it.
//   bun fixtures/make-sample.ts
// Writes fixtures/sample/deck/ (the deck: HTML + a generated photo) and fixtures/sample/ir + fixtures/sample/ref
// (what extract.ts makes of it). All three are committed so the tests run on a fresh machine without a network,
// a client deck or a session folder. Fonts are macOS system fonts (Helvetica Neue, Menlo), so any Mac renders it.
// Rerun after changing the extractor in a way that changes the IR, then rerun `bun test`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const root = join(import.meta.dir, "sample");
const deckDir = join(root, "deck");

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

const A = "position:absolute;margin:0;";
const SANS = "font-family:'Helvetica Neue';";
const MONO = "font-family:Menlo;";
const sec = (label: string, bg: string, body: string) =>
  `<section data-label="${label}" style="position:relative;width:1920px;height:1080px;background:${bg};overflow:hidden">${body}</section>`;
const grain = `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" result="t"/><feColorMatrix in="t" type="saturate" values="0" result="m"/><feComponentTransfer in="m" result="s"><feFuncR type="linear" slope=".5" intercept=".72"/><feFuncG type="linear" slope=".5" intercept=".72"/><feFuncB type="linear" slope=".5" intercept=".72"/></feComponentTransfer><feBlend in="SourceGraphic" in2="s" mode="multiply" result="b"/><feComposite in="b" in2="SourceGraphic" operator="in"/></filter>`;
const duo = `<svg width="0" height="0" style="position:absolute"><filter id="duo" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values=".2126 .7152 .0722 0 0  .2126 .7152 .0722 0 0  .2126 .7152 .0722 0 0  0 0 0 1 0"/><feComponentTransfer><feFuncR type="table" tableValues=".1 .95"/><feFuncG type="table" tableValues=".15 .9"/><feFuncB type="table" tableValues=".35 .85"/></feComponentTransfer></filter></svg>`;

const slides = [
  // 1 cover: dark ground, big title on two lines (a pinned break), small light mono label, a photo
  sec("Cover", "#16181d", `
    <p style="${A}${MONO}left:96px;top:80px;font-size:14px;letter-spacing:.12em;color:#e8e6e1">SAMPLE DECK · 01</p>
    <h1 style="${A}${SANS}left:96px;top:300px;width:1100px;font-size:120px;line-height:1;font-weight:700;letter-spacing:-.02em;color:#f4f2ee">A neutral deck for testing</h1>
    <p style="${A}${SANS}left:96px;top:600px;width:700px;font-size:28px;line-height:1.35;color:#b9b6ae">Every feature the converter maps, in system fonts, so it renders the same on any Mac.</p>
    <img data-name="cover-photo" src="photo.png" style="${A}left:1300px;top:240px;width:520px;height:600px;object-fit:cover;border-radius:24px">`),
  // 2 type: styled runs, colour runs, centred text, small light-on-dark text in a card
  sec("Type", "#f6f4ef", `
    <h2 style="${A}${SANS}left:96px;top:96px;font-size:64px;font-weight:700;color:#16181d">Type and runs</h2>
    <p style="${A}${SANS}left:96px;top:240px;width:760px;font-size:26px;line-height:1.4;color:#33363d">A paragraph with a <b>bold run</b>, an <i>italic run</i>, a <span style="color:#d6336c">coloured run</span> and <u>an underline</u>, wrapping onto several lines inside a fixed width box.</p>
    <p style="${A}${SANS}left:1000px;top:240px;width:820px;font-size:40px;line-height:1.2;text-align:center;font-weight:500;color:#16181d">Centred, medium weight, two lines exactly</p>
    <div data-name="dark-card" style="${A}left:1000px;top:560px;width:820px;height:360px;background:#16181d;border-radius:16px">
      <p style="${A}${MONO}left:40px;top:40px;font-size:12px;letter-spacing:.08em;color:#f4f2ee">1.1 · SMALL LIGHT TEXT</p>
      <p style="${A}${MONO}left:40px;top:64px;font-size:12px;letter-spacing:.08em;color:#f4f2ee">1.2 · ON A DARK GROUND</p>
      <p style="${A}${SANS}left:40px;top:140px;width:740px;font-size:44px;line-height:1.1;font-weight:700;color:#f4f2ee">Light headline on dark</p>
    </div>
    <p style="${A}${MONO}left:96px;top:980px;font-size:14px;color:#6b6e75">02</p>`),
  // 3 effects: grain on a gradient, drop and inset shadows, layer blur, backdrop blur, multiply, rotation
  sec("Effects", "#ffffff", `
    <svg data-name="grain-field" style="${A}left:96px;top:96px" width="560" height="400"><defs><linearGradient id="gg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#7048e8"/></linearGradient>${grain}</defs><rect data-name="grain" width="100%" height="100%" fill="url(#gg)" filter="url(#grain)"/></svg>
    <div data-name="shadow-card" style="${A}left:760px;top:120px;width:400px;height:240px;background:#fff;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.25), inset 0 0 0 2px #e03131"><p style="${A}${SANS}left:32px;top:32px;font-size:28px;font-weight:700;color:#16181d">Shadow card</p></div>
    <div data-name="blur-blob" style="${A}left:1300px;top:120px;width:260px;height:260px;border-radius:50%;background:#20c997;filter:blur(18px)"></div>
    <div data-name="glass" style="${A}left:1360px;top:220px;width:400px;height:200px;background:rgba(255,255,255,.35);backdrop-filter:blur(10px);border-radius:12px"><p style="${A}${SANS}left:24px;top:24px;font-size:24px;color:#16181d">Backdrop blur</p></div>
    <div data-name="multiply" style="${A}left:160px;top:620px;width:300px;height:220px;background:#fab005;mix-blend-mode:multiply"></div>
    <div data-name="under" style="${A}left:300px;top:560px;width:300px;height:220px;background:#4dabf7"></div>
    <div data-name="rotated" style="${A}left:820px;top:620px;width:340px;height:160px;background:#16181d;transform:rotate(-8deg)"><p style="${A}${SANS}left:28px;top:52px;font-size:40px;font-weight:700;color:#f4f2ee">Rotated</p></div>
    <div data-name="drop" style="${A}left:1360px;top:620px;width:300px;height:180px;background:#e64980;filter:drop-shadow(0 8px 10px rgba(0,0,0,.4))"></div>`),
  // 4 images: toned photo, stretched photo, contained photo, masked photo, tiled dots
  sec("Images", "#f6f4ef", `${duo}
    <img data-name="toned" src="photo.png" style="${A}left:96px;top:96px;width:400px;height:400px;filter:url(#duo)">
    <img data-name="stretched" src="photo.png" style="${A}left:600px;top:96px;width:520px;height:200px">
    <img data-name="squashed" src="photo.png" style="${A}left:600px;top:360px;width:200px;height:200px;transform:scale(1.6,.6);transform-origin:0 0">
    <img data-name="contained" src="photo.png" style="${A}left:1220px;top:96px;width:600px;height:300px;object-fit:contain;background:#16181d">
    <img data-name="masked" src="photo.png" style="${A}left:96px;top:600px;width:400px;height:400px;-webkit-mask-image:radial-gradient(circle,#000 60%,transparent 61%);mask-image:radial-gradient(circle,#000 60%,transparent 61%)">
    <div data-name="dots" style="${A}left:600px;top:700px;width:720px;height:24px;background-image:radial-gradient(circle at 12px 12px,#16181d 10px,transparent 11px);background-size:48px 24px;background-repeat:repeat-x"></div>
    <div data-name="round" style="${A}left:1420px;top:600px;width:300px;height:300px;background:#7048e8;clip-path:circle(50% at 50% 50%)"></div>`),
  // 5 shapes: gradients, radii, borders, an svg icon, a pill label
  sec("Shapes", "#16181d", `
    <div data-name="linear" style="${A}left:96px;top:96px;width:520px;height:300px;border-radius:20px;background:linear-gradient(135deg,#ff922b,#f03e3e)"></div>
    <div data-name="radial" style="${A}left:700px;top:96px;width:520px;height:300px;border-radius:20px;background:radial-gradient(circle at 30% 40%,#63e6be,#1864ab)"></div>
    <div data-name="outline" style="${A}left:1300px;top:96px;width:520px;height:300px;border:4px solid #f4f2ee;border-radius:40px 0 40px 0"></div>
    <svg data-name="icon" style="${A}left:96px;top:520px" width="200" height="200" viewBox="0 0 24 24"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z" fill="#ffd43b"/></svg>
    <div data-name="pill" style="${A}left:400px;top:580px;height:56px;padding:0 28px;border-radius:28px;background:#f4f2ee;display:flex;align-items:center"><span style="${SANS}font-size:24px;font-weight:500;color:#16181d">Pill label</span></div>
    <p style="${A}${SANS}left:96px;top:820px;width:1200px;font-size:72px;line-height:1;font-weight:700;color:#f4f2ee">Shapes and gradients</p>`),
];

const deck = `<!doctype html><meta charset="utf-8"><title>Sample deck</title><body style="margin:0"><deck-stage>${slides.join("")}</deck-stage>
<script>customElements.define("deck-stage", class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>"; }
  connectedCallback() { this.goTo(0); }
  goTo(k) { [...this.querySelectorAll(":scope > section")].forEach((s, i) => { s.toggleAttribute("data-deck-active", i === k); s.style.display = i === k ? "block" : "none"; }); }
});</script>`;

rmSync(root, { recursive: true, force: true });
mkdirSync(deckDir, { recursive: true });
writeFileSync(join(deckDir, "sample.dc.html"), deck);
writeFileSync(join(deckDir, "photo.png"), photoPng());
const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "extract.ts"), "--deck", join(deckDir, "sample.dc.html"), "--out", join(root, "ir"), "--ref", join(root, "ref")], { stdout: "inherit", stderr: "inherit" });
process.exit(p.exitCode ?? 1);
