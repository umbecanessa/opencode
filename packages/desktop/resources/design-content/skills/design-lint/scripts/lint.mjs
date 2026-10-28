#!/usr/bin/env node
// Anti-slop artifact linter, ported from nexu-io/open-design apps/daemon/src/lint-artifact.ts
// (Apache-2.0). Regex-based, dependency-free. Usage: node lint.mjs <file.html>...
import { readFileSync } from "fs"

const PURPLE = ["#a855f7", "#9333ea", "#7c3aed", "#6d28d9", "#581c87", "#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe", "#ede9fe", "#6366f1", "#4f46e5", "#4338ca", "#3730a3", "#312e81", "#818cf8", "#a5b4fc", "#c7d2fe", "#e0e7ff", "#eef2ff"]
const BLUE = ["#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8", "#1e40af", "#f0f9ff", "#e0f2fe", "#bae6fd", "#7dd3fc", "#38bdf8", "#0ea5e9", "#0284c7", "#0369a1"]
const CYAN = ["#ecfeff", "#cffafe", "#a5f3fc", "#67e8f9", "#22d3ee", "#06b6d4", "#0891b2", "#0e7490"]
const AI_INDIGO = ["#6366f1", "#4f46e5", "#4338ca", "#3730a3", "#8b5cf6", "#7c3aed", "#a855f7"]
const EMOJIS = ["✨", "🚀", "🎯", "⚡", "🔥", "💡", "📈", "🎨", "🛡️", "🌟", "💪", "🎉", "👋", "🙌", "✅", "⭐", "🏆"]
const STOCK_HOSTS = ["images.unsplash.com", "placehold.co", "placekitten.com", "via.placeholder.com", "picsum.photos", "loremflickr.com"]

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error("usage: node lint.mjs <file.html>...")
  process.exit(2)
}

let total = 0
for (const file of files) {
  const findings = lint(readFileSync(file, "utf8"))
  const blocked = findings.filter((f) => f.sev !== "P2").length
  total += blocked
  const status = blocked ? "FAIL" : findings.length ? "clean (notes only)" : "clean"
  console.log(`${file}: ${status}`)
  for (const finding of findings) console.log(`  [${finding.sev}] ${finding.id} — ${finding.message}`)
}
process.exit(total > 0 ? 1 : 0)

