import { useRouter } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { SectionList, RefreshControl, StyleSheet, Text } from "react-native"
import { HostTag } from "../../src/components/Rows"
import { useHosts } from "../../src/state/hosts"
import { useLive } from "../../src/state/live"
import { useTheme } from "../../src/theme"

type Section = { host: string; data: { id: string; name: string; dir?: string }[] }

export default function Projects() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const live = useLive()
  const [sections, setSections] = useState<Section[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    const results = await Promise.allSettled(
      hosts.map(async (h) => ({
        host: h.name,
        data: ((await client(h.id)?.projects()) ?? []).map((p) => ({
          id: p.id,
          name: p.name || p.canonical?.split(/[\\/]/).pop() || p.id,
          dir: p.canonical,
        })),
      })),
    )
    setSections(results.flatMap((r) => (r.status === "fulfilled" && r.value.data.length ? [r.value] : [])))
    live.refresh()
    setRefreshing(false)
  }, [hosts, client])

  useEffect(() => {
    load()
  }, [load])

  return (
    <SectionList
      contentContainerStyle={{ paddingTop: 120, paddingBottom: 40 }}
      sections={sections}
      keyExtractor={(p) => `${p.id}`}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.tint} />}
      ListEmptyComponent={
        refreshing ? undefined : (
          <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>No projects seen yet.</Text>
        )
      }
      renderSectionHeader={({ section }) => (
        <Text style={[t.font.footnote, styles.section, { color: t.tertiaryLabel }]}>{section.host.toUpperCase()}</Text>
      )}
      renderItem={({ item, section }) => (
        <Text
          onPress={() => router.push({ pathname: "/project", params: { host: section.host, id: item.id, name: item.name } })}
          style={[t.font.title3, { color: t.label, fontWeight: "600", paddingHorizontal: 16, paddingVertical: 14 }]}
        >
          {item.name}
        </Text>
      )}
      ItemSeparatorComponent={() => <Text style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.separator }} />}
    />
  )
}

const styles = StyleSheet.create({
  empty: { textAlign: "center", marginTop: 60 },
  section: { fontWeight: "700", letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 6 },
})
