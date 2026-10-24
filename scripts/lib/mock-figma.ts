// Strict mock of the Figma plugin API, shared by plugin.test.ts and e2e-mock.ts.
export type FontDef = { family: string; styles: string[]; axes?: string[] };
export const INTER_STYLES = ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"].flatMap((s) =>
  s === "Regular" ? ["Regular", "Italic"] : [s, s + " Italic"],
);
export const DENIM_STYLES = ["", "WD "].flatMap((wd) =>
  ["Bold", "Heavy", "Light", "Medium", "Regular", "SemiBold"].flatMap((w) => [wd + w, wd + w + " Italic"]),
);
export const DEFAULT_FONTS: FontDef[] = [
  { family: "Inter", styles: INTER_STYLES },
  // As real Figma desktop listed the local DenimINKTRIALVF.ttf on 2026-10-24 (probe.json).
  { family: "Denim INK TRIAL", styles: DENIM_STYLES, axes: ["wght", "ital", "wdth"] },
  { family: "Circular XX Mono", styles: ["Regular"] },
  // macOS system fonts the sample deck (fixtures/make-sample.ts) uses, styles as macOS ships them.
  { family: "Helvetica Neue", styles: ["Regular", "Italic", "UltraLight", "UltraLight Italic", "Thin", "Thin Italic", "Light", "Light Italic", "Medium", "Medium Italic", "Bold", "Bold Italic", "Condensed Bold", "Condensed Black"] },
  { family: "Menlo", styles: ["Regular", "Italic", "Bold", "Bold Italic"] },
];

// What the mock exports for a slide holding an image nobody has decoded yet (real Figma gave a blank slide).
export const BLANK_PNG = new Uint8Array([137, 80, 78, 71, 0, 0]);

// The real BlendMode union (developers.figma.com/docs/plugins/api/BlendMode), kept independent of lib/figma-map.ts.
export const MOCK_BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
  "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
];
const IMAGE_FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];

function exactKeys(o: any, allowed: string[], required: string[], where: string) {
  if (!o || typeof o !== "object") throw new Error(`${where}: must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: unknown field "${k}"`);
  for (const k of required) if (o[k] === undefined) throw new Error(`${where}: missing field "${k}"`);
}
function checkRgba(c: any, where: string) {
  exactKeys(c, ["r", "g", "b", "a"], ["r", "g", "b", "a"], where);
  for (const k of ["r", "g", "b", "a"]) if (!(typeof c[k] === "number" && c[k] >= 0 && c[k] <= 1)) throw new Error(`${where}: ${k} must be 0..1`);
}

