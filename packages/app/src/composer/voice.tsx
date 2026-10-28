import { createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Spinner } from "@opencode/ui/spinner"
import { Tooltip } from "@opencode/ui/tooltip"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { useI18n } from "@opencode/ui/context/i18n"
import { useCommand } from "@/shell/commands/command"
import { showToast } from "@/shell/notifications/toast"
import { useLanguage } from "@/runtime/i18n/language"

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } }
type RecognitionEvent = { resultIndex: number; results: { length: number; [index: number]: RecognitionResult } }
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionConstructor = new () => Recognition

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
}

type Transcriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string }>) & {
  dispose?: () => Promise<void>
}

// Electron has no Chromium speech service, so dictation there runs Whisper locally through
// transformers.js; browsers keep using the built-in SpeechRecognition. `opencode.voice.engine`
// in localStorage forces either one ("speech" | "whisper") and `opencode.voice.model` picks the model.
function preferredEngine(): "speech" | "whisper" {
  const forced = localStorage.getItem("opencode.voice.engine")
  if (forced === "speech" || forced === "whisper") return forced
  if (/Electron\//.test(navigator.userAgent)) return "whisper"
  return window.SpeechRecognition || window.webkitSpeechRecognition ? "speech" : "whisper"
}

// Multilingual models handle English just as well, so there is no reason to bias toward the
// English-only ".en" variants. `opencode.voice.model` overrides (see the dictation model dialog).
function whisperModel() {
  return localStorage.getItem("opencode.voice.model") || "onnx-community/whisper-large-v3-turbo"
}

// One Whisper pipeline lives for the whole renderer, not the button that loaded it. Composer
// buttons unmount when sessions switch or the composer enters shell mode, and disposing the
// graph on unmount would make the next dictation rebuild the WebGPU session from the cached
// weights. The pipeline therefore stays warm across sessions; only choosing a different model
// in the dialog replaces it. Weights themselves persist in the browser cache (transformers.js
// `useBrowserCache`), so a full app restart never re-downloads them.
const whisperCache: { model: string; pipeline?: Transcriber; loading?: Promise<Transcriber> } = { model: "" }

function loadWhisper(model: string, onProgress?: (percent: number) => void): Promise<Transcriber> {
  if (whisperCache.model === model && (whisperCache.pipeline || whisperCache.loading))
    return whisperCache.pipeline ? Promise.resolve(whisperCache.pipeline) : whisperCache.loading!
  whisperCache.model = model
  const loading = startWhisperLoad(model, onProgress)
  whisperCache.loading = loading
  // A failed load must not poison the cache; the next attempt retries from scratch.
  loading.catch(() => {
    if (whisperCache.loading !== loading) return
    whisperCache.loading = undefined
    whisperCache.model = ""
  })
  return loading
}

async function startWhisperLoad(model: string, onProgress?: (percent: number) => void): Promise<Transcriber> {
  const previous = whisperCache.pipeline
  whisperCache.pipeline = undefined
  // A model chosen in the dialog replaces the cached one; the old graph must be released first.
  await previous?.dispose?.()
  const { pipeline, env } = await import("@huggingface/transformers")
  env.allowLocalModels = false
  const loaded = (await pipeline("automatic-speech-recognition", model, {
    // Put the whole model (encoder AND the sequential decoder) on the GPU. Left on its own,
    // transformers.js runs the decoder on the main thread via WASM, which freezes the entire
    // window for the length of generation (seen in the desktop logs as "renderer unresponsive").
    device: "webgpu",
    // fp32 is the WebGPU default and its ~2.5 GB encoder buffer kills the renderer
    // ("Array buffer allocation failed"). Encoders are quantization-sensitive (per
    // transformers.js docs), and this GPU has shader-f16, so fp16 encoder + q4f16 decoder.
    dtype: { encoder_model: "fp16", decoder_model_merged: "q4f16" },
    progress_callback: (progress: { status?: string; progress?: number }) => {
      if (progress.status === "progress" && typeof progress.progress === "number") onProgress?.(progress.progress)
    },
  })) as unknown as Transcriber
  whisperCache.pipeline = loaded
  return loaded
}

// transformers.js cannot auto-detect spoken language (it is a TODO in the library) and silently
// forces English instead, so detection is implemented below as a single-token generation from a
// bare <|startoftranscript|>: the model's first output token is its language choice.
// `opencode.voice.language` holds "auto" (default) or an explicit whisper language code.
function savedLanguage() {
  return localStorage.getItem("opencode.voice.language") || "auto"
}

function fallbackLanguage() {
  return (navigator.language.slice(0, 2) || "en").toLowerCase()
}

function savedDeviceId() {
  return localStorage.getItem("opencode.voice.deviceId") ?? ""
}

function micConstraints(): MediaStreamConstraints {
  const id = savedDeviceId()
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

  return { audio: id ? { deviceId: { exact: id }, ...base } : base }
}

// Device labels only appear once some mic permission was granted; ask silently once to populate the list.
async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter((device) => device.kind === "audioinput")
  if (inputs.every((device) => !device.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((track) => track.stop())
      const named = await navigator.mediaDevices.enumerateDevices()
      return named.filter((device) => device.kind === "audioinput")
    } catch {
      return inputs
    }
  }

  return inputs
}

