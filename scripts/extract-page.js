// Runs INSIDE the browser (injected by extract.ts). Plain JS, no imports.
// window.__fxExtract(index) walks the active <section> (open shadow roots included) and returns
// { label, background, nodes, warnings }. Nodes are IR nodes (see extract.ts header). Image nodes
// carry `src` (absolute URL or data: URL) instead of `ref`; extract.ts turns those into assets. Image fills with a `tile` spec
// (a repeating cell, scaleMode TILE) are rendered to a PNG cell by extract.ts, which then sets `ref` and `scalingFactor`.
// Everything is decided from computed style and SVG filter primitives, never from tag or class names (D-006).
// Raster fallbacks (last resort, D-008) carry `rasterEl` (index into window.__fxEls) for extract.ts to screenshot, `rasterMode`
// ("isolate" | "backdrop" | "composite") saying what extract.ts must hide while it does, and `rasterWhy` (the reason, for the report).
(() => {
  const SKIP = new Set(["STYLE", "SCRIPT", "LINK", "META", "TEMPLATE", "NOSCRIPT", "TITLE", "HEAD", "DEFS"]);
  const RASTER_TAGS = new Set(["CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED"]);
  const REPLACED = new Set(["IMG", "CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED", "INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
  const round = (n) => Math.round(n * 100) / 100;
  const cvs = document.createElement("canvas");
  cvs.width = cvs.height = 1;
  const g2 = cvs.getContext("2d", { willReadFrequently: true });

  // ---------- colour ----------
  const colorCache = new Map();
  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();
  function parseColor(str) {
    if (colorCache.has(str)) return colorCache.get(str);
    let r, g, b, a = 1;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      r = +m[1]; g = +m[2]; b = +m[3];
      if (m[4] != null) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4];
    } else {
      g2.clearRect(0, 0, 1, 1);
      g2.fillStyle = "#000";
      g2.fillStyle = str;
      g2.fillRect(0, 0, 1, 1);
      const d = g2.getImageData(0, 0, 1, 1).data;
      r = d[0]; g = d[1]; b = d[2]; a = d[3] / 255;
    }
    const out = { color: "#" + hex2(r) + hex2(g) + hex2(b), opacity: round(a) };
    colorCache.set(str, out);
    return out;
  }

  // ---------- helpers ----------
  const splitTop = (s, sep = ",") => {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === sep && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  };
  const splitWs = (s) => {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) { if (cur) parts.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  };
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const colorish = (s) => /^(rgba?|hsla?|color|oklch|oklab|lab|lch|hwb|#)/i.test(s) || s === "transparent";

  // ---------- fonts ----------
  const loadedFaces = new Set();
  const refreshFaces = () => {
    loadedFaces.clear();
    for (const f of document.fonts) if (f.status === "loaded") loadedFaces.add(f.family.replace(/^["']|["']$/g, "").toLowerCase());
  };
  const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);
  const famCache = new Map();
  function measureAvail(fam) {
    const c = document.createElement("canvas").getContext("2d");
    const txt = "mmmmmmmmmmlli";
    for (const base of ["monospace", "serif", "sans-serif"]) {
      c.font = `72px ${base}`;
      const w0 = c.measureText(txt).width;
      c.font = `72px "${fam}", ${base}`;
      if (Math.abs(c.measureText(txt).width - w0) > 0.01) return true;
    }
    return false;
  }
  function resolveFamily(stack) {
    if (famCache.has(stack)) return famCache.get(stack);
    let found = null;
    const list = splitTop(stack).map((s) => s.replace(/^["']|["']$/g, ""));
    for (const fam of list) {
      if (GENERIC.has(fam.toLowerCase())) { found = fam; break; }
      if (loadedFaces.has(fam.toLowerCase()) || measureAvail(fam)) { found = fam; break; }
    }
    found = found || list[list.length - 1] || "sans-serif";
    famCache.set(stack, found);
    return found;
  }
  function parseVariation(s) {
    const v = {};
    if (!s || s === "normal") return v;
    s.replace(/["'](\w{4})["']\s+(-?[\d.]+)/g, (_, tag, val) => { if (tag === "wght" || tag === "wdth") v[tag] = +val; return ""; });
    return v;
  }

  // ---------- filters: CSS functions and SVG <filter> primitives (decided from computed style, never tag or class) ----------
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const BLEND = {
    normal: "NORMAL", multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN", lighten: "LIGHTEN",
    "color-dodge": "COLOR_DODGE", "color-burn": "COLOR_BURN", "hard-light": "HARD_LIGHT", "soft-light": "SOFT_LIGHT",
    difference: "DIFFERENCE", exclusion: "EXCLUSION", hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
    "plus-lighter": "LINEAR_DODGE", "plus-darker": "LINEAR_BURN",
  };
  const blendName = (s) => BLEND[(s || "normal").trim().toLowerCase()] || null;
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const numList = (s) => (s || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  // feFuncX transfer function at x (0..1), result clamped to 0..1
  function funcEval(fe, x) {
    if (!fe) return x;
    const t = fe.getAttribute("type");
    let y = x;
    if (t === "table") {
      const v = numList(fe.getAttribute("tableValues"));
      if (v.length === 1) y = v[0];
      else if (v.length) { const n = v.length - 1, p = Math.min(x, 1) * n, i = Math.min(Math.floor(p), n - 1); y = v[i] + (p - i) * (v[i + 1] - v[i]); }
    } else if (t === "discrete") {
      const v = numList(fe.getAttribute("tableValues"));
      if (v.length) y = v[Math.min(Math.floor(x * v.length), v.length - 1)];
    } else if (t === "linear") {
      const s = fe.hasAttribute("slope") ? +fe.getAttribute("slope") : 1, i = fe.hasAttribute("intercept") ? +fe.getAttribute("intercept") : 0;
      y = s * x + i;
    } else if (t === "gamma") {
      const a = fe.hasAttribute("amplitude") ? +fe.getAttribute("amplitude") : 1, e = fe.hasAttribute("exponent") ? +fe.getAttribute("exponent") : 1, o = fe.hasAttribute("offset") ? +fe.getAttribute("offset") : 0;
      y = a * Math.pow(x, e) + o;
    }
    return clamp01(y);
  }
  function transferFns(tfEl) {
    const fn = [null, null, null, null];
    if (tfEl) for (const c of tfEl.children) { const i = { feFuncR: 0, feFuncG: 1, feFuncB: 2, feFuncA: 3 }[c.localName]; if (i != null) fn[i] = c; }
    return fn;
  }
  // 20 numbers of an feColorMatrix, or null when it is not a plain matrix / saturate
  function matrixValues(fe) {
    const type = fe.getAttribute("type") || "matrix", v = numList(fe.getAttribute("values"));
    if (type === "matrix") return v.length === 20 ? v : null;
    if (type === "saturate") {
      const s = v.length ? v[0] : 1;
      return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0, 0, 0, 0, 1, 0];
    }
    return null;
  }
  // Runs a chain of feColorMatrix / feComponentTransfer primitives on one opaque colour (0..1 per channel).
  function runChain(prims, linear, rgb) {
    let v = [rgb[0], rgb[1], rgb[2], 1];
    if (linear) v = [toLin(v[0]), toLin(v[1]), toLin(v[2]), 1];
    for (const p of prims) {
      if (p.localName === "feColorMatrix") {
        const m = matrixValues(p);
        v = [0, 1, 2, 3].map((r) => clamp01(m[r * 5] * v[0] + m[r * 5 + 1] * v[1] + m[r * 5 + 2] * v[2] + m[r * 5 + 3] * v[3] + m[r * 5 + 4]));
      } else {
        const fn = transferFns(p);
        v = [funcEval(fn[0], v[0]), funcEval(fn[1], v[1]), funcEval(fn[2], v[2]), v[3]];
      }
    }
    if (linear) v = [toSrgb(v[0]), toSrgb(v[1]), toSrgb(v[2])];
    return v.slice(0, 3);
  }
  const filterCache = new Map();
  // kind: grain | tone | blur | shadow | unknown. Lengths are CSS px (the caller scales them).
  function classifyFilter(fe) {
    if (filterCache.has(fe)) return filterCache.get(fe);
    const prims = [...fe.children].filter((c) => /^fe[A-Z]/.test(c.localName));
    const names = prims.map((p) => p.localName);
    const linear = (getComputedStyle(fe).colorInterpolationFilters || "linearrgb").toLowerCase() === "linearrgb"; // "auto" is sRGB in Chrome
    const greyRows = (m) => !!m && [0, 1, 2, 3, 4].every((j) => Math.abs(m[j] - m[5 + j]) < 1e-4 && Math.abs(m[j] - m[10 + j]) < 1e-4);
    let out = { kind: "unknown", why: "svg filter primitives with no native Figma mapping: " + (names.join(",") || "none") };
    if (names.includes("feTurbulence")) {
      const t = prims.find((p) => p.localName === "feTurbulence");
      const bl = prims.find((p) => p.localName === "feBlend");
      const benign = prims.every((p) => ["feTurbulence", "feColorMatrix", "feComponentTransfer", "feBlend", "feComposite"].includes(p.localName) && (p.localName !== "feComposite" || ["in", "atop"].includes(p.getAttribute("operator"))));
      const mats = prims.filter((p) => p.localName === "feColorMatrix").map(matrixValues);
      const mode = bl ? blendName(bl.getAttribute("mode")) : null;
      if (!bl) out.why = "feTurbulence without an feBlend onto SourceGraphic (pure noise, nothing to put the noise on)";
      else if (!benign || !mats.every(Boolean) || t.getAttribute("type") === "turbulence" || !mode) out.why = "feTurbulence grain with primitives outside colour-matrix / transfer / blend";
      else {
        const fn = transferFns(prims.find((p) => p.localName === "feComponentTransfer"));
        const ev = (x) => (funcEval(fn[0], x) + funcEval(fn[1], x) + funcEval(fn[2], x)) / 3;
        const enc = linear ? toSrgb : (v) => v; // filter maths in linearRGB: express the effect in sRGB, which is where Figma blends
        const v0 = enc(ev(0)), vm = enc(ev(0.5)), v1 = enc(ev(1));
        const neutral = { MULTIPLY: 1, DARKEN: 1, COLOR_BURN: 1, OVERLAY: 0.5, SOFT_LIGHT: 0.5, HARD_LIGHT: 0.5 }[mode] ?? 0;
        const bf = numList(t.getAttribute("baseFrequency"));
        out = { kind: "grain", noise: {
          type: "noise", baseFrequency: r3(bf.length ? bf.reduce((a, b) => a + b, 0) / bf.length : 0),
          octaves: t.hasAttribute("numOctaves") ? +t.getAttribute("numOctaves") : 1, seed: t.hasAttribute("seed") ? +t.getAttribute("seed") : 0,
          amount: r3(clamp01(Math.abs(v1 - v0))), bias: r3(vm - neutral), blend: mode, monochrome: mats.some(greyRows),
        } };
      }
    } else if (names.length && names.every((n) => n === "feColorMatrix" || n === "feComponentTransfer")) {
      const m0 = names[0] === "feColorMatrix" ? matrixValues(prims[0]) : null;
      const allMat = prims.filter((p) => p.localName === "feColorMatrix").every((p) => matrixValues(p));
      if (m0 && greyRows(m0) && allMat && Math.abs(m0[18] - 1) < 1e-4 && [15, 16, 17, 19].every((j) => Math.abs(m0[j]) < 1e-4)) {
        const F = [0, 0.5, 1].map((L) => runChain(prims, linear, [L, L, L]).map((c) => Math.round(c * 10000) / 10000));
        out = { kind: "tone", tone: { F } };
      } else out.why = "svg colour filter that does not reduce to luminance first (per-channel curves / hue shifts)";
    } else if (names.length === 1 && names[0] === "feGaussianBlur" && (!prims[0].getAttribute("in") || prims[0].getAttribute("in") === "SourceGraphic")) {
      const sd = numList(prims[0].getAttribute("stdDeviation"));
      out = { kind: "blur", sigma: sd.length ? (sd[0] + (sd[1] ?? sd[0])) / 2 : 0 };
    } else if (names.length === 1 && names[0] === "feDropShadow") {
      const p = prims[0], pcs = getComputedStyle(p), c = parseColor(pcs.floodColor);
      const sd = numList(p.getAttribute("stdDeviation"));
      out = { kind: "shadow", shadow: { color: c.color, opacity: round(c.opacity * parseFloat(pcs.floodOpacity)), x: +(p.getAttribute("dx") || 2), y: +(p.getAttribute("dy") || 2), sigma: sd.length ? sd[0] : 2 } };
    }
    filterCache.set(fe, out);
    return out;
  }
  // What an element's CSS `filter` list asks for: Figma effects, image adjustments, a tone stack, extra opacity, or a failure (raster).
  function filterPlan(el, cs, k) {
    const plan = { effects: [], imageFilters: null, tone: null, opacity: 1, fail: null };
    const f = cs.filter;
    if (!f || f === "none") return plan;
    const fail = (why, detail) => { if (!plan.fail) plan.fail = { why, detail }; };
    const img = {};
    const bump = (key, d) => { img[key] = Math.max(-1, Math.min(1, (img[key] || 0) + d)); };
    for (const fn of splitWs(f)) {
      const m = fn.match(/^([a-z-]+)\((.*)\)$/s);
      if (!m) { fail("css-filter", "unparsed filter " + fn.slice(0, 40)); continue; }
      const name = m[1], arg = m[2].trim();
      const amt = () => (arg.endsWith("%") ? parseFloat(arg) / 100 : arg === "" ? 1 : +arg);
      if (name === "blur") plan.effects.push({ type: "layer-blur", radius: round(2 * px(arg) * k) });
      else if (name === "drop-shadow") {
        const toks = splitWs(arg), colTok = toks.find((t) => colorish(t));
        const ls = toks.filter((t) => t !== colTok).map(parseFloat);
        const c = parseColor(colTok || cs.color);
        plan.effects.push({ type: "drop-shadow", color: c.color, opacity: c.opacity, x: round((ls[0] || 0) * k), y: round((ls[1] || 0) * k), blur: round(2 * (ls[2] || 0) * k), spread: 0 });
      } else if (name === "opacity") plan.opacity *= amt();
      else if (el.tagName === "IMG" || el.localName === "image") {
        if (name === "grayscale") bump("saturation", -amt());
        else if (name === "saturate") bump("saturation", amt() - 1);
        else if (name === "contrast") bump("contrast", amt() - 1);
        else if (name === "brightness") bump("exposure", amt() - 1);
        else if (name !== "url") fail("css-filter", name + "() has no Figma image adjustment");
      } else if (name !== "url") fail("css-filter", name + "() on a non-image element");
      if (name === "url") {
        const id = arg.replace(/^["']|["']$/g, "");
        const root = el.getRootNode();
        const fe = id[0] === "#" ? ((root.getElementById && root.getElementById(id.slice(1))) || document.getElementById(id.slice(1))) : null;
        const cls = fe && fe.localName === "filter" ? classifyFilter(fe) : { kind: "unknown", why: "filter " + id.slice(0, 40) + " not found in the document" };
        if (cls.kind === "grain") plan.effects.push(cls.noise);
        else if (cls.kind === "tone") { if (plan.tone) fail("svg-filter", "two tone filters on one element"); else plan.tone = cls.tone; }
        else if (cls.kind === "blur") plan.effects.push({ type: "layer-blur", radius: round(2 * cls.sigma * k) });
        else if (cls.kind === "shadow") plan.effects.push({ type: "drop-shadow", color: cls.shadow.color, opacity: cls.shadow.opacity, x: round(cls.shadow.x * k), y: round(cls.shadow.y * k), blur: round(2 * cls.shadow.sigma * k), spread: 0 });
        else fail("svg-filter", cls.why);
      }
    }
    if (Object.keys(img).length) plan.imageFilters = Object.fromEntries(Object.entries(img).map(([a, b]) => [a, round(b)]));
    return plan;
  }
  // Tone mapping as a stack over a greyscale photo (all in sRGB, Figma / CSS blend maths).
  // F = filter output for grey input 0, .5, 1. Per channel: out = lo + (hi - lo) * o(L), o = overlay curve through (0,0) (.5,s) (1,1).
  //   DIFFERENCE k (inverts channels where the tone runs light to dark) -> OVERLAY s (bends the middle) -> MULTIPLY X -> SCREEN Y
  //   with Y = lo, X = (hi - lo) / (1 - lo), s = (mid - lo) / (hi - lo): exact when the mid tone lies between the end tones.
  function toneStack(F) {
    const inv = [0, 0, 0], s = [0.5, 0.5, 0.5], X = [1, 1, 1], Y = [0, 0, 0];
    let bend = false;
    for (let c = 0; c < 3; c++) {
      let lo = F[0][c], hi = F[2][c];
      const mid = F[1][c];
      if (lo > hi) { inv[c] = 1; [lo, hi] = [hi, lo]; }
      const span = hi - lo;
      if (span > 1e-4) { s[c] = clamp01((mid - lo) / span); if (Math.abs(mid - (lo + hi) / 2) > 0.004) bend = true; }
      X[c] = lo < 0.9999 ? clamp01(span / (1 - lo)) : 0;
      Y[c] = lo;
    }
    const hex3 = (v) => "#" + v.map((q) => hex2(q * 255)).join("");
    const layers = [];
    if (inv.some(Boolean)) layers.push({ color: hex3(inv), blendMode: "DIFFERENCE" });
    if (bend) layers.push({ color: hex3(s), blendMode: "OVERLAY" });
    if (X.some((q) => q < 0.9999)) layers.push({ color: hex3(X), blendMode: "MULTIPLY" });
    if (Y.some((q) => q > 0.0001)) layers.push({ color: hex3(Y), blendMode: "SCREEN" });
    return layers;
  }


  // ---------- gradients / backgrounds ----------
  function angleToDeg(tok, w, h) {
    const t = tok.trim().toLowerCase();
    let m;
    if ((m = t.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/))) {
      const n = +m[1];
      return m[2] === "deg" ? n : m[2] === "grad" ? n * 0.9 : m[2] === "rad" ? (n * 180) / Math.PI : n * 360;
    }
    if (t.startsWith("to ")) {
      const s = t.slice(3).split(/\s+/);
      const a = Math.atan2(w, h) * 180 / Math.PI;
      const has = (x) => s.includes(x);
      if (has("top") && has("right")) return a;
      if (has("bottom") && has("right")) return 180 - a;
      if (has("bottom") && has("left")) return 180 + a;
      if (has("top") && has("left")) return 360 - a;
      if (has("top")) return 0;
      if (has("right")) return 90;
      if (has("bottom")) return 180;
      if (has("left")) return 270;
    }
    return null;
  }
  function parseStops(parts, lenPx) {
    const stops = [];
    for (const p of parts) {
      const toks = splitWs(p);
      if (!toks.length) continue;
      const poss = [];
      while (toks.length > 1 && /^-?[\d.]+(%|px)$/.test(toks[toks.length - 1])) poss.unshift(toks.pop());
      if (!toks.length || !colorish(toks[0])) continue; // interpolation hint or junk
      const c = parseColor(toks.join(" "));
      const posOf = (s) => (s.endsWith("%") ? parseFloat(s) / 100 : lenPx ? parseFloat(s) / lenPx : 0);
      if (!poss.length) stops.push({ pos: null, color: c.color, opacity: c.opacity });
      else for (const ps of poss) stops.push({ pos: posOf(ps), color: c.color, opacity: c.opacity });
    }
    if (!stops.length) return [];
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    let last = 0;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].pos != null) { stops[i].pos = Math.max(stops[i].pos, i ? stops[i - 1].pos : 0); last = i; continue; }
      let j = i;
      while (stops[j].pos == null) j++;
      const a = stops[i - 1].pos, b = stops[j].pos;
      for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
      i = j - 1;
    }
    return stops.map((s) => ({ pos: round(Math.min(1, Math.max(0, s.pos))), color: s.color, opacity: s.opacity }));
  }
  function gradientFill(layer, w, h, warn) {
    let m;
    if ((m = layer.match(/^(repeating-)?linear-gradient\((.*)\)$/s))) {
      const parts = splitTop(m[2]);
      let ang = angleToDeg(parts[0], w, h);
      if (ang != null) parts.shift(); else ang = 180;
      const rad = (ang * Math.PI) / 180;
      const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      const stops = parseStops(parts, len);
      if (m[1]) warn("repeating-linear-gradient approximated");
      return stops.length ? { type: "linear", angleDeg: round(((ang % 360) + 360) % 360), stops } : null;
    }
    if ((m = layer.match(/^(repeating-)?radial-gradient\((.*)\)$/s))) {
      const parts = splitTop(m[2]);
      if (parts.length && !colorish(splitWs(parts[0])[0] || "")) parts.shift();
      const stops = parseStops(parts, Math.max(w, h) / 2);
      return stops.length ? { type: "radial", stops } : null;
    }
    return null;
  }
  // repeat keyword(s) -> [repeats in x, repeats in y]
  function repeatFlags(rep) {
    const t = splitWs(rep || "repeat");
    if (t[0] === "repeat-x") return [true, false];
    if (t[0] === "repeat-y") return [false, true];
    return [t[0] !== "no-repeat", (t[1] ?? t[0]) !== "no-repeat"];
  }
  // One background / mask layer in a w x h box (slide px, k = css-to-slide scale). Returns
  //   { kind: "fill", fill }               covers the box: native gradient / image fill
  //   { kind: "tile", fill }               repeats a cell smaller than the box: image fill scaleMode TILE (extract.ts renders the cell)
  //   { kind: "inset", rect, fill }        one non-repeating copy smaller than the box: a rect at rect {x,y,w,h} (box-relative)
  //   { kind: "none" }
  function parseLayer(layer, size, pos, rep, w, h, k, warn) {
    let m;
    const grad = /^(repeating-)?(linear|radial)-gradient\(/.test(layer);
    const url = (m = layer.match(/^url\((["']?)(.*)\1\)$/s)) ? m[2] : null;
    if (!grad && !url) { if (layer.includes("conic-gradient")) warn("conic-gradient unsupported, dropped"); return { kind: "none" }; }
    const toks = splitWs(size || "auto");
    const keyword = toks[0] === "cover" || toks[0] === "contain" ? toks[0] : null;
    const dim = (t, full) => (!t || t === "auto" ? null : t.endsWith("%") ? (full * parseFloat(t)) / 100 : px(t) * k);
    let tw = keyword ? w : dim(toks[0], w), th = keyword ? h : dim(toks[1], h);
    const [rx, ry] = repeatFlags(rep);
    const natural = !!url && !keyword && (tw == null || th == null); // image at its own size, which is unknown here
    if (!url) { if (tw == null) tw = w; if (th == null) th = h; }
    if (url && (keyword || (natural && !(rx || ry)))) return { kind: "fill", fill: { type: "image", src: url, scaleMode: keyword === "contain" ? "FIT" : "FILL" } };
    if (natural) return { kind: "tile", fill: { type: "image", src: url, scaleMode: "TILE", scalingFactor: round(k) } };
    const tilesX = rx && tw < w - 0.5, tilesY = ry && th < h - 0.5;
    const [p0, p1] = splitWs(pos || "0% 0%");
    const off = (t, free) => (!t ? 0 : t.endsWith("%") ? (free * parseFloat(t)) / 100 : px(t) * k);
    if (tilesX || tilesY) {
      const cw = tilesX ? tw : w, ch = tilesY ? th : h;
      let ox = off(p0, w - tw), oy = off(p1, h - th);
      if (tilesX) ox = ((ox % tw) + tw) % tw;
      if (tilesY) oy = ((oy % th) + th) % th;
      return { kind: "tile", fill: { type: "image", scaleMode: "TILE", tile: {
        layer, cw: round(cw / k), ch: round(ch / k), size: `${round(tw / k)}px ${round(th / k)}px`, pos: `${round(ox / k)}px ${round(oy / k)}px`,
        repeat: `${tilesX ? "repeat" : "no-repeat"} ${tilesY ? "repeat" : "no-repeat"}`, scale: round(k),
      } } };
    }
    if (tw >= w - 0.5 && th >= h - 0.5) return { kind: "fill", fill: url ? { type: "image", src: url, scaleMode: "FILL" } : gradientFill(layer, w, h, warn) };
    const x0 = Math.max(0, off(p0, w - tw)), y0 = Math.max(0, off(p1, h - th));
    const rect = { x: x0, y: y0, w: Math.min(tw, w - x0), h: Math.min(th, h - y0) };
    if (rect.w < 0.5 || rect.h < 0.5) return { kind: "none" };
    return { kind: "inset", rect, fill: url ? { type: "image", src: url, scaleMode: "FILL" } : gradientFill(layer, tw, th, warn) };
  }
  // Returns { fills (bottom to top), extras: inset layers as { rect, fill } }
  function parseBackground(cs, w, h, k, warn) {
    const fills = [], extras = [];
    const bg = parseColor(cs.backgroundColor);
    if (bg.opacity > 0) fills.push({ type: "solid", color: bg.color, opacity: bg.opacity });
    const img = cs.backgroundImage;
    if (img && img !== "none") {
      const layers = splitTop(img);
      const sizes = splitTop(cs.backgroundSize || "auto"), poss = splitTop(cs.backgroundPosition || "0% 0%"), reps = splitTop(cs.backgroundRepeat || "repeat");
      const layerFills = [];
      layers.forEach((layer, i) => {
        const r = parseLayer(layer, sizes[i % sizes.length], poss[i % poss.length], reps[i % reps.length], w, h, k, warn);
        if (!r.fill) return;
        if (r.kind === "inset") extras.push({ rect: r.rect, fill: r.fill });
        else layerFills.push(r.fill);
      });
      layerFills.reverse(); // CSS first layer is on top; IR fills go bottom to top
      fills.push(...layerFills);
    }
    return { fills, extras };
  }

  // ---------- SVG ----------
  function serializeSvg(svgEl, w, h, warn) {
    const clone = svgEl.cloneNode(true);
    const src = [svgEl, ...svgEl.querySelectorAll("*")];
    const dst = [clone, ...clone.querySelectorAll("*")];
    const toRemove = [];
    for (let i = 0; i < src.length; i++) {
      const e = src[i], d = dst[i];
      const tag = e.tagName.toLowerCase();
      if (tag === "style" || tag === "script" || tag === "filter") { toRemove.push(d); continue; }
      const cs = getComputedStyle(e);
      if (cs.display === "none" && tag !== "defs" && !/gradient|pattern|clippath|mask|marker|symbol/.test(tag)) { toRemove.push(d); continue; }
      d.removeAttribute("style");
      d.removeAttribute("class");
      d.removeAttribute("filter");
      if (tag === "stop") {
        d.setAttribute("stop-color", cs.stopColor);
        d.setAttribute("stop-opacity", cs.stopOpacity);
        continue;
      }
      if (/gradient|pattern|clippath|mask|marker|symbol|defs|title|desc/.test(tag)) continue;
      d.setAttribute("fill", cs.fill);
      d.setAttribute("stroke", cs.stroke);
      if (cs.stroke !== "none") {
        d.setAttribute("stroke-width", cs.strokeWidth.replace("px", ""));
        if (cs.strokeLinecap !== "butt") d.setAttribute("stroke-linecap", cs.strokeLinecap);
        if (cs.strokeLinejoin !== "miter") d.setAttribute("stroke-linejoin", cs.strokeLinejoin);
        if (cs.strokeDasharray !== "none") d.setAttribute("stroke-dasharray", cs.strokeDasharray.replace(/px/g, ""));
        if (cs.strokeOpacity !== "1") d.setAttribute("stroke-opacity", cs.strokeOpacity);
      }
      if (cs.fillOpacity !== "1") d.setAttribute("fill-opacity", cs.fillOpacity);
      if (cs.fillRule !== "nonzero") d.setAttribute("fill-rule", cs.fillRule);
      if (cs.opacity !== "1") d.setAttribute("opacity", cs.opacity);
      if (cs.transform !== "none" && !e.hasAttribute("transform") && e !== svgEl) d.setAttribute("transform", cs.transform);
      if (tag === "text" || tag === "tspan") {
        d.setAttribute("font-family", cs.fontFamily);
        d.setAttribute("font-size", cs.fontSize.replace("px", ""));
        d.setAttribute("font-weight", cs.fontWeight);
        if (cs.letterSpacing !== "normal") d.setAttribute("letter-spacing", cs.letterSpacing.replace("px", ""));
      }
    }
    toRemove.forEach((n) => n.remove());
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", String(round(w)));
    clone.setAttribute("height", String(round(h)));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${round(w)} ${round(h)}`);
    clone.removeAttribute("style");
    clone.removeAttribute("class");
    clone.removeAttribute("filter");
    return new XMLSerializer().serializeToString(clone);
  }

  // ---------- main ----------
  window.__fxEls = [];
  window.__fxExtract = function (index) {
    refreshFaces();
    window.__fxEls = [];
    const section = document.querySelectorAll("deck-stage > section")[index];
    if (!section) throw new Error("no section " + index);
    const sr = section.getBoundingClientRect();
    const scale = sr.width / 1920;
    const warnings = new Map();
    const warn = (m) => warnings.set(m, (warnings.get(m) || 0) + 1);
    const rel = (r) => ({ x: (r.left - sr.left) / scale, y: (r.top - sr.top) / scale, w: r.width / scale, h: r.height / scale });
    const W = 1920, H = 1080;
    const nodes = [];

    const nameOf = (el) => {
      if (el.getAttribute && el.getAttribute("data-name")) return el.getAttribute("data-name");
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const c = (el.getAttribute && el.getAttribute("class")) || "";
      return c ? `${tag}.${c.split(/\s+/)[0]}` : tag;
    };

    const childList = (el) => {
      const base = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
      const out = [];
      const push = (n) => {
        if (n.nodeType === 1 && n.tagName === "SLOT") {
          const a = n.assignedNodes({ flatten: true });
          (a.length ? a : [...n.childNodes]).forEach(push);
        } else out.push(n);
      };
      base.forEach(push);
      return out;
    };

    const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    // Intersection of a box with every ancestor overflow clip (and the slide). Null if nothing is left.
    function clipBox(box, ctx) {
      let x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
      for (const c of ctx.clips) { x0 = Math.max(x0, c.rect.x); y0 = Math.max(y0, c.rect.y); x1 = Math.min(x1, c.rect.x + c.rect.w); y1 = Math.min(y1, c.rect.y + c.rect.h); }
      return x1 - x0 > 0.01 && y1 - y0 > 0.01 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    const sameBox = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

    // Is the node's slide-space box worth emitting given ancestor clips and the slide itself?
    function visibleBox(box, ctx) {
      if (!intersects(box, { x: 0, y: 0, w: W, h: H })) return false;
      for (const c of ctx.clips) if (!intersects(box, c.rect)) return false;
      return true;
    }
    function noteClip(box, ctx) {
      for (const c of ctx.clips) {
        const r = c.rect;
        if (box.x < r.x - 1 || box.y < r.y - 1 || box.x + box.w > r.x + r.w + 1 || box.y + box.h > r.y + r.h + 1) { warn("node extends beyond ancestor overflow clip (not cropped)"); break; }
      }
    }
    function inheritClipRadius(box, radius, ctx) {
      if (radius.some((v) => v > 0)) return radius;
      for (let i = ctx.clips.length - 1; i >= 0; i--) {
        const c = ctx.clips[i];
        if (!c.radius.some((v) => v > 0)) continue;
        const r = c.rect;
        if (Math.abs(box.x - r.x) < 1.5 && Math.abs(box.y - r.y) < 1.5 && Math.abs(box.w - r.w) < 1.5 && Math.abs(box.h - r.h) < 1.5) return c.radius;
      }
      return radius;
    }

    function radiusOf(cs, w, h, k) {
      const one = (v) => {
        const first = v.split(" ")[0];
        const n = parseFloat(first);
        if (!Number.isFinite(n)) return 0;
        return first.endsWith("%") ? (n / 100) * w : n * k;
      };
      const max = Math.min(w, h) / 2;
      return [one(cs.borderTopLeftRadius), one(cs.borderTopRightRadius), one(cs.borderBottomRightRadius), one(cs.borderBottomLeftRadius)].map((v) => round(Math.max(0, Math.min(v, max))));
    }

    function pushRaster(el, box, why, ctx, extra = {}) {
      const b = { x: Math.max(0, box.x), y: Math.max(0, box.y) };
      b.w = Math.min(W, box.x + box.w) - b.x;
      b.h = Math.min(H, box.y + box.h) - b.y;
      if (b.w < 1 || b.h < 1) return;
      window.__fxEls.push(el);
      nodes.push({ type: "image", name: "raster:" + why, x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h), src: null, rasterEl: window.__fxEls.length - 1, scaleMode: "FILL", opacity: round(ctx.op), radius: [0, 0, 0, 0], ...extra });
      warn("raster fallback: " + why);
    }

    // ----- effects: decided from computed style / SVG filter primitives, never tag or class -----
    // Reach of a CSS filter list beyond the element box, in unscaled px (3 sigma for blur and drop-shadow).
    function filterMargin(f) {
      let m = 0;
      for (const fn of f.match(/(blur|drop-shadow)\((?:[^()]|\([^)]*\))*\)/g) || []) {
        const nums = (fn.replace(/(rgba?|hsla?|color|oklch|oklab|lab|lch|hwb)\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
        if (fn.startsWith("blur")) m += 3 * (nums[0] || 0);
        else m += Math.max(Math.abs(nums[0] || 0), Math.abs(nums[1] || 0)) + 3 * (nums[2] || 0);
      }
      return m;
    }
    const aabb = (n) => {
      const r = ((n.rotation || 0) * Math.PI) / 180;
      if (!r || n.type === "group") return { x: n.x, y: n.y, w: n.w, h: n.h };
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      const W2 = n.w * c + n.h * s, H2 = n.w * s + n.h * c;
      return { x: cx - W2 / 2, y: cy - H2 / 2, w: W2, h: H2 };
    };
    const unionBox = (bs) => {
      const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
      return { x: round(x0), y: round(y0), w: round(Math.max(...bs.map((b) => b.x + b.w)) - x0), h: round(Math.max(...bs.map((b) => b.y + b.h)) - y0) };
    };
    // Adds effects / blendMode to one node, or wraps several nodes in a group that carries them.
    function attach(seg, el, props) {
      if (!seg.length) return seg;
      if (seg.length === 1 && !(props.blendMode && seg[0].blendMode)) {
        const n = seg[0];
        if (props.effects) n.effects = [...(n.effects || []), ...props.effects];
        if (props.blendMode) n.blendMode = props.blendMode;
        return seg;
      }
      return [{ type: "group", name: nameOf(el), ...unionBox(seg.map(aabb)), children: seg, ...props }];
    }
    // Photo tone: greyscale the photo (Figma image adjustment on an image, a SATURATION layer on anything else), then the blend stack.
    function toneWrap(seg, tone, el) {
      const layers = toneStack(tone.F);
      if (seg.length === 1 && seg[0].type === "image") {
        const im = seg[0];
        const keep = { ...im, opacity: 1, filters: { ...(im.filters || {}), saturation: -1 } };
        const kids = [keep, ...layers.map((l) => ({ type: "rect", name: "tone " + l.blendMode.toLowerCase(), x: im.x, y: im.y, w: im.w, h: im.h, fills: [{ type: "solid", color: l.color, opacity: 1 }], radius: im.radius || [0, 0, 0, 0], stroke: null, opacity: 1, blendMode: l.blendMode }))];
        return [{ type: "group", name: "tone " + im.name, x: im.x, y: im.y, w: im.w, h: im.h, children: kids, blendMode: "NORMAL", opacity: im.opacity }];
      }
      const u = unionBox(seg.map(aabb));
      const mk = (name, color, blendMode) => ({ type: "rect", name, ...u, fills: [{ type: "solid", color, opacity: 1 }], radius: [0, 0, 0, 0], stroke: null, opacity: 1, blendMode });
      return [{ type: "group", name: "tone " + nameOf(el), ...u, children: [...seg, mk("tone desaturate", "#808080", "SATURATION"), ...layers.map((l) => mk("tone " + l.blendMode.toLowerCase(), l.color, l.blendMode))], blendMode: "NORMAL", opacity: 1 }];
    }
    function applyPlan(seg, el, plan) {
      if (!seg.length) return seg;
      if (plan.imageFilters) { const im = seg.find((n) => n.type === "image"); if (im) im.filters = { ...(im.filters || {}), ...plan.imageFilters }; }
      if (plan.tone) seg = toneWrap(seg, plan.tone, el);
      if (plan.effects.length) seg = attach(seg, el, { effects: plan.effects });
      return seg;
    }
    // A mask is a group whose first child is the mask shape (rect with the mask image / gradient as fill, or an svg shape).
    function maskWrap(seg, el, mask) {
      if (!seg.length) return seg;
      return [{ type: "group", name: "mask " + nameOf(el), ...unionBox([mask.node, ...seg].map(aabb)), mask: true, children: [mask.node, ...seg] }];
    }
    function clipShape(cp, box, k, cs) {
      const svgNode = (inner) => ({ type: "svg", name: "mask", x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${round(box.w)}" height="${round(box.h)}" viewBox="0 0 ${round(box.w)} ${round(box.h)}">${inner}</svg>`, opacity: 1 });
      const len = (t, full) => (t.endsWith("%") ? (full * parseFloat(t)) / 100 : px(t) * k);
      let m;
      if ((m = cp.match(/^inset\((.*)\)$/s))) {
        const [lens, rnd] = m[1].split(/\s+round\s+/);
        const v = splitWs(lens);
        const [t, r, b, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
        const T = len(t, box.h), R = len(r, box.w), B = len(b, box.h), L = len(l, box.w);
        const rad = rnd ? len(splitWs(rnd)[0], Math.min(box.w, box.h)) : 0;
        if (!T && !R && !B && !L && !rad) return { noop: true };
        const w = box.w - L - R, h = box.h - T - B;
        return { node: { type: "rect", name: "mask", x: round(box.x + L), y: round(box.y + T), w: round(w), h: round(h), fills: [{ type: "solid", color: "#000000", opacity: 1 }], radius: [rad, rad, rad, rad].map((q) => round(Math.min(q, w / 2, h / 2))), stroke: null, opacity: 1 } };
      }
      const at = (s) => { const [pa, pb] = s ? splitWs(s) : ["50%", "50%"]; const kw = { left: "0%", top: "0%", center: "50%", right: "100%", bottom: "100%" }; return [len(kw[pa] || pa || "50%", box.w), len(kw[pb] || pb || "50%", box.h)]; };
      if ((m = cp.match(/^circle\((.*)\)$/s))) {
        const [rs, pos] = m[1].split(/\s+at\s+/);
        const [cx, cy] = at(pos);
        const rr = (rs || "").trim();
        const r = rr === "closest-side" ? Math.min(cx, cy, box.w - cx, box.h - cy) : rr === "farthest-side" ? Math.max(cx, cy, box.w - cx, box.h - cy) : rr ? len(rr, Math.sqrt((box.w * box.w + box.h * box.h) / 2)) : Math.min(cx, cy, box.w - cx, box.h - cy);
        return { node: svgNode(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="#000"/>`) };
      }
      if ((m = cp.match(/^ellipse\((.*)\)$/s))) {
        const [rs, pos] = m[1].split(/\s+at\s+/);
        const [cx, cy] = at(pos);
        const [a, b] = splitWs(rs || "closest-side closest-side");
        const rx = a === "closest-side" ? Math.min(cx, box.w - cx) : a === "farthest-side" ? Math.max(cx, box.w - cx) : len(a, box.w);
        const ry = b === "closest-side" ? Math.min(cy, box.h - cy) : b === "farthest-side" ? Math.max(cy, box.h - cy) : len(b, box.h);
        return { node: svgNode(`<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(rx)}" ry="${round(ry)}" fill="#000"/>`) };
      }
      if ((m = cp.match(/^polygon\((.*)\)$/s))) {
        const pts = splitTop(m[1]);
        const rule = /^(nonzero|evenodd)$/.test(pts[0]) ? pts.shift() : "nonzero";
        const xy = pts.map((p) => { const [a, b] = splitWs(p); return round(len(a, box.w)) + "," + round(len(b, box.h)); });
        return { node: svgNode(`<polygon points="${xy.join(" ")}" fill="#000" fill-rule="${rule}"/>`) };
      }
      return { fail: { why: "clip-path", detail: "clip-path " + cp.slice(0, 40) + " has no native mapping" } };
    }
    function maskSpec(el, cs, box, ctx) {
      const k = ctx.k;
      const mi = cs.maskImage && cs.maskImage !== "none" ? cs.maskImage : cs.webkitMaskImage && cs.webkitMaskImage !== "none" ? cs.webkitMaskImage : null;
      if (mi) {
        const layers = splitTop(mi);
        if (layers.length > 1) warn("multiple mask layers: top layer only");
        const first = (a, b, d) => splitTop(a || b || d)[0];
        const r = parseLayer(layers[0], first(cs.maskSize, cs.webkitMaskSize, "auto"), first(cs.maskPosition, cs.webkitMaskPosition, "0% 0%"), first(cs.maskRepeat, cs.webkitMaskRepeat, "repeat"), box.w, box.h, k, warn);
        if (!r.fill) return { fail: { why: "css-mask", detail: "mask-image " + layers[0].slice(0, 40) + " has no native mapping" } };
        const rect = r.kind === "inset" ? { x: box.x + r.rect.x, y: box.y + r.rect.y, w: r.rect.w, h: r.rect.h } : box;
        return { node: { type: "rect", name: "mask", x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h), fills: [r.fill], radius: r.kind === "inset" ? [0, 0, 0, 0] : radiusOf(cs, box.w, box.h, k), stroke: null, opacity: 1 } };
      }
      const cp = cs.clipPath;
      if (cp && cp !== "none") {
        const r = clipShape(cp, box, k, cs);
        return r.noop ? null : r;
      }
      return null;
    }
    function backdropFx(cs, k) {
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === "none") return [];
      const out = [];
      for (const fn of splitWs(bf)) {
        const m = fn.match(/^([a-z-]+)\((.*)\)$/s);
        if (m && m[1] === "blur") out.push({ type: "background-blur", radius: round(2 * px(m[2]) * k) });
        else warn("backdrop-filter " + (m ? m[1] + "()" : fn) + " ignored (only blur maps to Figma)");
      }
      return out;
    }

    // ----- transforms -----
    // scale: uniform scale only (folded into k); rot: rotation plus scale, no shear (decomposed M = R(theta) * diag(sx, sy));
    // skew: a real shear remains; 3d: not a 2D matrix.
    function analyzeTransform(t) {
      let a, b, c, d, m;
      if ((m = t.match(/^matrix\(([^)]+)\)$/))) [a, b, c, d] = m[1].split(",").map(Number);
      else if ((m = t.match(/^matrix3d\(([^)]+)\)$/))) {
        const v = m[1].split(",").map(Number);
        if (![2, 3, 6, 7, 8, 9, 11, 14].every((i) => Math.abs(v[i]) < 1e-6) || Math.abs(v[10] - 1) > 1e-6 || Math.abs(v[15] - 1) > 1e-6) return { kind: "3d" };
        [a, b, c, d] = [v[0], v[1], v[4], v[5]];
      } else return { kind: "3d" };
      const sx = Math.hypot(a, b);
      if (sx < 1e-6) return { kind: "skew" };
      const sy = (a * d - b * c) / sx, shear = (a * c + b * d) / sx;
      const axis = Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3;
      if (axis && Math.abs(sx - Math.hypot(c, d)) <= 0.01) return { kind: "scale", s: sx }; // a mirror is ignored, as before
      if (sy <= 0 || Math.abs(shear) > 0.01 * Math.max(sx, sy)) return { kind: "skew" };
      return { kind: "rot", theta: (Math.atan2(b, a) * 180) / Math.PI, sx, sy };
    }
    const scaleProps = (n, s) => {
      if (n.radius) n.radius = n.radius.map((v) => round(v * s));
      if (n.stroke) n.stroke = { ...n.stroke, width: round(n.stroke.width * s) };
      if (n.runs) for (const r of n.runs) { r.fontSize = round(r.fontSize * s); r.lineHeightPx = round(r.lineHeightPx * s); r.letterSpacingPx = round(r.letterSpacingPx * s); }
      if (n.effects) for (const e of n.effects) for (const key of ["x", "y", "blur", "spread", "radius"]) if (typeof e[key] === "number" && e.type !== "noise") e[key] = round(e[key] * s);
    };
    // Bitmap aspect (natural w/h) of each <img> node, for stretching it under a non-uniform scale. Not part of the IR.
    const natAspect = (window.__natAspect = window.__natAspect || new WeakMap());
    // Turns an image node into scaleMode STRETCH (the whole bitmap mapped onto the box, which Figma does with CROP + identity
    // imageTransform), so a non-uniform scale can stretch the box. FIT shrinks the box to the drawn bitmap first; FILL works when it
    // shows the whole bitmap (same aspect). Returns "" when done, else why not.
    function toStretch(n) {
      if (n.scaleMode === "STRETCH") return "";
      const a = natAspect.get(n);
      if (!a) return "an image of unknown aspect under a non-uniform scale";
      if (n.scaleMode === "FIT") {
        const dw = Math.min(n.w, n.h * a), dh = dw / a;
        n.x = n.x + (n.w - dw) / 2; n.y = n.y + (n.h - dh) / 2; n.w = dw; n.h = dh;
      } else if (n.scaleMode !== "FILL" || Math.abs(a / (n.w / n.h) - 1) > 0.02) return "a cropped image under a non-uniform scale";
      n.scaleMode = "STRETCH";
      return "";
    }
    // Moves one node into a rotated frame: F = { ox, oy, cos, sin, sx, sy, theta, uniform }. Returns "" when moved, else why it cannot be
    // (text / images / rounded corners under a non-uniform scale, rasters).
    function frameNode(n, F) {
      if (n.type === "group") {
        for (const c of n.children) { const why = frameNode(c, F); if (why) return why; }
        Object.assign(n, unionBox(n.children.map(aabb)));
        return "";
      }
      if (n.name && n.name.startsWith("raster:")) return "a raster fallback sits inside the rotated element";
      if (!F.uniform) {
        if (n.type === "text") return "text under a non-uniform scale (glyphs cannot be stretched)";
        if (n.type === "image") { const why = toStretch(n); if (why) return why; }
        if (n.rotation) return "an already-rotated node under a non-uniform scale";
        if (n.radius && n.radius.some((v) => v > 0)) return "rounded corners under a non-uniform scale (they would become elliptical)";
      }
      const lx = (n.x + n.w / 2 - F.ox) * F.sx, ly = (n.y + n.h / 2 - F.oy) * F.sy;
      const w = n.w * F.sx, h = n.h * F.sy;
      n.x = round(F.ox + lx * F.cos - ly * F.sin - w / 2);
      n.y = round(F.oy + lx * F.sin + ly * F.cos - h / 2);
      n.w = round(w); n.h = round(h);
      if (F.uniform && Math.abs(F.sx - 1) > 1e-4) scaleProps(n, F.sx);
      if (n.effects) for (const e of n.effects) if (e.type === "drop-shadow" || e.type === "inner-shadow") { const ex = e.x, ey = e.y; e.x = round(ex * F.cos - ey * F.sin); e.y = round(ex * F.sin + ey * F.cos); }
      let rot = (n.rotation || 0) + F.theta;
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      if (Math.abs(rot) > 0.005) n.rotation = round(rot); else delete n.rotation;
      return "";
    }
    function walkRotated(el, cs, ctx, op, plan, tf) {
      const st = el.style;
      const save = ["transform", "transition"].map((p) => [p, st.getPropertyValue(p), st.getPropertyPriority(p)]);
      st.setProperty("transition", "none", "important");
      st.setProperty("transform", "none", "important");
      const start = nodes.length, elStart = window.__fxEls.length;
      let ok = true, detail = "";
      try {
        const box = rel(el.getBoundingClientRect());
        const og = (cs.transformOrigin || "").split(/\s+/).map(parseFloat);
        const th = (tf.theta * Math.PI) / 180, uniform = Math.abs(tf.sx - tf.sy) < 0.01;
        const F = { ox: box.x + (og[0] || 0) * ctx.k, oy: box.y + (og[1] || 0) * ctx.k, cos: Math.cos(th), sin: Math.sin(th), sx: tf.sx, sy: uniform ? tf.sx : tf.sy, theta: tf.theta, uniform };
        walkBody(el, cs, ctx, op, plan);
        for (const n of nodes.slice(start)) { detail = frameNode(n, F); if (detail) { ok = false; break; } }
      } finally {
        for (const [p, v, pr] of save) v ? st.setProperty(p, v, pr) : st.removeProperty(p);
      }
      if (ok) return;
      nodes.length = start;
      window.__fxEls.length = elStart;
      const b = rel(el.getBoundingClientRect());
      if (visibleBox(b, ctx)) pushRaster(el, b, "rotated-or-skewed-or-nonuniform", { op, k: ctx.k, clips: ctx.clips }, { rasterWhy: detail });
    }

    // ----- element walk -----
    function walkElement(el, ctx) {
      const tag = el.tagName;
      if (SKIP.has(tag)) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none") return;
      const plan = filterPlan(el, cs, ctx.k);
      const op = ctx.op * parseFloat(cs.opacity) * plan.opacity;
      if (!(op > 0.001)) return;
      const tf = cs.transform && cs.transform !== "none" ? analyzeTransform(cs.transform) : null;
      if (tf && (tf.kind === "3d" || tf.kind === "skew")) {
        const b = rel(el.getBoundingClientRect());
        if (visibleBox(b, ctx)) pushRaster(el, b, tf.kind === "3d" ? "3d-transform" : "rotated-or-skewed-or-nonuniform", { op, k: ctx.k, clips: ctx.clips }, { rasterWhy: tf.kind === "3d" ? "3d matrix" : "a real shear remains after decomposing the matrix" });
        return;
      }
      if (tf && tf.kind === "rot") { walkRotated(el, cs, ctx, op, plan, tf); return; }
      walkBody(el, cs, tf && tf.kind === "scale" ? { ...ctx, k: ctx.k * tf.s } : ctx, op, plan);
    }

    function walkBody(el, cs, ctx, op, plan) {
      const tag = el.tagName, k = ctx.k;
      const ctx2 = { op, k, clips: ctx.clips };
      const box = rel(el.getBoundingClientRect());
      if (cs.display === "contents") { walkChildren(el, ctx2); return; }
      const visible = cs.visibility === "visible";

      // clip context for descendants
      let ctx3 = ctx2;
      const ox = cs.overflowX, oy = cs.overflowY;
      const clips = ox !== "visible" || oy !== "visible";
      if (clips && box.w > 0 && box.h > 0) {
        ctx3 = { op, k, clips: [...ctx.clips, { rect: box, radius: radiusOf(cs, box.w, box.h, k) }] };
      } else if (clips) {
        ctx3 = { op, k, clips: [...ctx.clips, { rect: { x: box.x, y: box.y, w: 0, h: 0 }, radius: [0, 0, 0, 0] }] };
      }

      const isSvg = el instanceof SVGSVGElement;
      const start = nodes.length;
      let mask = null, blend = null;
      if (visible && box.w > 0 && box.h > 0 && visibleBox(box, ctx)) {
        // what Figma cannot express: the whole subtree becomes one raster, named and explained
        if (plan.fail) {
          const m = plan.fail.why === "css-filter" ? filterMargin(cs.filter) * k : 0;
          pushRaster(el, { x: box.x - m, y: box.y - m, w: box.w + 2 * m, h: box.h + 2 * m }, plan.fail.why, ctx2, { rasterMode: "isolate", rasterWhy: plan.fail.detail });
          return;
        }
        if (cs.mixBlendMode && cs.mixBlendMode !== "normal") {
          blend = blendName(cs.mixBlendMode);
          if (!blend) { pushRaster(el, box, "mix-blend-mode", ctx2, { rasterMode: "composite", rasterWhy: cs.mixBlendMode + " has no Figma blend mode" }); return; }
        }
        mask = maskSpec(el, cs, box, ctx2);
        if (mask && mask.fail) { pushRaster(el, box, mask.fail.why, ctx2, { rasterWhy: mask.fail.detail }); return; }
        // backdrop-filter blurs what is behind the element: Figma background blur on the element's own rect, its children stay live
        paintBox(el, cs, box, ctx2, clips, backdropFx(cs, k));
        if (RASTER_TAGS.has(tag)) pushRaster(el, box, tag.toLowerCase(), ctx2, { rasterWhy: "<" + tag.toLowerCase() + "> has no editable form" });
        else if (isSvg) emitSvg(el, box, ctx2);
        else if (tag === "IMG") emitImg(el, cs, box, ctx2);
      } else if (isSvg || RASTER_TAGS.has(tag)) return;
      if (!(isSvg || tag === "IMG" || RASTER_TAGS.has(tag))) walkChildren(el, ctx3, cs);
      // everything this element emitted is one segment: filter effects / tone first, then the mask around them, then blend on the outside
      let seg = nodes.splice(start);
      seg = applyPlan(seg, el, plan);
      if (mask) seg = maskWrap(seg, el, mask);
      if (blend) seg = attach(seg, el, { blendMode: blend });
      nodes.push(...seg);
    }

    function boxShadows(cs, k) {
      const out = [];
      if (!cs.boxShadow || cs.boxShadow === "none") return out;
      for (const sh of splitTop(cs.boxShadow)) {
        const toks = splitWs(sh);
        const colTok = toks.find((t) => colorish(t));
        const n = toks.filter((t) => t !== colTok && t !== "inset").map((t) => parseFloat(t));
        const c = parseColor(colTok || cs.color);
        out.push({ type: toks.includes("inset") ? "inner-shadow" : "drop-shadow", color: c.color, opacity: c.opacity, x: round((n[0] || 0) * k), y: round((n[1] || 0) * k), blur: round((n[2] || 0) * k), spread: round((n[3] || 0) * k) });
      }
      return out;
    }

    function paintBox(el, cs, box, ctx, clips, extraFx) {
      const k = ctx.k;
      const { fills, extras } = parseBackground(cs, box.w, box.h, k, warn);
      const bw = ["Top", "Right", "Bottom", "Left"].map((s) => px(cs["border" + s + "Width"]) * k);
      const bst = ["Top", "Right", "Bottom", "Left"].map((s) => cs["border" + s + "Style"]);
      const bcol = ["Top", "Right", "Bottom", "Left"].map((s) => parseColor(cs["border" + s + "Color"]));
      const active = bw.map((w, i) => w > 0 && bst[i] !== "none" && bst[i] !== "hidden" && bcol[i].opacity > 0);
      const anyBorder = active.some(Boolean);
      const uniform = active.every(Boolean) && bw.every((w) => Math.abs(w - bw[0]) < 0.01) && bcol.every((c) => c.color === bcol[0].color && c.opacity === bcol[0].opacity);
      if (anyBorder && bst.some((s) => s === "dashed" || s === "dotted")) warn("dashed/dotted border drawn solid");
      const name = nameOf(el);
      const hasPaint = fills.length > 0 || (anyBorder && uniform);
      // A hard ring (no blur, no offset) around a box with no fill is how CSS draws a hairline frame; Figma only casts a shadow from
      // a filled layer, so there it becomes a native inside-stroke rect. Everything else is a shadow effect.
      const shadows = boxShadows(cs, k), rings = [];
      const keep = hasPaint ? shadows : shadows.filter((s) => { const ring = s.blur === 0 && s.x === 0 && s.y === 0 && s.spread > 0; if (ring) rings.push(s); return !ring; });
      const effects = [...keep, ...extraFx];
      if (hasPaint || effects.length) {
        let rb = box, radius = inheritClipRadius(box, radiusOf(cs, box.w, box.h, k), ctx), stroke = anyBorder && uniform ? { color: bcol[0].color, opacity: bcol[0].opacity, width: round(bw[0]), align: "INSIDE" } : null;
        const vb = clipBox(box, ctx);
        if (vb && !sameBox(vb, box)) {
          // cropped by an ancestor's overflow: keep only what shows (a flat IR cannot clip siblings)
          rb = vb; radius = [0, 0, 0, 0]; stroke = null; warn("rect cropped to ancestor overflow clip");
          if (fills.some((f) => f.type !== "solid")) warn("cropped rect has gradient/image fill: fill now spans the cropped box");
        }
        let nf = fills;
        if (!hasPaint) {
          // a box with only a shadow / backdrop blur: Figma needs a layer to hang the effect on
          if (effects.some((e) => e.type === "background-blur")) nf = [{ type: "solid", color: "#FFFFFF", opacity: 0.01 }];
          else if (effects.length) warn("soft box-shadow on a box with no fill: Figma casts a shadow only from a filled layer");
        }
        const node = { type: "rect", name, x: round(rb.x), y: round(rb.y), w: round(rb.w), h: round(rb.h), fills: nf, radius, stroke, opacity: round(ctx.op) };
        if (effects.length) node.effects = effects;
        if (clips) node.clipsContent = true;
        nodes.push(node);
      }
      const rad0 = radiusOf(cs, box.w, box.h, k);
      for (const s of rings) {
        const o = s.type === "drop-shadow" ? s.spread : 0;
        nodes.push({ type: "rect", name: `${name} ring`, x: round(box.x - o), y: round(box.y - o), w: round(box.w + 2 * o), h: round(box.h + 2 * o), fills: [], radius: rad0.map((v) => round(v > 0 ? v + o : 0)), stroke: { color: s.color, opacity: s.opacity, width: s.spread, align: "INSIDE" }, opacity: round(ctx.op) });
      }
      for (const ex of extras) {
        const r = { x: box.x + ex.rect.x, y: box.y + ex.rect.y, w: ex.rect.w, h: ex.rect.h };
        nodes.push({ type: "rect", name: name + " layer", x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), fills: [ex.fill], radius: [0, 0, 0, 0], stroke: null, opacity: round(ctx.op) });
      }
      if (anyBorder && !uniform) {
        const sides = [
          ["top", box.x, box.y, box.w, bw[0]],
          ["right", box.x + box.w - bw[1], box.y, bw[1], box.h],
          ["bottom", box.x, box.y + box.h - bw[2], box.w, bw[2]],
          ["left", box.x, box.y, bw[3], box.h],
        ];
        sides.forEach(([nm, x, y, w, h], i) => {
          if (!active[i]) return;
          nodes.push({ type: "rect", name: `${name} border-${nm}`, x: round(x), y: round(y), w: round(w), h: round(h), fills: [{ type: "solid", color: bcol[i].color, opacity: bcol[i].opacity }], radius: [0, 0, 0, 0], stroke: null, opacity: round(ctx.op) });
        });
      }
    }

    // ----- svg -----
    const DRAWS = "path,rect,circle,ellipse,line,polyline,polygon,text,image,use";
    // objectBoundingBox gradient on a w x h shape -> IR fill (stops re-based to the CSS gradient line of the box)
    function svgGradientFill(g, w, h) {
      const stopsOf = (e) => {
        for (let i = 0; e && i < 6; i++) {
          const s = [...e.children].filter((c) => c.localName === "stop");
          if (s.length) return s;
          const href = e.getAttribute("href") || e.getAttribute("xlink:href");
          e = href && href[0] === "#" ? e.getRootNode().getElementById(href.slice(1)) : null;
        }
        return [];
      };
      const stops = stopsOf(g).map((s) => {
        const css = getComputedStyle(s), c = parseColor(css.stopColor);
        const o = s.getAttribute("offset") || "0";
        return { pos: round(clamp01((o.endsWith("%") ? parseFloat(o) / 100 : parseFloat(o)) || 0)), color: c.color, opacity: round(c.opacity * parseFloat(css.stopOpacity)) };
      });
      if (!stops.length) return null;
      if (g.getAttribute("gradientTransform")) warn("svg gradientTransform ignored");
      if (g.localName === "radialGradient") return { type: "radial", stops };
      const user = g.getAttribute("gradientUnits") === "userSpaceOnUse";
      const co = (n, d, full) => { const v = g.getAttribute(n); if (v == null) return d; const f = parseFloat(v); return v.trim().endsWith("%") ? f / 100 : user ? f / full : f; };
      const x1 = co("x1", 0, w), y1 = co("y1", 0, h), x2 = co("x2", 1, w), y2 = co("y2", 0, h);
      const dx = x2 - x1, dy = y2 - y1, d2 = dx * dx + dy * dy;
      if (d2 < 1e-12) return { type: "solid", color: stops[stops.length - 1].color, opacity: stops[stops.length - 1].opacity };
      const vx = dx / w, vy = dy / h; // direction of increasing t, per px
      const theta = Math.atan2(vx, -vy); // CSS angle
      const L = Math.abs(w * Math.sin(theta)) + Math.abs(h * Math.cos(theta));
      const tc = ((0.5 - x1) * dx + (0.5 - y1) * dy) / d2; // t at the box centre
      const a = (Math.hypot(vx, vy) * L) / d2; // dt per unit of CSS gradient length
      let last = 0;
      const rebased = stops.map((s) => { last = Math.max(last, clamp01((s.pos - tc) / a + 0.5)); return { ...s, pos: round(last) }; });
      return { type: "linear", angleDeg: round(((((theta * 180) / Math.PI) % 360) + 360) % 360), stops: rebased };
    }
    function emitSvg(el, box, ctx) {
      const filtered = [...el.querySelectorAll("*")].filter((e) => { const f = getComputedStyle(e).filter; return f && f !== "none"; });
      const plain = () => ({ type: "svg", name: nameOf(el), x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), svg: serializeSvg(el, box.w, box.h, warn), opacity: round(ctx.op) });
      if (!filtered.length) { nodes.push(plain()); return; }
      const fail = (detail) => pushRaster(el, box, "svg-filter", ctx, { rasterMode: "isolate", rasterWhy: detail });
      // a filter on one shape that is the only drawing in the svg maps to native fields; anything else has no clean mapping
      const tops = filtered.filter((e) => !filtered.some((o) => o !== e && o.contains(e)));
      const draw = [...el.querySelectorAll(DRAWS)].filter((e) => !e.closest("defs,clipPath,mask,pattern,marker,symbol,filter"));
      if (tops.length !== 1 || !draw.every((d) => d === tops[0] || tops[0].contains(d))) return fail("an svg filter applies to part of an svg that also draws other things");
      const sh = tops[0], scs = getComputedStyle(sh);
      const plan = filterPlan(sh, scs, ctx.k);
      if (plan.fail) return fail(plan.fail.detail);
      const sctx = { ...ctx, op: ctx.op * parseFloat(scs.opacity) * plan.opacity };
      const sb = rel(sh.getBoundingClientRect());
      let seg;
      if (sh.localName === "image") {
        const href = sh.getAttribute("href") || sh.getAttribute("xlink:href");
        if (!href) return fail("svg <image> without href");
        const src = new URL(href, document.baseURI).href;
        const par = sh.getAttribute("preserveAspectRatio") || "xMidYMid meet";
        seg = [{ type: "image", name: nameOf(sh), x: round(sb.x), y: round(sb.y), w: round(sb.w), h: round(sb.h), src, scaleMode: /slice|none/.test(par) ? "FILL" : "FIT", opacity: round(sctx.op), radius: [0, 0, 0, 0] }];
      } else if (sh.localName === "rect" && !(parseFloat(scs.rx) > 0) && !(parseFloat(scs.ry) > 0) && scs.stroke === "none") {
        // a plain rect: emit it as a rect with its own gradient / solid fill (editable), the filter becomes effects
        let fill = null;
        const pm = scs.fill.match(/^url\(["']?#([^"')]+)["']?\)/);
        if (pm) { const g = sh.getRootNode().getElementById(pm[1]); fill = g ? svgGradientFill(g, sb.w, sb.h) : null; }
        else if (scs.fill !== "none") { const c = parseColor(scs.fill); fill = { type: "solid", color: c.color, opacity: round(c.opacity * parseFloat(scs.fillOpacity)) }; }
        if (!fill) return fail("svg rect with a paint that is not a solid colour or gradient");
        seg = [{ type: "rect", name: nameOf(sh), x: round(sb.x), y: round(sb.y), w: round(sb.w), h: round(sb.h), fills: [fill], radius: [0, 0, 0, 0], stroke: null, opacity: round(sctx.op) }];
      } else {
        seg = [plain()];
        warn("svg shape with a filter: effects applied to the whole svg node");
      }
      nodes.push(...applyPlan(seg, sh, plan));
    }

    function emitImg(el, cs, box, ctx) {
      const k = ctx.k;
      // content box
      const pl = px(cs.paddingLeft) * k + px(cs.borderLeftWidth) * k, pr = px(cs.paddingRight) * k + px(cs.borderRightWidth) * k;
      const pt = px(cs.paddingTop) * k + px(cs.borderTopWidth) * k, pb = px(cs.paddingBottom) * k + px(cs.borderBottomWidth) * k;
      const b = { x: box.x + pl, y: box.y + pt, w: box.w - pl - pr, h: box.h - pt - pb };
      if (b.w <= 0 || b.h <= 0) return;
      const src = el.currentSrc || el.src;
      if (!src || !el.complete || !el.naturalWidth) { warn("image not loaded: " + (src || "").slice(0, 60)); return; }
      const fit = cs.objectFit;
      const nw = el.naturalWidth, nh = el.naturalHeight;
      const [pxs, pys] = cs.objectPosition.split(" ");
      const frac = (t, free) => (t.endsWith("%") ? parseFloat(t) / 100 : free ? parseFloat(t) / free : 0.5);
      // D = where the browser actually draws the bitmap (slide px)
      let D = b;
      if (fit === "cover" || fit === "contain" || fit === "none" || fit === "scale-down") {
        let sc = fit === "cover" ? Math.max(b.w / nw, b.h / nh) : fit === "contain" ? Math.min(b.w / nw, b.h / nh) : fit === "none" ? k : Math.min(k, Math.min(b.w / nw, b.h / nh));
        const dw = nw * sc, dh = nh * sc;
        D = { x: b.x + (b.w - dw) * frac(pxs, b.w - dw), y: b.y + (b.h - dh) * frac(pys, b.h - dh), w: dw, h: dh };
      }
      // object-fit:fill (the default) maps the whole bitmap onto the box; when the aspects differ that is a stretch (STRETCH).
      const stretched = (fit === "fill" || !fit) && Math.abs(nw / nh / (b.w / b.h) - 1) > 0.02;
      const V = clipBox(b, ctx);
      if (!V) return;
      const cut = !sameBox(V, b);
      const jpeg = /^data:image\/jpe?g/.test(src) || /\.jpe?g(\?|$)/i.test(src);
      const bake = (vis) => { // crop the bitmap to `vis` (slide px inside D), return data URL
        const sx = ((vis.x - D.x) / D.w) * nw, sy = ((vis.y - D.y) / D.h) * nh, sw = (vis.w / D.w) * nw, sh = (vis.h / D.h) * nh;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(sw)); c.height = Math.max(1, Math.round(sh));
        c.getContext("2d").drawImage(el, sx, sy, sw, sh, 0, 0, c.width, c.height);
        return c.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92);
      };
      let node = { x: b.x, y: b.y, w: b.w, h: b.h }, outSrc = src, scaleMode = fit === "contain" ? "FIT" : fit === "none" || fit === "scale-down" ? "CROP" : stretched ? "STRETCH" : "FILL";
      let radius = inheritClipRadius(b, radiusOf(cs, b.w, b.h, k), ctx);
      try {
        if (cut) {
          // clipped by an ancestor: emit just the visible part of the drawn bitmap
          const vis = { x: Math.max(D.x, V.x), y: Math.max(D.y, V.y) };
          vis.w = Math.min(D.x + D.w, V.x + V.w) - vis.x; vis.h = Math.min(D.y + D.h, V.y + V.h) - vis.y;
          if (vis.w <= 0.01 || vis.h <= 0.01) return;
          outSrc = bake(vis); node = vis; scaleMode = "FILL"; radius = [0, 0, 0, 0];
          warn("image cropped to ancestor overflow clip (baked)");
        } else if (fit === "cover" && (Math.abs(frac(pxs, b.w - D.w) - 0.5) > 0.01 || Math.abs(frac(pys, b.h - D.h) - 0.5) > 0.01)) {
          outSrc = bake(b); scaleMode = "FILL"; // Figma FILL centres the crop; bake the off-centre one
        }
      } catch (e) { warn("image crop could not be baked: " + e.message); }
      const imgNode = { type: "image", name: nameOf(el), x: round(node.x), y: round(node.y), w: round(node.w), h: round(node.h), src: outSrc, scaleMode, opacity: round(ctx.op), radius };
      if (outSrc === src) natAspect.set(imgNode, nw / nh); // a baked crop has the node's own aspect
      nodes.push(imgNode);
    }

    // ----- children / text -----
    const isInlineFlow = (n, cs) => (cs.display === "inline" || cs.display === "contents") && !(n instanceof SVGElement) && !REPLACED.has(n.tagName) && !n.shadowRoot && cs.position === "static" && cs.float === "none";
    function zKey(cs, parentFlex) {
      const pos = cs.position !== "static";
      if (cs.zIndex !== "auto" && (pos || parentFlex)) { const n = parseInt(cs.zIndex); return n === 0 ? 0.5 : n; }
      return pos ? 0.5 : 0;
    }

    function walkChildren(el, ctx, ecs) {
      const parentCs = ecs || getComputedStyle(el);
      const parentFlex = /flex|grid/.test(parentCs.display);
      const items = [];
      let cur = [];
      const flush = () => { if (cur.length) { items.push({ kind: "text", pieces: cur, key: 0 }); cur = []; } };
      const proc = (list, hostEl) => {
        for (const n of list) {
          if (n.nodeType === 3) { cur.push({ node: n, el: n.parentElement || hostEl }); continue; }
          if (n.nodeType !== 1) continue;
          if (SKIP.has(n.tagName)) continue;
          const cs = getComputedStyle(n);
          if (cs.display === "none") continue;
          if (n.tagName === "BR") { cur.push({ br: true, el: n }); continue; }
          if (isInlineFlow(n, cs)) { proc(childList(n), n); continue; }
          flush();
          items.push({ kind: "el", el: n, key: zKey(cs, parentFlex) });
        }
      };
      proc(childList(el), el);
      flush();
      items.map((it, i) => ((it.i = i), it));
      items.sort((a, b) => a.key - b.key || a.i - b.i);
      for (const it of items) {
        if (it.kind === "el") walkElement(it.el, ctx);
        else emitText(it.pieces, el, parentCs, ctx);
      }
    }

    function opacityBetween(el, container) {
      let o = 1;
      for (let e = el; e && e !== container; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
      return o;
    }
    function decorationOf(el, container) {
      for (let e = el; e; e = e.parentElement) {
        const d = getComputedStyle(e).textDecorationLine;
        if (/underline/.test(d)) return "UNDERLINE";
        if (/line-through/.test(d)) return "STRIKETHROUGH";
        if (e === container) break;
      }
      return "NONE";
    }
    function transformText(s, tt) {
      if (tt === "uppercase") return s.toUpperCase();
      if (tt === "lowercase") return s.toLowerCase();
      if (tt === "capitalize") return s.replace(/(^|[\s\-(])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
      return s;
    }

    function emitText(pieces, container, ccs, ctx) {
      const k = ctx.k;
      // 1. collapse whitespace per CSS white-space, keep per-piece style
      const segs = [];
      let prevSpace = true;
      for (const p of pieces) {
        const pcs = getComputedStyle(p.el);
        if (pcs.visibility !== "visible") continue;
        if (p.br) { segs.push({ p, pcs, str: "\n", hard: true }); prevSpace = true; continue; }
        const data = p.node.data;
        const ws = pcs.whiteSpace;
        const preserve = ws === "pre" || ws === "pre-wrap" || ws === "break-spaces";
        // `dom[j]` = offset in the DOM text node of char j of `s`, so line starts measured in the DOM map to `characters`
        let s = "", dom = [];
        if (preserve) { s = data; for (let i = 0; i < data.length; i++) dom.push(i); }
        else {
          const keepNl = ws === "pre-line";
          for (let i = 0; i < data.length; i++) {
            const c = data[i];
            if (keepNl && c === "\n") { if (s.endsWith(" ")) { s = s.slice(0, -1); dom.pop(); } s += "\n"; dom.push(i); continue; }
            if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\n") {
              if (s.endsWith(" ") || (keepNl && s.endsWith("\n"))) continue;
              s += " "; dom.push(i); continue;
            }
            s += c; dom.push(i);
          }
          if (prevSpace && s.startsWith(" ")) { s = s.slice(1); dom.shift(); }
        }
        if (!s.length) continue;
        segs.push({ p, pcs, str: s, dom, hard: false, preserve });
        prevSpace = preserve ? false : /[ \n]$/.test(s);
      }
      // trim: spaces before a hard break, trailing space, trailing hard breaks
      const trimEnd = (sg) => { while (sg.str.endsWith(" ")) { sg.str = sg.str.slice(0, -1); sg.dom.pop(); } };
      for (let i = 0; i < segs.length; i++) if (segs[i].hard && i > 0 && !segs[i - 1].hard && !segs[i - 1].preserve) trimEnd(segs[i - 1]);
      while (segs.length && (segs[segs.length - 1].hard || (!segs[segs.length - 1].preserve && /^ *$/.test(segs[segs.length - 1].str)))) segs.pop();
      if (segs.length) { const l = segs[segs.length - 1]; if (!l.preserve && !l.hard) trimEnd(l); }
      while (segs.length && !segs[0].hard && /^ *$/.test(segs[0].str) && !segs[0].preserve) segs.shift();
      if (!segs.length) return;

      // 2. geometry from client rects of each text node
      const rects = [];
      for (const sg of segs) {
        if (sg.hard) continue;
        const rg = document.createRange();
        rg.selectNodeContents(sg.p.node);
        for (const q of rg.getClientRects()) if (q.width > 0.01 && q.height > 0.01) rects.push(q);
      }
      if (!rects.length) return;
      const lines = [];
      [...rects].sort((a, b) => a.top - b.top || a.left - b.left).forEach((q) => {
        const cy = (q.top + q.bottom) / 2;
        const L = lines.find((l) => Math.abs(l.cy - cy) < Math.min(l.h, q.height) * 0.5);
        if (L) { L.l = Math.min(L.l, q.left); L.r = Math.max(L.r, q.right); L.top = Math.min(L.top, q.top); L.bottom = Math.max(L.bottom, q.bottom); L.h = L.bottom - L.top; L.cy = (L.top + L.bottom) / 2; }
        else lines.push({ l: q.left, r: q.right, top: q.top, bottom: q.bottom, h: q.height, cy });
      });
      lines.sort((a, b) => a.top - b.top);
      const ubox = rel({ left: Math.min(...lines.map((l) => l.l)), top: lines[0].top, width: Math.max(...lines.map((l) => l.r)) - Math.min(...lines.map((l) => l.l)), height: lines[lines.length - 1].bottom - lines[0].top });

      // 3. runs
      const runs = [];
      let chars = "";
      for (const sg of segs) {
        const cs = sg.pcs;
        const str = transformText(sg.str, cs.textTransform);
        if (!str.length) continue;
        sg.base = chars.length;
        sg.out = str;
        if (sg.dom && str.length !== sg.str.length) sg.dom = Array.from(str, (_, j) => sg.dom[Math.min(sg.dom.length - 1, Math.floor((j * sg.dom.length) / str.length))]); // transform changed the length: spread the offsets
        const variation = parseVariation(cs.fontVariationSettings);
        const fam = resolveFamily(cs.fontFamily);
        const col = parseColor(cs.webkitTextFillColor && cs.webkitTextFillColor !== "currentcolor" ? cs.webkitTextFillColor : cs.color);
        const fs = px(cs.fontSize) * k;
        const lhRaw = cs.lineHeight;
        const style = {
          fontFamily: fam,
          fontWeight: variation.wght != null ? variation.wght : parseInt(cs.fontWeight) || 400,
          italic: cs.fontStyle === "italic" || cs.fontStyle.startsWith("oblique"),
          fontSize: round(fs),
          lineHeightPx: lhRaw === "normal" ? null : round(px(lhRaw) * k),
          letterSpacingPx: cs.letterSpacing === "normal" ? 0 : round(px(cs.letterSpacing) * k),
          color: col.color,
          colorOpacity: round(col.opacity * opacityBetween(sg.p.el, container)),
          variation,
          decoration: decorationOf(sg.p.el, container),
        };
        const key = JSON.stringify(style);
        const last = runs[runs.length - 1];
        if (last && last._key === key) last.end += str.length;
        else runs.push({ start: chars.length, end: chars.length + str.length, ...style, _key: key });
        chars += str;
      }
      if (!chars.length) return;
      // resolve "normal" line-height from the measured line box
      const normalLh = lines[0].h / scale / (k || 1);
      runs.forEach((r) => { if (r.lineHeightPx == null) r.lineHeightPx = round(normalLh * k); delete r._key; });
      const lh = Math.max(...runs.map((r) => r.lineHeightPx));

      // line starts as Chrome laid them out: char index (in `chars`) of the first glyph on every line after the first.
      // Soft wraps only: a start right after a hard break ("\n") is not recorded, that line break is already in `chars`.
      const breaks = [];
      if (lines.length > 1) {
        const rg = document.createRange();
        let cur = null, prevIdx = -1;
        for (const sg of segs) {
          if (sg.hard || sg.out == null) continue;
          for (let j = 0; j < sg.out.length; j++) {
            const c = sg.out.charCodeAt(j);
            if (c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || (c >= 0xdc00 && c <= 0xdfff)) continue;
            const d = sg.dom[j], len = sg.p.node.data.length;
            rg.setStart(sg.p.node, d);
            rg.setEnd(sg.p.node, Math.min(len, d + (c >= 0xd800 && c <= 0xdbff ? 2 : 1)));
            const q = [...rg.getClientRects()].find((r) => r.width > 0.01 && r.height > 0.01);
            if (!q) continue;
            const idx = sg.base + j, cy = (q.top + q.bottom) / 2;
            if (cur && Math.abs(cy - cur.cy) < Math.min(cur.h, q.height) * 0.5) { prevIdx = idx; continue; }
            if (cur && !chars.slice(prevIdx + 1, idx).includes("\n")) breaks.push(idx);
            cur = { cy, h: q.height };
            prevIdx = idx;
          }
        }
      }

      const ws = ccs.whiteSpace;
      const noWrapStyle = ws === "nowrap" || ws === "pre";
      const multi = lines.length > 1;
      const wrap = multi && !noWrapStyle;
      const ta = ccs.textAlign;
      const align = ta === "center" ? "CENTER" : ta === "right" || ta === "end" ? "RIGHT" : ta === "justify" ? "JUSTIFIED" : "LEFT";

      // y/h from line boxes: rect height is the font content area, centred in the line box
      const first = lines[0], lastL = lines[lines.length - 1];
      const topPx = (first.top - (lh * scale - first.h) / 2 - sr.top) / scale;
      const botPx = (lastL.bottom + (lh * scale - lastL.h) / 2 - sr.top) / scale;
      let x = ubox.x, w = ubox.w;
      if (wrap) {
        const cr = rel(container.getBoundingClientRect());
        const pl = px(ccs.paddingLeft) * k + px(ccs.borderLeftWidth) * k, pr = px(ccs.paddingRight) * k + px(ccs.borderRightWidth) * k;
        if (container.getBoundingClientRect().width > 0) { x = cr.x + pl; w = cr.w - pl - pr; }
      }
      const box = { x, y: topPx, w, h: botPx - topPx };
      if (!visibleBox(box, ctx)) return;
      noteClip(box, ctx);
      nodes.push({ type: "text", name: chars.replace(/\s+/g, " ").slice(0, 40), x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), characters: chars, ...(breaks.length ? { lines: breaks } : {}), align, wrap, opacity: round(ctx.op), runs });
    }

    // ----- go -----
    const scs = getComputedStyle(section);
    const bgp = parseBackground(scs, 1920, 1080, 1, warn);
    const rootCtx = { op: 1, k: 1, clips: [{ rect: { x: 0, y: 0, w: W, h: H }, radius: [0, 0, 0, 0] }] };
    walkChildren(section, rootCtx, scs);
    return { label: section.getAttribute("data-label") || "", background: bgp.fills, nodes, warnings: Object.fromEntries(warnings), scale };
  };
})();
