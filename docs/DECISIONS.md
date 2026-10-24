# design-figma decisions

## D-001 Build a DOM-to-Figma converter, not a PowerPoint round-trip (owner, 2026-10-24)
Claude Design decks are rebuilt in Figma as native layers by reading the rendered slide in
headless Chrome (positions, styles, text runs, images, SVG) and recreating them through
Figma's `use_figma` plugin API. Chosen over testing Claude Design's PPTX export into Figma
Slides first: more control over fidelity, and editable text in the real brand fonts.

## D-002 Target Figma Slides first (owner, 2026-10-24)
Output is a Figma Slides file, one slide per deck section, starting with an 88-slide
brand book (the first real deck, a client project). A Design-file target can come later from the same extractor.

## D-003 Survives context loss via PROGRESS.md; tested by a scored screenshot diff (owner, 2026-10-24)
`PROGRESS.md` is updated after every step and is the first thing read on resume.
Each Figma slide is screenshotted and compared with the Chrome render of the same slide;
a mismatch score over a set limit fails the slide. The check must be proven red by
deliberately moving one element before it is trusted.

## D-004 Prove on 5 representative slides before the full deck (claude, 2026-10-24)
Cover (001), a colour page, a typography page, a photo template, a LinkedIn grid. Only
when all 5 pass the diff does the converter run on all 88.

## D-005 Text and images go in through a local Figma desktop plugin, not the Figma MCP (owner, 2026-10-24)
Research (docs/FIGMA_CONSTRAINTS.md) found `use_figma` runs on Figma's servers and can only
load fonts uploaded to Figma; Denim INK (trial) and Circular XX Mono are installed on this
Mac only. A development plugin running in Figma desktop should see local fonts, can call
figma.createImage directly, and works on any plan. The plugin interprets the IR itself (no
eval of generated code), fetches IR + images from a local Bun server, and posts back a node
report and a PNG export of each slide for the diff. The plugin window stays open and polls,
so rebuilds need no extra clicks. Rejected: uploading fonts to Figma (needs Org/Enterprise +
a full Denim INK licence), stand-in Google fonts (off-brand text).
The use_figma script builder (scripts/build.ts) is superseded; its pure mapping maths is kept.

## D-006 The converter is universal: any deck, any font (owner, 2026-10-24)
No deck- or font-specific code. Fonts resolve against whatever Figma lists on this Mac:
exact family name first, else the shortest local family that extends it (the first live probe
showed the IR's "Denim INK" is listed by Figma as "Denim INK TRIAL"). Width cuts named in the
style (Condensed, Narrow, Compressed, Wide, Extended, Expanded, WD...) are matched to the run's
`wdth` before weight, so a wide heading lands on "WD Bold" or "Extended Bold" in any family. A
probe with no family list asks about every family the deck's text uses. Unit tests use a made-up
family (Acme) as well as Denim. `scripts/fonts.json` belongs to the superseded build.ts and is
not used by the plugin.

## D-007 Pin the browser's line breaks in imported text (owner, 2026-10-24)
Figma sets the same text slightly wider than Chrome, so wrapped lines broke at different words
(first full 88-slide run: 17 slides failed the pixel diff, text/fills/geometry/fonts all passed).
The extractor records where Chrome actually broke each line and the plugin inserts soft line
breaks (U+2028, Figma's Shift+Enter) there, so every line ends where it does in the deck. Trade-off
accepted: after editing, those breaks stay until removed. Rejected: widening boxes to fit Figma
(not guaranteed identical), pinning headings only.

## D-008 Everything in the Figma file stays editable: no rasterised effects (owner, 2026-10-24)
Rasterising grain fields (the first fix) was rejected: every element must be a native, editable
Figma layer. Effects map to Figma's own features, detected generically from computed CSS and SVG
filter primitives:
- grain (SVG feTurbulence noise) -> the element's own fill (e.g. editable gradient) + Figma NOISE
  effect, parameters fitted once by a calibration run in real Figma and stored for every deck;
- toned photos (SVG colour-matrix / component-transfer tritone or duotone) -> the original photo,
  untouched, with Figma image adjustments plus colour layers in blend modes. Editable approximation
  chosen over an exact baked-in tone (owner);
- box-shadow / drop-shadow -> DROP_SHADOW / INNER_SHADOW, blur -> LAYER_BLUR, backdrop-filter ->
  BACKGROUND_BLUR, mix-blend-mode -> layer blend mode, rotation/skew -> node rotation, tiled
  backgrounds -> TILE image fills, CSS masks -> Figma mask layers.
A raster is a last resort only, named "raster:<why>", and the checker fails any slide that has one.
D-007 (pinned line breaks) reconfirmed by the owner after the trade-off was explained.

## D-009 Stretched images are native image fills, not rasters (owner, 2026-10-24)
An image drawn distorted (object-fit fill at a different aspect, or under a non-uniform CSS scale)
becomes an IR scaleMode STRETCH, built in Figma as an image fill in Crop mode with the identity
transform, so the whole bitmap maps onto the box and stays an editable image layer. Chosen over
rasterising the distorted result (D-008). Verified live on the first real deck.

## D-010 The goal is zero measurable difference, and the agent keeps going until it gets there (owner, 2026-10-24)
Passing the diff threshold (score <= 9) is not "done". A conversion is finished only when every
slide passes all nine checks with diff score exactly 0. check.ts exits 0 only then (prints DONE)
and lists every other slide as OPEN with its worst region. The skill loops: diagnose the open
slides, fix the cause generically, rebuild those slides, recheck the whole deck, until DONE.
`--allow-diff` keeps the old rule for diagnostics only.

## D-011 REJECTED: reference renders with grayscale anti-aliasing (owner, 2026-10-24)
Owner reverted it: the reference is the deck as Chrome draws it and the design must not change to reach 0.
Original proposal, kept for the record:
After D-010, 9 slides still scored above 0. All of them had the same cause: small light text on a dark
ground. The IR and the Figma nodes were identical (same font, size, colour, position); Chrome on macOS
thickens light-on-dark glyphs (font dilation) and Figma's renderer does not. extract.ts now renders the
references with `-webkit-font-smoothing: antialiased`, so the diff measures what was built rather
than how the two programs draw text. It changes no layout and no IR (re-extracted deck: only the D-009
STRETCH changes). With it all 88 slides score 0. The diff and check selftests still go red on the new
references. Alternatives rejected: heavier Figma text (falsifies the design), a looser diff (blinds the check).

## D-012 Zero is the goal, never at the cost of the design (owner, 2026-10-24)
Revises D-010, which the owner judged too strict. The agent still loops until check.ts prints DONE,
but nothing in the design, the IR or the reference renders changes to chase 0. A slide may stay above 0
only as a renderer-only residue: all nine checks pass, its nodes match the IR, and the leftover is how
Chrome and Figma rasterise (e.g. Chrome's macOS thickening of small light-on-dark text). Such slides go in
<out>/accepted.json with their measured score as a ceiling and a reason; check.ts counts them as done and
turns them OPEN again if the score ever rises above the ceiling. First real deck: 79 at 0, 9 accepted.