function DialogVoiceDevice() {
  const dialog = useDialog()
  const language = useLanguage()
  const [devices] = createResource(listMicrophones)
  const [current, setCurrent] = createStore({ id: savedDeviceId() })

  const choose = (id: string) => {
    if (id) localStorage.setItem("opencode.voice.deviceId", id)
    else localStorage.removeItem("opencode.voice.deviceId")
    setCurrent({ id })
    dialog.close()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("command.voice.device")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-1">
        <Show when={devices() && devices()!.length > 1}>
          <DeviceRow label="Default device" id="" current={current.id} onPick={choose} />
        </Show>
        <For each={devices()}>
          {(device) => (
            <DeviceRow
              label={device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
              id={device.deviceId}
              current={current.id}
              onPick={choose}
            />
          )}
        </For>
        <Show when={!devices.loading && devices() && devices()!.length === 0}>
          <div class="px-2 py-3 text-center text-[13px] opacity-60">{language.t("command.voice.device.none")}</div>
        </Show>
      </DialogBody>
    </Dialog>
  )
}

function DeviceRow(props: { label: string; id: string; current: string; onPick: (id: string) => void }) {
  return (
    <Button
      variant="ghost-muted"
      class="w-full justify-start"
      onClick={() => props.onPick(props.id)}
      icon={props.id === props.current ? "check" : undefined}
    >
      <span class="truncate">{props.label}</span>
    </Button>
  )
}

// Model names stay in English (proper names); the qualifier copy is translated.
function DialogVoiceModel() {
  const dialog = useDialog()
  const language = useLanguage()
  const models = [
    {
      id: "onnx-community/whisper-large-v3-turbo",
      name: "Whisper Large v3 Turbo",
      note: language.t("command.voice.model.turbo"),
    },
    { id: "Xenova/whisper-small", name: "Whisper Small", note: language.t("command.voice.model.small") },
    { id: "Xenova/whisper-base", name: "Whisper Base", note: language.t("command.voice.model.base") },
  ]
  const [current, setCurrent] = createStore({ id: whisperModel() })

  const choose = (id: string) => {
    localStorage.setItem("opencode.voice.model", id)
    setCurrent({ id })
    dialog.close()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("command.voice.model")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-1">
        <For each={models}>
          {(model) => (
            <Button variant="ghost-muted" class="h-auto w-full justify-start py-2" onClick={() => choose(model.id)}>
              <span class="flex w-full items-center gap-3">
                <span class="flex flex-col items-start">
                  <span class="font-medium">{model.name}</span>
                  <span class="text-[12px] opacity-60" style={{ "line-height": "var(--line-height-compact)" }}>
                    {model.note}
                  </span>
                </span>
                <Show when={model.id === current.id}>
                  <Icon name="check" class="ms-auto shrink-0" />
                </Show>
              </span>
            </Button>
          )}
        </For>
      </DialogBody>
    </Dialog>
  )
}

// Endonym labels are the language-picker convention and need no translation.
const dictationLanguages = [
  ["it", "Italiano"], ["en", "English"], ["tr", "Türkçe"], ["de", "Deutsch"], ["fr", "Français"],
  ["es", "Español"], ["pt", "Português"], ["nl", "Nederlands"], ["pl", "Polski"], ["ru", "Русский"],
  ["uk", "Українська"], ["ar", "العربية"], ["zh", "中文"], ["ja", "日本語"], ["ko", "한국어"],
  ["hi", "हिन्दी"], ["fa", "فارسی"], ["he", "עברית"], ["sv", "Svenska"], ["el", "Ελληνικά"],
  ["ro", "Română"], ["cs", "Čeština"],
]

function DialogVoiceLanguage() {
  const dialog = useDialog()
  const language = useLanguage()
  const [current, setCurrent] = createStore({ id: savedLanguage() })

  const choose = (id: string) => {
    if (id === "auto") localStorage.removeItem("opencode.voice.language")
    else localStorage.setItem("opencode.voice.language", id)
    setCurrent({ id })
    dialog.close()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("command.voice.language")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-1">
        <DeviceRow label={language.t("command.voice.language.auto")} id="auto" current={current.id} onPick={choose} />
        <For each={dictationLanguages}>
          {([code, label]) => <DeviceRow label={label} id={code} current={current.id} onPick={choose} />}
        </For>
      </DialogBody>
    </Dialog>
  )
}

export function ComposerVoiceButton(props: { editor: () => HTMLElement | undefined }) {
  const i18n = useI18n()
  const factory = window.SpeechRecognition ?? window.webkitSpeechRecognition
  const engine = preferredEngine()
  const dialog = useDialog()
  const [state, setState] = createStore({ phase: "idle" as "idle" | "recording" | "busy", note: "" })

  // Renderer console output is forwarded to the dev terminal by the desktop launcher.
  // The bridge stringifies objects as "[object Object]", so args are flattened to strings here.
  const debug = (...args: unknown[]) => {
    if (import.meta.env.DEV) console.log("[voice]", ...args.map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))))
  }
  const notify = (note: string, variant: "default" | "error" = "error", pickDevice = false) => {
    setState("note", note)
    showToast({
      title: note,
      variant,
      duration: 6000,
      actions: pickDevice
        ? [{ label: language.t("command.voice.device"), onClick: () => void dialog.show(() => <DialogVoiceDevice />) }]
        : undefined,
    })
  }

  let recognition: Recognition | undefined
  let restart: ReturnType<typeof setTimeout> | undefined
  let stream: MediaStream | undefined
  let recorder: MediaRecorder | undefined
  let chunks: Blob[] = []
  let transcriber: Transcriber | undefined
  let disposed = false
  // The interim text the button owns inside the editor; each new interim replaces it in place.
  let owned = ""

  const insert = (text: string) => {
    const el = props.editor()
    if (!el || !text) return
    el.focus()
    const selection = window.getSelection()
    if (owned && selection?.isCollapsed && selection.rangeCount && selection.anchorNode?.nodeType === Node.TEXT_NODE) {
      const caret = selection.getRangeAt(0)
      // The user may have typed or moved the caret; only splice when our text is exactly where we left it.
      if (caret.startOffset >= owned.length) {
        const probe = document.createRange()
        probe.setStart(caret.startContainer, caret.startOffset - owned.length)
        probe.setEnd(caret.startContainer, caret.startOffset)
        if (probe.toString() === owned) {
          selection.removeAllRanges()
          selection.addRange(probe)
          document.execCommand("insertText", false, text)
          return
        }
      }
    }
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.execCommand("insertText", false, text)
  }

  const commit = (text: string, final: boolean) => {
    insert(final ? `${text} ` : text)
    owned = final ? "" : text
  }

  const fail = (message: unknown) => {
    setState("phase", "idle")
    notify(i18n.t("ui.promptInput.voiceError", { message: String(message) }))
  }

  // --- Web Speech backend (browsers) ---

  const startSpeech = () => {
    if (!factory) return
    const recognitionInstance = new factory()
    recognition = recognitionInstance
    recognitionInstance.lang = navigator.language
    recognitionInstance.continuous = true
    recognitionInstance.interimResults = true
    recognitionInstance.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]
        if (!result) continue
        commit(result[0]!.transcript, result.isFinal)
      }
    }
    recognitionInstance.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return
      // A dead speech service (missing keys, offline) falls back to local Whisper instead of dying.
      if (event.error === "network" || event.error === "service-not-allowed") {
        setState("phase", "idle")
        startWhisper()

        return
      }
      setState({ phase: "idle", note: i18n.t("ui.promptInput.voiceError", { message: event.error }) })
    }
    recognitionInstance.onend = () => {
      // Chrome ends continuous recognition after silence; keep the session alive while the user is recording.
      if (state.phase !== "recording" || recognition !== recognitionInstance) return
      restart = setTimeout(() => {
        if (state.phase !== "recording" || recognition !== recognitionInstance) return
        try {
          recognitionInstance.start()
        } catch {
          // A restart race with the native session just ends the recording normally.
        }
      }, 300)
    }
    recognitionInstance.start()
    setState({ phase: "recording", note: "" })
  }

  const stopSpeech = () => {
    clearTimeout(restart)
    recognition?.stop()
    recognition = undefined
    owned = ""
  }

  // --- Local Whisper backend (Electron; any browser without a speech service) ---

  const loadTranscriber = async () => {
    transcriber = await loadWhisper(whisperModel(), (percent) =>
      setState("note", `${i18n.t("ui.promptInput.voiceModelLoading")} ${Math.round(percent)}%`),
    )
    return transcriber
  }

  const startWhisper = async () => {
    try {
      setState({ phase: "busy", note: i18n.t("ui.promptInput.voiceModelLoading") })
      await loadTranscriber()
      if (disposed) return
      try {
        stream = await navigator.mediaDevices.getUserMedia(micConstraints())
      } catch (error) {
        // A removed or renamed saved device falls back to the system default instead of failing.
        if (error instanceof OverconstrainedError && savedDeviceId()) {
          localStorage.removeItem("opencode.voice.deviceId")
          stream = await navigator.mediaDevices.getUserMedia(micConstraints())
        } else throw error
      }
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      chunks = []
      recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : {})
      const track = stream.getAudioTracks()[0]
      debug("capturing", { device: savedDeviceId() || "default", label: track?.label, muted: track?.muted, ...track?.getSettings() })
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      recorder.onstop = () => {
        stream?.getTracks().forEach((track) => track.stop())
        stream = undefined
        void transcribeRecorded()
      }
      recorder.start()
      setState({ phase: "recording", note: "" })
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      stream = undefined
      fail(error instanceof Error ? error.message : error)
    }
  }

  const transcribeRecorded = async () => {
    try {
      const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" })
      chunks = []
      debug("recorded", blob.size, "bytes", recorder?.mimeType ?? "audio/webm")
      if (!blob.size) {
        setState("phase", "idle")
        notify(i18n.t("ui.promptInput.voiceNoAudio"), "error", true)

        return
      }
      setState("phase", "busy")
      const audio = await decodeTo16k(blob)
      const peak = audio.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
      debug("decoded", Math.round(audio.length / 1600) / 10 + "s", "peak", peak.toFixed(4))
      if (audio.length < 1600) {
        setState("phase", "idle")
        notify(i18n.t("ui.promptInput.voiceNoAudio"), "error", true)

        return
      }
      // transformers.js has no language detection (TODO in the library) and a wrong language
      // token produces fluent-but-wrong text, so "auto" detects the language with a one-token
      // generation from bare <|startoftranscript|> before the real pass runs.
      const englishOnly = whisperModel().endsWith(".en")
      const source = savedLanguage()
      const language = englishOnly ? "" : source === "auto" ? await detectSpokenLanguage(audio) : source
      const options = {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(language ? { language, task: "transcribe" } : {}),
        // Dictation clips are short; cap the decode budget so a repetition loop ends in seconds
        // instead of grinding through the full 448-token ceiling under a stuck spinner.
        max_new_tokens: Math.min(448, Math.ceil(audio.length / 16000) * 15 + 32),
      }
      debug("transcribing", { language: language || "model default", source, maxNewTokens: options.max_new_tokens })
      let timer: ReturnType<typeof setTimeout> | undefined
      const startedAt = performance.now()
      try {
        const result = await Promise.race([
          transcriber!(audio, options),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Transcription timed out")), 120_000))),
        ])
        debug("transcribed in", Math.round(performance.now() - startedAt), "ms", JSON.stringify(result.text.slice(0, 80)))
        if (result.text.trim()) commit(result.text.trim(), true)
        else notify(i18n.t("ui.promptInput.voiceNoSpeech"), "default")
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : error)
    } finally {
      setState("phase", "idle")
    }
  }

  const decodeTo16k = async (blob: Blob) => {
    const context = new AudioContext()
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    debug("blob decoded", decoded.duration.toFixed(2) + "s", decoded.sampleRate + "hz", decoded.numberOfChannels + "ch")
    context.close()
    // The buffer source resamples into the context's rate, so the render length is simply duration x 16000.
    const target = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000)
    const source = target.createBufferSource()
    source.buffer = decoded
    source.connect(target.destination)
    source.start()
    return (await target.startRendering()).getChannelData(0)
  }

  // Whisper's first generated token after a bare <|startoftranscript|> is its own language pick;
  // reading it costs one encoder pass + one step, versus a wrong-language full pass.
  const detectSpokenLanguage = async (audio: Float32Array) => {
    try {
      const asr = transcriber as unknown as {
        processor: (a: Float32Array) => Promise<{ input_features: unknown }>
        model: {
          generation_config?: { decoder_start_token_id?: number; lang_to_id?: Record<string, number> }
          generate: (options: Record<string, unknown>) => Promise<ArrayLike<{ tolist: () => bigint[] }>>
        }
      }
      const { Tensor } = await import("@huggingface/transformers")
      const start = asr.model.generation_config?.decoder_start_token_id ?? 1
      const features = await asr.processor(audio)
      const output = await asr.model.generate({
        inputs: features.input_features,
        max_new_tokens: 1,
        decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(start)]), [1, 1]),
      })
      const last = Number(output[0].tolist().at(-1))
      const langToId = asr.model.generation_config?.lang_to_id ?? {}
      const token = Object.keys(langToId).find((key) => langToId[key] === last)
      debug("language detected", token ?? `token ${last}`)

      return token ? token.slice(2, -2) : fallbackLanguage()
    } catch (error) {
      debug("language detection failed", error instanceof Error ? error.message : String(error))

      return fallbackLanguage()
    }
  }

  const stopWhisper = () => {
    recorder?.stop()
    recorder = undefined
  }

  const start = () => {
    if (engine === "speech" && factory) startSpeech()
    else void startWhisper()
  }

  const stop = () => {
    if (recognition) stopSpeech()
    if (recorder) stopWhisper()
    setState({ phase: "idle", note: "" })
  }

  onCleanup(() => {
    disposed = true
    clearTimeout(restart)
    recognition?.abort()
    recorder?.stream.getTracks().forEach((track) => track.stop())
    // The shared Whisper pipeline intentionally survives this unmount (see whisperCache);
    // only the microphone and any live recognition belong to this button.
  })

  const tooltip = () => {
    if (state.note) return state.note
    if (state.phase === "busy") return i18n.t("ui.promptInput.voiceTranscribing")
    if (state.phase === "recording") return i18n.t("ui.promptInput.voiceStop")
    return i18n.t("ui.promptInput.voiceInput")
  }

  const icon = () => {
    if (state.phase === "busy") return <Spinner class="size-3.5" />
    if (state.phase === "recording") return <Icon name="stop" />
    return <Icon name="mic" />
  }

  const command = useCommand()
  const language = useLanguage()
  command.register("composer-voice", () => [
    {
      id: "prompt.voice.toggle",
      title: language.t("command.voice.toggle"),
      description: language.t("command.voice.toggle.description"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+v",
      editable: true,
      onSelect: () => (state.phase === "recording" ? stop() : state.phase === "idle" ? start() : undefined),
    },
    {
      id: "prompt.voice.device",
      title: language.t("command.voice.device"),
      description: language.t("command.voice.device.description"),
      category: language.t("command.category.session"),
      onSelect: () => void dialog.show(() => <DialogVoiceDevice />),
    },
    {
      id: "prompt.voice.model",
      title: language.t("command.voice.model"),
      description: language.t("command.voice.model.description"),
      category: language.t("command.category.session"),
      onSelect: () => void dialog.show(() => <DialogVoiceModel />),
    },
    {
      id: "prompt.voice.language",
      title: language.t("command.voice.language"),
      description: language.t("command.voice.language.description"),
      category: language.t("command.category.session"),
      onSelect: () => void dialog.show(() => <DialogVoiceLanguage />),
    },
  ])

  return (
    <Tooltip placement="top" inactive={state.phase === "idle"} value={tooltip()}>
      <IconButton
        data-action="composer-voice"
        type="button"
        disabled={state.phase === "busy"}
        variant={state.phase === "recording" ? "submit" : "ghost-muted"}
        icon={icon()}
        class="me-2 size-7 rounded-md p-[6px]"
        aria-label={
          state.phase === "recording" ? i18n.t("ui.promptInput.voiceStop") : i18n.t("ui.promptInput.voiceInput")
        }
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()

          if (state.phase === "recording") {
            stop()

            return
          }

          if (state.phase === "idle") start()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void dialog.show(() => <DialogVoiceDevice />)
        }}
      />
    </Tooltip>
  )
}
