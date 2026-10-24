# design-figma: status

Read this first, then `docs/DECISIONS.md`. Log each session's work at the bottom, with absolute dates.

## Where it stands (2026-10-24)

- **Pipeline works end to end in real Figma.** First real deck (an 88-slide brand book): 88/88 built, order exact,
  0 rasters, all nine checks pass; 79 slides at zero measurable difference and 9 accepted renderer-only
  (small light-on-dark text, D-012).
- **Verified live in Figma:** native text in variable and static fonts, pinned line breaks, gradients, images,
  Noise (calibrated, `scripts/noise-calibration.json`), shadows, blend modes, masks, toned photos, tiled fills,
  stretched images (D-009).
- **Tests run anywhere** on the bundled neutral sample deck (`scripts/fixtures/sample`, system fonts only):
  `bun test` (173), `bun check.ts --selftest`, `bun e2e-mock.ts`.

## Open

- Rotated text is now anchored on its aligned edge (`placeRotated`, tested on the mock). Not yet seen in live
  Figma: the first deck with rotated text should confirm it.
- `BLUR_SCALE = 2` (CSS blur sigma to Figma blur radius) unverified live.
- Toned photos: Figma's greyscale weights vs CSS grayscale not measured (editable approximation is the ruling).
- `check.ts` does not compare an image's scaleMode (FILL vs STRETCH): add `scaleModes` to the report if a deck
  ever makes the difference visible.
- `ir-preview.ts` (a debugging tool, not part of the workflow) still loads two named fonts when given `--fonts`.

## Log

- 2026-10-24: made shareable. Tests, selftest and e2e moved off session-only fixtures onto the neutral sample deck
  (`fixtures/make-sample.ts`); found and fixed on the way: rotated text drift, e2e corruption targeting a slide
  that no longer existed (now guarded), test helpers that predated pinned breaks, groups and rotation. Client
  material removed; the first deck's full log stays local in `PROGRESS.local.md` (git-ignored).
