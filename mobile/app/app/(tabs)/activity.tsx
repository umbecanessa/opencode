import { useRouter } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import { Row } from "../../src/components/Rows"
import type { Session } from "../../src/api/types"
import { useHosts } from "../../src/state/hosts"
import { statusOf, useLive } from "../../src/state/live"
import { useTheme } from "../../src/theme"

type Item = { session: Session; hostName: string }

export default function Activity() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const live = useLive()
  const [items, setItems] = useState<Item[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    const pages = await Promise.allSettled(
      hosts.map(async (h) => {
        const c = client(h.id)
        if (!c) return []
        const page = await c.sessions("limit=30&order=desc")
        return page.data.map((raw) => ({ session: { ...(raw as object), host: h.id } as Session, hostName: h.name }))
      }),
    )
    const merged = pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []))
    merged.sort((a, b) => (b.session.time.updated ?? 0) - (a.session.time.updated ?? 0))
    setItems(merged)
    live.refresh()
    setRefreshing(false)
  }, [hosts, client])

  useEffect(() => {
    load()
  }, [load])

  return (
    <FlatList
      contentContainerStyle={{ paddingTop: 120, paddingBottom: 40 }}
      data={items}
      keyExtractor={(i) => `${i.session.host}/${i.session.id}`}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.tint} />}
      ListEmptyComponent={
        refreshing ? undefined : (
          <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
            No sessions yet on your paired hosts.
          </Text>
        )
      }
      renderItem={({ item }) => (
        <Row
          title={item.session.title}
          hostName={item.hostName}
          status={statusOf(live, item.session.host, item.session.id)}
          detail={item.session.location?.directory?.split(/[\\/]/).pop()}
          onPress={() =>
            router.push({
              pathname: "/session",
              params: { host: item.session.host, id: item.session.id, title: item.session.title },
            })
          }
        />
      )}
    />
  )
}

const styles = StyleSheet.create({ empty: { textAlign: "center", marginTop: 60 } })
