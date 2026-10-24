---
name: design-figma
description: >-
  Convert a slide deck built in Claude Design (claude.ai/design/p/... link) into a fully
  editable Figma Slides file: native text in the deck's real fonts, editable shapes,
  gradients, images and effects (grain becomes Figma Noise, shadows/blur/blend modes
  native), same slide order. Use when the user asks to import, convert, move or rebuild
  a Claude Design deck in Figma or Figma Slides. Works for any deck and any locally
  installed font, through a local Figma desktop plugin the user runs once per session.
---

# design-figma

Claude Design deck → editable Figma Slides file. Every slide is rebuilt as native Figma
layers, then screenshotted and checked against the original, and the agent keeps fixing
until every slide has zero measurable difference. Read `PROGRESS.md` for the
live state and `docs/DECISIONS.md` (D-001..D-012) before changing anything: those rulings
are settled (local plugin, universal fonts, pinned line breaks, no rasters, native stretch,
zero difference as the goal without ever changing the design).

## Requirements

macOS with Xcode Command Line Tools, Bun, Google Chrome, Figma desktop, Claude in Chrome (for the archive
download), and the deck's fonts installed. README.md has the install (as a Claude Code plugin or a plain clone).

`${CLAUDE_SKILL_DIR}` below is this skill's own folder (Claude Code fills it in). An installed plugin lives under
a path that changes with each version: never write lasting state there, never hand that path to Figma.

## What the user has to do

Only two things, both in **Figma desktop** (the plugin cannot run in the browser):
1. Open or create a **Figma Slides** file. The slides are built into whichever file the
   plugin runs in, so say which file before they start.
2. Run the plugin: **⌥⌘P** (Plugins → Development → design-figma). First time only:
   Plugins → Development → Import plugin from manifest → the `manifest` path that
   `setup.ts` prints (normally `~/.design-figma/figma-plugin/manifest.json`).
   The window stays open and polls; no other clicks. **After any change to plugin code,
   they must close it and press ⌥⌘P again** (Figma loads code.js only at start).

Fonts come from the Mac: the deck's fonts must be installed locally. Missing fonts are
reported by the probe; tell the user which ones before building.

## Steps

Work in a scratch dir `W` (session scratchpad). All commands from `"${CLAUDE_SKILL_DIR}/scripts"`.

0. **Setup** (every conversion, a second when nothing changed): `bun setup.ts`. It installs
   the script dependencies if missing and syncs the Figma plugin to its fixed folder. Read
   its JSON: `firstRun: true` → the user imports the printed manifest once (step 2 above);
   `pluginChanged: true` → the skill was updated, the user must restart the plugin. On a
   machine's first run, also run `bun test` once; it must pass before converting.

1. **Get the deck archive.** Same route as the design-pdf skill (the request is the
   go-ahead for this one download): open the link in a new Chrome tab, Share →
   More formats and apps → Project HTML → **Project archive** → Export. Never
   "Standalone HTML". Confirm with `ls -lt ~/Downloads | head -3`.
2. **Unzip** into a fresh empty dir `W/deck`. The deck file is the `.dc.html` with the
   most slides (or the one `export/export-pdf.mjs` names).
3. **Extract** (about 1 min for 88 slides):
   ```
   bun extract.ts --deck "W/deck/<name>.dc.html" --out W/ir --ref W/ref
   ```
   Read `W/ir/extract-report.json`: `rasterList` must be empty (D-008). Any entry is a
   gap in the extractor to fix, not to accept.
4. **Start the bridge** (background): `bun serve.ts --ir W/ir --out W/out --port 4747`.
   Ask the user to open the plugin, then `curl -s localhost:4747/status` until
   "plugin last polled" is a few seconds.
5. **Probe** fonts and the file: `bun serve.ts enqueue --kind probe --port 4747`, then
   read `W/out/probe.json` (missing families, `similar` names, file layout).
6. **Build all slides**:
   ```
   bun serve.ts enqueue --kind build --slides all --remove-blank --port 4747
   ```
   (`--slides 0,16,26-28` for a subset, 0-based.) Wait for `last finished` in /status
   with `ok:true` (about 2 min for 88). Rebuilding replaces slides in place.
7. **Check order**: probe again; `layout.gridOrder` must be 0..N-1 with no gaps.
8. **Check fidelity**:
   ```
   bun check.ts --ir W/ir --ref W/ref --out W/out
   ```
   Nine named checks per slide: diff, text, lines, images, fills, geom, fonts, editable,
   effects. The diff check also gives a **score: the measurable difference** between the
   Figma slide and the original (0 = no difference the eye can measure; anti-aliasing and
   sub-pixel drift are already forgiven, so 0 is reachable and most slides land on it).
   The last line reads `N/M slides pass, Z/M at zero difference - DONE | NOT DONE`, and
   each slide that passes but scores above 0 prints an `OPEN` line with its score, worst
   32x32 region and heatmap path. Exit 0 only on DONE.
