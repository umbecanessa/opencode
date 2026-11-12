import Ionicons from "@expo/vector-icons/Ionicons"
import * as ExpoLinking from "expo-linking"
import { useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { LargeTitle } from "../src/components/LargeTitle"
import { usePocket } from "../src/state/pocket"
import { useTheme } from "../src/theme"

function actionInUrl(url: string) {
  return url.match(/[?&]action=(record|pull)/)?.[1]
}

// Pending cards carry the full note template; the transcript slice is what is worth reading.
// Whale-length transcripts are capped so one Text element cannot stall the list.
function transcriptOf(text: string) {
  const start = text.indexOf("Transcript:\n")
  if (start < 0) return text.slice(0, 4000)
  const end = text.indexOf("\n\nSegments:", start)
  return text.slice(start + "Transcript:\n".length, end < 0 ? undefined : end).slice(0, 4000)
}

function formatDuration(seconds: number) {
  return seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)}s`
}

export default function Pocket() {
  const t = useTheme()
  const pocket = usePocket()
  // Route-param and URL-event deliveries; the provider owns dedupe and also polls
  // the native App Intent's stashed action app-wide (see state/pocket.tsx).
  const params = useLocalSearchParams<{ action?: string }>()
  const [target, setTarget] = useState<string>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [pickerFor, setPickerFor] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [choices, setChoices] = useState<{ id: string; title?: string }[]>([])

  useEffect(() => {
    // Cold start or fresh navigation: params carry the action.
    pocket.runDeepAction(params.action)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.action])

  useEffect(() => {
    // Resume onto an already-mounted route: expo-router may see no param change at all.
    const sub = ExpoLinking.addEventListener("url", ({ url }) => pocket.runDeepAction(actionInUrl(url)))
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Transcribe jobs land a beat after uploads, so the pending list refreshes while
  // the screen is open; the provider already loaded it on mount.
  useEffect(() => {
    const timer = setInterval(() => pocket.loadPending(), 15_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A refused pairing needs the fallback card, whether or not the user opened it.
  const showHelp = helpOpen || pocket.needsKey

  const phaseLabel =
    pocket.progress?.phase === "connecting"
      ? "Connecting to the recorder…"
      : pocket.progress?.phase === "listing"
        ? "Reading recordings…"
        : pocket.progress?.phase === "downloading"
          ? `Downloading ${pocket.progress.done + 1} of ${pocket.progress.total}…`
          : pocket.progress?.phase === "uploading"
            ? `Shipping ${pocket.progress.done + 1} of ${pocket.progress.total} to the host…`
            : undefined

  const pair = (id: string, key?: string) => {
    const device = pocket.devices.find((d) => d.id === id)
    if (!device) return
    setTarget(id)
    pocket.pair(device, key).finally(() => setTarget(undefined))
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <LargeTitle title="Pocket" subtitle="Voice recorder capture" />

      {!pocket.device && (
        <View style={[styles.card, { backgroundColor: t.surface }]}>
          <View style={styles.row}>
            <View style={[styles.icon, { backgroundColor: t.fill.tertiary }]}>
              <Ionicons name="ear-outline" size={20} color={t.tint} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]}>{pocket.hasKey ? "Add a recorder" : "Pair a recorder"}</Text>
              <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
                Short-press the recorder to wake it and hold it close to the phone. Tap it below — pairing happens by
                itself.
              </Text>
            </View>
          </View>

          {pocket.devices.map((d) => {
            const pairingThis = pocket.pairing && target === d.id
            return (
              <Pressable
                key={d.id}
                disabled={pocket.pairing}
                onPress={() => pair(d.id, keyInput.length === 16 ? keyInput : undefined)}
                style={({ pressed }) => [styles.row, styles.device, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Ionicons name="ear-outline" size={20} color={t.tint} />
                <Text style={[t.font.body, { color: t.label, flex: 1 }]} numberOfLines={1}>
                  {d.name}
                </Text>
                {pairingThis ? (
                  <ActivityIndicator size="small" color={t.tint} />
                ) : (
                  <Ionicons name={pocket.pairing ? "lock-closed-outline" : "chevron-forward"} size={16} color={t.tertiaryLabel} />
                )}
              </Pressable>
            )
          })}

          <Pressable
            disabled={pocket.scanning || pocket.pairing}
            onPress={pocket.scan}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: pocket.scanning || pocket.pairing ? t.fill.primary : t.tint,
                opacity: pressed ? 0.8 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}
          >
            <Text style={[t.font.headline, { color: pocket.scanning || pocket.pairing ? t.secondaryLabel : "#FFFFFF", fontWeight: "600" }]}>
              {pocket.scanning ? "Scanning…" : pocket.devices.length ? "Scan again" : "Scan for recorders"}
            </Text>
          </Pressable>

          <Pressable onPress={() => setHelpOpen((v) => !v)} hitSlop={8} style={{ alignSelf: "center", paddingVertical: 4 }}>
            <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
              {showHelp ? "Hide help" : "Recorder already paired somewhere?"}
            </Text>
          </Pressable>

          {showHelp && (
            <View style={{ gap: 8, paddingVertical: 6 }}>
              <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
                Easiest: reset it — triple-click the side button (the LED blinks red), then press and hold until the
                blinking stops and the LED pulses blue. Then scan and tap it above.
              </Text>
              <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
                Or type the recorder&apos;s existing 16-character key below and tap the recorder.
              </Text>
              <TextInput
                value={keyInput}
                onChangeText={(v) => setKeyInput(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16))}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="Existing key (optional)"
                placeholderTextColor={t.tertiaryLabel}
                editable={!pocket.pairing}
                style={[styles.input, { borderColor: t.separator, color: t.label, backgroundColor: t.background }]}
              />
            </View>
          )}
        </View>
      )}

      {pocket.device && (
        <View style={[styles.card, { backgroundColor: t.surface }]}>
          <View style={styles.row}>
            <View style={[styles.icon, { backgroundColor: t.fill.tertiary }]}>
              <Ionicons name={pocket.recording ? "recording" : "mic-outline"} size={18} color={pocket.recording ? t.status.failed : t.tint} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]}>
                {pocket.recording ? "Recording…" : "Record remotely"}
              </Text>
              <Text style={[t.font.footnote, { color: t.tertiaryLabel }]} numberOfLines={2}>
                {pocket.recording
                  ? `On the device${pocket.recordingName ? ` · ${pocket.recordingName}` : ""} — closing this screen does not stop it.`
                  : "Starts the recorder without touching it. Stopping ships the recording straight to the host."}
              </Text>
            </View>
            {pocket.recBusy && <ActivityIndicator size="small" color={t.tint} />}
          </View>
          <Pressable
            disabled={pocket.recBusy || pocket.busy}
            onPress={pocket.recording ? pocket.stopRecording : pocket.startRecording}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: pocket.recBusy || pocket.busy ? t.fill.primary : pocket.recording ? t.status.failed : t.tint,
                opacity: pressed ? 0.8 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}
          >
            <Text style={[t.font.headline, { color: pocket.recBusy || pocket.busy ? t.secondaryLabel : "#FFFFFF", fontWeight: "600" }]}>
              {pocket.recBusy ? (pocket.recording ? "Stopping…" : "Starting…") : pocket.recording ? "Stop & ship" : "Start recording"}
            </Text>
          </Pressable>
        </View>
      )}

      {pocket.device && (
        <View style={[styles.card, { backgroundColor: t.surface, marginTop: 16 }]}>
          <View style={styles.row}>
            <View style={[styles.icon, { backgroundColor: t.fill.tertiary }]}>
              <Ionicons name="ear-outline" size={20} color={t.tint} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
                {pocket.device.name}
              </Text>
              {pocket.busy && phaseLabel && (
                <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
                  {phaseLabel}
                  {pocket.progress?.label ? ` · ${pocket.progress.label}` : ""}
                </Text>
              )}
            </View>
            <Pressable
              disabled={pocket.busy || pocket.scanning}
              onPress={() => {
                pocket.pick(undefined).then(() => pocket.scan())
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
              hitSlop={12}
            >
              <Ionicons name="refresh-outline" size={20} color={t.tertiaryLabel} />
            </Pressable>
          </View>
          <Pressable
            disabled={pocket.busy}
            onPress={pocket.pull}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: pocket.busy ? t.fill.primary : t.tint,
                opacity: pressed ? 0.8 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}
          >
            {pocket.busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={[t.font.headline, { color: "#FFFFFF", fontWeight: "600" }]}>Pull recordings</Text>
            )}
          </Pressable>
          <Text style={[t.font.footnote, { color: t.tertiaryLabel, textAlign: "center" }]}>
            Back Tap shortcut: opencode-mobile://pocket?action=record
          </Text>
        </View>
      )}

      {!!pocket.error && (
        <Text style={[t.font.footnote, styles.note, { color: t.status.failed }]}>{pocket.error}</Text>
      )}

      {pocket.pending.length > 0 && (
        <View style={[styles.card, { backgroundColor: t.surface, marginTop: 16 }]}>
          <Text style={[t.font.headline, { color: t.label, fontWeight: "600", marginBottom: 6 }]}>
            Pending notes
          </Text>
          {pocket.pending.map((card, i) => {
            const busy = pocket.pendingBusy === card.id
            const picking = pickerFor === card.id
            const open = expanded === card.id
            const stamp = card.recordedAt ?? card.created
            return (
              <View
                key={card.id}
                style={{
                  gap: 8,
                  paddingVertical: 10,
                  borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0,
                  borderTopColor: t.separator,
                }}
              >
                {/* The whole header is the expand affordance: summary in full, then the transcript. */}
                <Pressable onPress={() => setExpanded(open ? undefined : card.id)} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                    <Text style={[t.font.footnote, { color: t.label, flex: 1 }]} numberOfLines={open ? undefined : 2}>
                      {card.summary ?? card.title ?? "Voice note"}
                    </Text>
                    {!!card.text && (
                      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={13} color={t.tertiaryLabel} style={{ marginTop: 2 }} />
                    )}
                  </View>
                  <Text style={[t.font.footnote, { color: t.tertiaryLabel }]} numberOfLines={1}>
                    {stamp ? new Date(stamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Pending"}
                    {card.duration ? ` · ${formatDuration(card.duration)}` : ""}
                    {card.project ? ` · suggests ${card.project}` : ""}
                  </Text>
                </Pressable>
                {open && !!card.text && (
                  <Text style={[t.font.footnote, { color: t.secondaryLabel, lineHeight: 18 }]} numberOfLines={40}>
                    {transcriptOf(card.text)}
                  </Text>
                )}
                {picking ? (
                  <View style={{ gap: 2 }}>
                    {choices.map((s) => (
                      <Pressable
                        key={s.id}
                        disabled={busy}
                        onPress={() => pocket.acceptPending(card.id, s.id).then(() => setPickerFor(undefined))}
                        style={({ pressed }) => [styles.row, styles.device, styles.pickerRow, { opacity: pressed ? 0.6 : 1 }]}
                      >
                        <Ionicons name="chatbubble-outline" size={16} color={t.tint} />
                        <Text style={[t.font.footnote, { color: t.label, flex: 1 }]} numberOfLines={1}>
                          {s.title ?? s.id}
                        </Text>
                      </Pressable>
                    ))}
                    <Pressable onPress={() => setPickerFor(undefined)} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
                      <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable
                      disabled={busy}
                      onPress={() => {
                        setPickerFor(card.id)
                        pocket.listSessions().then(setChoices).catch(() => setChoices([]))
                      }}
                      style={({ pressed }) => [styles.pill, { borderColor: t.separator, opacity: pressed ? 0.6 : busy ? 0.4 : 1 }]}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={t.tint} />
                      ) : (
                        <Ionicons name="arrow-forward-circle-outline" size={15} color={t.tint} />
                      )}
                      <Text style={[t.font.footnote, { color: t.tint }]}>Add to session</Text>
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => pocket.rememberPending(card.id)}
                      style={({ pressed }) => [styles.pill, { borderColor: t.separator, opacity: pressed ? 0.6 : busy ? 0.4 : 1 }]}
                    >
                      <Ionicons name="bookmark-outline" size={15} color={t.tint} />
                      <Text style={[t.font.footnote, { color: t.tint }]}>Remember</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )
          })}
        </View>
      )}

      {pocket.recent.length > 0 && (
        <View style={[styles.card, { backgroundColor: t.surface, marginTop: 16 }]}>
          <Text style={[t.font.headline, { color: t.label, fontWeight: "600", marginBottom: 6 }]}>
            Recently shipped
          </Text>
          {pocket.recent.slice(0, 20).map((r) => (
            <View key={`${r.at}-${r.date}-${r.name}`} style={styles.row}>
              <Ionicons name="checkmark-circle-outline" size={18} color={t.status.running} />
              <Text style={[t.font.footnote, { color: t.label, flex: 1 }]} numberOfLines={1}>
                {r.date} · {r.name}
              </Text>
              <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>{Math.round(r.seconds)}s</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, borderRadius: 14, padding: 14, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  device: {
    borderRadius: 10,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "solid",
    marginVertical: 2,
  },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontVariant: ["tabular-nums"],
  },
  button: { alignItems: "center", paddingVertical: 12, borderRadius: 10, backgroundColor: "transparent" },
  note: { textAlign: "center", marginHorizontal: 32, marginTop: 14 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderStyle: "solid" },
  pickerRow: { paddingVertical: 6, paddingHorizontal: 8 },
})
