(() => {
  // noise-calibration.json
  var noise_calibration_default = {
    status: "calibrated",
    note: "Fitted by scripts/calibrate-noise.ts against real Figma exports; see fit for the residual.",
    fittedAt: "2026-10-24T14:01:58.621Z",
    size: [
      {
        baseFrequency: 0.2,
        noiseSize: 2
      },
      {
        baseFrequency: 0.5,
        noiseSize: 1
      },
      {
        baseFrequency: 0.85,
        noiseSize: 0.5
      },
      {
        baseFrequency: 1.5,
        noiseSize: 0.5
      }
    ],
    strength: [
      {
        amount: 0.15,
        density: 0.2,
        alpha: 0.1
      },
      {
        amount: 0.35,
        density: 0.2,
        alpha: 0.175
      },
      {
        amount: 0.5,
        density: 0.5,
        alpha: 0.1
      },
      {
        amount: 0.8,
        density: 0.5,
        alpha: 0.1
      }
    ],
    fit: {
      specs: 17,
      fields: 3,
      meanCost: 1.587124
    }
  };

  // lib/figma-map.ts
  function imagePaintMode(mode) {
    if (mode === "STRETCH")
      return { scaleMode: "CROP", imageTransform: [[1, 0, 0], [0, 1, 0]] };
    return { scaleMode: mode === "FIT" ? "FIT" : mode === "TILE" ? "TILE" : "FILL" };
  }
  var clean = (n) => {
    const r = Math.round(n * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  };
  function hexToRgb(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m)
      throw new Error(`bad colour "${hex}" (expected #RRGGBB)`);
    const n = parseInt(m[1], 16);
    return { r: clean((n >> 16 & 255) / 255), g: clean((n >> 8 & 255) / 255), b: clean((n & 255) / 255) };
  }
  function linearGradientTransform(angleDeg, w, h) {
    const a = angleDeg * Math.PI / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const L = Math.abs(w * dx) + Math.abs(h * dy);
    if (!(L > 0))
      return [[1, 0, 0], [0, 1, 0]];
    const nx = -dy;
    const ny = dx;
    return [
      [clean(w * dx / L), clean(h * dy / L), clean(0.5 - (w / 2 * dx + h / 2 * dy) / L)],
      [clean(w * nx / L), clean(h * ny / L), clean(0.5 - (w / 2 * nx + h / 2 * ny) / L)]
    ];
  }
  function radialGradientTransform() {
    const s = 1 / Math.SQRT2;
    const c = clean(0.5 - 0.5 * s);
    return [[clean(s), 0, c], [0, clean(s), c]];
  }
  function stopsOf(stops) {
    if (!stops || stops.length < 2)
      throw new Error("gradient needs at least 2 stops");
    return stops.map((s) => ({
      position: clean(Math.min(1, Math.max(0, s.pos))),
      color: { ...hexToRgb(s.color), a: clean(s.opacity === undefined || s.opacity === null ? 1 : s.opacity) }
    }));
  }
  function fillToPaint(fill, w, h) {
    switch (fill.type) {
      case "solid": {
        const p = { type: "SOLID", color: hexToRgb(fill.color) };
        if (fill.opacity !== undefined && fill.opacity < 1)
          p.opacity = clean(fill.opacity);
        return p;
      }
      case "linear":
        return { type: "GRADIENT_LINEAR", gradientStops: stopsOf(fill.stops), gradientTransform: linearGradientTransform(fill.angleDeg, w, h) };
      case "radial":
        return { type: "GRADIENT_RADIAL", gradientStops: stopsOf(fill.stops), gradientTransform: radialGradientTransform() };
      case "image": {
        const p = { type: "IMAGE", imageRef: fill.ref, scaleMode: fill.scaleMode === "FIT" ? "FIT" : fill.scaleMode === "TILE" ? "TILE" : "FILL" };
        if (p.scaleMode === "TILE" && fill.scalingFactor !== undefined)
          p.scalingFactor = tileFactor(fill.scalingFactor);
        const f = cleanImageFilters(fill.filters);
        if (f)
          p.filters = f;
        return p;
      }
      default:
        throw new Error(`unknown fill type ${fill.type}`);
    }
  }
  function normalizeRuns(len, runs) {
    if (len <= 0 || !runs || runs.length === 0)
      return [];
    const owner = new Array(len).fill(-1);
    runs.forEach((r, i) => {
      const s = Math.max(0, Math.floor(r.start));
      const e = Math.min(len, Math.floor(r.end));
      for (let c = s;c < e; c++)
        owner[c] = i;
    });
    let prev = -1;
    for (let c = 0;c < len; c++) {
      if (owner[c] >= 0)
        prev = owner[c];
      else if (prev >= 0)
        owner[c] = prev;
    }
    let next = -1;
    for (let c = len - 1;c >= 0; c--) {
      if (owner[c] >= 0)
        next = owner[c];
      else if (next >= 0)
        owner[c] = next;
    }
    if (owner[0] < 0)
      return [];
    const styleOf = (i) => {
      const { start: _s, end: _e, ...rest } = runs[i];
      return JSON.stringify(rest);
    };
    const out = [];
    let segStart = 0;
    for (let c = 1;c <= len; c++) {
      if (c === len || styleOf(owner[c]) !== styleOf(owner[segStart])) {
        out.push({ ...runs[owner[segStart]], start: segStart, end: c });
        segStart = c;
      }
    }
    return out;
  }
  function parseCssColor(input) {
    const s = String(input).trim().toLowerCase();
    if (s === "transparent")
      return { r: 0, g: 0, b: 0, a: 0 };
    let m = /^#([0-9a-f]{3,8})$/.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4)
        h = h.split("").map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8)
        throw new Error('bad colour "' + input + '"');
      const n = parseInt(h.slice(0, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r: clean((n >> 16 & 255) / 255), g: clean((n >> 8 & 255) / 255), b: clean((n & 255) / 255), a: clean(a) };
    }
    m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3 || parts.length > 4)
        throw new Error('bad colour "' + input + '"');
      const ch = (t) => {
        const v = t.endsWith("%") ? parseFloat(t) / 100 * 255 : parseFloat(t);
        if (!isFinite(v))
          throw new Error('bad colour "' + input + '"');
        return clean(Math.min(255, Math.max(0, v)) / 255);
      };
      let a = 1;
      if (parts.length === 4) {
        const t = parts[3];
        a = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
        if (!isFinite(a))
          throw new Error('bad colour "' + input + '"');
        a = Math.min(1, Math.max(0, a));
      }
      return { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: clean(a) };
    }
    throw new Error('bad colour "' + input + '"');
  }
  function rgbToHex(c) {
    return "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  function clampRadii(radius, w, h) {
    const max = Math.max(0, Math.min(w, h) / 2);
    const r = radius && radius.length === 4 ? radius : [0, 0, 0, 0];
    const f = (v) => clean(Math.min(max, Math.max(0, isFinite(v) ? v : 0)));
    return [f(r[0]), f(r[1]), f(r[2]), f(r[3])];
  }
  var groupRuns = normalizeRuns;
  var LINE_SEP = "\u2028";
  function cleanLines(len, lines) {
    const out = [];
    if (!lines)
      return out;
    for (const v of lines) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= len - 1 && (out.length === 0 || v > out[out.length - 1]))
        out.push(v);
    }
    return out;
  }
  function pinLines(characters, runs, lines) {
    const pins = cleanLines(characters.length, lines);
    if (pins.length === 0)
      return { characters, runs };
    const before = (i) => {
      let c = 0;
      for (const p of pins)
        if (p < i)
          c++;
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
  var WEIGHT_WORDS = [
    [/^(thin|hairline)/, 100],
    [/^(extralight|ultralight)/, 200],
    [/^(light)/, 300],
    [/^(regular|normal|book|roman|text)/, 400],
    [/^(medium)/, 500],
    [/^(semibold|demibold|demi)/, 600],
    [/^(extrabold|ultrabold)/, 800],
    [/^(bold)/, 700],
    [/^(black|heavy)/, 900]
  ];
  function parseStyleName(style) {
    const flat = String(style).toLowerCase().replace(/[\s_-]+/g, "");
    const italic = /italic|oblique/.test(flat);
    const base = flat.replace(/italic|oblique/g, "");
    if (base === "")
      return { weight: 400, italic };
    for (const [re, w] of WEIGHT_WORDS)
      if (re.test(base))
        return { weight: w, italic };
    const num = /(\d{3,4})/.exec(base);
    if (num)
      return { weight: parseInt(num[1], 10), italic };
    return { weight: 400, italic };
  }
  function selectFontStyle(styles, weight, italic) {
    if (!styles || styles.length === 0)
      return null;
    const parsed = styles.map((s) => ({ s, ...parseStyleName(s) }));
    const pool = italic && parsed.some((p) => p.italic) ? parsed.filter((p) => p.italic) : parsed.filter((p) => !p.italic);
    const use = pool.length ? pool : parsed;
    let best = use[0];
    for (const p of use) {
      const d = Math.abs(p.weight - weight);
      const bd = Math.abs(best.weight - weight);
      if (d < bd || d === bd && p.weight < best.weight)
        best = p;
    }
    return best.s;
  }
  var WIDTH_WORDS = [
    [/\b(ultra|extra)[\s-]?(condensed|compressed|narrow)\b/i, 62.5],
    [/\b(condensed|compressed|narrow|cond|cn)\b/i, 75],
    [/\b(semi[\s-]?condensed)\b/i, 87.5],
    [/\b(semi[\s-]?(expanded|extended))\b/i, 112.5],
    [/\b(ultra|extra)[\s-]?(expanded|extended|wide)\b/i, 150],
    [/\b(expanded|extended|wide|wd|ext)\b/i, 125]
  ];
  function styleWidth(style) {
    for (const [re, w] of WIDTH_WORDS)
      if (re.test(style))
        return w;
    return 100;
  }
  function stripWidth(style) {
    let out = style;
    for (const [re] of WIDTH_WORDS)
      out = out.replace(new RegExp(re.source, "gi"), " ");
    return out.replace(/\s+/g, " ").trim();
  }
  function pickStyle(styles, weight, italic, wdth) {
    const want = wdth === null ? 100 : wdth;
    let bestGap = Infinity;
    for (const s of styles)
      bestGap = Math.min(bestGap, Math.abs(styleWidth(s) - want));
    const pool = styles.filter((s) => Math.abs(styleWidth(s) - want) === bestGap);
    const bare = pool.map(stripWidth);
    const chosen = selectFontStyle(bare, weight, italic);
    const i = chosen === null ? 0 : bare.indexOf(chosen);
    return pool[i < 0 ? 0 : i];
  }
  function paintTag(p) {
    if (p.type === "SOLID" && p.color) {
      const o = p.opacity === undefined ? 1 : p.opacity;
      return rgbToHex(p.color) + "@" + String(Math.round(o * 1000) / 1000);
    }
    return p.type === "IMAGE" ? "IMAGE" : p.type;
  }
  var BLEND_MODES = [
    "PASS_THROUGH",
    "NORMAL",
    "DARKEN",
    "MULTIPLY",
    "LINEAR_BURN",
    "COLOR_BURN",
    "LIGHTEN",
    "SCREEN",
    "LINEAR_DODGE",
    "COLOR_DODGE",
    "OVERLAY",
    "SOFT_LIGHT",
    "HARD_LIGHT",
    "DIFFERENCE",
    "EXCLUSION",
    "HUE",
    "SATURATION",
    "COLOR",
    "LUMINOSITY"
  ];
  function blendModeOf(s) {
    if (typeof s !== "string")
      return null;
    const k = s.trim().toUpperCase().replace(/[\s-]+/g, "_");
    return BLEND_MODES.indexOf(k) >= 0 ? k : null;
  }
  function tileFactor(v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? clean(v) : 1;
  }
  var FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];
  function cleanImageFilters(f) {
    if (!f || typeof f !== "object")
      return null;
    const out = {};
    let any = false;
    for (const k of FILTER_KEYS) {
      const v = f[k];
      if (typeof v === "number" && isFinite(v)) {
        out[k] = clean(Math.min(1, Math.max(-1, v)));
        if (out[k] !== 0)
          any = true;
      }
    }
    return any ? out : null;
  }
  function rotationTransform(x, y, w, h, deg) {
    const a = deg * Math.PI / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const cx = x + w / 2;
    const cy = y + h / 2;
    return [
      [clean(c), clean(-s), clean(cx - (c * (w / 2) - s * (h / 2)))],
      [clean(s), clean(c), clean(cy - (s * (w / 2) + c * (h / 2)))]
    ];
  }
  function placeRotated(box, nodeW, nodeH, deg, textAlign) {
    const left = textAlign === undefined ? box.x + (box.w - nodeW) / 2 : textAlign === "RIGHT" ? box.x + box.w - nodeW : textAlign === "CENTER" ? box.x + (box.w - nodeW) / 2 : box.x;
    const top = textAlign === undefined ? box.y + (box.h - nodeH) / 2 : box.y;
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const dx = left + nodeW / 2 - cx, dy = top + nodeH / 2 - cy;
    const rx = cx + c * dx - s * dy, ry = cy + s * dx + c * dy;
    return rotationTransform(rx - nodeW / 2, ry - nodeH / 2, nodeW, nodeH, deg);
  }
  function unrotatedIn(t, nodeW, nodeH, box) {
    const tb = transformBox(t, nodeW, nodeH);
    const a = tb.deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const dx = tb.x + nodeW / 2 - cx, dy = tb.y + nodeH / 2 - cy;
    return { x: clean(cx + c * dx + s * dy - nodeW / 2), y: clean(cy - s * dx + c * dy - nodeH / 2) };
  }
  function transformBox(t, w, h) {
    const cx = t[0][0] * (w / 2) + t[0][1] * (h / 2) + t[0][2];
    const cy = t[1][0] * (w / 2) + t[1][1] * (h / 2) + t[1][2];
    return { x: clean(cx - w / 2), y: clean(cy - h / 2), deg: clean(Math.atan2(t[1][0], t[0][0]) * 180 / Math.PI) };
  }
  var BLUR_SCALE = 2;
  function interp1(points, key, x, field) {
    if (!points || points.length === 0)
      throw new Error("empty calibration table");
    const pts = points.slice().sort((a, b) => a[key] - b[key]);
    if (!isFinite(x) || x <= pts[0][key])
      return pts[0][field];
    const last = pts[pts.length - 1];
    if (x >= last[key])
      return last[field];
    for (let i = 1;i < pts.length; i++) {
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
  var rgba = (hex, a) => ({ ...hexToRgb(hex), a: clean(Math.min(1, Math.max(0, a))) });
  var unit = (v) => clean(Math.min(1, Math.max(0, v)));
  function rawNoiseToFigma(f) {
    const noiseType = f.noiseType || "MONOTONE";
    const color = rgba(f.color || "#000000", noiseType === "MULTITONE" ? 1 : f.alpha);
    const out = {
      type: "NOISE",
      noiseType,
      color,
      noiseSize: clean(Math.max(0.01, f.noiseSize)),
      density: unit(f.density),
      visible: true
    };
    if (noiseType === "MULTITONE")
      out.opacity = unit(f.alpha);
    if (noiseType === "DUOTONE")
      out.secondaryColor = rgba("#ffffff", f.alpha);
    return out;
  }
  var DARKENING = ["MULTIPLY", "DARKEN", "COLOR_BURN", "LINEAR_BURN"];
  var LIGHTENING = ["SCREEN", "LIGHTEN", "COLOR_DODGE", "LINEAR_DODGE"];
  function noiseToFigma(e, calib) {
    const blend = blendModeOf(e.blend) || "NORMAL";
    const raw = {
      noiseSize: interp1(calib.size, "baseFrequency", e.baseFrequency, "noiseSize"),
      density: interp1(calib.strength, "amount", e.amount, "density"),
      alpha: interp1(calib.strength, "amount", e.amount, "alpha"),
      noiseType: e.monochrome === false ? "MULTITONE" : "MONOTONE",
      color: DARKENING.indexOf(blend) >= 0 ? "#000000" : LIGHTENING.indexOf(blend) >= 0 ? "#ffffff" : e.bias > 0 ? "#ffffff" : "#000000",
      blendMode: blend
    };
    return rawNoiseToFigma(raw);
  }
  function effectToFigma(e, calib, spreadOk) {
    switch (e.type) {
      case "noise":
        return { effect: noiseToFigma(e, calib) };
      case "drop-shadow":
      case "inner-shadow": {
        const fx = {
          type: e.type === "drop-shadow" ? "DROP_SHADOW" : "INNER_SHADOW",
          color: rgba(e.color, e.opacity),
          offset: { x: clean(e.x), y: clean(e.y) },
          radius: clean(Math.max(0, e.blur)),
          visible: true,
          blendMode: "NORMAL"
        };
        let note;
        if (e.spread) {
          if (spreadOk)
            fx.spread = clean(e.spread);
          else
            note = e.type + " spread " + e.spread + " dropped: this node type does not accept spread";
        }
        return { effect: fx, note };
      }
      case "layer-blur":
      case "background-blur":
        return { effect: { type: e.type === "layer-blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR", blurType: "NORMAL", radius: clean(Math.max(0, e.radius) * BLUR_SCALE), visible: true } };
      default:
        return { effect: null, note: "unknown effect type " + e.type };
    }
  }

  // ../plugin/src/code.ts
  var NS = "designfigma";
  var FALLBACK_FAMILY = "Inter";
  var imageHashes = {};
  var fontCache = null;
  var axesCache = {};
  var FONT_CACHE_MS = 20000;
  function errText(e) {
    return String(e && e.message ? e.message : e);
  }
  async function getFonts(fresh) {
    const now = Date.now();
    if (!fresh && fontCache && now - fontCache.at < FONT_CACHE_MS)
      return fontCache.byFamily;
    const list = await figma.listAvailableFontsAsync();
    const byFamily = {};
    for (const f of list) {
      const fam = f.fontName.family;
      const key = fam.toLowerCase();
      if (!byFamily[key])
        byFamily[key] = { family: fam, styles: [] };
      if (byFamily[key].styles.indexOf(f.fontName.style) === -1)
        byFamily[key].styles.push(f.fontName.style);
    }
    fontCache = { at: now, byFamily };
    for (const k in axesCache)
      delete axesCache[k];
    return byFamily;
  }
  function findFamily(fonts, family) {
    const want = String(family).toLowerCase();
    if (fonts[want])
      return fonts[want];
    let best = null;
    for (const key in fonts) {
      if (key.indexOf(want + " ") === 0 && (!best || key.length < best.family.length))
        best = fonts[key];
    }
    return best;
  }
  function axesOf(family) {
    if (Object.prototype.hasOwnProperty.call(axesCache, family))
      return axesCache[family];
    let axes = null;
    try {
      axes = figma.getFontFamilyVariationAxes(family);
    } catch (e) {
      axes = null;
    }
    axesCache[family] = axes;
    return axes;
  }
  function toBytes(v) {
    if (v instanceof Uint8Array)
      return v;
    if (v instanceof ArrayBuffer)
      return new Uint8Array(v);
    if (v && typeof v === "object")
      return Uint8Array.from(Object.keys(v).map((k) => v[k]));
    throw new Error("image bytes missing");
  }
  function weightName(w) {
    if (w <= 150)
      return "Thin";
    if (w <= 250)
      return "Extra Light";
    if (w <= 350)
      return "Light";
    if (w <= 450)
      return "Regular";
    if (w <= 550)
      return "Medium";
    if (w <= 650)
      return "Semi Bold";
    if (w <= 750)
      return "Bold";
    if (w <= 850)
      return "Extra Bold";
    return "Black";
  }
  function resolveRunFont(run, fonts) {
    const wdth = run.variation && run.variation.wdth !== undefined ? run.variation.wdth : null;
    const want = {
      family: run.fontFamily,
      style: weightName(run.fontWeight) + (run.italic ? " Italic" : ""),
      weight: run.fontWeight,
      wdth
    };
    const entry = findFamily(fonts, run.fontFamily);
    if (!entry) {
      const inter = fonts[FALLBACK_FAMILY.toLowerCase()];
      const style2 = inter ? selectFontStyle(inter.styles, run.fontWeight, run.italic) || "Regular" : "Regular";
      return { family: inter ? inter.family : FALLBACK_FAMILY, style: style2, missing: true, want };
    }
    const style = pickStyle(entry.styles, run.fontWeight, run.italic, wdth);
    const out = { family: entry.family, style, missing: false, want };
    const axes = axesOf(entry.family);
    if (axes && axes.length) {
      const vs = {};
      const given = run.variation || {};
      for (const ax of axes) {
        const v = ax === "wght" ? given.wght !== undefined ? given.wght : run.fontWeight : given[ax];
        if (typeof v === "number" && isFinite(v))
          vs[ax] = v;
      }
      if (Object.keys(vs).length)
        out.variationSettings = vs;
    }
    return out;
  }
  function fontNameOf(r) {
    return r.variationSettings ? { family: r.family, style: r.style, variationSettings: r.variationSettings } : { family: r.family, style: r.style };
  }
  function fontTag(r) {
    let s = r.family + " " + r.style;
    if (r.variationSettings) {
      const vs = r.variationSettings;
      s += " " + Object.keys(vs).sort().map((k) => k + "=" + vs[k]).join(" ");
    }
    return s;
  }
  function imageHash(ctx, ref) {
    if (imageHashes[ref])
      return imageHashes[ref];
    const raw = ctx.images ? ctx.images[ref] : undefined;
    if (raw === undefined || raw === null)
      throw new Error("image not supplied: " + ref);
    const hash = figma.createImage(toBytes(raw)).hash;
    imageHashes[ref] = hash;
    return hash;
  }
  function paintsFor(ctx, fills, w, h, nodeName, noteMissing) {
    const out = [];
    for (const f of fills || []) {
      try {
        const p = fillToPaint(f, w, h);
        if (p.type === "IMAGE") {
          const hash = imageHash(ctx, p.imageRef);
          const ip = { type: "IMAGE", scaleMode: p.scaleMode, imageHash: hash };
          if (p.scaleMode === "TILE" && p.scalingFactor !== undefined)
            ip.scalingFactor = p.scalingFactor;
          if (p.filters)
            ip.filters = p.filters;
          out.push(ip);
        } else
          out.push(p);
      } catch (e) {
        const m = "fill: " + errText(e);
        ctx.errors.push({ node: nodeName, msg: m });
        noteMissing(m);
      }
    }
    return out;
  }
  function paintTags(node) {
    const fills = node.fills;
    if (!fills || fills === figma.mixed)
      return [];
    return fills.map((p) => paintTag(p));
  }
  function collectImageHashes(node, out) {
    try {
      const fills = node.fills;
      if (fills && fills !== figma.mixed) {
        for (const p of fills)
          if (p && p.type === "IMAGE" && p.imageHash)
            out[p.imageHash] = true;
      }
    } catch (e) {}
    if (node.children)
      for (const k of node.children)
        collectImageHashes(k, out);
  }
  function imageHashesOf(slide) {
    const out = {};
    collectImageHashes(slide, out);
    return Object.keys(out).sort();
  }
  async function prewarmImages(hashes) {
    const failed = [];
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
  function applyBox(node, n) {
    node.x = n.x;
    node.y = n.y;
    node.opacity = n.opacity === undefined ? 1 : n.opacity;
  }
  function setRadii(node, r) {
    node.topLeftRadius = r[0];
    node.topRightRadius = r[1];
    node.bottomRightRadius = r[2];
    node.bottomLeftRadius = r[3];
  }
  function buildRect(slide, n, ctx, soft) {
    const node = n.clipsContent ? figma.createFrame() : figma.createRectangle();
    slide.appendChild(node);
    node.name = n.name;
    node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    node.fills = paintsFor(ctx, n.fills, n.w, n.h, n.name, (m) => soft.push(m));
    if (n.clipsContent)
      node.clipsContent = true;
    setRadii(node, clampRadii(n.radius, n.w, n.h));
    if (n.stroke && n.stroke.width > 0) {
      const c = parseCssColor(n.stroke.color);
      const op = (n.stroke.opacity === undefined ? 1 : n.stroke.opacity) * c.a;
      const sp = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
      if (op < 1)
        sp.opacity = op;
      node.strokes = [sp];
      node.strokeWeight = n.stroke.width;
      node.strokeAlign = "INSIDE";
    }
    applyBox(node, n);
    return node;
  }
  function buildImage(slide, n, ctx) {
    const hash = imageHash(ctx, n.ref);
    const node = figma.createRectangle();
    slide.appendChild(node);
    node.name = n.name;
    node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    const paint = { type: "IMAGE", ...imagePaintMode(n.scaleMode), imageHash: hash };
    if (paint.scaleMode === "TILE")
      paint.scalingFactor = tileFactor(n.scalingFactor === undefined ? 1 : n.scalingFactor);
    const filters = cleanImageFilters(n.filters);
    if (filters)
      paint.filters = filters;
    node.fills = [paint];
    setRadii(node, clampRadii(n.radius, n.w, n.h));
    applyBox(node, n);
    return node;
  }
  function buildSvg(slide, n) {
    const node = figma.createNodeFromSvg(n.svg);
    slide.appendChild(node);
    node.name = n.name;
    if (Math.abs(node.width - n.w) > 0.5 || Math.abs(node.height - n.h) > 0.5) {
      for (const c of node.children) {
        try {
          c.constraints = { horizontal: "SCALE", vertical: "SCALE" };
        } catch (e) {}
      }
      node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    }
    applyBox(node, n);
    return node;
  }
  function spreadAllowed(node) {
    if (node.type === "RECTANGLE" || node.type === "ELLIPSE")
      return true;
    if (node.type === "FRAME")
      return !!node.clipsContent && visiblePaints(node.fills);
    return false;
  }
  function applyCommon(node, n, soft) {
    if (n.blendMode !== undefined && n.blendMode !== null) {
      const bm = blendModeOf(n.blendMode);
      if (bm)
        node.blendMode = bm;
      else
        soft.push("unknown blendMode " + n.blendMode);
    }
    const effects = [];
    if (n.figmaNoise)
      effects.push(rawNoiseToFigma(n.figmaNoise));
    const irFx = n.effects || [];
    for (let i = 0;i < irFx.length; i++) {
      if (n.figmaNoise && irFx[i].type === "noise")
        continue;
      try {
        const r = effectToFigma(irFx[i], noise_calibration_default, spreadAllowed(node));
        if (r.effect)
          effects.push(r.effect);
        if (r.note)
          soft.push(r.note);
      } catch (e) {
        soft.push("effect " + irFx[i].type + ": " + errText(e));
      }
    }
    if (effects.length)
      node.effects = effects;
    if (typeof n.rotation === "number" && isFinite(n.rotation) && Math.abs(n.rotation) > 0.000001) {
      node.relativeTransform = placeRotated(n, node.width, node.height, n.rotation, n.type === "text" ? n.align || "LEFT" : undefined);
    }
  }
  function buildGroup(parent, n) {
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
  function runPaint(r) {
    const c = parseCssColor(r.color);
    const op = (r.colorOpacity === undefined ? 1 : r.colorOpacity) * c.a;
    const p = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
    if (op < 1)
      p.opacity = op;
    return p;
  }
  function setRangeFont(t, r, f, soft) {
    try {
      t.setRangeFontName(r.start, r.end, fontNameOf(f));
    } catch (e) {
      if (!f.variationSettings)
        throw e;
      t.setRangeFontName(r.start, r.end, { family: f.family, style: f.style });
      soft.push("variationSettings rejected (" + errText(e) + "); used named style " + f.style);
    }
  }
  function buildText(slide, n, plan, soft) {
    const t = figma.createText();
    slide.appendChild(t);
    t.name = n.name;
    t.fontName = { family: plan.fonts[0].family, style: plan.fonts[0].style };
    t.characters = plan.chars;
    t.textAlignHorizontal = n.align || "LEFT";
    for (let i = 0;i < plan.runs.length; i++) {
      const r = plan.runs[i];
      setRangeFont(t, r, plan.fonts[i], soft);
      t.setRangeFontSize(r.start, r.end, r.fontSize);
      t.setRangeLineHeight(r.start, r.end, { unit: "PIXELS", value: r.lineHeightPx });
      t.setRangeLetterSpacing(r.start, r.end, { unit: "PIXELS", value: r.letterSpacingPx });
      t.setRangeFills(r.start, r.end, [runPaint(r)]);
      if (r.decoration && r.decoration !== "NONE")
        t.setRangeTextDecoration(r.start, r.end, r.decoration);
    }
    let x = n.x;
    if (plan.pinned) {
      const slack = Math.min(16, Math.max(2, n.w * 0.04));
      t.resize(Math.max(1, n.w + slack), Math.max(1, n.h));
      t.textAutoResize = "HEIGHT";
      if (n.align === "CENTER")
        x = n.x - slack / 2;
      else if (n.align === "RIGHT")
        x = n.x - slack;
    } else if (n.wrap) {
      t.resize(Math.max(1, n.w), Math.max(1, n.h));
      t.textAutoResize = "HEIGHT";
    } else {
      t.textAutoResize = "WIDTH_AND_HEIGHT";
      if (n.align === "CENTER")
        x = n.x + (n.w - t.width) / 2;
      else if (n.align === "RIGHT")
        x = n.x + n.w - t.width;
    }
    let y = n.y;
    const lh = plan.runs[0].lineHeightPx;
    const dh = n.h - t.height;
    if (lh > 0 && dh !== 0 && Math.abs(dh) <= 2 && Math.round(n.h / lh) === Math.round(t.height / lh))
      y = n.y + dh / 2;
    t.x = x;
    t.y = y;
    t.opacity = n.opacity === undefined ? 1 : n.opacity;
    return t;
  }
  function slidesInGrid() {
    return typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid() : figma.getSlideGrid();
  }
  function allSlides() {
    const out = [];
    const seen = {};
    const add = (n) => {
      if (!n || seen[n.id])
        return;
      if (n.type === "SLIDE") {
        seen[n.id] = true;
        out.push(n);
      } else if (n.type === "SLIDE_ROW" && n.children)
        for (const k of n.children)
          add(k);
    };
    try {
      for (const row of slidesInGrid())
        for (const n of row)
          add(n);
    } catch (e) {}
    try {
      const page = figma.currentPage;
      if (page && typeof page.findAllWithCriteria === "function")
        for (const n of page.findAllWithCriteria({ types: ["SLIDE"] }))
          add(n);
    } catch (e) {}
    return out;
  }
  function gridShape() {
    try {
      const g = slidesInGrid();
      const types = g.map((r) => Array.isArray(r) ? r.map((n) => n && n.type || typeof n).join(",") : typeof r).join(" | ");
      return "grid " + g.length + " rows [" + types.slice(0, 200) + "], slides found " + allSlides().length;
    } catch (e) {
      return "grid unreadable: " + errText(e);
    }
  }
  function fileLayout() {
    const chain = (n) => {
      const out = [];
      for (let p = n.parent;p; p = p.parent)
        out.push(p.type + ":" + p.name + (p.id ? "#" + p.id : ""));
      return out;
    };
    const pages = [];
    try {
      for (const pg of figma.root.children)
        pages.push({ id: pg.id, name: pg.name, current: pg === figma.currentPage, kids: (pg.children || []).map((k) => k.type + ":" + k.name).slice(0, 20) });
    } catch (e) {
      pages.push({ error: errText(e) });
    }
    const kidsOf = (sl) => (sl.children || []).slice(0, 10).map((k) => {
      const e = { type: k.type, name: k.name };
      if (k.type === "TEXT")
        e.chars = String(k.characters || "").length;
      if (k.children)
        e.kids = k.children.length;
      return e;
    });
    const slides = allSlides().map((sl) => ({ id: sl.id, name: sl.name, index: sl.getSharedPluginData(NS, "index"), skipped: sl.isSkippedSlide, childCount: (sl.children || []).length, children: kidsOf(sl), chain: chain(sl) }));
    let gridOrder = [];
    try {
      gridOrder = slidesInGrid().map((r) => r.map((n) => n && n.getSharedPluginData ? n.getSharedPluginData(NS, "index") || "-" : "?").join(","));
    } catch (e) {
      gridOrder = ["unreadable"];
    }
    return { pages, grid: gridShape(), gridOrder, slides };
  }
  function findSlide(index) {
    for (const s of allSlides())
      if (s.getSharedPluginData(NS, "index") === String(index))
        return s;
    return null;
  }
  function visiblePaints(paints) {
    if (paints === figma.mixed)
      return true;
    if (!paints)
      return false;
    for (const p of paints)
      if (p && p.visible !== false && (p.opacity === undefined || p.opacity > 0))
        return true;
    return false;
  }
  function isEmptyPlaceholder(n) {
    try {
      if (n.type === "TEXT")
        return String(n.characters || "").replace(/\s+/g, "") === "";
      if (n.type === "SVG" || n.type === "IMAGE" || n.type === "VIDEO")
        return false;
      if (visiblePaints(n.fills) || visiblePaints(n.strokes))
        return false;
      if (n.children && (n.type === "FRAME" || n.type === "GROUP" || n.type === "SECTION")) {
        for (const k of n.children)
          if (!isEmptyPlaceholder(k))
            return false;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  function isBlankSlide(s) {
    if (!s.children)
      return true;
    for (const k of s.children)
      if (!isEmptyPlaceholder(k))
        return false;
    return true;
  }
  function orderSlides(removeBlank) {
    const setGrid = typeof figma.setCanvasGrid === "function" ? figma.setCanvasGrid : figma.setSlideGrid;
    if (typeof setGrid !== "function")
      return;
    let grid = [];
    try {
      grid = slidesInGrid();
    } catch (e) {
      grid = [];
    }
    if (grid.length > 1)
      return;
    const slides = allSlides();
    const tag = (s) => s.getSharedPluginData(NS, "index");
    const tagged = slides.filter((s) => tag(s) !== "").sort((a, b) => Number(tag(a)) - Number(tag(b)));
    let rest = slides.filter((s) => tag(s) === "");
    if (removeBlank && tagged.length) {
      for (const s of rest)
        if (isBlankSlide(s))
          s.remove();
      rest = rest.filter((s) => !s.removed);
    }
    const want = tagged.concat(rest);
    const have = grid.length ? grid[0] : [];
    if (have.length === want.length && have.every((s, i) => s.id === want[i].id))
      return;
    setGrid.call(figma, [want]);
  }
  function createSlideFor(index) {
    const grid = slidesInGrid();
    if (grid.length === 0)
      return figma.createSlide();
    let col = 0;
    for (let c = 0;c < grid[0].length; c++) {
      const v = grid[0][c].getSharedPluginData(NS, "index");
      if (v !== "" && Number(v) < index)
        col = c + 1;
    }
    return figma.createSlide(0, col);
  }
  function clearChildren(slide) {
    const kids = slide.children.slice();
    for (const k of kids)
      k.remove();
  }
  function planText(n, fonts) {
    try {
      const runs = groupRuns(n.characters.length, n.runs);
      if (runs.length === 0)
        return { error: "text has no usable runs" };
      const pinned = pinLines(n.characters, runs, n.lines);
      return { chars: pinned.characters, runs: pinned.runs, fonts: runs.map((r) => resolveRunFont(r, fonts)), pinned: pinned.characters !== n.characters };
    } catch (e) {
      return { error: errText(e) };
    }
  }
  function collectTextPlans(ir, fonts) {
    const out = { list: [], byNode: new Map };
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.type === "text") {
          const plan = planText(n, fonts);
          out.list.push(plan);
          out.byNode.set(n, plan);
        } else if (n.type === "group" && n.children)
          walk(n.children);
      }
    };
    walk(ir.nodes);
    return out;
  }
  async function loadPlannedFonts(plans, fonts) {
    const need = {};
    const add = (r) => {
      need[r.family + "\x00" + r.style] = r;
    };
    add({ family: FALLBACK_FAMILY, style: "Regular", missing: false, want: { family: FALLBACK_FAMILY, style: "Regular", weight: 400, wdth: null } });
    for (const p of plans)
      if (p && !("error" in p))
        for (const f of p.fonts)
          add(f);
    const keys = Object.keys(need);
    const failed = {};
    await Promise.all(keys.map((k) => figma.loadFontAsync({ family: need[k].family, style: need[k].style }).then(() => {
      return;
    }, () => {
      failed[k] = true;
    })));
    if (!keys.some((k) => failed[k]))
      return;
    if (failed[FALLBACK_FAMILY + "\x00Regular"])
      throw new Error("cannot load fallback font Inter Regular");
    const inter = fonts[FALLBACK_FAMILY.toLowerCase()];
    for (const p of plans) {
      if (!p || "error" in p)
        continue;
      for (let i = 0;i < p.fonts.length; i++) {
        const f = p.fonts[i];
        if (!failed[f.family + "\x00" + f.style])
          continue;
        const style = inter ? selectFontStyle(inter.styles, f.want.weight, /Italic$/.test(f.want.style)) || "Regular" : "Regular";
        const fb = { family: FALLBACK_FAMILY, style, missing: true, want: f.want };
        try {
          await figma.loadFontAsync({ family: fb.family, style: fb.style });
        } catch (e) {
          fb.style = "Regular";
        }
        p.fonts[i] = fb;
      }
    }
  }
  function describeNode(irNode, node, plan) {
    const entry = {
      name: irNode.name,
      irType: irNode.type,
      figmaType: node.type,
      x: node.x,
      y: node.y,
      w: node.width,
      h: node.height
    };
    if (irNode.type === "text") {
      entry.characters = node.characters;
      const tags = [];
      if (plan && !("error" in plan)) {
        for (const r of plan.runs) {
          let tag = "";
          try {
            const fills = node.getRangeFills(r.start, r.end);
            tag = fills === figma.mixed || !fills.length ? "MIXED" : paintTag(fills[0]);
          } catch (e) {
            tag = "UNREADABLE";
          }
          if (tags.length === 0 || tags[tags.length - 1] !== tag)
            tags.push(tag);
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
  function describeCommon(entry, node, irNode) {
    try {
      if (node.effects && node.effects !== figma.mixed && node.effects.length)
        entry.effects = node.effects.map((f) => ({ type: f.type }));
    } catch (e) {}
    try {
      if (node.blendMode && node.blendMode !== "PASS_THROUGH" && node.blendMode !== "NORMAL")
        entry.blendMode = node.blendMode;
    } catch (e) {}
    try {
      if (node.rotation && Math.abs(node.rotation) > 0.000001 && node.relativeTransform) {
        const tb = typeof irNode.w === "number" ? unrotatedIn(node.relativeTransform, node.width, node.height, irNode) : transformBox(node.relativeTransform, node.width, node.height);
        entry.x = tb.x;
        entry.y = tb.y;
        entry.rotation = -node.rotation;
      }
    } catch (e) {}
    try {
      const fills = node.fills;
      if (fills && fills !== figma.mixed) {
        const union = {};
        for (const p of fills)
          if (p && p.type === "IMAGE" && p.filters)
            for (const k in p.filters)
              union[k] = p.filters[k];
        if (Object.keys(union).length)
          entry.imageFilters = union;
      }
    } catch (e) {}
  }
  function buildNodes(parent, nodes, ox, oy, ctx, plans) {
    const out = [];
    for (let i = 0;i < nodes.length; i++) {
      const orig = nodes[i];
      const n = ox || oy ? Object.assign({}, orig, { x: orig.x - ox, y: orig.y - oy }) : orig;
      const plan = plans.byNode.get(orig) || null;
      let node = null;
      const soft = [];
      try {
        let kids = null;
        if (n.type === "rect")
          node = buildRect(parent, n, ctx, soft);
        else if (n.type === "image")
          node = buildImage(parent, n, ctx);
        else if (n.type === "svg")
          node = buildSvg(parent, n);
        else if (n.type === "text") {
          if (!plan || "error" in plan)
            throw new Error(plan ? plan.error : "no text plan");
          node = buildText(parent, n, plan, soft);
        } else if (n.type === "group") {
          node = buildGroup(parent, n);
          kids = buildNodes(node, orig.children || [], orig.x, orig.y, ctx, plans);
          if (orig.mask) {
            if (node.children.length && kids[0] && kids[0].figmaType !== "NONE")
              node.children[0].isMask = true;
            else
              soft.push("mask: first child did not build, group left unmasked");
          }
        } else
          throw new Error("unknown node type " + n.type);
        applyCommon(node, n, soft);
        const entry = describeNode(n, node, plan);
        entry.x += ox;
        entry.y += oy;
        if (kids) {
          entry.children = kids;
          if (orig.mask)
            entry.mask = !!(node.children.length && node.children[0].isMask);
        }
        if (soft.length)
          entry.error = soft[0];
        out.push(entry);
      } catch (e) {
        const msg = errText(e);
        ctx.errors.push({ node: n.name, msg });
        try {
          if (node && !node.removed)
            node.remove();
        } catch (e2) {}
        out.push({ name: n.name, irType: n.type, figmaType: "NONE", x: 0, y: 0, w: 0, h: 0, error: msg });
      }
    }
    return out;
  }
  async function buildSlide(ir, images) {
    const fonts = await getFonts(false);
    const ctx = { images, errors: [], fontsUsed: {}, missing: {} };
    const plans = collectTextPlans(ir, fonts);
    await loadPlannedFonts(plans.list, fonts);
    let slide = findSlide(ir.index);
    if (!slide)
      slide = createSlideFor(ir.index);
    clearChildren(slide);
    slide.name = ir.label;
    slide.setSharedPluginData(NS, "index", String(ir.index));
    const bg = paintsFor(ctx, ir.background, ir.width, ir.height, "(background)", () => {
      return;
    });
    slide.fills = ir.background && ir.background.length ? bg : [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    const nodes = buildNodes(slide, ir.nodes, 0, 0, ctx, plans);
    const fontsUsed = [];
    const missingFonts = [];
    const seenUsed = {};
    const seenMissing = {};
    for (const p of plans.list) {
      if (!p || "error" in p)
        continue;
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
      imageHashes: imageHashesOf(slide)
    };
  }
  function notify(text) {
    try {
      figma.notify(text, { timeout: 3000 });
    } catch (e) {}
  }
  async function handleProbe(msg) {
    const families = msg.families || [];
    const byFamily = await getFonts(true);
    const fonts = [];
    const axes = {};
    for (const fam of families) {
      const entry = findFamily(byFamily, fam);
      if (!entry) {
        axes[fam] = null;
        continue;
      }
      for (const style of entry.styles)
        fonts.push({ family: entry.family, style });
      axes[fam] = axesOf(entry.family);
    }
    const similar = {};
    for (const fam of families) {
      const word = String(fam).toLowerCase().split(" ")[0];
      similar[fam] = [];
      for (const key in byFamily) {
        if (key.indexOf(word) >= 0)
          similar[fam].push({ family: byFamily[key].family, styles: byFamily[key].styles, axes: axesOf(byFamily[key].family) });
      }
    }
    figma.ui.postMessage({ type: "probe-result", fonts, axes, similar, layout: fileLayout(), editorType: figma.editorType });
    notify("design-figma: probed " + families.length + " font families");
  }
  async function handleBuild(msg) {
    const ir = msg.ir;
    const report = await buildSlide(ir, msg.images || {});
    try {
      orderSlides(!!msg.removeBlank);
    } catch (e) {
      report.errors.push({ node: "slide-order", msg: errText(e) });
    }
    figma.ui.postMessage({ type: "built", index: ir.index, report });
    const bad = report.errors.length;
    notify("design-figma: " + ir.label + " built, " + report.nodes.length + " nodes, " + bad + " error" + (bad === 1 ? "" : "s") + (report.missingFonts.length ? ", " + report.missingFonts.length + " missing font" + (report.missingFonts.length === 1 ? "" : "s") : ""));
  }
  async function handleExport(msg) {
    const slide = findSlide(msg.index);
    if (!slide)
      throw new Error("no slide with index " + msg.index + " (build it first); " + gridShape());
    const scale = typeof msg.scale === "number" && msg.scale > 0 ? msg.scale : 1;
    await prewarmImages(imageHashesOf(slide));
    const bytes = await slide.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    figma.ui.postMessage({ type: "png", index: msg.index, bytes });
  }
  async function handleRemove(msg) {
    const wanted = {};
    for (const i of msg.indices || [])
      wanted[String(i)] = true;
    const removed = [];
    for (const s of allSlides()) {
      const tag = s.getSharedPluginData(NS, "index");
      if (tag !== "" && wanted[tag]) {
        s.remove();
        removed.push(Number(tag));
      }
    }
    const missing = (msg.indices || []).filter((i) => removed.indexOf(i) === -1);
    figma.ui.postMessage({ type: "removed", removed, missing });
    notify("design-figma: removed " + removed.length + " slide" + (removed.length === 1 ? "" : "s"));
  }
  async function handle(msg) {
    if (!msg || typeof msg.type !== "string")
      return;
    try {
      if (msg.type === "probe")
        await handleProbe(msg);
      else if (msg.type === "build")
        await handleBuild(msg);
      else if (msg.type === "export")
        await handleExport(msg);
      else if (msg.type === "remove")
        await handleRemove(msg);
    } catch (e) {
      const index = msg.type === "build" && msg.ir ? msg.ir.index : msg.index;
      figma.ui.postMessage({ type: "error", index, msg: errText(e) });
      notify("design-figma: " + msg.type + " failed: " + errText(e));
    }
  }
  figma.showUI(__html__, { width: 360, height: 220 });
  var chain = Promise.resolve();
  figma.ui.onmessage = (msg) => {
    chain = chain.then(() => handle(msg));
    return chain;
  };
})();
