const FILE_RE = /(?:[A-Za-z0-9_.\-~][A-Za-z0-9_.\-\\/]*[\\/])?[\w][\w.\-]*\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|jsx|css|html|py|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|sh|ps1|sql|csv|env|lock|toml)/g

export const extractFiles = (text: string): { text: string; file: boolean }[] => {
  const out: { text: string; file: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(FILE_RE)) {
    const i = match.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), file: false })
    out.push({ text: match[0], file: true })
    last = i + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), file: false })
  return out
}

export const joinPath = (a: string, b: string) => {
  const clean = b.replace(/^\.\/+/, "").replace(/\\/g, "/")
  if (/^[A-Za-z]:\//.test(clean) || clean.startsWith("/")) return clean
  return `${a.replace(/[\\/]+$/, "")}/${clean}`
}
