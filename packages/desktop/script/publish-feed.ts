#!/usr/bin/env bun
// Fork-only: publish desktop installers to the GitHub Releases auto-update feed
// (umbecanessa/opencode-updates). Packaging bakes the feed URL as
// .../releases/latest/download/, so every publish is a new release and the newest
// build is always what clients resolve. Requires authenticated gh for the feed repo.
//
// Usage: bun scripts/publish-feed.ts [--dir <dist>] [--repo <owner/name>] [--dry-run]

const repo = process.env.OPENCODE_FEED_REPO ?? "umbecanessa/opencode-updates"

const dir = process.argv.indexOf("--dir")

const dist = dir >= 0 ? process.argv[dir + 1] : new URL("../dist", import.meta.url).pathname.replace(/^\/(\w:\/)/, "$1")

const dryRun = process.argv.includes("--dry-run")

// The updater sets allowPrerelease = false, so a tag like 1.0.0-rc.1 is invisible to it.
const version = await manifestVersion(`${dist}/latest.yml`)

if (version === undefined) throw new Error(`${dist}/latest.yml not found; build the Windows installer first`)

if (version.includes("-"))
  throw new Error(`version ${version} is a semver prerelease, which the updater ignores; build with OPENCODE_BUILD_VERSION`)

// Windows and macOS installers are built on different machines; if their builds ran on
// different days the CalVer versions diverge and one manifest would clobber the other's.
for (const sibling of ["latest-mac.yml", "latest-linux.yml"]) {
  const other = await manifestVersion(`${dist}/${sibling}`)

  if (other !== undefined && other !== version)
    throw new Error(`${sibling} says ${other}, latest.yml says ${version}; rebuild the lagging platform`)
}

// The dmg is a fresh-install artifact, not an update artifact: macOS updates take the zip.
const files = [
  ...new Set([
    ...(await Array.fromAsync(new Bun.Glob("latest*.yml").scan({ cwd: dist, absolute: true }))),
    ...(await Array.fromAsync(new Bun.Glob("opencode-desktop-*.{exe,zip}").scan({ cwd: dist, absolute: true }))),
    ...(await Array.fromAsync(
      new Bun.Glob("opencode-desktop-*.{exe,zip}.blockmap").scan({ cwd: dist, absolute: true }),
    )),
  ]),
]

if (!files.length) throw new Error(`no feed artifacts found under ${dist}`)

for (const file of files.sort()) console.log(file.slice(dist.length + 1))

const tag = `v${version}`

const gh = (args: string[]) =>
  Bun.spawn(["gh", ...args, ...files.map((file) => file.slice(dist.length + 1))], {
    cwd: dist,
    stdout: "inherit",
    stderr: "inherit",
    env: dryRun ? { ...process.env, GH_PROMPT_DISABLED: "1" } : process.env,
  })

if (dryRun) {
  console.log(`dry-run: ${repo} release ${tag} <- ${files.length} files`)
  process.exit(0)
}

const exists = await Bun.spawn(["gh", "release", "view", tag, "--repo", repo], { stdout: "ignore" }).exited

// Replacing assets under an existing tag keeps release/latest resolving to this build;
// a fresh release would be cleaner, but a failed create after a partial upload must not
// strand the feed, so upload --clobber is the retry path.
const publish = exists
  ? await gh(["release", "upload", "--clobber", tag, "--repo", repo]).exited
  : await gh(["release", "create", tag, "--repo", repo, "--latest", "--title", tag]).exited

if (publish !== 0) throw new Error(`failed to publish ${repo} ${tag}`)

console.log(`published ${repo} ${tag} -> https://github.com/${repo}/releases/latest/download/`)

async function manifestVersion(file: string) {
  const text = await Bun.file(file).text()

  return text
    .split("\n")
    .find((line) => line.startsWith("version:"))
    ?.slice("version:".length)
    .trim()
}
