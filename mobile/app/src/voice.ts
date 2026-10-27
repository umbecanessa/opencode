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
          setError(e.message || e.error)
        }),
      ]
      speech.start({
        lang: language,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        iosTaskHint: "dictation",
        requiresOnDeviceRecognition: speech.supportsOnDeviceRecognition(),
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
