---
name: html-artifacts
description: |
  Emit single-file HTML deliverables (prototypes, decks, posters, one-page tools)
  as <artifact> blocks so the chat host renders them as live preview cards.
  Use when the deliverable IS the chat answer; for project code, write real
  files instead.
---

# HTML Artifacts in Chat

The chat host renders `<artifact>` blocks as cards with live sandboxed previews
and code views. This is the delivery format for one-off visual deliverables in
conversation — not a replacement for writing files in a project.

## When to use an artifact block

- Quick visual deliverables in chat: prototype page, deck, poster, invoice,
  carousel, social card, mobile mockup.
- Prefer writing a real file (plus a short pointer) when the HTML is part of a
  repo, is large (> ~100 KB), or the user will iterate on it repeatedly.

## The block format

Emit at top level of your reply (not inside a code fence):

```
<artifact identifier="pricing-page" type="text/html" title="Pricing — Acme">
<!doctype html>
<html>...complete, self-contained document...</html>
</artifact>
```

- `type` is the MIME (`text/html` for pages). `title` shows on the card.
  `identifier` is a short slug.
- The body is the ENTIRE artifact: inline all CSS/JS, no external assets
  beyond font CDN links. The preview is a sandboxed frame — no
  `scrollIntoView`, no same-origin assumptions, no cookies/storage reliance.
- One artifact per deliverable; prose before/after works normally around it.
- When *explaining* the protocol, wrap examples in code fences or inline code —
  tags inside those stay literal.

## Loop

Emit the artifact → run design-lint on the body → fix P0/P1 → re-emit the
corrected artifact (re-emit the whole block, don't describe the fix) → run the
design-critique gate → summarize in one line.
