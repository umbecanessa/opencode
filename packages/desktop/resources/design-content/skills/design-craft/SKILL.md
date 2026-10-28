---
name: design-craft
description: |
  Engineering-grade visual craft rules for anything with a UI: typography, color,
  anti-AI-slop, animation discipline, accessibility, states, RTL, forms. Load this
  whenever creating or reviewing frontend/design output, alongside any
  design-templated or brand-kit work.
---

# Design Craft

These are the craft references OpenDesign enforced via its `craft.requires`
mechanism, ported as plain files. Apply them to all design/UI output.

## How to use

Before producing or critiquing UI output, read the relevant references in
`references/` (relative to this skill's base directory):

- `anti-ai-slop.md` - the baseline: what screams "AI-generated". Always apply.
- `typography.md`, `typography-hierarchy.md`, `typography-hierarchy-editorial.md` - type selection and scale.
- `color.md` - palette discipline, contrast, accent budget.
- `animation-discipline.md` - when motion helps and when it screams.
- `accessibility-baseline.md`, `rtl-and-bidi.md`, `form-validation.md`, `state-coverage.md` - correctness floors.
- `laws-of-ux.md` - interaction heuristics.

Cross-host note: brand kits (DESIGN.md + tokens.css per brand) live at
`~/.config/opencode/design-systems/` - see the brand-kits skill.
