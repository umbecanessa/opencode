import Ionicons from "@expo/vector-icons/Ionicons"
import { Stack, useLocalSearchParams, useRouter } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"
import { joinPath } from "../src/api/files"
import type { PermissionDecision, PermissionRequest, PromptFile, Session as SessionInfo } from "../src/api/types"
import { ApprovalCard } from "../src/components/session/Approval"
import { Composer } from "../src/components/session/Composer"
import {
  AssistantText,
  buildItems,
  Note,
  Thinking,
  Thought,
  ToolGroup,
  TurnEnd,
  UserBubble,
  type Item,
  type Message,
} from "../src/components/session/Timeline"
import { useHosts } from "../src/state/hosts"
import { familyStatus, liveKey, useLive } from "../src/state/live"
import { useTheme } from "../src/theme"

const REFRESH_MS = 900

export default function Session() {
  const t = useTheme()
  const router = useRouter()
  const headerHeight = useHeaderHeight()
  const params = useLocalSearchParams<{ host: string; id: string; title: string }>()
  const { hosts, client } = useHosts()
  const c = client(params.host)
  const live = useLive(3000)
  const [messages, setMessages] = useState<Message[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [title, setTitle] = useState(params.title)
  const [atBottom, setAtBottom] = useState(true)
  const [sending, setSending] = useState(false)
  const directory = useRef("")
  const list = useRef<FlatList<Item>>(null)
  const pinned = useRef(true)
  const throttle = useRef<{ timer?: ReturnType<typeof setTimeout>; last: number }>({ last: 0 })

  const [subagents, setSubagents] = useState<SessionInfo[]>([])
  const [requests, setRequests] = useState<PermissionRequest[]>([])

  const status = requests.length ? "waiting" : familyStatus(live, params.host, [params.id, ...subagents.map((s) => s.id)])
  const running = status === "running" || sending
  const hostName = hosts.find((h) => h.id === params.host)?.name ?? ""

  // Subagents raise their own approvals, so the parent screen asks each running child as well.
  const runningChildren = subagents.filter((s) => live.running.has(liveKey(params.host, s.id))).map((s) => s.id).join(",")
  useEffect(() => {
    if (!c) return
    let cancelled = false
    const ids = [params.id, ...runningChildren.split(",").filter(Boolean)]
    const poll = () =>
      Promise.allSettled(ids.map((s) => c.sessionPermissions(s))).then((r) => {
        if (!cancelled) setRequests(r.flatMap((x) => (x.status === "fulfilled" ? x.value : [])))
      })
    poll()
    const timer = setInterval(poll, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [c, params.id, runningChildren])

  useEffect(() => {
    c?.children(params.id).then(setSubagents).catch(() => {})
  }, [c, params.id, messages.length])

  const decide = async (request: PermissionRequest, decision: PermissionDecision) => {
    if (!c) return
    await c.replyPermission(request.sessionID, request.id, decision)
    setRequests((r) => r.filter((x) => x.id !== request.id))
    live.refresh()
    scheduleRefresh()
  }

  const merge = useCallback((fresh: Message[]) => {
    setMessages((current) => {
      const ids = new Set(fresh.map((m) => m.id))
      return [...fresh, ...current.filter((m) => !ids.has(m.id))]
    })
  }, [])

  const refresh = useCallback(() => {
    if (!c) return Promise.resolve()
    return c
      .messages(params.id)
      .then((page) => {
        merge(page.data as Message[])
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [c, params.id, merge])

  // Streams emit many events per second; refetch at most every REFRESH_MS, always catching the trailing edge.
  const scheduleRefresh = useCallback(() => {
    const state = throttle.current
    if (state.timer) return
    const wait = Math.max(0, REFRESH_MS - (Date.now() - state.last))
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.last = Date.now()
      refresh()
    }, wait)
  }, [refresh])

  useEffect(() => {
    if (!c) return
    c.session(params.id)
      .then((s) => {
        directory.current = s.location?.directory ?? ""
        if (s.title) setTitle(s.title)
      })
      .catch(() => {})
    c.messages(params.id)
      .then((page) => {
        setMessages(page.data as Message[])
        setCursor(page.cursor.next ?? undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    const abort = new AbortController()
    const pending = throttle.current
    c.events((e) => {
      const data = e.data as { sessionID?: string }
      if (e.type === "server.connected") return
      if (data.sessionID && data.sessionID !== params.id) return
      scheduleRefresh()
    }, abort.signal)
    return () => {
      abort.abort()
      clearTimeout(pending.timer)
    }
  }, [c, params.id, scheduleRefresh])

  const older = useCallback(() => {
    if (!c || !cursor) return
    c.messages(params.id, cursor)
      .then((page) => {
        setMessages((m) => [...m, ...(page.data as Message[]).filter((x) => !m.some((y) => y.id === x.id))])
        setCursor(page.cursor.next ?? undefined)
      })
      .catch(() => {})
  }, [c, params.id, cursor])

  const items = useMemo(() => buildItems(messages), [messages])

  const openFile = useCallback(
    (rel: string) => {
      const path = joinPath(directory.current || "", rel)
      router.push({
        pathname: "/file",
        params: { host: params.host, directory: directory.current, path, name: rel.split(/[\\/]/).pop() },
      })
    },
    [router, params.host],
  )

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 96
    pinned.current = near
    if (near !== atBottom) setAtBottom(near)
  }

  const send = async (text: string, files: PromptFile[] = []) => {
    if (!c) return
    setSending(true)
    pinned.current = true
    try {
      const res = await c.prompt(params.id, text, files)
      // The list view exposes the user message with top-level text/files; echo the sent prompt from the
      // response itself so the bubble appears even if the very next list fetch races delivery.
      setMessages((m) => [
        {
          id: res.data.id,
          type: "user",
          text,
          files: files.map((f) => ({ data: f.uri.slice(f.uri.indexOf(",") + 1), mime: f.uri.slice(5, f.uri.indexOf(";")), name: f.name })),
          time: res.data.time ?? { created: Date.now() },
        },
        ...m.filter((x) => x.id !== res.data.id),
      ])
      await refresh()
      live.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    if (!c) return
    await c.interrupt(params.id).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    live.refresh()
    refresh()
  }

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === "user") return <UserBubble item={item} />
    if (item.kind === "text") return <AssistantText text={item.text} onFile={openFile} />
    if (item.kind === "thought") return <Thought text={item.text} />
    if (item.kind === "thinking") return <Thinking />
    if (item.kind === "tools") return <ToolGroup tools={item.tools} />
    if (item.kind === "end") return <TurnEnd outcome={item.outcome} time={item.time} />
    return <Note text={item.text} />
  }

  const statusLine =
    status === "waiting"
      ? { text: "Needs your approval", color: t.status.waiting }
      : running
        ? { text: "Working…", color: t.status.running }
        : { text: hostName ? `Idle · ${hostName}` : "Idle", color: t.tertiaryLabel }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headerTitle} accessible accessibilityRole="header">
              <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
                {title || "Session"}
              </Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: statusLine.color }]} />
                <Text style={[t.font.caption, { color: statusLine.color, fontWeight: "600" }]} numberOfLines={1}>
                  {statusLine.text}
                </Text>
              </View>
            </View>
          ),
        }}
      />

      {error.length > 0 && (
        <Pressable
          onPress={() => {
            setError("")
            refresh()
          }}
          style={[styles.banner, { backgroundColor: t.fill.secondary }]}
          accessibilityRole="button"
          accessibilityHint="Retries loading the session"
        >
          <Ionicons name="warning-outline" size={16} color={t.status.failed} />
          <Text style={[t.font.footnote, { color: t.label, flex: 1 }]} numberOfLines={2}>
            {error}
          </Text>
          <Text style={[t.font.footnote, { color: t.tint, fontWeight: "600" }]}>Retry</Text>
        </Pressable>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={t.tint} />
        </View>
      ) : (
        <FlatList
          ref={list}
          data={items}
          keyExtractor={(i) => i.key}
          renderItem={renderItem}
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={64}
          onStartReached={older}
          onStartReachedThreshold={0.5}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onContentSizeChange={() => {
            if (pinned.current) list.current?.scrollToEnd({ animated: false })
          }}
          ListHeaderComponent={
            cursor ? <ActivityIndicator style={{ marginVertical: 16 }} color={t.tertiaryLabel} /> : <View style={{ height: 8 }} />
          }
          ListFooterComponent={running && items[items.length - 1]?.kind !== "thinking" ? <Thinking /> : undefined}
          ListEmptyComponent={
            <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
              No messages yet. Send a prompt to get started.
            </Text>
          }
        />
      )}

      {!atBottom && !loading && (
        <Pressable
          onPress={() => {
            pinned.current = true
            list.current?.scrollToEnd({ animated: true })
          }}
          style={({ pressed }) => [
            styles.jump,
            { backgroundColor: t.surfaceRaised, borderColor: t.separator, opacity: pressed ? 0.8 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Jump to latest"
        >
          <Ionicons name="arrow-down" size={18} color={t.label} />
        </Pressable>
      )}

      {requests.map((r) => (
        <ApprovalCard
          key={r.id}
          request={r}
          context={r.sessionID === params.id ? undefined : `From subagent: ${subagents.find((s) => s.id === r.sessionID)?.title ?? r.sessionID}`}
          onDecide={decide}
        />
      ))}

      <Composer running={running} disabled={!c} onSend={send} onStop={stop} />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  headerTitle: { alignItems: "center", maxWidth: 240 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { paddingBottom: 16 },
  empty: { textAlign: "center", marginHorizontal: 32, marginTop: 60 },
  jump: {
    position: "absolute",
    right: 16,
    bottom: 96,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
})