/** Strict check of one Effect against the documented shapes. `node` decides whether shadow spread is accepted. */
export function checkEffect(fx: any, node: { type: string; clipsContent?: boolean; _fills?: any[] }, where = "effect") {
  if (!fx || typeof fx.type !== "string") throw new Error(`${where}: effect needs a type`);
  const common = ["type", "visible"];
  if (fx.visible !== undefined && typeof fx.visible !== "boolean") throw new Error(`${where}: visible must be boolean`);
  const blend = () => {
    if (!MOCK_BLEND_MODES.includes(fx.blendMode)) throw new Error(`${where}: bad blendMode ${fx.blendMode}`);
  };
  switch (fx.type) {
    case "DROP_SHADOW":
    case "INNER_SHADOW": {
      exactKeys(fx, [...common, "color", "offset", "radius", "spread", "blendMode", ...(fx.type === "DROP_SHADOW" ? ["showShadowBehindNode"] : [])], ["color", "offset", "radius", "visible", "blendMode"], where);
      checkRgba(fx.color, where + ".color");
      exactKeys(fx.offset, ["x", "y"], ["x", "y"], where + ".offset");
      if (!(typeof fx.offset.x === "number" && typeof fx.offset.y === "number")) throw new Error(`${where}: offset must be numbers`);
      if (!(typeof fx.radius === "number" && fx.radius >= 0)) throw new Error(`${where}: radius must be >= 0`);
      blend();
      if (fx.spread !== undefined) {
        if (typeof fx.spread !== "number") throw new Error(`${where}: spread must be a number`);
        const ok = node.type === "RECTANGLE" || node.type === "ELLIPSE" || (node.type === "FRAME" && !!node.clipsContent && (node._fills || []).some((p) => p.visible !== false));
        if (fx.spread !== 0 && !ok) throw new Error(`${where}: spread is only accepted on rectangles, ellipses, or clipping frames with a visible fill (${node.type})`);
      }
      return;
    }
    case "LAYER_BLUR":
    case "BACKGROUND_BLUR":
      exactKeys(fx, [...common, "radius", "blurType"], ["radius", "visible"], where);
      if (fx.blurType !== undefined && fx.blurType !== "NORMAL") throw new Error(`${where}: blurType ${fx.blurType} not supported by the mock`);
      if (!(typeof fx.radius === "number" && fx.radius >= 0)) throw new Error(`${where}: radius must be >= 0`);
      return;
    case "NOISE": {
      const nt = fx.noiseType;
      if (!["MONOTONE", "DUOTONE", "MULTITONE"].includes(nt)) throw new Error(`${where}: bad noiseType ${nt}`);
      // Real Figma rejects blendMode on NOISE (live run 2026-10-24), so the mock does too.
      exactKeys(fx, [...common.filter((k) => k !== "blendMode"), "noiseType", "color", "noiseSize", "noiseSizeVector", "density", ...(nt === "DUOTONE" ? ["secondaryColor"] : []), ...(nt === "MULTITONE" ? ["opacity"] : [])], ["noiseType", "color", "noiseSize", "density", "visible", ...(nt === "DUOTONE" ? ["secondaryColor"] : []), ...(nt === "MULTITONE" ? ["opacity"] : [])], where);
      checkRgba(fx.color, where + ".color");
      if (nt === "DUOTONE") checkRgba(fx.secondaryColor, where + ".secondaryColor");
      if (nt === "MULTITONE" && !(typeof fx.opacity === "number" && fx.opacity >= 0 && fx.opacity <= 1)) throw new Error(`${where}: opacity must be 0..1`);
      if (!(typeof fx.noiseSize === "number" && fx.noiseSize > 0)) throw new Error(`${where}: noiseSize must be > 0`);
      if (!(typeof fx.density === "number" && fx.density >= 0 && fx.density <= 1)) throw new Error(`${where}: density must be 0..1`);
      if (fx.noiseSizeVector !== undefined && fx.noiseSizeVector.x !== fx.noiseSize) throw new Error(`${where}: noiseSizeVector.x must equal noiseSize`);
      return;
    }
    default:
      throw new Error(`${where}: unknown effect type ${fx.type}`);
  }
}

