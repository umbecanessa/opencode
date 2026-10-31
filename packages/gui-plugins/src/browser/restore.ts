import { Browser } from "@opencode/plugin-browser/rpc"
import { Schema } from "effect"
import type { BuiltinMainStorage, MainStoreFrom } from "@opencode/plugin/gui/builtin"

const Stored = Schema.Struct({
  tabs: Schema.Array(
    Schema.Struct({
      id: Browser.TabID,
      url: Browser.Tab.fields.url,
      // The window scroll offset kept for the tab's next page, captured while its page is alive.
      // Absent means the top of the page; the fields arrived after these rows, so they stay optional.
      scrollX: Schema.optionalKey(Schema.Finite),
      scrollY: Schema.optionalKey(Schema.Finite),
      // The inner scrollers (overflow divs, virtualized lists) scrolled away from their origin,
      // addressed by the DOM path the page's capture script builds.
      scrollInner: Schema.optionalKey(
        Schema.Array(Schema.Struct({ p: Schema.String.check(Schema.isMaxLength(512)), x: Schema.Finite, y: Schema.Finite })),
      ),
    }),
  ),
  focusedTabID: Schema.NullOr(Browser.TabID),
})

type Stored = typeof Stored.Type

const empty: Stored = { tabs: [], focusedTabID: null }

/** Tab URLs and focus per `${server}\n${session}`, imported once from the desktop's own `opencode.browser.dat` rows. */
export function createBrowserRestoreStore(storage: BuiltinMainStorage) {
  const from = (key: string): MainStoreFrom => ({ state: ["opencode.browser.dat", key] })
  const open = (key: string) => storage.store(`restore:${key}`, { schema: Stored, initial: empty, from: from(key) })

  const stores = new Map<string, ReturnType<typeof open>>()

  const store = (key: string) => {
    const existing = stores.get(key)

    if (existing) return existing
    const created = open(key)
    stores.set(key, created)

    return created
  }

  return {
    load: (key: string) => store(key).value,
    save(key: string, state: Stored) {
      const target = store(key)

      const value = {
        tabs: state.tabs.map((tab) => {
          const stored = { id: tab.id, url: tab.url }

          if (tab.scrollX || tab.scrollY) {
            if (tab.scrollInner?.length)
              return { ...stored, scrollX: tab.scrollX ?? 0, scrollY: tab.scrollY ?? 0, scrollInner: tab.scrollInner }

            return { ...stored, scrollX: tab.scrollX ?? 0, scrollY: tab.scrollY ?? 0 }
          }

          return stored
        }),
        focusedTabID: state.focusedTabID,
      }

      if (JSON.stringify(target.value) !== JSON.stringify(value)) target.set(value)
    },
    // Also drops the unimported desktop row, as the pane's own close always did.
    remove(key: string) {
      storage.remove(`restore:${key}`, { from: from(key) })
      stores.delete(key)
    },
  }
}
