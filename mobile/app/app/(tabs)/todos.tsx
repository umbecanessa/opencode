import Ionicons from "@expo/vector-icons/Ionicons"
import { useFocusEffect, useRouter } from "expo-router"
import { useCallback, useMemo, useState } from "react"
import { Alert, KeyboardAvoidingView, Platform, Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from "react-native"
import { LargeTitle } from "../../src/components/LargeTitle"
import { useHosts } from "../../src/state/hosts"
import { useTheme } from "../../src/theme"
import type { TodoInfo } from "../../src/api/types"

type Row = TodoInfo & { host: string; hostId: string }
type Section = { key: string; host: string; hostId: string; dir: string; name: string; done: number; data: Row[] }

const basename = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir

// The same durable list the desktop Todos tab and the voice triage write to: one row set per host,
// grouped by project directory. 404s classify as "needs a newer server" instead of an empty list.
export default function Todos() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const [rows, setRows] = useState<Row[]>([])
  const [stale, setStale] = useState<string[]>([])
  const [failed, setFailed] = useState<string[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [shownDone, setShownDone] = useState<string[]>([])
  const [adding, setAdding] = useState("")
  const [draft, setDraft] = useState("")
  const [assignDraft, setAssignDraft] = useState("")
  const [editing, setEditing] = useState<{ hostId: string; host: string; id: string; value: string } | undefined>()

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled(
      hosts.map(async (h) => ({ host: h.name, hostId: h.id, rows: ((await client(h.id)?.todos()) ?? []) as Row[] })),
    )
    return {
      rows: results.flatMap((r) => (r.status === "fulfilled" ? r.value.rows.map((row) => ({ ...row, host: r.value.host, hostId: r.value.hostId })) : [])),
      stale: results.flatMap((r) => (r.status === "rejected" && /\b404\b/.test(String(r.reason)) ? [String(r.reason).split(":")[0].trim()] : [])),
      failed: results.flatMap((r) => (r.status === "rejected" && !/\b404\b/.test(String(r.reason)) ? [String(r.reason).slice(0, 140)] : [])),
    }
  }, [hosts, client])

  const apply = useCallback((next: Awaited<ReturnType<typeof fetchAll>>) => {
    setRows(next.rows)
    setStale(next.stale)
    setFailed(next.failed)
  }, [])

  // Reload on focus, not just on mount: todos added from the new-todo modal or another device
  // should be there when you come back to the tab, without a manual pull.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      fetchAll().then((next) => {
        if (cancelled) return
        apply(next)
        setLoaded(true)
      })
      return () => {
        cancelled = true
      }
    }, [fetchAll, apply]),
  )

  // Sections are project groups across hosts, open rows first; done rows join only when expanded.
  const sections = useMemo<Section[]>(() => {
    const byKey = new Map<string, { host: string; hostId: string; dir: string; open: Row[]; done: Row[] }>()
    for (const row of rows) {
      const key = `${row.hostId}\u0000${row.directory}`
      const group = byKey.get(key)
      if (group) (row.status === "done" ? group.done : group.open).push(row)
      else byKey.set(key, { host: row.host, hostId: row.hostId, dir: row.directory, open: [row], done: [] })
    }
    return [...byKey]
      .map(([key, group]) => ({
        key,
        host: group.host,
        hostId: group.hostId,
        dir: group.dir,
        name: basename(group.dir),
        done: group.done.length,
        data: shownDone.includes(key) ? [...group.open, ...group.done] : group.open,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host))
  }, [rows, shownDone])

  const mutate = (hostId: string, id: string, patch: (row: Row) => Row) =>
    setRows((prev) => prev.map((row) => (row.hostId === hostId && row.id === id ? patch(row) : row)))

  const fail = (error: unknown) => Alert.alert("Todos", String(error instanceof Error ? error.message : error).slice(0, 220))

  const toggle = (row: Row) => {
    const status = row.status === "done" ? "open" : "done"
    mutate(row.hostId, row.id, (r) => ({ ...r, status }))
    client(row.hostId)
      ?.todoSet(row.id, { status })
      .then((data) => mutate(row.hostId, row.id, () => ({ ...data, host: row.host, hostId: row.hostId })), fail)
  }

  const removeItem = (row: Row) =>
    Alert.alert("Delete todo?", row.text.slice(0, 120), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setRows((prev) => prev.filter((r) => !(r.hostId === row.hostId && r.id === row.id)))
          client(row.hostId)
            ?.todoRemove(row.id)
            .catch((error) => {
              setRows((prev) => [...prev, row])
              fail(error)
            })
        },
      },
    ])

  const commitEdit = () => {
    const current = editing
    setEditing(undefined)
    if (!current || current.value.trim() === "") return
    mutate(current.hostId, current.id, (r) => ({ ...r, text: current.value.trim() }))
    client(current.hostId)
      ?.todoSet(current.id, { text: current.value.trim() })
      .then(
        (data) => mutate(current.hostId, current.id, () => ({ ...data, host: current.host, hostId: current.hostId })),
        (error) => {
          fetchAll().then(apply, () => {})
          fail(error)
        },
      )
  }

  const addTodo = (section: Section) => {
    const text = draft.trim()
    const assignee = assignDraft.trim()
    setDraft("")
    setAssignDraft("")
    setAdding("")
    if (text === "") return
    const optimistic: Row = {
      id: `pending_${text}`,
      directory: section.dir,
      text,
      status: "open",
      source: "user",
      ...(assignee === "" ? {} : { assignee }),
      time_created: Date.now(),
      time_updated: Date.now(),
      host: section.host,
      hostId: section.hostId,
    }
    setRows((prev) => [...prev, optimistic])
    client(section.hostId)
      ?.todoAdd(section.dir, text, assignee === "" ? undefined : assignee)
      .then(
        (data) =>
          setRows((prev) => [...prev.filter((r) => !(r.hostId === section.hostId && r.id === optimistic.id)), { ...data, host: section.host, hostId: section.hostId }]),
        (error) => {
          setRows((prev) => prev.filter((r) => !(r.hostId === section.hostId && r.id === optimistic.id)))
          fail(error)
        },
      )
  }

  const manyHosts = hosts.length > 1

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SectionList
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 40 }}
        sections={sections}
        keyExtractor={(row) => `${row.hostId}|${row.id}`}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              fetchAll()
                .then(apply, () => {})
                .finally(() => setRefreshing(false))
            }}
            tintColor={t.tint}
          />
        }
        ListHeaderComponent={
          <>
            <LargeTitle
              title="Todos"
              action={
                <Pressable
                  onPress={() => router.push("/new-todo")}
                  accessibilityRole="button"
                  accessibilityLabel="New todo in any project"
                  hitSlop={10}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Ionicons name="add-circle-outline" size={28} color={t.tint} />
                </Pressable>
              }
            />
            {(stale.length > 0 || failed.length > 0) && (
              <Text style={[t.font.caption, styles.note, { color: t.tertiaryLabel }]}>
                {stale.length ? `${stale.join(", ")}: project todos need a newer opencode server on that machine. ` : ""}
                {failed.join(" · ")}
              </Text>
            )}
          </>
        }
        ListEmptyComponent={
          loaded && rows.length === 0 ? (
            <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
              {"No todos yet.\n\nTap the + above to add one to any project, triage a Pocket voice note, or ask the agent to use its todo tool."}
            </Text>
          ) : undefined
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionRow}>
            <Text style={[t.font.footnote, { color: t.tertiaryLabel, fontWeight: "600", letterSpacing: 0.5, flexShrink: 1 }]} numberOfLines={1}>
              {section.name.toUpperCase()}
              {manyHosts ? ` · ${section.host}` : ""}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              {section.done > 0 && (
                <Pressable
                  onPress={() =>
                    setShownDone((prev) => (prev.includes(section.key) ? prev.filter((k) => k !== section.key) : [...prev, section.key]))
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`${section.done} done, toggle`}
                  hitSlop={10}
                >
                  <Text style={[t.font.caption, { color: t.tertiaryLabel, textDecorationLine: "line-through" }]}>{section.done} done</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => {
                  setAdding(section.key)
                  setDraft("")
                  setAssignDraft("")
                }}
                accessibilityRole="button"
                accessibilityLabel={`Add todo to ${section.name}`}
                hitSlop={10}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <Ionicons name="add-circle-outline" size={22} color={t.tint} />
              </Pressable>
            </View>
          </View>
        )}
        renderItem={({ item, index, section }) => {
          const done = item.status === "done"
          const editingThis = editing?.id === item.id && editing.hostId === item.hostId

          return (
            <Pressable
              onLongPress={() => removeItem(item)}
              delayLongPress={450}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? t.surfaceRaised : t.surface,
                  borderTopColor: t.separator,
                  borderTopWidth: index === 0 && adding !== section.key ? 0 : StyleSheet.hairlineWidth,
                },
                index === 0 && styles.first,
                index === section.data.length - 1 && styles.last,
              ]}
            >
              <Pressable
                onPress={() => toggle(item)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: done }}
                accessibilityLabel={done ? `Reopen: ${item.text}` : `Mark done: ${item.text}`}
                hitSlop={8}
                style={styles.check}
              >
                <Ionicons name={done ? "checkmark-circle" : "ellipse-outline"} size={22} color={done ? t.tertiaryLabel : t.tint} />
              </Pressable>
              <View style={{ flex: 1, gap: 2 }}>
                {editingThis ? (
                  <TextInput
                    style={[t.font.body, { color: t.label }]}
                    value={editing.value}
                    onChangeText={(value) => setEditing({ hostId: item.hostId, host: item.host, id: item.id, value })}
                    onEndEditing={commitEdit}
                    onSubmitEditing={commitEdit}
                    autoCorrect={false}
                    autoFocus
                  />
                ) : (
                  <Pressable
                    onPress={() => setEditing({ hostId: item.hostId, host: item.host, id: item.id, value: item.text })}
                    accessibilityRole="text"
                    accessibilityLabel={`Edit: ${item.text}`}
                  >
                    <Text style={[t.font.body, { color: done ? t.tertiaryLabel : t.label }, done && { textDecorationLine: "line-through" }]}>
                      {item.text}
                    </Text>
                  </Pressable>
                )}
                {item.description && !editingThis && (
                  <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={2}>
                    {item.description}
                  </Text>
                )}
                {!editingThis && (item.refs?.length ?? 0) > 0 && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {(item.refs ?? []).map((ref) => (
                      <Text key={ref.uri} style={[t.font.caption, styles.chip, { color: t.tertiaryLabel, backgroundColor: t.fill.tertiary }]} numberOfLines={1}>
                        {ref.label}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
              <View style={{ alignItems: "flex-end", gap: 3 }}>
                {item.assignee && (
                  <Text style={[t.font.caption, styles.chip, { color: t.tint, backgroundColor: t.fill.tertiary }]} numberOfLines={1}>
                    @{item.assignee}
                  </Text>
                )}
                <Text style={[t.font.caption, { color: t.tertiaryLabel }]}>{item.source === "user" ? "you" : item.source}</Text>
              </View>
            </Pressable>
          )
        }}
      />
      {sections.some((s) => s.key === adding) && (
        <View style={[styles.composer, { backgroundColor: t.surface, borderTopColor: t.separator }]}>
          <TextInput
            style={[t.font.body, { color: t.label, flex: 1 }]}
            placeholder="New todo…"
            placeholderTextColor={t.tertiaryLabel}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => {
              const section = sections.find((s) => s.key === adding)
              if (section) addTodo(section)
            }}
            autoFocus
            autoCorrect={false}
            returnKeyType="done"
          />
          <TextInput
            style={[t.font.subhead, styles.assign, { color: t.label, backgroundColor: t.fill.secondary }]}
            placeholder="@assign"
            placeholderTextColor={t.tertiaryLabel}
            value={assignDraft}
            onChangeText={setAssignDraft}
            onSubmitEditing={() => {
              const section = sections.find((s) => s.key === adding)
              if (section) addTodo(section)
            }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
          />
          <Pressable
            onPress={() => setAdding("")}
            accessibilityRole="button"
            accessibilityLabel="Cancel new todo"
            hitSlop={10}
          >
            <Ionicons name="close-circle" size={22} color={t.tertiaryLabel} />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  note: { marginHorizontal: 32, marginBottom: 8 },
  empty: { textAlign: "center", marginHorizontal: 32, marginTop: 40, lineHeight: 20 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 32, paddingTop: 18, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginHorizontal: 16, paddingHorizontal: 14, paddingVertical: 11 },
  first: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  last: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  check: { paddingTop: 1 },
  chip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, overflow: "hidden" },
  composer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  assign: { width: 96, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 9, textAlign: "center" },
})
