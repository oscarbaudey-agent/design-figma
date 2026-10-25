# design-figma

A Claude Code skill that turns a slide deck made in **Claude Design** into a fully editable **Figma Slides** file:
native text in the deck's own fonts with the same line breaks, editable shapes, gradients, images and effects
(grain becomes Figma Noise; shadows, blur, blend modes and masks stay native), in the same slide order. Every slide
is then screenshotted and compared with the original until there is no measurable difference.

## Requirements

- **macOS** (the image checks use Swift and `sips`) with Xcode Command Line Tools (`xcode-select --install`)
- [Claude Code](https://claude.com/claude-code)
- [Bun](https://bun.sh)
- **Google Chrome** (the deck is rendered in it)
- **Figma desktop app** (the plugin cannot run in the browser) and a Figma account that can create Slides files
- The deck's fonts installed on the Mac (the skill reports any that are missing before it builds)

## Install

**As a Claude Code plugin (recommended).** In Claude Code:

```
/plugin install design-figma --marketplace oscarbaudey-agent/design-figma
```

(Older Claude Code: `/plugin marketplace add oscarbaudey-agent/design-figma`, then `/plugin install design-figma@design-figma`.)
Updates: `/plugin`, Installed, design-figma, Update now (or turn on auto-update for the marketplace).

**Or ask Claude.** Paste this into Claude Code: *"Install the Claude Code plugin from
oscarbaudey-agent/design-figma and run its setup and tests."*

**Or as a plain skill (for working on it):**

```sh
git clone https://github.com/oscarbaudey-agent/design-figma ~/.claude/skills/design-figma
```

Use one or the other, not both.

**First run.** The skill runs `scripts/setup.ts` on every conversion. It installs its dependencies and copies the
Figma plugin to `~/.design-figma/figma-plugin`, a folder that never moves. Once, in Figma desktop:
**Plugins → Development → Import plugin from manifest…** and pick `~/.design-figma/figma-plugin/manifest.json`.

To check an install by hand (from the skill's `scripts` folder; all must pass):

```sh
bun setup.ts && bun test && bun check.ts --selftest && bun e2e-mock.ts
```

## Use

1. In Figma desktop, open (or create) the **Figma Slides** file the slides should go into.
2. Run the plugin: **⌥⌘P** (Plugins → Development → design-figma). Leave its window open.
3. In Claude Code, paste the Claude Design link and ask for it in Figma, or type `/design-figma <link>`.

Claude runs the setup, downloads the deck's project archive through Claude in Chrome, extracts every slide, builds them in your
file, and keeps checking and fixing until every slide matches. It tells you if it needs the plugin restarted.

## How it works

`SKILL.md` is the procedure Claude follows. `docs/DECISIONS.md` holds the design rulings (editable over pixel-exact,
no rasters, pinned line breaks, zero difference without changing the design). `PROGRESS.md` is the current state.

- `scripts/extract.ts` + `extract-page.js`: headless Chrome reads each slide into a JSON description (the IR) and
  takes a reference screenshot.
- `scripts/serve.ts`: a local bridge on port 4747 that hands slides to the plugin and collects reports and shots.
- `plugin/`: the Figma plugin that builds each slide natively and exports a screenshot.
- `scripts/check.ts`: nine checks per slide (pixels, text, line breaks, images, fills, geometry, fonts, editable,
  effects) and the measurable-difference score.
- `scripts/fixtures/sample`: a neutral five-slide deck the tests run on (`bun fixtures/make-sample.ts` rebuilds it).

## License

MIT. See `LICENSE`.
