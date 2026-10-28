export function preview(text: string, limit = 220): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " [code omitted] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/g, " ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ").trim()
  const chars = Array.from(plain)
  return chars.length > limit ? chars.slice(0, limit - 1).join("").trimEnd() + "…" : plain
}
