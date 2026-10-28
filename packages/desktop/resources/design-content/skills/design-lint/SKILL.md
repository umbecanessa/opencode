---
name: design-lint
description: |
  Anti-slop lint loop for generated HTML artifacts (pages, decks, posters, emails).
  Run the bundled checker over any single-file HTML deliverable before presenting it,
  fix every P0 and P1 finding, and re-run until clean. Use after producing any
  artifact: text/html output, design-template result, or exported page.
---

# Design Lint

Mechanical anti-slop checks ported from OpenDesign's artifact linter. The script
is regex-based and dependency-free; run it with plain `node`.

## How to use

1. After creating an HTML artifact (file or the body of an `<artifact>` block), run:

   ```bash
   node scripts/lint.mjs <path-to-artifact.html>
   ```

   Relative to this skill's base directory. Multiple files can be passed at once.
   Output is one line per finding: `[P0] rule-id message — snippet`.

2. Fix EVERY P0 (hard blocks) and P1 (quality), then re-run. Repeat until exit
   code 0. Do not present the artifact while any P0 remains.

3. Do not "fix" findings by deleting the feature wholesale (e.g. removing all
   uppercase labels); apply the suggested direction: a different font, palette
   stop, letter-spacing, or real copy.

## The rules

- P0 color clichés: Tailwind violet/purple gradients, blue→cyan "trust" gradients,
  AI-default indigo accents outside legitimate `:root` token definitions.
- P0 structural tells: emoji as icons in headings/buttons, left-border accent
  cards, system-sans fonts on display type, invented metrics ("10× faster",
  "99.99% uptime"), filler copy (lorem ipsum, "feature one").
- P0 iframe breakage: `scrollIntoView` anywhere (breaks sandboxed previews).
- P1 craft: uppercase text without adequate letter-spacing, stock image CDNs,
  >12 raw hex values outside `:root`, `var(--accent)` used more than 6 times,
  3+ same-theme slides in a row, sections without anchors/labels.

Deck files additionally need every `.slide` tagged `light`/`dark`/`hero`
(`slide-theme` rule) — required by the deck preview conventions.
