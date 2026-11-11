import Ionicons from "@expo/vector-icons/Ionicons"
import { useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { LargeTitle } from "../src/components/LargeTitle"
import { generatePocketKey, usePocket } from "../src/state/pocket"
import { useTheme } from "../src/theme"

export default function Pocket() {
  const t = useTheme()
  const pocket = usePocket()
  const [keyInput, setKeyInput] = useState("")

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

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <LargeTitle title="Pocket" subtitle="Voice recorder capture" />

      <View style={[styles.card, { backgroundColor: t.surface }]}>
        <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]}>
          {pocket.hasKey ? "Pair another recorder" : "Pair a recorder"}
        </Text>
        <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
          Reset the recorder first: triple-click the side button (the LED blinks red), then press and hold it until
          the blinking stops and the LED pulses blue. Scan, then tap the recorder to make it adopt the key below.
        </Text>
        <TextInput
          value={keyInput}
          onChangeText={(v) => setKeyInput(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16))}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="16-character key"
          placeholderTextColor={t.tertiaryLabel}
          editable={!pocket.pairing}
          style={[styles.input, { borderColor: t.separator, color: t.label, backgroundColor: t.background }]}
        />
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            disabled={pocket.pairing}
            onPress={() => setKeyInput(generatePocketKey())}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: t.fill.tertiary, opacity: pressed || pocket.pairing ? 0.6 : 1, flex: 1 },
            ]}
          >
            <Text style={[t.font.footnote, { color: t.label, fontWeight: "600" }]}>Generate key</Text>
          </Pressable>
          <Pressable
            disabled={pocket.scanning || pocket.pairing}
            onPress={pocket.scan}
            style={({ pressed }) => [styles.button, { opacity: pressed || pocket.scanning ? 0.6 : 1, flex: 1 }]}
          >
            {pocket.scanning ? (
              <ActivityIndicator color={t.tint} />
            ) : (
              <Text style={[t.font.footnote, { color: t.tint, fontWeight: "600" }]}>
                {pocket.devices.length ? "Scan again" : "Scan"}
              </Text>
            )}
          </Pressable>
        </View>
        {pocket.pairing && (
          <View style={styles.row}>
            <ActivityIndicator color={t.tint} />
            <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>Pairing — keep the recorder close…</Text>
          </View>
        )}
        {pocket.devices.map((d) => (
          <Pressable
            key={d.id}
            disabled={pocket.pairing}
            onPress={() => pocket.pair(d, keyInput)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Ionicons name="ear-outline" size={20} color={t.tint} />
            <Text style={[t.font.body, { color: t.label, flex: 1 }]} numberOfLines={1}>
              {d.name}
            </Text>
            <Ionicons name="link" size={16} color={t.tertiaryLabel} />
          </Pressable>
        ))}
        {keyInput.length === 16 && !pocket.pairing && (
          <Text style={[t.font.footnote, { color: t.tertiaryLabel }]}>
            A recorder a computer already paired works too: enter its existing key and tap it — no reset needed.
          </Text>
        )}
      </View>

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
            {pocket.busy ? <ActivityIndicator color={t.tint} /> : (
              <Text style={[t.font.headline, { color: t.tint, fontWeight: "600" }]}>Pull recordings</Text>
            )}
          </Pressable>
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
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  input: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontVariant: ["tabular-nums"],
  },
  button: { alignItems: "center", paddingVertical: 12, borderRadius: 10, backgroundColor: "transparent" },
  note: { textAlign: "center", marginHorizontal: 32, marginTop: 14 },
})
