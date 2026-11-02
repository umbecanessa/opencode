import { createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import type { OpenCodeClient } from "@opencode/client/promise"
import { Memory } from "@opencode/schema/memory"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { Spinner } from "@opencode/ui/spinner"
import { showToast } from "@opencode/ui/toast"
import type definition from "./index"

interface Probe {
  state: "idle" | "checking" | "done" | "failed"
  reachable?: boolean
  models?: ReadonlyArray<{ id: string; embeddings: boolean }>
  sample?: { model: string; ok: boolean; error?: string }
  error?: string
}

/** Models the local picker lists; anything else stays typed in free-form. */
const LOCAL_MODELS = [
  { value: "xenova/bge-small-en-v1.5", label: "BGE Small (English, ~30 MB)" },
  { value: "xenova/bge-base-en-v1.5", label: "BGE Base (English, ~50 MB)" },
  { value: "xenova/nomic-embed-text-v1.5", label: "Nomic Embed (long context, ~120 MB)" },
]

/**
 * Where semantic recall gets its vectors: a remote OpenAI-compatible endpoint, an automatically
 * downloaded local model, both (remote preferred), or keyword-only. The choice is stored
 * server-side and machine-wide; projects can still pin it with `experimental.memory` config.
 */
export default function MemorySettings(props: { server: Accessor<{ client: OpenCodeClient } | undefined> }) {
  const ctx = usePlugin<typeof definition>()
  const [info, setInfo] = createSignal<Memory.EmbeddingInfo>()
  const [failed, setFailed] = createSignal("")
  const [probe, setProbe] = createSignal<Probe>({ state: "idle" })
  const [saving, setSaving] = createSignal(false)
  const [url, setUrl] = createSignal(info()?.url ?? "")
  const [localModel, setLocalModel] = createSignal(info()?.localModel ?? LOCAL_MODELS[0]!.value)

  const rpc = () => props.server()?.client.rpc(Memory.Definition)

  const refresh = () => {
    const client = rpc()

    if (client === undefined) return

    client
      .embedding({})
      .then((next) => {
        setInfo(next)
        setFailed("")
        setUrl(next.url ?? "")
        setLocalModel(next.localModel)
      })
      .catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)))
  }

  onMount(refresh)

  // While the local model downloads, the page polls so its progress bar moves without a reload.
  createKeyed(
    () => info()?.local.state === "downloading",
    (downloading) => {
      if (!downloading) return
      const timer = setInterval(refresh, 1500)
      onCleanup(() => clearInterval(timer))
    },
  )

  const save = (input: Memory.EmbeddingSettings, notice = true) => {
    const client = rpc()

    if (client === undefined) return
    setSaving(true)
    client
      .setEmbedding(input)
      .then((next) => {
        setInfo(next)
        setFailed("")

        if (notice) showToast({ variant: "success", title: ctx.t("settings.saved") })
      })
      .catch((cause: unknown) => showToast({ variant: "error", title: ctx.t("settings.error"), description: cause instanceof Error ? cause.message : String(cause) }))
      .finally(() => setSaving(false))
  }

  const check = () => {
    const client = rpc()

    if (client === undefined) return
    setProbe({ state: "checking" })
    client
      .checkEmbedding({ url: url() || undefined })
      .then((next) => setProbe({ state: "done", ...next }))
      .catch((cause: unknown) => setProbe({ state: "failed", error: cause instanceof Error ? cause.message : String(cause) }))
  }

  const modes = [
    { value: "auto", label: ctx.t("settings.mode.auto") },
    { value: "remote", label: ctx.t("settings.mode.remote") },
    { value: "local", label: ctx.t("settings.mode.local") },
    { value: "off", label: ctx.t("settings.mode.off") },
  ] satisfies ReadonlyArray<{ value: Memory.EmbeddingSettings["mode"]; label: string }>

  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <h2 class="text-14-regular font-medium text-v2-text-text-base">{ctx.t("settings.title")}</h2>
        <p class="text-12-regular text-v2-text-text-muted">{ctx.t("settings.description")}</p>
        <Show when={failed()}>
          <p class="text-12-regular text-v2-state-fg-danger">{failed()}</p>
        </Show>
      </div>
      <Show when={info() !== undefined}>
        <div class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-4">
            <div class="flex min-w-0 flex-col">
              <span class="text-12-regular font-medium text-v2-text-text-base">{ctx.t("settings.mode.title")}</span>
              <span class="text-12-regular text-v2-text-text-muted">{ctx.t("settings.mode.description")}</span>
            </div>
            <Select
              options={modes}
              current={modes.find((option) => option.value === info()?.mode)}
              value={(option) => option.value}
              label={(option) => option.label}
              placement="bottom-end"
              gutter={6}
              onSelect={(option) => option !== null && save({ mode: option.value }, false)}
            />
          </div>
          <Show when={info()?.mode === "remote" || info()?.mode === "auto"}>
            <div class="flex flex-col gap-2">
              <span class="text-12-regular font-medium text-v2-text-text-base">{ctx.t("settings.endpoint.title")}</span>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  spellcheck={false}
                  placeholder="http://192.168.1.20:8000/v1"
                  value={url()}
                  class="min-w-0 flex-1 rounded-md border-[0.5px] border-v2-border-border-muted bg-transparent px-2 py-1.5 text-12-regular text-v2-text-text-base outline-none focus:border-v2-border-border-base"
                  onInput={(event) => setUrl(event.currentTarget.value)}
                />
                <Button size="small" variant="outline" onClick={check} disabled={probe().state === "checking"}>
                  <Show when={probe().state === "checking"} fallback={ctx.t("settings.check")}>
                    <Spinner class="size-3" />
                  </Show>
                </Button>
              </div>
              <Show when={probe().state === "done" || probe().state === "failed"}>
                <div class="flex flex-col gap-1 rounded-md border-[0.5px] border-v2-border-border-muted px-2 py-1.5">
                  <Show when={probe().state === "failed"}>
                    <span class="text-12-regular text-v2-state-fg-danger">{probe().error}</span>
                  </Show>
                  <Show when={probe().state === "done" && probe().reachable === false}>
                    <span class="text-12-regular text-v2-state-fg-danger">{ctx.t("settings.check.unreachable")}</span>
                  </Show>
                  <Show when={probe().state === "done" && probe().reachable === true}>
                    <span class="text-12-regular text-v2-text-text-base">{ctx.t("settings.check.reachable")}</span>
                    <For each={probe().models ?? []}>
                      {(model) => (
                        <div class="flex items-center justify-between gap-2">
                          <span class="min-w-0 truncate text-12-regular text-v2-text-text-muted">{model.id}</span>
                          <Show when={model.embeddings}>
                            <span class="shrink-0 text-[10px] uppercase tracking-wide text-v2-text-text-muted">{ctx.t("settings.check.embeddings")}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={probe().sample !== undefined}>
                      <span class="text-12-regular">
                        {probe().sample?.ok ? ctx.t("settings.check.embeds", { model: probe().sample?.model ?? "" }) : ctx.t("settings.check.noembeds", { model: probe().sample?.model ?? "" })}
                        <Show when={probe().sample?.error !== undefined}>
                          <span class="text-v2-text-text-muted"> ({probe().sample?.error})</span>
                        </Show>
                      </span>
                    </Show>
                    <Button size="small" variant="ghost" onClick={() => save({ mode: info()?.mode, url: url(), model: probe().sample?.model })}>
                      {ctx.t("settings.use")}
                    </Button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
          <Show when={info()?.mode === "local" || info()?.mode === "auto"}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between gap-4">
                <div class="flex min-w-0 flex-col">
                  <span class="text-12-regular font-medium text-v2-text-text-base">{ctx.t("settings.local.title")}</span>
                  <span class="text-12-regular text-v2-text-text-muted">{ctx.t("settings.local.description")}</span>
                </div>
                <Select
                  options={LOCAL_MODELS}
                  current={LOCAL_MODELS.find((option) => option.value === localModel())}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  placement="bottom-end"
                  gutter={6}
                  onSelect={(option) => option !== null && (setLocalModel(option.value), save({ localModel: option.value }, false))}
                />
              </div>
              <div class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
                <Show when={info()?.local.state === "ready"}>
                  <span class="size-1.5 rounded-full bg-v2-state-fg-success" />
                  <span>{ctx.t("settings.local.ready")}</span>
                </Show>
                <Show when={info()?.local.state === "downloading"}>
                  <Loader class="size-3" />
                  <span>
                    {ctx.t("settings.local.downloading")} {info()?.local.percent ?? 0}%
                  </span>
                </Show>
                <Show when={info()?.local.state === "failed"}>
                  <span class="text-v2-state-fg-danger">{ctx.t("settings.local.failed")}</span>
                  <Show when={info()?.local.error !== undefined}>
                    <span class="truncate text-v2-text-text-muted">{info()?.local.error}</span>
                  </Show>
                </Show>
                <Show when={info()?.local.state === "idle"}>
                  <span>{ctx.t("settings.local.idle")}</span>
                </Show>
              </div>
            </div>
          </Show>
          <div class="flex items-center justify-between gap-4 border-t-[0.5px] border-v2-border-border-muted pt-3">
            <span class="min-w-0 text-12-regular text-v2-text-text-muted">{ctx.t("settings.reset.description")}</span>
            <div class="flex shrink-0 items-center gap-2">
              <Show when={saving()}>
                <Spinner class="size-3 text-v2-text-text-muted" />
              </Show>
              <Button size="small" variant="ghost-muted" onClick={() => save({}, false)}>
                {ctx.t("settings.reset")}
              </Button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={info() === undefined && failed() === ""}>
        <div class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
          <Spinner class="size-3" /> {ctx.t("loading")}
        </div>
      </Show>
    </div>
  )
}