export function makeFigma(
  fontDefs: FontDef[] = DEFAULT_FONTS,
  opts: {
    exportBytes?: (node: any, settings: any) => Uint8Array | Promise<Uint8Array>;
    // Height Figma would lay a fixed-width (HEIGHT) text out to; undefined keeps the box height as set.
    textHeight?: (node: any) => number | undefined;
  } = {},
) {
  const violations: string[] = [];
  const posted: any[] = [];
  const loaded = new Set<string>();
  const images = new Map<string, Uint8Array>();
  const warmed = new Set<string>(); // image hashes whose bytes were awaited since creation
  const notes: string[] = [];
  const exports: any[] = [];
  let nextId = 1;
  const grid: any[][] = [];
  const fk = (f: { family: string; style: string }) => `${f.family}/${f.style}`;
  const famOf = (family: string) => fontDefs.find((d) => d.family === family);
  const MIXED = Symbol("mixed");

  function checkFont(f: any, where: string) {
    const d = famOf(f.family);
    if (!d) throw new Error(`${where}: unknown font family ${f.family}`);
    if (f.style === undefined || !d.styles.includes(f.style)) throw new Error(`${where}: unknown font style ${f.family}/${f.style}`);
    if (f.variationSettings) {
      for (const ax of Object.keys(f.variationSettings)) {
        if (!d.axes || !d.axes.includes(ax)) throw new Error(`${where}: family ${f.family} has no axis ${ax}`);
        if (typeof f.variationSettings[ax] !== "number") throw new Error(`${where}: axis ${ax} not a number`);
      }
    }
  }
  function checkPaints(ps: any, where: string) {
    if (!Array.isArray(ps)) throw new Error(`${where}: paints must be an array`);
    for (const p of ps) {
      const t = p.type;
      if (t === "SOLID") {
        const keys = Object.keys(p.color || {}).sort().join("");
        if (keys !== "bgr") throw new Error(`${where}: SOLID colour must be exactly {r,g,b}, got ${keys}`);
        for (const k of ["r", "g", "b"]) if (!(p.color[k] >= 0 && p.color[k] <= 1)) throw new Error(`${where}: colour channel out of range`);
        if (p.opacity !== undefined && !(p.opacity >= 0 && p.opacity <= 1)) throw new Error(`${where}: opacity out of range`);
      } else if (t === "GRADIENT_LINEAR" || t === "GRADIENT_RADIAL") {
        if (!Array.isArray(p.gradientStops) || p.gradientStops.length < 2) throw new Error(`${where}: gradient needs 2+ stops`);
        for (const s of p.gradientStops) {
          const keys = Object.keys(s.color || {}).sort().join("");
          if (keys !== "abgr") throw new Error(`${where}: gradient stop colour must be {r,g,b,a}, got ${keys}`);
          if (!(s.position >= 0 && s.position <= 1)) throw new Error(`${where}: stop position out of range`);
        }
        if (!Array.isArray(p.gradientTransform) || p.gradientTransform.length !== 2 || p.gradientTransform.some((r: any) => r.length !== 3))
          throw new Error(`${where}: gradientTransform must be 2x3`);
      } else if (t === "IMAGE") {
        if (!images.has(p.imageHash)) throw new Error(`${where}: unknown imageHash ${p.imageHash}`);
        if (!["FILL", "FIT", "CROP", "TILE"].includes(p.scaleMode)) throw new Error(`${where}: bad scaleMode ${p.scaleMode}`);
        if (p.imageTransform !== undefined) {
          if (p.scaleMode !== "CROP") throw new Error(`${where}: imageTransform only applies to scaleMode CROP`);
          if (!Array.isArray(p.imageTransform) || p.imageTransform.length !== 2 || p.imageTransform.some((r: any) => !Array.isArray(r) || r.length !== 3 || r.some((v: any) => typeof v !== "number")))
            throw new Error(`${where}: imageTransform must be 2x3 numbers`);
        }
        if (p.scalingFactor !== undefined) {
          if (p.scaleMode !== "TILE") throw new Error(`${where}: scalingFactor only applies to scaleMode TILE`);
          if (!(typeof p.scalingFactor === "number" && p.scalingFactor > 0)) throw new Error(`${where}: scalingFactor must be > 0`);
        }
        if (p.filters !== undefined) {
          exactKeys(p.filters, IMAGE_FILTER_KEYS, [], `${where}: filters`);
          for (const k of Object.keys(p.filters)) if (!(typeof p.filters[k] === "number" && p.filters[k] >= -1 && p.filters[k] <= 1)) throw new Error(`${where}: filter ${k} must be -1..1`);
        }
      } else throw new Error(`${where}: unknown paint type ${t}`);
    }
  }

  class FNode {
    id = `${nextId++}:1`;
    type: string;
    parent: FNode | null = null;
    children: FNode[] = [];
    removed = false;
    name = "";
    opacity = 1;
    width = 100;
    height = 100;
    _x = 0;
    _y = 0;
    _fills: any[] = [];
    _strokes: any[] = [];
    data = new Map<string, string>();
    clipsContent = false;
    radii = [0, 0, 0, 0];
    constraints: any = null;
    // text
    _chars = "";
    _charFont: any[] = [];
    _charSize: number[] = [];
    _charFills: any[][] = [];
    _autoResize = "WIDTH_AND_HEIGHT";
    _align = "LEFT";
    ranges: any[] = [];
    constructor(type: string) {
      this.type = type;
      if (type === "TEXT") this._autoResize = "WIDTH_AND_HEIGHT";
    }
    // blend mode, effects, rotation, mask (all strict)
    _blend = "PASS_THROUGH";
    _effects: any[] = [];
    _isMask = false;
    _m: [[number, number, number], [number, number, number]] = [[1, 0, 0], [0, 1, 0]];
    get blendMode() { return this._blend; }
    set blendMode(v: string) {
      if (!MOCK_BLEND_MODES.includes(v)) throw new Error(`bad blendMode ${v}`);
      this._blend = v;
    }
    get effects() { return this._effects; }
    set effects(v: any[]) {
      if (!Array.isArray(v)) throw new Error("effects must be an array");
      if (this.type === "SLIDE") throw new Error("a slide has no effects");
      v.forEach((fx, i) => checkEffect(fx, this, `${this.type} "${this.name}" effects[${i}]`));
      this._effects = v;
    }
    get isMask() { return this._isMask; }
    set isMask(v: boolean) {
      if (typeof v !== "boolean") throw new Error("isMask must be boolean");
      if (!this.parent) violations.push(`${this.type} "${this.name}": isMask set before appendChild`);
      if (this.parent && this.parent.type === "SLIDE" && v) throw new Error("a mask inside a slide would mask the whole slide above it; put it in a frame");
      this._isMask = v;
    }
    get relativeTransform() { return [[this._m[0][0], this._m[0][1], this._x], [this._m[1][0], this._m[1][1], this._y]]; }
    set relativeTransform(t: any) {
      if (!this.parent) violations.push(`${this.type} "${this.name}": relativeTransform set before appendChild`);
      if (!Array.isArray(t) || t.length !== 2 || t.some((r: any) => !Array.isArray(r) || r.length !== 3 || r.some((v: any) => typeof v !== "number" || !isFinite(v)))) throw new Error("relativeTransform must be a finite 2x3 matrix");
      const det = t[0][0] * t[1][1] - t[0][1] * t[1][0];
      if (Math.abs(Math.abs(det) - 1) > 1e-3 || Math.abs(t[0][0] - t[1][1]) > 1e-3 || Math.abs(t[0][1] + t[1][0]) > 1e-3) throw new Error("mock: relativeTransform must be a pure rotation");
      this._m = [[t[0][0], t[0][1]], [t[1][0], t[1][1]]] as any;
      this._x = t[0][2];
      this._y = t[1][2];
    }
    /** Figma reports rotation counter-clockwise in degrees, -180..180. */
    get rotation() {
      const deg = -(Math.atan2(this._m[1][0], this._m[0][0]) * 180) / Math.PI;
      return Math.abs(deg) < 1e-9 ? 0 : deg;
    }
    get x() { return this._x; }
    set x(v: number) { if (!this.parent) violations.push(`${this.type} "${this.name}": x set before appendChild`); this._x = v; }
    get y() { return this._y; }
    set y(v: number) { if (!this.parent) violations.push(`${this.type} "${this.name}": y set before appendChild`); this._y = v; }
    appendChild(c: FNode) {
      if (!["SLIDE", "FRAME"].includes(this.type)) throw new Error(`${this.type} cannot have children`);
      if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c);
      c.parent = this;
      this.children.push(c);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
      this.removed = true;
    }
    resize(w: number, h: number) {
      if (!(w > 0 && h > 0)) throw new Error(`resize to non-positive size ${w}x${h}`);
      this.width = w;
      this.height = h;
      if (this.type === "TEXT") this._autoResize = "NONE";
    }
    get fills() { return this._fills; }
    set fills(v: any[]) {
      if (this.type === "TEXT") throw new Error("mock: use setRangeFills on text");
      checkPaints(v, `${this.type} "${this.name}" fills`);
      this._fills = v;
    }
    get strokes() { return this._strokes; }
    set strokes(v: any[]) { checkPaints(v, "strokes"); this._strokes = v; }
    strokeWeight = 0;
    strokeAlign = "CENTER";
    setRadius(i: number, v: number) {
      if (!["RECTANGLE", "FRAME"].includes(this.type)) throw new Error(`${this.type} has no corner radius`);
      if (!(v >= 0 && v <= Math.min(this.width, this.height) / 2 + 1e-9)) throw new Error(`radius ${v} exceeds half of ${this.width}x${this.height}`);
      this.radii[i] = v;
    }
    set topLeftRadius(v: number) { this.setRadius(0, v); }
    set topRightRadius(v: number) { this.setRadius(1, v); }
    set bottomRightRadius(v: number) { this.setRadius(2, v); }
    set bottomLeftRadius(v: number) { this.setRadius(3, v); }
    setSharedPluginData(ns: string, k: string, v: string) { this.data.set(ns + "|" + k, v); }
    getSharedPluginData(ns: string, k: string) { return this.data.get(ns + "|" + k) ?? ""; }
    async exportAsync(settings: any) {
      exports.push({ id: this.id, settings });
      const cold: string[] = [];
      const walk = (n: FNode) => {
        for (const p of n._fills) if (p.type === "IMAGE" && !warmed.has(p.imageHash)) cold.push(p.imageHash);
        n.children.forEach(walk);
      };
      walk(this);
      if (cold.length) return BLANK_PNG;
      if (opts.exportBytes) return opts.exportBytes(this, settings);
      return new Uint8Array([137, 80, 78, 71]);
    }
    // ---- text
    private needLoaded(f: any, what: string) {
      if (!loaded.has(fk(f))) throw new Error(`${what}: font ${fk(f)} is not loaded`);
    }
    private onlyText() { if (this.type !== "TEXT") throw new Error(`${this.type} is not a text node`); }
    get fontName() { return this._chars.length ? this._charFont[0] : this._defaultFont; }
    _defaultFont: any = { family: "Inter", style: "Regular" };
    set fontName(f: any) {
      this.onlyText();
      checkFont(f, "fontName");
      this.needLoaded(f, "fontName");
      this._defaultFont = f;
      this._charFont = this._charFont.map(() => f);
      this.relayout();
    }
    get characters() { return this._chars; }
    set characters(s: string) {
      this.onlyText();
      this.needLoaded(this._defaultFont, "characters");
      this._chars = s;
      this._charFont = Array.from({ length: s.length }, () => this._defaultFont);
      this._charSize = Array.from({ length: s.length }, () => 12);
      this._charFills = Array.from({ length: s.length }, () => [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]);
      this.relayout();
    }
    relayout() {
      if (this._autoResize === "WIDTH_AND_HEIGHT") {
        const size = this._charSize.length ? Math.max(...this._charSize) : 12;
        this.width = Math.max(1, this._chars.length * size * 0.5);
        // line height as laid out: the largest PIXELS range if one was set, else Figma's auto ~1.2
        const lh = this.ranges.filter((r: any) => r[0] === "lh" && r[3].unit === "PIXELS").map((r: any) => r[3].value);
        this.height = (lh.length ? Math.max(...lh) : size * 1.2) * this._chars.split("\u2028").length;
      } else if (this._autoResize === "HEIGHT" && opts.textHeight) {
        const h = opts.textHeight(this);
        if (h !== undefined) this.height = h;
      }
    }
    set textAutoResize(v: string) {
      this.onlyText();
      if (!["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"].includes(v)) throw new Error(`bad textAutoResize ${v}`);
      this._autoResize = v;
      this.relayout();
    }
    get textAutoResize() { return this._autoResize; }
    set textAlignHorizontal(v: string) {
      this.onlyText();
      if (!["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(v)) throw new Error(`bad textAlignHorizontal ${v}`);
      this._align = v;
    }
    get textAlignHorizontal() { return this._align; }
    private range(s: number, e: number) {
      this.onlyText();
      if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= this._chars.length && s < e)) throw new Error(`bad range ${s}-${e} for ${this._chars.length} chars`);
      for (let i = s; i < e; i++) this.needLoaded(this._charFont[i], "text edit");
    }
    setRangeFontName(s: number, e: number, f: any) {
      this.range(s, e);
      checkFont(f, "setRangeFontName");
      this.needLoaded(f, "setRangeFontName");
      for (let i = s; i < e; i++) this._charFont[i] = f;
      this.ranges.push(["font", s, e, f]);
    }
    setRangeFontSize(s: number, e: number, v: number) {
      this.range(s, e);
      if (!(v > 0)) throw new Error("bad font size");
      for (let i = s; i < e; i++) this._charSize[i] = v;
      this.ranges.push(["size", s, e, v]);
      this.relayout();
    }
    setRangeLineHeight(s: number, e: number, v: any) {
      this.range(s, e);
      if (v.unit !== "PIXELS" && v.unit !== "PERCENT") throw new Error("bad line height unit");
      this.ranges.push(["lh", s, e, v]);
      this.relayout();
    }
    setRangeLetterSpacing(s: number, e: number, v: any) {
      this.range(s, e);
      if (v.unit !== "PIXELS" && v.unit !== "PERCENT") throw new Error("bad letter spacing unit");
      this.ranges.push(["ls", s, e, v]);
    }
    setRangeFills(s: number, e: number, v: any[]) {
      this.range(s, e);
      checkPaints(v, "setRangeFills");
      for (let i = s; i < e; i++) this._charFills[i] = v;
      this.ranges.push(["fills", s, e, v]);
    }
    setRangeTextDecoration(s: number, e: number, v: string) {
      this.range(s, e);
      if (!["NONE", "UNDERLINE", "STRIKETHROUGH"].includes(v)) throw new Error("bad decoration");
      this.ranges.push(["deco", s, e, v]);
    }
    getRangeFills(s: number, e: number) {
      this.onlyText();
      if (!(s >= 0 && e <= this._chars.length && s < e)) throw new Error("bad range");
      const first = JSON.stringify(this._charFills[s]);
      for (let i = s; i < e; i++) if (JSON.stringify(this._charFills[i]) !== first) return MIXED;
      return this._charFills[s];
    }
    getRangeFontName(s: number, e: number) { return this._charFont[s]; }
  }

  const figma: any = {
    mixed: MIXED,
    editorType: "slides",
    root: new FNode("DOCUMENT"),
    ui: { onmessage: null as any, postMessage: (m: any) => posted.push(m) },
    showUI: (html: string, opts: any) => { if (typeof html !== "string") throw new Error("showUI needs html"); },
    notify: (t: string, o?: any) => { notes.push(t); },
    createRectangle: () => new FNode("RECTANGLE"),
    createFrame: () => new FNode("FRAME"),
    createText: () => new FNode("TEXT"),
    createNodeFromSvg: (svg: string) => {
      if (!/<svg[\s>]/.test(svg)) throw new Error("not an svg");
      const f = new FNode("FRAME");
      const w = /width="([\d.]+)"/.exec(svg);
      const h = /height="([\d.]+)"/.exec(svg);
      f.width = w ? parseFloat(w[1]) : 100;
      f.height = h ? parseFloat(h[1]) : 100;
      f.children = [new FNode("VECTOR")];
      return f;
    },
    createImage: (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("createImage needs non-empty bytes");
      const hash = `img${images.size}`;
      images.set(hash, bytes);
      return { hash };
    },
    getImageByHash: (hash: string) =>
      images.has(hash)
        ? {
            hash,
            getSizeAsync: async () => ({ width: 1, height: 1 }),
            getBytesAsync: async () => {
              warmed.add(hash);
              return images.get(hash)!;
            },
          }
        : null,
    createSlide: (row?: number, col?: number) => {
      const s = new FNode("SLIDE");
      s.width = 1920;
      s.height = 1080;
      s.parent = new FNode("SLIDE_ROW");
      if (row === undefined) {
        if (!grid.length) grid.push([]);
        grid[grid.length - 1].push(s);
      } else {
        if (!grid[row]) throw new Error(`no row ${row}`);
        if (col === undefined || col < 0 || col > grid[row].length) throw new Error(`bad col ${col}`);
        grid[row].splice(col, 0, s);
      }
      return s;
    },
    currentPage: { findAllWithCriteria: (c: { types: string[] }) => grid.flat().filter((s) => !s.removed && c.types.includes(s.type)) },
    getCanvasGrid: () => grid.map((r) => r.filter((s) => !s.removed)),
    getSlideGrid: () => grid.map((r) => r.filter((s) => !s.removed)),
    setCanvasGrid: (rows: any[][]) => {
      const live = grid.flat().filter((s) => !s.removed);
      const given = rows.flat();
      if (given.length !== live.length || !live.every((s) => given.includes(s))) throw new Error("setCanvasGrid must list every slide exactly once");
      grid.splice(0, grid.length, ...rows.map((r) => r.slice()));
    },
    listAvailableFontsAsync: async () => fontDefs.flatMap((d) => d.styles.map((style) => ({ fontName: { family: d.family, style } }))),
    getFontFamilyVariationAxes: (family: string) => {
      const d = famOf(family);
      if (!d) throw new Error(`unknown family ${family}`);
      return d.axes ?? null;
    },
    loadFontAsync: async (f: any) => {
      const d = famOf(f.family);
      if (!d) throw new Error(`font not available: ${f.family}`);
      if (f.style === undefined) { for (const s of d.styles) loaded.add(fk({ family: f.family, style: s })); return; }
      if (!d.styles.includes(f.style)) throw new Error(`style not available: ${fk(f)}`);
      loaded.add(fk(f));
    },
  };
  return { figma, violations, posted, loaded, images, warmed, notes, exports, grid };
}

