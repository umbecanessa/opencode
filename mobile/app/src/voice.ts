import AsyncStorage from "@react-native-async-storage/async-storage"
import { requireOptionalNativeModule } from "expo"
import type { ExpoSpeechRecognitionNativeEventMap, ExpoSpeechRecognitionOptions } from "expo-speech-recognition"
import { useCallback, useEffect, useRef, useState } from "react"

type SpeechModule = {
  start(options: ExpoSpeechRecognitionOptions): void
  stop(): void
  abort(): void
  requestPermissionsAsync(): Promise<{ granted: boolean }>
  supportsOnDeviceRecognition(): boolean
  getSupportedLocales(options: { androidRecognitionServicePackage?: string }): Promise<{
    locales: string[]
    installedLocales: string[]
  }>
  addListener<K extends keyof ExpoSpeechRecognitionNativeEventMap>(
    event: K,
    listener: (event: ExpoSpeechRecognitionNativeEventMap[K]) => void,
  ): { remove(): void }
}

// Looked up optionally: importing expo-speech-recognition throws on builds that predate the native module.
const speech = requireOptionalNativeModule<SpeechModule>("ExpoSpeechRecognition")

const LANG_KEY = "voice.lang"
const deviceLocale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US"
export const voiceLanguages = [...new Set([deviceLocale, "en-US"])]

// The recognizer only accepts locales it ships. Regional variants like it-IT or en-IT are frequently absent
// even when the base language is installed, so fall back to a supported variant rather than fail.
let supportedLocales: Promise<string[]> = Promise.resolve([])
const loadLocales = () => {
  supportedLocales = speech
    ? speech
        .getSupportedLocales({})
        .then((r) => [...r.installedLocales, ...r.locales])
        .catch(() => [])
    : Promise.resolve([])
  return supportedLocales
}

const pickLocale = (preferred: string, supported: string[]) => {
  if (supported.length === 0) return preferred
  if (supported.includes(preferred)) return preferred
  const base = preferred.split("-")[0].toLowerCase()
  return supported.find((l) => l.split("-")[0].toLowerCase() === base) ?? (supported.includes("en-US") ? "en-US" : supported[0])
}

export const useDictation = (onText: (text: string) => void) => {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState("")
  const [lang, setLang] = useState(voiceLanguages[0])
  const base = useRef("")
  const subs = useRef<{ remove(): void }[]>([])
  const emit = useRef(onText)

  useEffect(() => {
    emit.current = onText
  }, [onText])

  useEffect(() => {
    AsyncStorage.getItem(LANG_KEY).then((v) => v && voiceLanguages.includes(v) && setLang(v))
    loadLocales()
    return () => {
      subs.current.forEach((s) => s.remove())
      speech?.abort()
    }
  }, [])

  const start = useCallback(
    async (current: string, language = lang) => {
      if (!speech) return
      setError("")
      const permission = await speech.requestPermissionsAsync()
      if (!permission.granted) {
        setError("Allow Microphone and Speech Recognition for OpenCode Mobile in Settings.")
        return
      }
      const locale = pickLocale(language, await supportedLocales)
      base.current = current.trim() ? `${current.trimEnd()} ` : ""
      subs.current.forEach((s) => s.remove())
      subs.current = [
        speech.addListener("start", () => setListening(true)),
        speech.addListener("end", () => setListening(false)),
        // iOS reports the whole utterance so far on each result, so replace rather than append.
        speech.addListener("result", (e) => {
          const text = e.results[0]?.transcript ?? ""
          emit.current(base.current + text)
        }),
        speech.addListener("error", (e) => {
          if (e.error === "aborted" || e.error === "no-speech") return
          if (e.error === "language-not-supported" || e.error === "service-not-allowed") {
            setError(`Dictation is not available for ${locale}. Try English from the language chip.`)
            return
          }
          setError(e.message || e.error)
        }),
      ]
      // Forcing on-device limits locales to the installed offline subset, which rejects many valid
      // regional locales; Apple's recognizer stays local for the dictation hint regardless.
      speech.start({
        lang: locale,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        iosTaskHint: "dictation",
        requiresOnDeviceRecognition: false,
      })
    },
    [lang],
  )

  const stop = useCallback(() => speech?.stop(), [])

  const switchLanguage = useCallback(
    (current: string) => {
      const next = voiceLanguages[(voiceLanguages.indexOf(lang) + 1) % voiceLanguages.length]
      setLang(next)
      AsyncStorage.setItem(LANG_KEY, next)
      if (!listening || !speech) return
      speech.abort()
      setTimeout(() => start(current, next), 250)
    },
    [lang, listening, start],
  )

  return { available: speech !== null, listening, error, lang, start, stop, switchLanguage }
}
