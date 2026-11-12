import Ionicons from "@expo/vector-icons/Ionicons"
import { useLocalSearchParams } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { LargeTitle } from "../src/components/LargeTitle"
import { usePocket } from "../src/state/pocket"
import { useTheme } from "../src/theme"

export default function Pocket() {
  const t = useTheme()
  const pocket = usePocket()
  // opencode-mobile://pocket?action=pull is what the Back Tap shortcut opens;
  // the device is restored from storage a beat after first mount, hence the ref.
  const params = useLocalSearchParams<{ action?: string }>()
  const autoFired = useRef(false)
  const [target, setTarget] = useState<string>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [keyInput, setKeyInput] = useState("")

  // pocket is a fresh object each provider render; depending on it would re-fire the pull
  // on every state change, so the ref makes this a once-per-deep-link side effect.
  useEffect(() => {
    if (autoFired.current) return
    if (params.action !== "pull" && params.action !== "record") return
    if (!pocket.device && !pocket.hasKey) return
    autoFired.current = true
    if (!pocket.device) pocket.scan()
    else if (params.action === "record") (pocket.recording ? pocket.stopRecording : pocket.startRecording)()
    else pocket.pull()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.action, pocket.device, pocket.hasKey])

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
        <View style={[styles.card, { backgroundColor: t.surface, marginTop: 16 }]}>
          <View style={styles.row}>
            <View
              style={[styles.icon, { backgroundColor: t.fill.tertiary }]}
            >
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
        <View style={[styles.card, { backgroundColor: t.surface }]}>
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
            style={({ pressed }) => [styles.button, { opacity: pocket.busy ? 0.6 : pressed ? 0.8 : 1 }]}
          >
            {pocket.busy ? (
              <ActivityIndicator color={t.tint} />
            ) : (
              <Text style={[t.font.headline, { color: t.tint, fontWeight: "600" }]}>Pull recordings</Text>
            )}
          </Pressable>
          <Text style={[t.font.footnote, { color: t.tertiaryLabel, textAlign: "center" }]}>
            Tip: a Back Tap shortcut to opencode-mobile://pocket?action=record starts and ships a recording, and
            ?action=pull just ships.
          </Text>
        </View>
      )}

      {!!pocket.error && (
        <Text style={[t.font.footnote, styles.note, { color: t.status.failed }]}>{pocket.error}</Text>
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
})
