import Ionicons from "@expo/vector-icons/Ionicons"
import { useFocusEffect } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio"
import { LargeTitle } from "../src/components/LargeTitle"
import { useHosts } from "../src/state/hosts"
import { resolveDirectory } from "../src/state/pocket"
import { useTheme } from "../src/theme"

// A few seconds of clean speech is already enough for the ECAPA embeddings the
// voiceprint is built from; twenty seconds justifies itself when the room is noisy.
const TARGET_SECONDS = 20

type Speaker = { name: string; created?: number; source?: string }

export default function Voices() {
  const t = useTheme()
  const { hosts, client } = useHosts()
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [stale, setStale] = useState(false)
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [phase, setPhase] = useState<"idle" | "ready" | "recording" | "saved" | "saving">("idle")
  const clipUri = useRef<string | undefined>(undefined)
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)
  const state = useAudioRecorderState(recorder, 250)

  const triage = useCallback(() => {
    const host = hosts[0]
    const c = host ? client(host.id) : undefined
    if (!c) throw new Error("Pair a host first — voices are stored on the first paired machine.")
    return c
  }, [hosts, client])

  const load = useCallback(() => {
    triage()
      .voiceSpeakers()
      .then((list) => {
        setSpeakers(list)
        setStale(false)
      })
      .catch((e) => {
        // A 404 just means the host predates voiceprints; anything else is a real error.
        if (/\b404\b/.test(String(e))) setStale(true)
        else setError(String(e).slice(0, 140))
      })
  }, [triage])

  useFocusEffect(
    useCallback(() => {
      load()
      return () => {}
    }, [load]),
  )

  // Permission + audio mode are requested the moment the screen opens, so the
  // record button itself never dies on a permission race.
  useEffect(() => {
    AudioModule.requestRecordingPermissionsAsync()
      .then((status) => {
        if (!status.granted) setError("Allow microphone access to enroll a voice.")
        else {
          setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).then(() => setPhase("ready"))
        }
      })
      .catch(() => setPhase("ready"))
    return () => {
      if (recorder.isRecording) void recorder.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    setError("")
    clipUri.current = undefined
    try {
      await recorder.prepareToRecordAsync()
      // forDuration stops the recorder natively at the target, so the clip never
      // rambles on if the user forgets to come back to the button.
      recorder.record({ forDuration: TARGET_SECONDS })
      setPhase("recording")
    } catch (e) {
      setError(`Could not start recording: ${String(e).slice(0, 120)}`)
    }
  }

  // Reads the finalized clip whether the stop was manual or the native forDuration cutoff.
  const stop = async () => {
    try {
      if (recorder.isRecording) await recorder.stop()
      clipUri.current = recorder.uri ?? undefined
      setPhase(clipUri.current ? "saved" : "ready")
      if (!clipUri.current) setError("The recording came back empty — try again.")
    } catch (e) {
      setError(`Could not stop recording: ${String(e).slice(0, 120)}`)
      setPhase("ready")
    }
  }

  // The recorder state is polled at 250ms, so the countdown renders straight from it.
  const seconds = Math.floor((state.durationMillis ?? 0) / 1000)
  const recording = phase === "recording" && state.isRecording
  // After the native cutoff the clip is ready even though nobody pressed stop.
  const clipReady = phase === "saved" || (phase === "recording" && !state.isRecording)

  const save = async () => {
    const trimmed = name.trim()
    const clip = clipUri.current ?? recorder.uri ?? undefined
    if (!trimmed || !clip) return
    setPhase("saving")
    setError("")
    try {
      const c = triage()
      const { File } = await import("expo-file-system")
      const bytes = await new File(clip).bytes()
      const directory = await resolveDirectory(c)
      const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "voice"
      const audioPath = await c.fsWrite(directory, `voice/voices/${slug}-${Date.now().toString(36)}.m4a`, bytes)
      setSpeakers(await c.voiceEnroll({ name: trimmed, audioPath, source: "mobile" }))
      setName("")
      clipUri.current = undefined
      setPhase("ready")
    } catch (e) {
      setError(String(e).slice(0, 200))
      setPhase(clipUri.current ? "saved" : "ready")
    }
  }

  const remove = (speaker: string) =>
    Alert.alert(`Forget ${speaker}?`, "Future recordings will fall back to speaker numbers for them.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () =>
          triage()
            .voiceForget(speaker)
            .then(setSpeakers)
            .catch((e) => setError(String(e).slice(0, 140))),
      },
    ])

  const busy = phase === "saving"

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <LargeTitle title="Voices" subtitle="Speakers recognized by name" />

      {stale && (
        <Text style={[t.font.footnote, styles.note, { color: t.status.failed }]}>
          This host predates voiceprints — update the opencode server to use this screen.
        </Text>
      )}

      <View style={[styles.card, { backgroundColor: t.surface }]}>
        <Text style={[t.font.headline, { color: t.label, fontWeight: "600", marginBottom: 6 }]}>Enroll a voice</Text>
        <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
          Say a sentence or two near the phone — reading anything out loud works. About {TARGET_SECONDS} seconds is
          plenty.
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder="Who is this?"
          placeholderTextColor={t.tertiaryLabel}
          editable={!busy && !recording}
          style={[styles.input, { borderColor: t.separator, color: t.label, backgroundColor: t.background }]}
        />
        <View style={{ alignItems: "center", gap: 2 }}>
          {recording ? (
            <Pressable onPress={() => void stop()} style={({ pressed }) => [styles.button, { backgroundColor: t.status.failed, opacity: pressed ? 0.8 : 1 }]}>
              <Text style={[t.font.headline, { color: "#FFFFFF", fontWeight: "600" }]}>
                Stop · {seconds}s / {TARGET_SECONDS}s
              </Text>
            </Pressable>
          ) : (
            <Pressable
              disabled={busy || (!clipReady && !name.trim())}
              onPress={() => (clipReady ? void save() : void start())}
              style={({ pressed }) => [
                styles.button,
                {
                  backgroundColor: clipReady ? t.tint : t.fill.primary,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={[t.font.headline, { color: clipReady ? "#FFFFFF" : t.secondaryLabel, fontWeight: "600" }]}>
                  {clipReady ? "Save voice" : "Record sample"}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      </View>

      {!!speakers.length && (
        <View style={[styles.card, { backgroundColor: t.surface, marginTop: 16 }]}>
          <Text style={[t.font.headline, { color: t.label, fontWeight: "600", marginBottom: 6 }]}>Enrolled</Text>
          {speakers.map((speaker, i) => (
            <View key={speaker.name} style={[styles.row, { opacity: 1, paddingVertical: 8, borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0, borderTopColor: t.separator }]}>
              <Ionicons name="person-circle-outline" size={22} color={t.tint} />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={[t.font.body, { color: t.label }]} numberOfLines={1}>
                  {speaker.name}
                </Text>
                <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
                  {speaker.created ? new Date(speaker.created).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
                  {speaker.source ? `${speaker.created ? " · " : ""}${speaker.source}` : ""}
                </Text>
              </View>
              <Pressable disabled={busy} onPress={() => remove(speaker.name)} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
                <Ionicons name="trash-outline" size={18} color={t.tertiaryLabel} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {!!error && <Text style={[t.font.footnote, styles.note, { color: t.status.failed }]}>{error}</Text>}

      <Text style={[t.font.footnote, styles.note, { color: t.tertiaryLabel }]}>
        Enrolled voices replace “Speaker 1, 2, …” with real names in every new transcription — on any meeting where
        that person speaks.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 14, marginHorizontal: 16, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  note: { marginHorizontal: 20, marginTop: 12, lineHeight: 18 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  button: { borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12, alignItems: "center", alignSelf: "center", minWidth: 190, marginVertical: 4 },
})
