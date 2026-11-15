import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"

/**
 * Creation-time "Temporary session" switch for the new-session composer, seated in the
 * composer's right-hand action cluster immediately left of the mic so it reads as part of
 * that cluster instead of floating between them. The switch is a native button
 * (role="switch") in the mic/send button's 28px size class, driven entirely by the draft
 * tab's flag; this renders it and writes flips back, so the badge and the toggle can
 * never disagree.
 */
export function NewSessionTemporaryToggle(props: { temporary: () => boolean; onChange: (value: boolean) => void }) {
  const language = useLanguage()
  const on = () => props.temporary()

  return (
    <Tooltip
      placement="top"
      openDelay={800}
      value={
        <div class="flex flex-col gap-1 text-start">
          <span class="font-[530] text-v2-text-text-base">{language.t("session.new.temporary.toggle")}</span>
          <span class="font-[440] text-v2-text-text-muted">{language.t("command.session.newTemporary.description")}</span>
        </div>
      }
      contentClass="max-w-[280px]"
    >
      <IconButton
        data-action="composer-temporary"
        type="button"
        variant="ghost-muted"
        role="switch"
        aria-checked={on()}
        aria-label={language.t("session.new.temporary.toggle")}
        class="me-2 size-7 rounded-md"
        onClick={() => props.onChange(!on())}
        icon={<TemporarySwitchTrack on={on()} />}
      />
    </Tooltip>
  )
}

// The compact switch's 24x16 track and 12px thumb, drawn with the same tokens switch.css
// uses, so the pill matches every other switch in the app while sitting in an icon button.
function TemporarySwitchTrack(props: { on: boolean }) {
  return (
    <span
      class="inline-flex h-4 w-6 shrink-0 items-center rounded-[4px] p-[2px] transition-[background,box-shadow] duration-100 ease-out"
      style={{
        background: props.on
          ? "linear-gradient(180deg, var(--v2-alpha-light-0) 0%, var(--v2-alpha-light-10) 100%), var(--v2-background-bg-accent)"
          : "linear-gradient(180deg, var(--v2-alpha-light-0) 0%, var(--v2-alpha-light-20) 100%), var(--v2-background-bg-layer-04)",
        "box-shadow": props.on ? "var(--v2-elevation-switch-on)" : "var(--v2-elevation-switch-off)",
      }}
    >
      <span
        class="block size-3 rounded-[2px] border-[0.5px] shadow-[var(--v2-elevation-elements)] transition-transform duration-100 ease-out"
        style={{
          "border-color": "var(--v2-overlay-gradient-depth-overlay-depth-top)",
          background: `linear-gradient(180deg, var(--v2-overlay-gradient-depth-overlay-depth-top) 0%, var(--v2-overlay-gradient-depth-overlay-depth-bot) 100%), var(--v2-grey-${props.on ? "300" : "200"})`,
        }}
        classList={{ "translate-x-2 rtl:-translate-x-2": props.on }}
      />
    </span>
  )
}