function lint(raw) {
  const findings = []
  const report = (sev, id, message, snippet) => findings.push({ sev, id, message, snippet: clip(snippet) })
  const body = raw.replace(/<!--[\s\S]*?-->/g, "")
  const lower = body.toLowerCase()

  const gradients = [...lower.matchAll(/linear-gradient\(([^)]*)\)/g)].map((m) => m[1])
  const hexIn = (text, list) => list.some((hex) => text.includes(hex))
  const purpleHit = gradients.some((g) => hexIn(g, PURPLE))
  if (purpleHit || gradients.some((g) => /\b(purple|violet)\b/.test(g) && !hexIn(g, PURPLE)))
    report("P0", "purple-gradient", "AI-signature purple/violet gradient. Pick a palette with intent.", gradients[0])

  if (!purpleHit && gradients.some((g) => (hexIn(g, BLUE) || /\bblue\b/.test(g)) && (hexIn(g, CYAN) || /\bcyan\b/.test(g))))
    report("P0", "trust-gradient", "Blue→cyan 'generic SaaS trust' gradient. Choose a distinctive accent.", "")

  if (!purpleHit) {
    const outsideTokens = stripThemeTokenRules(body)
    const indigo = AI_INDIGO.find((hex) => outsideTokens.toLowerCase().includes(hex))
    if (indigo) report("P0", "ai-default-indigo", `AI-default indigo ${indigo} used outside token definitions.`, indigo)
  }

  const emojiTag = /<(h[1-6]\b[^>]*|button\b[^>]*|li\b[^>]*|span\b[^>]*class="[^"]*icon[^"]*"[^>]*)>([^<]*)/gi
  for (const m of body.matchAll(emojiTag))
    if (EMOJIS.some((emoji) => m[2].includes(emoji))) {
      report("P0", "emoji-icon", "Emoji used as iconography. Draw or inline a real icon.", m[0])
      break
    }

  if (/\.[a-z-]+\s*\{[^}]*border-left\s*:\s*\d+px\s+solid\s+[^;]+;[^}]*border-radius\s*:\s*[1-9]/i.test(body))
    report("P0", "left-accent-card", "Left-border-accent card — the default AI card. Rethink the card treatment.", "")

  if (/(h[123]|\.h-?(hero|xl|lg|md))[^{}]*\{[^}]*font-family\s*:\s*["']?(Inter|Roboto|Arial|-apple-system|system-ui|SF Pro)/i.test(body))
    report("P0", "sans-display", "Display type set to a system sans. Choose a distinctive display face.", "")

  const metric = /\b(10|100)\s?[×x]\s?(faster|better|easier)|99\.\d\s?% uptime|zero[- ]downtime|3\s?[×x]\s?more\s?(productive|efficient)/i.exec(body)
  if (metric) report("P0", "invented-metric", "Invented marketing metric. Use real numbers or drop the claim.", metric[0])

  const filler = /\bfeature (one|two|three|[123])\b|lorem ipsum|dolor sit amet|placeholder text|sample content/i.exec(body)
  if (filler) report("P0", "filler-copy", "Placeholder/filler copy left in the artifact. Write real copy.", filler[0])

  if (/\.scrollIntoView\s*\(/.test(body))
    report("P0", "scroll-into-view", "scrollIntoView hijacks the host page inside sandboxed previews. Scroll a container instead.", "")

  // uppercase without adequate tracking (rule-level approximation: same-block letter-spacing wins)
  let capsNotes = 0
  for (const rule of body.matchAll(/[^{}]*\{([^{}]*)\}/g)) {
    const decls = rule[1]
    if (!/text-transform\s*:\s*uppercase/i.test(decls)) continue
    const ls = [...decls.matchAll(/letter-spacing\s*:\s*([^;]+)/gi)].pop()
    const ok = ls && (/^\s*0?\.(0[6-9]|[1-9])\d*\s*(em)?\s*$/i.test(ls[1]) || /^\s*([1-9]\d*(\.\d+)?)(px|rem)\s*$/i.test(ls[1]))
    if (!ok && capsNotes++ < 3) report("P1", "all-caps-no-tracking", "Uppercase text needs letter-spacing ≥ 0.06em (or ≥ 1px).", clip(decls))
  }

  const stock = new RegExp(`<img[^>]+src=["']https?://(${STOCK_HOSTS.join("|")})`, "i").exec(body)
  if (stock) report("P1", "external-image", "Stock/placeholder image CDN. Use local assets, CSS, or SVG.", stock[0])

  const firstStyle = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(body)
  if (firstStyle) {
    const css = firstStyle[1].replace(/:root\s*\{[^}]*\}/gi, "")
    const hexCount = (css.match(/#[0-9a-f]{3,8}\b/gi) || []).length
    if (hexCount > 12) report("P1", "raw-hex", `${hexCount} raw hex values outside :root. Promote to tokens.`, "")
  }

  const inline = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
  const accentUses = (inline.match(/var\(--accent\)/g) || []).length
  if (accentUses > 6) report("P1", "accent-overuse", `${accentUses} uses of var(--accent); cap accent at ~2 visible moments per screen.`, "")

  const slideSections = [...body.matchAll(/<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/gi)].map((m) => m[0])
  if (slideSections.length > 0) {
    const themes = slideSections.map((tag) => {
      const cls = /\bclass="([^"]*)"/i.exec(tag)?.[1]?.toLowerCase() ?? ""
      if (/\bhero\b/.test(cls)) return /\bdark\b/.test(cls) ? "HD" : "HL"
      if (/\bdark\b/.test(cls)) return "D"
      if (/\blight\b/.test(cls)) return "L"
      return ""
    })
    if (themes.some((t) => t === ""))
      report("P0", "slide-theme-missing", "Every .slide section needs a light/dark/hero theme class.", "")
    const family = (t) => (t === "D" || t === "HD" ? "dark" : "light")
    for (let i = 2; i < themes.length; i++)
      if (themes[i] && themes[i - 1] && themes[i - 2] && family(themes[i]) === family(themes[i - 1]) && family(themes[i - 1]) === family(themes[i - 2])) {
        report("P1", "slide-rhythm", `3+ consecutive ${family(themes[i])}-theme slides. Alternate the rhythm.`, "")
        break
      }
  }

  let anchors = 0
  for (const section of body.matchAll(/<section\b([^>]*)>/gi)) {
    if (/\bclass="[^"]*\bslide\b/i.test(section[1])) continue
    if (!/\bid=|\baria-label=/i.test(section[1]) && anchors++ < 1)
      report("P2", "missing-section-anchor", "Sections should carry id or aria-label anchors.", "")
  }

  return findings
}

function stripThemeTokenRules(css) {
  return css.replace(/(^|})\s*([^{}]+)\{/g, (whole, lead, selectors) => {
    const legit = selectors
      .split(",")
      .every((s) => /^\s*(:root|html|body)(\[[^\]]*\])?\s*$/.test(s))
    return legit ? `${lead}__STRIPPED_{` : whole
  }).replace(/__STRIPPED_\{[^}]*\}/g, "")
}

function clip(text) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
}
