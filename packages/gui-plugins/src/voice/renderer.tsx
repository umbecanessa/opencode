import { lazy, onCleanup, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { MenuItem, Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

/**
 * The voice inbox as a pinned side tab: pending notes from the Pocket recorder, with expandable
 * transcripts, speaker chips namable into voiceprints, and accept / remember / dismiss triage —
 * the desktop counterpart of the mobile triage screen.
 */
const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const VoicePanel = lazy(() => import("./panel"))
  // Compile the tab while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void VoicePanel.preload()))

  const tab: BuiltinPanelTab = {
    id: "main",
    get title() {
      return ctx.t("title")
    },
    label: () => (
      <div class="flex items-center gap-1.5">
        <Icon name="waveform" size="small" />
        <span>{ctx.t("title")}</span>
      </div>
    ),
    pinned: true,
  }

  // A stable array keeps the tab's trigger from remounting.
  const tabs: BuiltinPanelTab[] = [tab]

  // A launcher of the side panel's new tab view, after the todos card.
  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current()

    if (!session) return undefined

    return {
      menu: "session.panel",
      id: "voice",
      title: ctx.t("title"),
      icon: "waveform",
      order: 46,
      run: () => ctx.layout.open("voice:main", session),
    }
  })

  ctx.add(BuiltinPanel, {
    id: "main",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("title")
      },
      order: 46,
      kind: "menu",
      icon: "waveform",
    },
    // A pinned tab stays listed whatever the session's stored layout holds.
    list: () => tabs,
    render: (props) => (
      <Suspense fallback={<div class="min-h-0 flex-1" />}>
        <VoicePanel session={props.session} />
      </Suspense>
    ),
  })
}

export default setup
