import { expect, test } from "bun:test";
import { pickStyle, styleWidth } from "./lib/figma-map";

// Width cuts named in the style, for any family (D-006: no deck- or font-specific code).
const ACME = ["Regular", "Bold", "Bold Italic", "Condensed Regular", "Condensed Bold", "Extended Bold", "Extended Black"];
const DENIM = ["", "WD "].flatMap((wd) => ["Bold", "Light", "Regular"].flatMap((w) => [wd + w, wd + w + " Italic"]));

test("style names map to nominal widths", () => {
  expect(styleWidth("Regular")).toBe(100);
  expect(styleWidth("Condensed Bold")).toBe(75);
  expect(styleWidth("Extra Condensed Light")).toBe(62.5);
  expect(styleWidth("WD Bold")).toBe(125);
  expect(styleWidth("Extended Black")).toBe(125);
  expect(styleWidth("SemiBold")).toBe(100); // "Semi" alone is a weight, not a width
});

test("the picker matches width first, then weight, then italic", () => {
  expect(pickStyle(ACME, 700, false, null)).toBe("Bold");
  expect(pickStyle(ACME, 700, true, null)).toBe("Bold Italic");
  expect(pickStyle(ACME, 700, false, 75)).toBe("Condensed Bold");
  expect(pickStyle(ACME, 900, false, 150)).toBe("Extended Black");
  expect(pickStyle(ACME, 400, false, 125)).toBe("Extended Bold"); // nearest weight inside the wide cut
  expect(pickStyle(DENIM, 700, false, 150)).toBe("WD Bold");
  expect(pickStyle(DENIM, 300, true, 150)).toBe("WD Light Italic");
  expect(pickStyle(DENIM, 700, false, 100)).toBe("Bold");
  expect(pickStyle(["Book", "Heavy"], 800, false, 150)).toBe("Heavy"); // no width cuts: weight only
});
