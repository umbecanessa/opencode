import { useLocalSearchParams, useRouter } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import { extractFiles, joinPath } from "../src/api/files"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

type Msg = {
  id: string
  type: string
  time?: { created?: number }
  text?: string
  content?: { type: string; text?: string; name?: string; state?: string }[]
}

export default function Session() {
  const t = useTheme()
  const router = useRouter()
  const { host, id, title } = useLocalSearchParams<{ host: string; id: string; title: string }>()
  const { client } = useHosts()
  const c = client(host)
  const [messages, setMessages] = useState<Msg[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState("")
  const directory = useRef("")
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const first = useCallback(() => {
    if (!c) return
    c.session(id).then((s) => (directory.current = s.location?.directory ?? "")).catch(() => {})
    c.messages(id)
      .then((page) => {
        setMessages(page.data as Msg[])
        setCursor(page.cursor.next ?? undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [c, id])

  const older = useCallback(() => {
    if (!c || !cursor) return
    c.messages(id, cursor).then((page) => {
      setMessages((m) => [...m, ...(page.data as Msg[])])
      setCursor(page.cursor.next ?? undefined)
    })
  }, [c, id, cursor])

  useEffect(() => {
    first()
    if (!c) return
    const abort = new AbortController()
    c.events((e) => {
      const data = e.data as { sessionID?: string }
      if (data.sessionID && data.sessionID !== id) return
      if (e.type === "server.connected") return
      clearTimeout(debounce.current)
      debounce.current = setTimeout(() => c.messages(id).then((p) => setMessages(p.data as Msg[])).catch(() => {}), 1200)
    }, abort.signal)
    return () => {
      setLive(true)
      abort.abort()
    }
  }, [c, id, first])

  const openFile = (rel: string) => {
    const path = joinPath(directory.current || "", rel)
    router.push({
      pathname: "/file",
      params: { host, directory: directory.current, path, name: rel.split(/[\\/]/).pop() },
    })
  }

  const renderMsg = ({ item }: { item: Msg }) => {
    if (item.type === "idle") return <View style={styles.gap} />
    const isUser = item.type === "user"
    const chunks: React.ReactNode[] = []
    if (item.text) chunks.push(<FileText key="t" text={item.text} onFile={openFile} color={t.label} bg={isUser ? t.tint : undefined} />)
    for (const [i, part] of (item.content ?? []).entries()) {
      if (part.type === "text" && part.text)
        chunks.push(<FileText key={`x${i}`} text={part.text} onFile={openFile} color={t.label} />)
      if (part.type === "reasoning")
        chunks.push(
          <Text key={`r${i}`} style={[t.font.footnote, { color: t.tertiaryLabel, fontStyle: "italic" }]}>
            reasoning…
          </Text>,
        )
      if (part.type === "tool")
        chunks.push(
          <Text key={`o${i}`} style={[t.font.subhead, { color: part.state === "error" ? t.status.failed : t.secondaryLabel }]}>
            ⚙ {part.name}
            {part.state ? ` · ${part.state}` : ""}
          </Text>,
        )
    }
    return (
      <View style={[styles.msg, isUser && { alignItems: "flex-end" }]}>
        <View
          style={{
            maxWidth: "86%",
            padding: 12,
            borderRadius: 14,
            backgroundColor: isUser ? t.tint : t.surface,
          }}
        >
          {chunks}
        </View>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      {loading && <ActivityIndicator style={{ marginTop: 20 }} color={t.tint} />}
      {error && <Text style={[t.font.footnote, { color: t.status.failed, padding: 16 }]}>{error}</Text>}
      <FlatList
        inverted
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingVertical: 16 }}
        onEndReached={older}
        onEndReachedThreshold={0.4}
        renderItem={renderMsg}
      />
      {live && <View style={styles.livePill}>{<Text style={[t.font.caption, { color: t.status.running, fontWeight: "700" }]}>● LIVE</Text>}</View>}
    </View>
  )
}

const FileText = ({
  text,
  onFile,
  color,
  bg,
}: {
  text: string
  onFile: (f: string) => void
  color: string
  bg?: string
}) => (
  <Text style={[{ fontSize: 16, lineHeight: 24, color: bg ? "#FFFFFF" : color }]}>
    {extractFiles(text).map((seg, i) =>
      seg.file ? (
        <Text key={i} onPress={() => onFile(seg.text)} style={{ color: bg ? "#EAF3FF" : undefined, textDecorationLine: "underline" }}>
          {seg.text}
        </Text>
      ) : (
        <Text key={i}>{seg.text}</Text>
      ),
    )}
  </Text>
)

const styles = StyleSheet.create({
  msg: { paddingHorizontal: 14, paddingVertical: 5 },
  gap: { height: 10 },
  livePill: { position: "absolute", bottom: 14, alignSelf: "center", paddingHorizontal: 10, paddingVertical: 4, backgroundColor: "rgba(0,0,0,0.001)" },
})
