import Ionicons from "@expo/vector-icons/Ionicons"
import { useFocusEffect, useRouter } from "expo-router"
import { useCallback, useMemo, useState } from "react"
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from "react-native"
import { LargeTitle } from "../../src/components/LargeTitle"
import { relTime } from "../../src/time"
import { useHosts } from "../../src/state/hosts"
import { useLive } from "../../src/state/live"
import { useTheme } from "../../src/theme"

type Item = { id: string; name: string; dir?: string; host: string; hostId: string; active: number }
type Section = { title: string; data: Item[] }

// A machine can hold dozens of projects, so the list opens with the ones touched lately (the
// server's own project activity time) and the rest stays behind search or a show-all toggle.
// Tapping a project opens its session list, like the desktop sidebar's drill-in.
const RECENT_COUNT = 7

export default function Projects() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const live = useLive()
  const [rows, setRows] = useState<Item[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState("")
  const [showAll, setShowAll] = useState(false)

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled(
      hosts.map(async (h) =>
        ((await client(h.id)?.projects()) ?? []).map((p) => ({
          id: p.id,
          name: p.name || p.canonical?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p.id,
          dir: p.canonical,
          host: h.name,
          hostId: h.id,
          active: Math.max(p.time?.active ?? 0, p.time?.updated ?? 0),
        }))),
    )
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
  }, [hosts, client])

  // Reload on focus: a project born from new-project or a fresh chat shows up on the way back.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      fetchAll().then((next) => {
        if (cancelled) return
        setRows(next)
        setLoaded(true)
      })
      return () => {
        cancelled = true
      }
    }, [fetchAll]),
  )

  const sections = useMemo<Section[]>(() => {
    const byRecency = (a: Item, b: Item) => b.active - a.active || a.name.localeCompare(b.name)
    const q = query.trim().toLowerCase()
    if (q !== "") {
      const hits = rows.filter((p) => p.name.toLowerCase().includes(q) || (p.dir ?? "").toLowerCase().includes(q))
      return [{ title: `${hits.length} ${hits.length === 1 ? "match" : "matches"}`, data: [...hits].sort(byRecency) }]
    }
    const sorted = [...rows].sort(byRecency)
    const rest = sorted.slice(RECENT_COUNT)
    if (rest.length === 0) return [{ title: "ALL PROJECTS", data: sorted }]
    // Recent first always; the long tail opens alphabetically on demand.
    const out: Section[] = [{ title: "RECENT", data: sorted.slice(0, RECENT_COUNT) }]
    if (showAll) out.push({ title: "ALL PROJECTS", data: rest.sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host)) })
    return out
  }, [rows, query, showAll])

  const manyHosts = hosts.length > 1
  const hidden = rows.length - Math.min(rows.length, RECENT_COUNT)

  return (
    <SectionList
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 40 }}
      sections={sections}
      keyExtractor={(p) => `${p.hostId}|${p.id}`}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            fetchAll()
              .then((next) => {
                setRows(next)
                setLoaded(true)
                live.refresh()
              })
              .finally(() => setRefreshing(false))
          }}
          tintColor={t.tint}
        />
      }
      ListHeaderComponent={
        <>
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
          <View style={[styles.search, { backgroundColor: t.surface, borderColor: t.separator }]}>
            <Ionicons name="search" size={16} color={t.tertiaryLabel} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search projects and folders"
              placeholderTextColor={t.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              style={[t.font.subhead, styles.searchInput, { color: t.label }]}
            />
            {query !== "" && (
              <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10}>
                <Ionicons name="close-circle" size={18} color={t.tertiaryLabel} />
              </Pressable>
            )}
          </View>
        </>
      }
      ListEmptyComponent={
        !loaded ? undefined : query.trim() !== "" ? (
          <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>No project matches that name or path.</Text>
        ) : (
          <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
            {hosts.length ? "No projects seen yet." : "Pair a machine from the Hosts tab to get started."}
          </Text>
        )
      }
      ListFooterComponent={
        query.trim() === "" && rows.length > RECENT_COUNT && !showAll && hidden > 0 ? (
          <Pressable
            onPress={() => setShowAll(true)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[t.font.subhead, { color: t.tint, fontWeight: "600" }]}>Show all {rows.length} projects</Text>
          </Pressable>
        ) : undefined
      }
      renderSectionHeader={({ section }) => (
        <Text style={[t.font.footnote, styles.section, { color: t.tertiaryLabel }]}>{section.title}</Text>
      )}
      renderItem={({ item, index, section }) => (
        <Pressable
          onPress={() => router.push({ pathname: "/project", params: { host: item.host, id: item.id, name: item.name } })}
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
              {manyHosts ? ` · ${item.host}` : ""}
            </Text>
            {item.dir && (
              <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1} ellipsizeMode="middle">
                {item.dir}
              </Text>
            )}
          </View>
          {item.active > 0 && (
            <Text style={[t.font.caption, { color: t.tertiaryLabel }]}>{relTime(item.active)}</Text>
          )}
          <Ionicons name="chevron-forward" size={18} color={t.tertiaryLabel} />
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  empty: { textAlign: "center", marginHorizontal: 32, marginTop: 40 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 20, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, paddingVertical: 2 },
  section: { fontWeight: "600", letterSpacing: 0.5, paddingHorizontal: 32, paddingTop: 18, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 16, paddingHorizontal: 14, paddingVertical: 11 },
  first: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  last: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  icon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  toggle: { alignItems: "center", paddingVertical: 16, marginTop: 8 },
})
