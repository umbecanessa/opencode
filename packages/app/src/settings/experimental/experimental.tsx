import { Component, Show, createMemo, createResource } from "solid-js"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerCtx } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { ModelsProvider, useModels } from "@/providers/models/models"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "@/settings/list"
import { useSettings } from "@/settings/model"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

export const experimentalSettingsAvailable = true

// Sentinels for the two modes that store nothing other than a marker in the
// config document. Unsetting the key restores the fork spawn default
// (SpawnModel.DEFAULT in core); the empty string selects each server's own
// default model. Both ends of the list, so the real models sit between them.
const FORK_DEFAULT = "\u0000fork"
const SERVER_DEFAULT = ""

export const SettingsExperimental: Component<{ server?: ServerConnection.Any }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.experimental")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t("settings.experimental.description")}
            </span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <div class="settings-section">
          <SettingsList>
            <Show when={props.server} keyed>
              {(server) => (
                <ModelsProvider>
                  <SpawnModelSetting server={server} />
                </ModelsProvider>
              )}
            </Show>
            <SettingsRow
              title={language.t("settings.experimental.row.newIcons.title")}
              description={language.t("settings.experimental.row.newIcons.description")}
            >
              <div data-action="settings-new-icons">
                <Switch
                  checked={settings.general.newIcons()}
                  onChange={(checked) => settings.general.setNewIcons(checked)}
                />
              </div>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.experimental.row.foldUserMessages.title")}
              description={language.t("settings.experimental.row.foldUserMessages.description")}
            >
              <div data-action="settings-fold-user-messages">
                <Switch
                  checked={settings.general.foldUserMessages()}
                  onChange={(checked) => settings.general.setFoldUserMessages(checked)}
                />
              </div>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.experimental.row.newQuestionUI.title")}
              description={language.t("settings.experimental.row.newQuestionUI.description")}
            >
              <div data-action="settings-new-question-ui">
                <Switch
                  checked={settings.general.newQuestionUI()}
                  onChange={(checked) => settings.general.setNewQuestionUI(checked)}
                  hideLabel
                >
                  {language.t("settings.experimental.row.newQuestionUI.title")}
                </Switch>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </>
  )
}

// Writes experimental.spawn_model into the server's highest-precedence global
// config document, the same path the shell setting uses. The spawn and
// subagent tools read it when choosing a model for sessions they create.
const SpawnModelSetting: Component<{ server: ServerConnection.Any }> = (props) => {
  const language = useLanguage()
  const serverCtx = useServerCtx(() => props.server)
  const models = useModels()

  const [state, actions] = createResource(
    () => ServerConnection.key(props.server),
    async () => {
      const entries = await serverCtx()
        .sdk.api.config.get()
        .catch(() => [])
      const boundary = entries.findIndex((entry) => entry.type === "directory")
      const global = boundary === -1 ? entries : entries.slice(0, boundary)
      return {
        spawnModel: global
          .flatMap((entry) => (entry.type === "document" ? (entry.info.experimental?.spawn_model ?? []) : []))
          .at(-1),
      }
    },
    { initialValue: { spawnModel: undefined as string | undefined } },
  )

  const options = createMemo(() => [
    { value: FORK_DEFAULT, label: language.t("settings.experimental.row.spawnModel.forkDefault") },
    { value: SERVER_DEFAULT, label: language.t("settings.experimental.row.spawnModel.serverDefault") },
    ...models.list().map((model) => ({
      value: `${model.provider.id}/${model.id}`,
      label: `${model.name} (${model.provider.name})`,
    })),
  ])

  const current = createMemo(() => {
    const configured = state.latest.spawnModel
    if (configured === undefined) return options()[0]
    return options().find((option) => option.value === configured) ?? { value: configured, label: configured }
  })

  const select = (value: string) => {
    const next = value === FORK_DEFAULT ? null : value
    if (next === (state.latest.spawnModel ?? null)) return
    const previous = state.latest
    actions.mutate({ spawnModel: next ?? undefined })
    void serverCtx()
      .sdk.api.experimental.config.update({ experimental: { spawn_model: next } })
      .catch((error) => {
        actions.mutate(previous)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : language.t("common.requestFailed"),
        })
      })
  }

  return (
    <SettingsRow
      title={language.t("settings.experimental.row.spawnModel.title")}
      description={language.t("settings.experimental.row.spawnModel.description")}
    >
      <div data-action="settings-spawn-model">
        <Select
          options={options()}
          current={current()}
          value={(option) => option.value}
          label={(option) => option.label}
          placement="bottom-end"
          gutter={6}
          onSelect={(option) => option && select(option.value)}
        />
      </div>
    </SettingsRow>
  )
}
