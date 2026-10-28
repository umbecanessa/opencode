---
name: brand-kits
description: |
  Apply a brand's visual system (Apple, Stripe, Linear, Vercel, Claude, Notion, and
  ~14 more) when designing UI, decks, posters, or prototypes that should look like a
  specific company or a named style (brutalism, glassmorphism, editorial...). Use
  whenever the user names a brand or design vibe.
---

# Brand Kits

Local brand kits live in `~/.config/opencode/design-systems/` (on this
machine's opencode config home; on other hosts the same path). Each kit:

- `DESIGN.md` - the 9-section brand contract: voice, color, typography, layout,
  components, motion, imagery, anti-patterns.
- `tokens.css` - CSS custom properties; the machine-readable form of DESIGN.md.
- `design-tokens.json`, `manifest.json` - structured tokens/registry metadata.
- `components.html` (some kits) - reference component renderings.
- `_schema/` - the manifest schema.

## How to use

1. Pick the closest kit by directory name (`apple`, `stripe`, `linear-app`,
   `vercel`, `claude`, `cursor`, `arc`, `notion`, `figma`, `openai`,
   `opencode-ai`, `shadcn`, `github`, `raycast`, `warp`, `superhuman`,
   `brutalism`, `glassmorphism`, `editorial`, `minimal`). List the directory to
   discover more.
2. Read its `DESIGN.md` fully before writing any UI.
3. Paste `tokens.css` verbatim into the artifact as the token layer; reference
   tokens by var() instead of hard-coding values. Nonexistent tokens fail
   silently, so use only tokens present in the file.
4. Honor the anti-patterns section - it is the fastest fidelity win.
5. If no kit matches, say so and design from `design-craft` defaults instead;
   optionally write a new DESIGN.md for the requested brand.
