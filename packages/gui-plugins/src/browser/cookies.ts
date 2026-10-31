import { Browser } from "@opencode/plugin-browser/rpc"
import electron from "electron"
import { Schema } from "effect"

/** Listings and exports are bounded so one cookie command cannot flood the tool result. */
const MAX_LISTED = 500

/**
 * The address a cookie is removed by: its domain without the leading dot, its path, and its scheme. An IPv6 host
 * needs its brackets in a URL.
 */
export function cookieURL(cookie: Electron.Cookie) {
  const domain = (cookie.domain ?? "").replace(/^\./, "")
  const host = domain.includes(":") && !domain.startsWith("[") ? `[${domain}]` : domain

  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`
}

/** Whether a cookie's scope covers the domain, its subdomains included. */
export function domainMatches(cookie: Electron.Cookie, domain: string) {
  const scope = (cookie.domain ?? "").replace(/^\./, "").toLowerCase()
  const want = domain.replace(/^\./, "").toLowerCase()

  return scope === want || scope.endsWith(`.${want}`)
}

/**
 * Cookies the prune rules delete: already-expired when `expired` applies (it defaults to on only when no
 * cutoff was given), or those expiring before `olderThan`. Cookies without an expiry cannot be judged by
 * age and are always kept. Names in `keepNames` are spared either way. `now` is Unix seconds.
 */
export function prunePlan(
  cookies: readonly Electron.Cookie[],
  now: number,
  rules: { expired?: boolean; olderThan?: number; keepNames?: readonly string[] },
) {
  const keep = new Set(rules.keepNames ?? [])
  const expired = rules.expired ?? rules.olderThan === undefined

  return cookies.filter(
    (cookie) =>
      !keep.has(cookie.name) &&
      cookie.expirationDate !== undefined &&
      ((expired && cookie.expirationDate <= now) ||
        (rules.olderThan !== undefined && cookie.expirationDate <= rules.olderThan)),
  )
}

/** The browser's report of a cookie without its value; for listings, where values stay in the jar. */
export function cookieInfo(cookie: Electron.Cookie): Browser.CookieInfo {
  const sameSite = cookie.sameSite === "unspecified" ? undefined : cookie.sameSite

  // CookieInfo's fields are all optional, and the filter keeps only defined values.
  // SAFETY: fromEntries yields exactly the CookieInfo fields whose value is defined; no field is renamed.
  return Object.fromEntries(
    Object.entries({
      name: cookie.name,
      domain: cookie.domain ? cookie.domain.replace(/^\./, "") : undefined,
      path: cookie.path && cookie.path !== "/" ? cookie.path : undefined,
      secure: cookie.secure ? true : undefined,
      httpOnly: cookie.httpOnly ? true : undefined,
      sameSite,
      expirationDate: cookie.expirationDate,
      session: cookie.session ? true : undefined,
      hostOnly: cookie.hostOnly ? true : undefined,
    }).filter(([, value]) => value !== undefined),
  ) as Browser.CookieInfo
}

const needsScope =
  "A cookie command needs url, domain, or both. Call browser.cookies.list({}) to see the domains the jar holds; do not guess one."

/** An http(s) address cookies are set against: the given URL, or the root of the given domain. */
function setURL(url?: string, domain?: string) {
  if (url) {
    const parsed = new URL(url)

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(
        "browser.cookies.set accepts an http(s) URL. Pass the site address the cookie belongs to, not another kind of address.",
      )

    return url
  }

  if (domain) return `https://${domain.replace(/^\./, "")}/`

  throw new Error(needsScope)
}

/** How a cookie command narrows the jar, read across the cookie actions' shared scope fields. */
function scopeOf(action: Browser.Action) {
  const url = "url" in action ? action.url : undefined

  return { url, domain: "domain" in action ? action.domain : undefined }
}

/** Runs one cookie command against a pane's persisted partition, tab-free: the jar is the session's. */
export async function runCookieCommand(partition: string, action: Browser.Action): Promise<Schema.Json> {
  const jar = electron.session.fromPartition(partition).cookies
  const scope = scopeOf(action)

  const matched = async () => {
    if (scope.url) return jar.get({ url: scope.url })

    const all = await jar.get({})
    const domain = scope.domain

    return domain ? all.filter((cookie) => domainMatches(cookie, domain)) : all
  }

  switch (action.type) {
    case "cookies.list": {
      const cookies = (await matched()).sort((a, b) =>
        `${a.domain ?? ""}\n${a.name}`.localeCompare(`${b.domain ?? ""}\n${b.name}`),
      )

      return { cookies: cookies.slice(0, MAX_LISTED).map(cookieInfo), total: cookies.length, truncated: cookies.length > MAX_LISTED }
    }

    case "cookies.get": {
      const found = (await matched()).find((item) => item.name === action.name)

      if (!found)
        throw new Error(
          `No cookie named ${JSON.stringify(action.name)} for this scope. Call browser.cookies.list({}) for this scope and use an exact name; do not invent one.`,
        )

      return { cookie: { ...cookieInfo(found), value: found.value } }
    }

    case "cookies.set": {
      await jar.set({
        url: setURL(action.url, action.domain),
        name: action.name,
        value: action.value,
        domain: action.domain?.replace(/^\./, ""),
        path: action.path,
        secure: action.secure,
        httpOnly: action.httpOnly,
        sameSite: action.sameSite,
        expirationDate: action.expires,
      })

      return { cookies: (await jar.get({})).length }
    }

    case "cookies.delete": {
      if (!scope.url && !scope.domain && !action.name) throw new Error(needsScope)
      const doomed = (await matched()).filter((item) => !action.name || item.name === action.name)
      await Promise.all(doomed.map(async (item) => jar.remove(cookieURL(item), item.name).catch(() => undefined)))

      return { removed: doomed.length }
    }

    case "cookies.prune": {
      const doomed = prunePlan(await matched(), Math.floor(Date.now() / 1_000), action)
      await Promise.all(doomed.map(async (item) => jar.remove(cookieURL(item), item.name).catch(() => undefined)))

      return { removed: doomed.length, remaining: (await jar.get({})).length }
    }

    case "cookies.export": {
      const cookies = await matched()

      return {
        cookies: cookies.slice(0, MAX_LISTED).map((item) => ({ ...cookieInfo(item), value: item.value })),
        total: cookies.length,
        truncated: cookies.length > MAX_LISTED,
      }
    }

    case "cookies.import": {
      let imported = 0

      for (const entry of action.cookies) {
        try {
          await jar.set({
            url: setURL(undefined, entry.domain),
            name: entry.name,
            value: entry.value,
            domain: entry.domain?.replace(/^\./, ""),
            path: entry.path,
            secure: entry.secure,
            httpOnly: entry.httpOnly,
            sameSite: entry.sameSite,
            expirationDate: entry.expirationDate,
          })

          imported++
        } catch {
          // A rejected entry is counted as failed, not fatal: an export can carry cookies this
          // Chromium refuses, such as one with an invalid domain.
        }
      }

      return { imported, failed: action.cookies.length - imported }
    }

    default:
      throw new Error(
        "This command was routed as a cookie operation but is not one. Report a desktop/plugin routing mismatch.",
      )
  }
}
