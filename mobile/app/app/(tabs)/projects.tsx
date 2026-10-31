import Ionicons from "@expo/vector-icons/Ionicons"
import { useRouter } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native"
import { LargeTitle } from "../../src/components/LargeTitle"
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
  const [loaded, setLoaded] = useState(false)

  const fetchAll = useCallback(async () => {
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
    return results.flatMap((r) => (r.status === "fulfilled" && r.value.data.length ? [r.value] : []))
  }, [hosts, client])

  const load = () =>
    fetchAll().then((next) => {
      setSections(next)
      live.refresh()
    })

  useEffect(() => {
    let cancelled = false
    fetchAll().then((next) => {
      if (cancelled) return
      setSections(next)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [fetchAll])

  return (
    <SectionList
      contentContainerStyle={{ paddingBottom: 40 }}
      sections={sections}
      keyExtractor={(p) => `${p.id}`}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            load().finally(() => setRefreshing(false))
          }}
          tintColor={t.tint}
        />
      }
      ListHeaderComponent={
        <LargeTitle
          title="Projects"
          action={
            <Pressable
              onPress={() => router.push("/new-project")}
              accessibilityRole="button"
              accessibilityLabel="New project"
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Ionicons name="add-circle-outline" size={28} color={t.tint} />
            </Pressable>
          }
        />
      }
      ListEmptyComponent={
        !loaded ? undefined : (
          <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
            {hosts.length ? "No projects seen yet." : "Pair a machine from the Hosts tab to get started."}
          </Text>
        )
      }
      renderSectionHeader={({ section }) => (
        <Text style={[t.font.footnote, styles.section, { color: t.tertiaryLabel }]}>{section.host.toUpperCase()}</Text>
      )}
      renderItem={({ item, section, index }) => (
        <Pressable
          onPress={() => router.push({ pathname: "/project", params: { host: section.host, id: item.id, name: item.name } })}
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: pressed ? t.surfaceRaised : t.surface,
              borderTopColor: t.separator,
              borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
            },
            index === 0 && styles.first,
            index === section.data.length - 1 && styles.last,
          ]}
        >
          <View style={[styles.icon, { backgroundColor: t.fill.tertiary }]}>
            <Ionicons name="folder" size={18} color={t.tint} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
              {item.name}
            </Text>
            {item.dir && (
              <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1} ellipsizeMode="middle">
                {item.dir}
              </Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={18} color={t.tertiaryLabel} />
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  empty: { textAlign: "center", marginHorizontal: 32, marginTop: 40 },
  section: { fontWeight: "600", letterSpacing: 0.5, paddingHorizontal: 32, paddingTop: 18, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 16, paddingHorizontal: 14, paddingVertical: 11 },
  first: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  last: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  icon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
})
