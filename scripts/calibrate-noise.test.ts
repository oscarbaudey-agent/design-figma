// Tests for scripts/calibrate-noise.ts: PNG codec, tile measuring, grain filter parsing, calibration slides, and the
// fit (with synthetic Figma/Chrome tiles whose best match is known). The fit tests are red-proven: see the
// "can fail" tests and the mutation notes in PROGRESS.md.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCalibration, cost, crop, decodePng, encodePng, extractGrainFilters, fit, FIELDS, grainFilterSvg, measure,
  parseGrainSpec, renderChrome, settingsGrid, sweepSpecs, TILE, type GrainSpec, type Img, type Manifest,
  monotoneSize,
} from "./calibrate-noise";

// The deck's own grain (units.js) next to a tritone filter that must not be taken for grain.
const TRITONE = `<filter id="t" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0"/><feComponentTransfer><feFuncR type="table" tableValues="0.1 0.9"/></feComponentTransfer></filter>`;
const DECK_GRAIN = `<filter id="\${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" result="t"/><feColorMatrix in="t" type="saturate" values="0" result="m"/><feComponentTransfer in="m" result="s"><feFuncR type="linear" slope=".5" intercept=".72"/><feFuncG type="linear" slope=".5" intercept=".72"/><feFuncB type="linear" slope=".5" intercept=".72"/></feComponentTransfer><feBlend in="SourceGraphic" in2="s" mode="multiply" result="b"/><feComposite in="b" in2="SourceGraphic" operator="in"/></filter>`;

// ---- synthetic tiles ---------------------------------------------------------------------------------------------
const hash = (x: number, y: number, seed: number) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hexN = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** A field gradient tile with blocky noise: cells of `cell` px, amplitude `amp` (0..1 of full scale), sign -1 dark / +1 light. */
function synthTile(field: { from: string; to: string }, w: number, h: number, cell: number, amp: number, sign: number, seed = 1): Img {
  const data = new Uint8Array(w * h * 4);
  const a = hexN(field.from), b = hexN(field.to);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const n = amp > 0 ? hash(Math.floor(x / cell), Math.floor(y / cell), seed) : 0;
      for (let c = 0; c < 3; c++) data[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(lerp(a[c]!, b[c]!, t) + sign * amp * n * 255)));
      data[(y * w + x) * 4 + 3] = 255;
    }
  return { w, h, data };
}
/** How the fake Figma renders a raw setting: amplitude alpha x density, blocks of noiseSize px. */
const figmaModel = (s: { noiseSize: number; density: number; alpha: number }) => ({ cell: Math.max(1, s.noiseSize), amp: s.alpha * s.density });

function fakeFigmaSlide(manifest: Manifest, slideIndex: number, model = figmaModel): Img {
  const img: Img = { w: 1920, h: 1080, data: new Uint8Array(1920 * 1080 * 4).fill(255) };
  const sl = manifest.slides.find((s) => s.index === slideIndex)!;
  const field = FIELDS.find((f) => f.name === sl.field)!;
  for (const t of manifest.tiles.filter((x) => x.slide === slideIndex)) {
    const m = t.setting ? model(t.setting) : { cell: 1, amp: 0 };
    const tile = synthTile(field, t.rect.w, t.rect.h, m.cell, m.amp, sl.color === "black" ? -1 : 1, t.id + 11);
    for (let r = 0; r < t.rect.h; r++) img.data.set(tile.data.subarray(r * t.rect.w * 4, (r + 1) * t.rect.w * 4), ((t.rect.y + r) * 1920 + t.rect.x) * 4);
  }
  return img;
}

const spec = (id: string, baseFrequency: number, amount: number): GrainSpec => ({ id, baseFrequency, octaves: 2, seed: 7, amount, bias: 0, blend: "multiply", monochrome: true });

// ---- tests -----------------------------------------------------------------------------------------------------
describe("png codec", () => {
  test("encode then decode returns the same pixels", () => {
    const img = synthTile(FIELDS[2]!, 40, 30, 3, 0.1, -1);
    const back = decodePng(encodePng(img));
    expect([back.w, back.h]).toEqual([40, 30]);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
  });
  test("crop takes the right pixels", () => {
    const img = synthTile(FIELDS[0]!, 40, 30, 1, 0.2, 1);
    const c = crop(img, 5, 7, 10, 4);
    expect(Array.from(c.data.subarray(0, 4))).toEqual(Array.from(img.data.subarray((7 * 40 + 5) * 4, (7 * 40 + 5) * 4 + 4)));
  });
});

