import { expect, test } from "bun:test"
import { cookieInfo, domainMatches, prunePlan } from "./cookies"

type Cookie = Parameters<typeof cookieInfo>[0]

const at = (name: string, fields: Partial<Cookie>): Cookie => ({
  name,
  value: "v",
  domain: "example.com",
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "no_restriction",
  session: false,
  hostOnly: false,
  ...fields,
})

const NOW = 1_800_000_000

test("domain matching covers the domain and its subdomains, not suffix lookalikes", () => {
  expect(domainMatches(at("a", { domain: "example.com" }), "example.com")).toBe(true)
  expect(domainMatches(at("a", { domain: ".example.com" }), "example.com")).toBe(true)
  expect(domainMatches(at("a", { domain: "app.example.com" }), "example.com")).toBe(true)
  expect(domainMatches(at("a", { domain: "EXAMPLE.COM" }), "example.com")).toBe(true)
  expect(domainMatches(at("a", { domain: "notexample.com" }), "example.com")).toBe(false)
  expect(domainMatches(at("a", { domain: "example.com" }), "sub.example.com")).toBe(false)
})

test("prune deletes expired cookies and those expiring before a cutoff, sparing the rest", () => {
  const cookies = [
    at("past", { expirationDate: NOW - 1 }),
    at("future", { expirationDate: NOW + 86_400 }),
    at("forever", {}),
  ]

  expect(prunePlan(cookies, NOW, {}).map((cookie) => cookie.name)).toEqual(["past"])
  expect(prunePlan(cookies, NOW, { olderThan: NOW + 86_400 }).map((cookie) => cookie.name)).toEqual([
    "past",
    "future",
  ])
  // An explicit expired: false with a cutoff still prunes by the cutoff alone.
  expect(prunePlan(cookies, NOW, { expired: false, olderThan: NOW + 1 }).map((cookie) => cookie.name)).toEqual(["past"])
  expect(prunePlan(cookies, NOW, { keepNames: ["past"] })).toEqual([])
})

test("the listing omits the value and the fields Chromium defaults", () => {
  expect(cookieInfo(at("session", { session: true, expirationDate: undefined, hostOnly: true }))).toEqual({
    name: "session",
    domain: "example.com",
    secure: true,
    sameSite: "no_restriction",
    session: true,
    hostOnly: true,
  })
  // Path "/" and sameSite "unspecified" are the defaults, so the listing leaves them out.
  expect(cookieInfo(at("root", { path: "/", sameSite: "unspecified", domain: "", secure: false }))).toEqual({
    name: "root",
  })
})
