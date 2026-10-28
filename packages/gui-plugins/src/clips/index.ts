import { Plugin, Store } from "@opencode/plugin/gui"
import { builtinCatalog } from "@opencode/plugin/gui/builtin"
import { ClipList } from "./contract"
import en from "./i18n/en"

export default Plugin.define({
  stores: {
    // Pinned files: live references, so a clip follows its file and disappears with it.
    clips: Store.global(ClipList, { items: [] }),
  },
  i18n: builtinCatalog({
    en,
  }),
})