describe("measure", () => {
  test("a smooth gradient has no noise: std and hf stay near zero", () => {
    const m = measure(synthTile(FIELDS[1]!, 150, 120, 1, 0, 1));
    expect(m.std).toBeLessThan(0.001); // 8-bit rounding of the gradient alone
    expect(m.hf).toBeLessThan(0.002);
  });
  test("noise raises std; bigger cells lower the neighbour difference at equal amplitude", () => {
    const fine = measure(synthTile(FIELDS[1]!, 150, 120, 1, 0.1, -1));
    const coarse = measure(synthTile(FIELDS[1]!, 150, 120, 4, 0.1, -1));
    expect(fine.std).toBeGreaterThan(0.02);
    expect(fine.hf).toBeGreaterThan(coarse.hf * 2);
  });
  test("darkening noise lowers the mean, lightening raises it", () => {
    const base = measure(synthTile(FIELDS[1]!, 150, 120, 1, 0, 1)).mean;
    expect(measure(synthTile(FIELDS[1]!, 150, 120, 2, 0.1, -1)).mean).toBeLessThan(base - 0.02);
    expect(measure(synthTile(FIELDS[0]!, 150, 120, 2, 0.1, 1)).mean).toBeGreaterThan(measure(synthTile(FIELDS[0]!, 150, 120, 2, 0, 1)).mean + 0.02);
  });
});

describe("grain filters", () => {
  test("extractGrainFilters keeps only the filter with feTurbulence", () => {
    const found = extractGrainFilters(`const f = \`${TRITONE}${DECK_GRAIN}\``);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("feTurbulence");
  });
  test("parseGrainSpec reads the deck's grain primitives", () => {
    const s = parseGrainSpec("deck", DECK_GRAIN);
    expect([s.baseFrequency, s.octaves, s.seed, s.amount, s.blend, s.monochrome]).toEqual([0.85, 2, 7, 0.5, "multiply", true]);
    expect(s.bias).toBeCloseTo(0.22, 6);
  });
  test("a synthesised filter parses back to the numbers it was written from", () => {
    for (const s of sweepSpecs()) {
      const back = parseGrainSpec(s.id, grainFilterSvg("x", s));
      expect([back.baseFrequency, back.octaves, back.seed, back.amount, back.blend, back.monochrome]).toEqual([s.baseFrequency, s.octaves, s.seed, s.amount, s.blend, s.monochrome]);
      expect(back.bias).toBeCloseTo(s.bias, 6);
    }
  });
});

describe("calibration slides", () => {
  const { slides, manifest } = buildCalibration();
  test("one slide per field and noise colour, indices from 1000", () => {
    expect(slides.map((s) => s.index)).toEqual([1000, 1001, 1002, 1003, 1004, 1005]);
    expect(manifest.slides.map((s) => `${s.field}/${s.color}`)).toEqual(["dark/black", "dark/white", "light/black", "light/white", "saturated/black", "saturated/white"]);
  });
  test("tile 0 is the bare field, the rest carry raw figmaNoise from the grid", () => {
    const grid = settingsGrid();
    for (const sl of slides) {
      expect(sl.nodes.length).toBe(grid.length + 1);
      expect(sl.nodes[0].figmaNoise).toBeUndefined();
      sl.nodes.slice(1).forEach((n: any, i: number) => {
        expect(n.figmaNoise.noiseSize).toBe(grid[i]!.noiseSize);
        expect(n.figmaNoise.density).toBe(grid[i]!.density);
        expect(n.figmaNoise.alpha).toBe(grid[i]!.alpha);
        expect(n.effects).toBeUndefined();
      });
    }
  });
  test("tiles stay on the slide and never overlap", () => {
    for (const sl of slides) {
      const r = sl.nodes.map((n: any) => n);
      for (const a of r) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(1920);
        expect(a.y + a.h).toBeLessThanOrEqual(1080);
      }
      for (let i = 0; i < r.length; i++)
        for (let j = i + 1; j < r.length; j++) {
          const a = r[i], b = r[j];
          expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
        }
    }
  });
});

