import { useRouter } from "expo-router"
import { useCallback, useEffect, useMemo, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import type { PermissionDecision, PermissionRequest, Session } from "../../src/api/types"
import { LargeTitle } from "../../src/components/LargeTitle"
import { flattenFamilies, TreeRow } from "../../src/components/SessionTree"
import { ApprovalCard } from "../../src/components/session/Approval"
import { useHosts } from "../../src/state/hosts"
import { useLive } from "../../src/state/live"
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

  const items = useMemo(() => flattenFamilies(nestSessions(sessions), open), [sessions, open])
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
          {live.requests.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={[t.font.footnote, styles.section, { color: t.status.waiting }]}>NEEDS YOU</Text>
              {live.requests.map((r) => (
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
            {hosts.length ? "No sessions yet on your paired hosts." : "Pair a machine from the Hosts tab to get started."}
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
