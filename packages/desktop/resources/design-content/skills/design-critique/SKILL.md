---
name: design-critique
description: |
  Self-critique gate for design output. Score any finished visual deliverable
  (page, deck, poster, dashboard, mobile screen) on five dimensions before
  presenting it, revise once if any dimension is weak, and report the verdict.
  Use after design-lint passes and before declaring design work done.
---

# Design Critique Gate

Mechanical lint (design-lint) catches tells; this catches *mediocrity*. Run the
gate on every design deliverable after the lint is clean, before presenting it
as final.

## The five dimensions

Score each 1–5. Be harsh; 5 means "would pass at a design review at a
top studio", not "looks fine for AI".

1. **Typography** — is there a deliberate display/body pairing with a real
   size/weight ratio? Or is everything one family at three sizes?
2. **Color** — one committed palette with a purposeful accent, or a default
   with leftovers? Check contrast at small text sizes.
3. **Layout** — asymmetry or rhythm with intent, alignment grid actually
   followed, generous margins; or centered stacks of equal-weight cards?
4. **Motion** — does movement serve hierarchy (page-in, hover, scroll reveal),
   or is it absent/everything-fades-in? One idea, executed precisely, wins.
5. **Polish** — the last 5%: favicon/title/meta, focus states, empty/loading
   states, hover affordances, consistent corner radii, real imagery.

## The gate

- Any dimension scoring ≤ 3: make ONE focused revision pass on the weakest
  dimension(s) — not a rewrite — then re-run design-lint (revisions re-introduce
  slop) and re-score.
- After one revision, ship it whatever the score, and state the weakest
  dimension honestly in the summary.
- Present the verdict as a compact single line, e.g.:
  `Critique: typo 4 · color 4 · layout 3→4 · motion 2→3 · polish 4 (revised: motion)`
- Never claim a score you didn't justify against the artifact's actual content;
  cite what you changed as evidence.

## Anti-gaming

- Adding decorative motion to raise "motion" on a cluttered layout is a downgrade
  of layout — score accordingly.
- Swapping a font without pairing intent does not raise typography.
- A deliverable that reuses its template's personality verbatim (no content-driven
  choices) caps at 3 on layout and polish.