describe("fit picks the Figma setting that matches the Chrome grain", () => {
  const { manifest } = buildCalibration();
  // Chrome grain for each spec, made with the same fake renderer as Figma but with a hidden "true" setting.
  const truth: { [spec: string]: { noiseSize: number; density: number; alpha: number } } = {
    fine: { noiseSize: 2, density: 0.5, alpha: 0.5 },
    coarse: { noiseSize: 4, density: 0.8, alpha: 1 },
  };
  const specs = [spec("fine", 0.85, 0.5), spec("coarse", 0.2, 0.8)];
  const figmaCache = new Map<number, Img>();
  const input = (figmaFn = (i: number) => (figmaCache.get(i) ?? (figmaCache.set(i, fakeFigmaSlide(manifest, i)), figmaCache.get(i)!))) => ({
    manifest, specs,
    chrome: (field: string, id: string): Img => {
      const f = FIELDS.find((x) => x.name === field)!;
      if (id === "base") return synthTile(f, TILE.w, TILE.h, 1, 0, 1);
      const m = figmaModel(truth[id]!);
      return synthTile(f, TILE.w, TILE.h, m.cell, m.amp, -1, 99);
    },
    figma: figmaFn,
  });

  test("the best tile per field is the one whose settings equal the hidden truth", () => {
    const res = fit(input());
    for (const r of res.perSpec) {
      expect(r.setting).toEqual(truth[r.spec]!);
      expect(r.color).toBe("black");
    }
    expect(res.perSpec.length).toBe(specs.length * FIELDS.length);
  });

  test("the tables map frequency -> size and amount -> density/alpha", () => {
    const { calibration } = fit(input());
    expect(calibration.status).toBe("calibrated");
    expect(calibration.size).toEqual([{ baseFrequency: 0.2, noiseSize: 4 }, { baseFrequency: 0.85, noiseSize: 2 }]);
    expect(calibration.strength).toEqual([{ amount: 0.5, density: 0.5, alpha: 0.5 }, { amount: 0.8, density: 0.8, alpha: 1 }]);
  });

  test("the size table never grows with frequency", () => {
    const rows = [{ baseFrequency: 0.2, noiseSize: 2 }, { baseFrequency: 0.5, noiseSize: 1 }, { baseFrequency: 0.85, noiseSize: 0.5 }, { baseFrequency: 1.5, noiseSize: 1 }];
    expect(monotoneSize(rows).map((r) => r.noiseSize)).toEqual([2, 1, 0.5, 0.5]);
    expect(monotoneSize([{ baseFrequency: 0.2, noiseSize: 1 }, { baseFrequency: 0.5, noiseSize: 3 }]).map((r) => r.noiseSize)).toEqual([1, 1]);
  });

  test("lightening Chrome grain picks the white-noise slides", () => {
    const inp = input();
    const light = { ...inp, chrome: (field: string, id: string) => {
      const f = FIELDS.find((x) => x.name === field)!;
      if (id === "base") return synthTile(f, TILE.w, TILE.h, 1, 0, 1);
      const m = figmaModel(truth[id]!);
      return synthTile(f, TILE.w, TILE.h, m.cell, m.amp, 1, 99);
    } };
    for (const r of fit(light).perSpec) { expect(r.color).toBe("white"); expect(r.setting).toEqual(truth[r.spec]!); }
  });

  // These two prove the fit can go wrong: feed it a Figma that does not respond to the setting, or a cost that ignores
  // the grain, and the answer must stop being the truth.
  test("can fail: a Figma that ignores the noise setting cannot reproduce the truth", () => {
    const flat = (i: number) => fakeFigmaSlide(manifest, i, () => ({ cell: 1, amp: 0 }));
    const res = fit(input(flat));
    expect(res.perSpec.some((r) => JSON.stringify(r.setting) !== JSON.stringify(truth[r.spec]))).toBe(true);
    expect(res.calibration.fit.meanCost).toBeGreaterThan(fit(input()).calibration.fit.meanCost + 1);
  });
  test("can fail: the cost separates a right tile from a wrong one", () => {
    const right = { shift: -0.05, std: 0.03, hf: 0.04 };
    expect(cost(right, right)).toBe(0);
    expect(cost({ ...right, std: 0.06 }, right)).toBeGreaterThan(1);
    expect(cost({ ...right, hf: 0.01 }, right)).toBeGreaterThan(1);
    expect(cost({ ...right, shift: 0.05 }, right)).toBeGreaterThan(1);
  });
});

const haveChrome = existsSync("/Applications/Google Chrome.app");
if (!haveChrome) console.warn("calibrate-noise.test.ts: Google Chrome not found, the real-render test is skipped");
describe("headless Chrome reference", () => {
  (haveChrome ? test : test.skip)("the deck's own grain filter renders visible darkening grain; the bare field has none", async () => {
    const out = mkdtempSync(join(tmpdir(), "cal-"));
    const deck = parseGrainSpec("deck", DECK_GRAIN);
    await renderChrome(out, [deck, spec("none-sweep", 0.5, 0.5)], [FIELDS[1]!]);
    const read = (n: string) => decodePng(new Uint8Array(readFileSync(join(out, "chrome", n))));
    const base = measure(read("light__base.png"));
    const grain = measure(read("light__deck.png"));
    expect(grain.std).toBeGreaterThan(base.std * 3);
    expect(grain.hf).toBeGreaterThan(base.hf * 3);
    expect(grain.mean).toBeLessThan(base.mean);
  }, 60_000);
});
