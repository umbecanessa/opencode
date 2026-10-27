import { useRouter } from "expo-router"
import { useState } from "react"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

export default function Pair() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { hosts, addHost } = useHosts()
  const [link, setLink] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!link.trim() || busy) return
    setBusy(true)
    try {
      await addHost(name.trim() || new URL(link.trim()).hostname, link.trim())
      router.replace("/(tabs)/hosts")
    } catch (e) {
      Alert.alert("Pairing failed", e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.background }}>
      <View style={[styles.wrap, { paddingTop: insets.top + 56 }]}>
        <Text style={[t.font.title2, { color: t.label, fontWeight: "700" }]}>
          {hosts.length === 0 ? "Connect your first machine" : "Add another machine"}
        </Text>
        <Text style={[t.font.callout, { color: t.secondaryLabel, lineHeight: 24, marginBottom: t.space.l }]}>
          Open the OpenCode app on that machine, press Pair, and paste the link here. It stays valid for five minutes
          and grants this phone a 30-day session.
        </Text>

        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>PAIRING LINK</Text>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="http://100.121.10.112:28894/auth/connect/…"
          placeholderTextColor={t.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { color: t.label, backgroundColor: t.surface }]}
        />
        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>NAME THIS MACHINE</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Desktop"
          placeholderTextColor={t.tertiaryLabel}
          style={[styles.input, { color: t.label, backgroundColor: t.surface }]}
        />

        <Pressable
          onPress={submit}
          disabled={busy || !link.trim()}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: link.trim() && !busy ? t.tint : t.fill.primary,
              opacity: pressed ? 0.8 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text style={[t.font.headline, { color: link.trim() && !busy ? "#FFFFFF" : t.secondaryLabel, fontWeight: "600" }]}>
            {busy ? "Pairing…" : "Pair"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 20, paddingTop: 90 },
  label: { fontWeight: "600", letterSpacing: 0.4, marginTop: 18, marginBottom: 6 },
  input: {
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 18,
  },
  button: { alignItems: "center", paddingVertical: 15, borderRadius: 14, marginTop: 8 },
})

