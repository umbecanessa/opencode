import { useRouter } from "expo-router"
import { useCallback, useEffect, useMemo, useState } from "react"
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { PermissionDecision, PermissionRequest, Session } from "../../src/api/types"
import { LargeTitle } from "../../src/components/LargeTitle"
import { flattenFamilies, TreeRow } from "../../src/components/SessionTree"
import { ApprovalCard } from "../../src/components/session/Approval"
import { Question } from "../../src/components/session/Question"
import { useHosts } from "../../src/state/hosts"
import { familyStatus, useLive } from "../../src/state/live"
import { nestSessions } from "../../src/state/tree"
import { useTheme } from "../../src/theme"

export default function Activity() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const live = useLive(4000)
  const [sessions, setSessions] = useState<Session[]>([])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [hostFilter, setHostFilter] = useState<string>()
  const [statusFilter, setStatusFilter] = useState("All")
  const [filterMenu, setFilterMenu] = useState<"host" | "status">()

  const fetchAll = useCallback(async () => {
    const pages = await Promise.allSettled(
      hosts.map(async (h) => {
        const page = await client(h.id)?.sessions("limit=80&order=desc")
        return (page?.data ?? []).map((raw) => ({ ...(raw as object), host: h.id }) as Session)
      }),
    )
    return pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []))
  }, [hosts, client])

  const load = () =>
    fetchAll().then((next) => {
      setSessions(next)
      live.refresh()
    })

  useEffect(() => {
    let cancelled = false
    fetchAll().then((next) => {
      if (cancelled) return
      setSessions(next)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [fetchAll])

  const items = useMemo(() => flattenFamilies(nestSessions(sessions.filter((s) => !hostFilter || s.host === hostFilter)).filter((family) => {
    if (statusFilter === "All") return true
    const status = familyStatus(live, family.session.host, [family.session.id, ...family.children.map((s) => s.id)])
    if (statusFilter === "Running") return status === "running"
    if (statusFilter === "Needs you") return status === "waiting"
    const outcome = family.session.outcome
    const failed = outcome === "failed" || (typeof outcome === "object" && outcome !== null && "type" in outcome && outcome.type === "failed")
    return status === "done" && (statusFilter === "Failed" ? failed : !failed)
  }), open), [sessions, open, hostFilter, statusFilter, live])
  const titles = useMemo(() => new Map(sessions.map((s) => [`${s.host}/${s.id}`, s])), [sessions])
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? ""

  const openSession = (s: Session) =>
    router.push({ pathname: "/session", params: { host: s.host, id: s.id, title: s.title } })

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const decide = async (request: PermissionRequest, decision: PermissionDecision) => {
    await client(request.host)?.replyPermission(request.sessionID, request.id, decision)
    live.refresh()
  }

  const describe = (r: PermissionRequest) => {
    const s = titles.get(`${r.host}/${r.sessionID}`)
    const parent = s?.parentID ? titles.get(`${r.host}/${s.parentID}`) : undefined
    const title = s?.title ?? "Session"
    return [parent ? `${parent.title} › ${title}` : title, hostName(r.host)].filter(Boolean).join(" · ")
  }

  return (
    <FlatList
      contentContainerStyle={{ paddingBottom: 40 }}
      data={items}
      keyExtractor={(i) => i.key}
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
        <>
          <LargeTitle title="Activity" />
          <View style={{ flexDirection: "row", paddingHorizontal: 22, marginBottom: 8, gap: 18 }}>
            {(["host", "status"] as const).map((kind) => <Pressable key={kind} onPress={() => setFilterMenu(kind)} accessibilityRole="button"
              accessibilityLabel={`Filter by ${kind}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, flexShrink: 1 }}>
              <Text numberOfLines={1} style={[t.font.subhead, { color: (kind === "host" ? !!hostFilter : statusFilter !== "All") ? t.tint : t.secondaryLabel }]}>
                {kind === "host" ? hosts.find((h) => h.id === hostFilter)?.name ?? "All hosts" : statusFilter === "All" ? "All activity" : statusFilter}
              </Text>
              <Ionicons name="chevron-down" size={12} color={t.secondaryLabel} />
            </Pressable>)}
          </View>
          <Modal visible={!!filterMenu} transparent animationType="slide" onRequestClose={() => setFilterMenu(undefined)}>
            <View style={{ flex: 1, justifyContent: "flex-end" }}>
              <Pressable onPress={() => setFilterMenu(undefined)} accessibilityLabel="Close filters" style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.4)" }} />
              <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36, maxHeight: "70%" }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <Text style={[t.font.headline, { color: t.label }]}>{filterMenu === "host" ? "Host" : "Activity"}</Text>
                  <Pressable onPress={() => setFilterMenu(undefined)} accessibilityRole="button" style={{ padding: 12 }}><Text style={{ color: t.tint }}>Done</Text></Pressable>
                </View>
                <ScrollView>
                  {(filterMenu === "host" ? [{ id: undefined, name: "All hosts" }, ...hosts].map((h) => ({ value: h.id, label: h.name }))
                    : ["All", "Running", "Needs you", "Completed", "Failed"].map((s) => ({ value: s, label: s === "All" ? "All activity" : s }))).map((option) => {
                    const selected = filterMenu === "host" ? hostFilter === option.value : statusFilter === option.value
                    return <Pressable key={option.value ?? "all"} onPress={() => {
                      if (filterMenu === "host") setHostFilter(option.value)
                      else setStatusFilter(option.value ?? "All")
                      setFilterMenu(undefined)
                    }} accessibilityRole="button" accessibilityState={{ selected }} style={{ minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 }}>
                      <Text style={[t.font.body, { color: t.label }]}>{option.label}</Text>
                      {selected && <Ionicons name="checkmark" size={21} color={t.tint} />}
                    </Pressable>
                  })}
                </ScrollView>
              </View>
            </View>
          </Modal>
          {hosts.filter((h) => live.online[h.id] === false).map((h) => <Text key={h.id} style={[t.font.footnote, { color: t.status.waiting, margin: 16 }]}>{h.name} is offline. Session information may be out of date.</Text>)}
          {live.forms.filter((f) => !hostFilter || f.host === hostFilter).map((form) => <Question key={`${form.host}/${form.id}`} form={form} onAnswer={async (answer) => {
            const c = client(form.host)
            if (!c) throw new Error("Host unavailable")
            await c.answerForm(form.sessionID, form.id, answer)
            live.refresh()
          }} />)}
          {live.requests.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={[t.font.footnote, styles.section, { color: t.status.waiting }]}>NEEDS YOU</Text>
              {live.requests.filter((r) => !hostFilter || r.host === hostFilter).map((r) => (
                <ApprovalCard key={r.id} request={r} context={describe(r)} onDecide={decide} />
              ))}
            </View>
          )}
          {items.length > 0 && <Text style={[t.font.footnote, styles.section, { color: t.tertiaryLabel }]}>RECENT</Text>}
        </>
      }
      ListEmptyComponent={
        !loaded ? undefined : (
          <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
            {hosts.length ? hostFilter || statusFilter !== "All" ? "No sessions match these filters." : "No sessions yet on your paired hosts." : "Pair a machine from the Hosts tab to get started."}
          </Text>
        )
      }
      renderItem={({ item, index }) => (
        <TreeRow
          item={item}
          first={index === 0}
          last={index === items.length - 1}
          hostName={hostName(item.kind === "parent" ? item.family.session.host : item.session.host)}
          live={live}
          showDirectory
          onOpen={openSession}
          onToggle={toggle}
        />
      )}
    />
  )
}

const styles = StyleSheet.create({
  empty: { textAlign: "center", marginHorizontal: 32, marginTop: 40 },
  section: { fontWeight: "600", letterSpacing: 0.5, paddingHorizontal: 32, paddingTop: 6, paddingBottom: 8 },
})
