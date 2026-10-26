import { useLocalSearchParams, useRouter } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import SegmentedControl from "../src/components/Segmented"
import { Row } from "../src/components/Rows"
import type { FileEntry, Session } from "../src/api/types"
import { useHosts } from "../src/state/hosts"
import { statusOf, useLive } from "../src/state/live"
import { useTheme } from "../src/theme"

export default function Project() {
  const t = useTheme()
  const router = useRouter()
  const { host, id, name } = useLocalSearchParams<{ host: string; id: string; name: string }>()
  const { hosts, client } = useHosts()
  const live = useLive()
  const [tab, setTab] = useState<"sessions" | "files">("sessions")
  const [sessions, setSessions] = useState<Session[]>([])
  const [dir, setDir] = useState<string>("")
  const [path, setPath] = useState("")
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState("")

  const hostID = hosts.find((h) => h.name === host)?.id ?? host
  const c = client(hostID)

  useEffect(() => {
    if (!c) return
    c.sessions(`project=${encodeURIComponent(id)}&limit=50&order=desc`)
      .then((page) =>
        setSessions(
          page.data.map((raw) => ({ ...(raw as object), host: hostID }) as Session),
        ),
      )
      .then(async () => {
        const list = await c.sessions(`project=${encodeURIComponent(id)}&limit=1`)
        const first = list.data[0] as { location?: { directory: string } } | undefined
        if (first?.location) setDir(first.location.directory)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [c, id])

  const openFiles = useCallback(() => {
    if (!c || !dir) return
    c.fsList({ directory: dir }, path)
      .then((r) => setEntries(r.data.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [c, dir, path])

  useEffect(() => {
    if (tab === "files") openFiles()
  }, [tab, openFiles])

  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <SegmentedControl
          values={["Sessions", "Files"]}
          selectedIndex={tab === "sessions" ? 0 : 1}
          onChange={(e) => setTab(e.nativeEvent.selectedSegmentIndex === 0 ? "sessions" : "files")}
          tintColor={t.tint}
        />
      </View>
      {error && <Text style={[t.font.footnote, styles.error, { color: t.status.failed }]}>{error}</Text>}
      {tab === "sessions" ? (
        <FlatList
          contentContainerStyle={{ paddingTop: 10, paddingBottom: 40 }}
          data={sessions}
          keyExtractor={(s) => s.id}
          ListEmptyComponent={<Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>No sessions in this project.</Text>}
          renderItem={({ item }) => (
            <Row
              title={item.title}
              hostName={host}
              status={statusOf(live, hostID, item.id)}
              onPress={() => router.push({ pathname: "/session", params: { host: hostID, id: item.id, title: item.title } })}
            />
          )}
        />
      ) : (
        <FlatList
          contentContainerStyle={{ paddingTop: 10, paddingBottom: 40 }}
          data={entries}
          keyExtractor={(e) => e.path}
          renderItem={({ item }) => (
            <Pressable
              onPress={() =>
                item.type === "directory"
                  ? setPath(path ? `${path}/${item.path}` : item.path)
                  : router.push({
                      pathname: "/file",
                      params: { host: hostID, directory: dir, path: path ? `${path}/${item.path}` : item.path, name: item.path.split("/").pop() },
                    })
              }
              style={({ pressed }) => [styles.fileRow, { borderBottomColor: t.separator, opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[t.font.callout, { color: t.label }]} numberOfLines={1}>
                {item.type === "directory" ? `${item.path}/` : item.path}
              </Text>
            </Pressable>
          )}
        />
      )}
      {tab === "files" && path !== "" && (
        <Pressable onPress={() => setPath(path.split("/").slice(0, -1).join("/"))} style={styles.up}>
          <Text style={[t.font.subhead, { color: t.tint, fontWeight: "600" }]}>← ..</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  error: { paddingHorizontal: 16, paddingTop: 8 },
  empty: { textAlign: "center", marginTop: 60 },
  fileRow: { paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  up: { position: "absolute", bottom: 20, left: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "rgba(0,0,0,0.001)" },
})
