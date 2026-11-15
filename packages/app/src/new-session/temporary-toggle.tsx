import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"

/**
 * Creation-time "Temporary session" switch for the new-session composer's model row.
 * The draft tab owns the flag; this renders it and writes flips back, so the badge and
 * the toggle can never disagree.
 */
export function NewSessionTemporaryToggle(props: { temporary: () => boolean; onChange: (value: boolean) => void }) {
  const language = useLanguage()

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
      <div class="flex h-7 shrink-0 items-center ps-1.5" data-action="composer-temporary">
        <Switch
          appearance="compact"
          checked={props.temporary()}
          onChange={props.onChange}
          class="cursor-pointer"
        >
          {language.t("session.new.temporary.toggle")}
        </Switch>
      </div>
    </Tooltip>
  )
}
