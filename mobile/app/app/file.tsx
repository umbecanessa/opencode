import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { Markdown } from "../src/components/Markdown"
import SegmentedControl from "../src/components/Segmented"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

export default function FileView() {
  const t = useTheme()
  const router = useRouter()
  const { host, directory, path, name } = useLocalSearchParams<{ host: string; directory: string; path: string; name: string }>()
  const { client } = useHosts()
  const [mode, setMode] = useState<"rendered" | "source">(String(name).endsWith(".md") || String(name).endsWith(".mdx") ? "rendered" : "source")
  const [text, setText] = useState<string>()
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    client(host)
      ?.fsRead({ directory }, path)
      .then((r) => {
        setText(r.text)
        setTruncated(r.truncated)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [host, directory, path, client])

  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={14} style={styles.close}>
          <Text style={[t.font.headline, { color: t.tint, fontWeight: "600" }]}>Done</Text>
        </Pressable>
        <Text style={[t.font.footnote, { color: t.tertiaryLabel }]} numberOfLines={1}>
          {name} · {host}
        </Text>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <SegmentedControl
          values={["Rendered", "Source"]}
          selectedIndex={mode === "rendered" ? 0 : 1}
          onChange={(i) => setMode(i === 0 ? "rendered" : "source")}
        />
      </View>
      {truncated && (
        <Text style={[t.font.footnote, styles.banner, { color: t.status.waiting, backgroundColor: t.fill.secondary }]}>
          Showing the first part of this file.
        </Text>
      )}
      {error && (
        <Text style={[t.font.callout, styles.banner, { color: t.status.failed, backgroundColor: t.fill.secondary }]}>{error}</Text>
      )}
      {!text && !error && <ActivityIndicator style={{ marginTop: 30 }} color={t.tint} />}
      {text && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          {mode === "rendered" ? (
            <Markdown>{text}</Markdown>
          ) : (
            <Text style={[styles.source, { color: t.label }]} selectable>
              {text}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, gap: 12 },
  close: { paddingVertical: 4 },
  banner: { marginHorizontal: 16, marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  source: { fontFamily: "Menlo", fontSize: 13, lineHeight: 19 },
})