9. **Drive every slide to zero. Do not stop, and do not report the job finished, until
   check.ts prints DONE.** Passing the threshold is not the goal; 0 is. **Never change the
   design to chase 0** (no heavier text, no nudged colours, no altered reference renders).
   A slide may stay above 0 only as an accepted renderer-only residue: every node matches
   the IR and the leftover is how Chrome and Figma rasterise (D-012). Loop:
   1. Take the open slides, worst score first; group slides with the same worst region
      (the same cause repeats across slides, e.g. 080-083).
   2. For each, look at the reference and the shot side by side, then crop both at the
      worst region (`sips -c`) and Read them, plus the heatmap. Name the cause in one line.
   3. Fix the cause **generically** in the extractor (`extract-page.js`/`extract.ts`) or
      the plugin (`plugin/src`), never per deck or per slide (D-006). Add a test that goes
      red without the fix and prove it red.
   4. Re-extract only those slides (`extract.ts --slides 13,42`, 0-based) into a fresh dir,
      copy their IR json, assets and ref png over `W/ir` and `W/ref`.
   5. Plugin code changed? `bun run build:plugin && bun setup.ts` and ask the owner to restart the plugin
      (close it, ⌥⌘P). That is the only thing worth interrupting them for.
   6. Rebuild only those slides (`enqueue --kind build --slides 13,42`), re-run check.ts
      on the whole deck (a fix must not move another slide off 0), and go round again.
   7. When a slide's cause is renderer-only (all nine checks pass, the IR and report nodes
      match field for field, the difference sits on glyph edges), add it to
      `W/out/accepted.json`: `{"slide-043": {"score": 8.077, "reason": "..."}}` with the
      measured score as its ceiling and a one-line reason. Rising above the ceiling turns
      it OPEN again. List every accepted slide in the report.
   Ask the owner only when a fix needs a decision a ruling in DECISIONS.md does not cover
   (for example two ways to approximate something Figma cannot do). Record the ruling as
   the next D-number. Log every round in PROGRESS.md so the loop survives lost context.
10. **Report** to the user: file it went into, slide count, order verified, the DONE line,
   what each round fixed, every accepted renderer-only slide with its reason. Stop the bridge when done.

## Learnings (do not relearn these)

- **Real Figma rejects things its docs allow.** NOISE effects take no `blendMode`. When
  live Figma refuses something, teach `lib/mock-figma.ts` to refuse it too, then fix.
- **Stretched images** (object-fit fill at another aspect, or under a non-uniform CSS
  scale): IR scaleMode `STRETCH`, built as an image fill in Crop mode with the identity
  `imageTransform` (D-009). Verified live. FIT under a non-uniform scale shrinks its box to
  the drawn bitmap first.
- **Small light text on a dark ground never reaches 0.** Chrome on macOS thickens it, Figma
  does not; identical slides score 0.06-8 there (9 of 88 slides on the first real deck).
  Confirm the nodes match, then accept it (step 9.7). Do not touch the references or the
  text weight: the owner rejected that (D-011).
- **Grain**: `noise-calibration.json` is fitted against live Figma; do not hand-tune it.
- **Slide indices are 0-based everywhere** (`serve.ts`, `extract.ts`, `check.ts`
  `--slides`); file names are 1-based (`slide-014.json` is index 13). `serve.ts --slides`
  takes ranges (`0-87`) and refuses junk.
- **Plugin restarts**: Figma loads `code.js` only when the plugin starts. A change you
  built is not live until the owner restarts it; check `/status` shows a recent poll.
- **The file's own starter slide** is untagged and filled, so `--remove-blank` leaves it.
  Tell the owner to delete it; never delete untagged slides yourself.
- A rebuild replaces tagged slides in place; rebuilding one slide does not disturb order.

## Maintenance

- After editing `plugin/src/*.ts`: `bun run build:plugin`, then `bun setup.ts` (syncs the
  copy Figma loads), then the user restarts the plugin. After `plugin/ui-client.ts`: `bun run build-ui.ts`.
- Tests: `bun test` (all files), `bun check.ts --selftest`, `bun e2e-mock.ts` (real
  bridge + real plugin code on a strict mock Figma). All three run on the neutral sample
  deck in `scripts/fixtures/sample` (system fonts, every feature). After an extractor change
  that alters the IR, rebuild it with `bun fixtures/make-sample.ts`, then rerun the tests.
  Never point tests at a client deck or a session folder: they must pass on a fresh clone.
  The mock rejects what real Figma rejects; when real Figma refuses something new, teach
  the mock first.
- Grain: `noise-calibration.json` maps feTurbulence grain to Figma Noise, fitted once
  against real Figma (2026-10-24). Refit only if Figma's Noise rendering changes:
  `calibrate-noise.ts ir` → build slides 1000+ → `chrome` → `fit --write`, then
  `enqueue --kind remove --slides 1000,...` (deck slides below 1000 need `--force`).
- Cleanup: `enqueue --kind remove` deletes tagged slides only.
