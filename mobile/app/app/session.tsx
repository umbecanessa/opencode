import Ionicons from "@expo/vector-icons/Ionicons"
import { Stack, useLocalSearchParams, useRouter } from "expo-router"
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
import type { PermissionDecision, PermissionRequest, PromptFile, SessionForm, Session as SessionInfo } from "../src/api/types"
import { Question } from "../src/components/session/Question"
import { ApprovalCard } from "../src/components/session/Approval"
import { Composer } from "../src/components/session/Composer"
import { SessionControls } from "../src/components/session/SessionControls"
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
  const params = useLocalSearchParams<{ host: string; id: string; title: string }>()
  const { hosts, client } = useHosts()
  const c = client(params.host)
  const live = useLive(3000)
  const [messages, setMessages] = useState<Message[]>([])
  const [streamText, setStreamText] = useState<Record<string, { messageID: string; ordinal: number; text: string; created: number }>>({})
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [title, setTitle] = useState(params.title)
  const [atBottom, setAtBottom] = useState(true)
  const [sending, setSending] = useState(false)
  const [selectedModel, setSelectedModel] = useState<{ id: string; providerID: string; variant?: string }>()
  const [panel, setPanel] = useState<"model" | "context" | "permissions">()
  const [controlDirectory, setControlDirectory] = useState("")
  const directory = useRef("")
  const list = useRef<FlatList<Item>>(null)
  const pinned = useRef(true)
  const scrolling = useRef(false)
  const throttle = useRef<{ timer?: ReturnType<typeof setTimeout>; last: number }>({ last: 0 })

  const [subagents, setSubagents] = useState<SessionInfo[]>([])
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<SessionForm[]>([])
  const [changes, setChanges] = useState<Awaited<ReturnType<NonNullable<typeof c>["diff"]>>["data"]>([])

  useEffect(() => {
    if (!c) return
    let cancelled = false
    c.diff(params.id).then((page) => { if (!cancelled) setChanges(page.data) }).catch(() => {})
    return () => { cancelled = true }
  }, [c, params.id, messages])

  const status = requests.length ? "waiting" : familyStatus(live, params.host, [params.id, ...subagents.map((s) => s.id)])
  const running = status === "running" || sending
  const hostName = hosts.find((h) => h.id === params.host)?.name ?? ""

  // Subagents raise their own approvals, so the parent screen asks each running child as well.
  const runningChildren = subagents.filter((s) => live.running.has(liveKey(params.host, s.id))).map((s) => s.id).join(",")
  const activeSubagents = subagents.filter((s) => familyStatus(live, params.host, [s.id]) !== "done")
  useEffect(() => {
    if (!c) return
    let cancelled = false
    const ids = [params.id, ...runningChildren.split(",").filter(Boolean)]
    const poll = () =>
      Promise.allSettled(ids.map(async (s) => ({ permissions: await c.sessionPermissions(s), forms: await c.forms(s) }))).then((r) => {
        if (cancelled) return
        setRequests(r.flatMap((x) => x.status === "fulfilled" ? x.value.permissions : []))
        setForms(r.flatMap((x) => x.status === "fulfilled" ? x.value.forms : []))
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
        .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
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
        setSelectedModel(s.model)
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
      const data = e.data as { sessionID?: string; assistantMessageID?: string; ordinal?: number; delta?: string; text?: string }
      if (e.type === "server.connected") return
      if (data.sessionID && data.sessionID !== params.id) return
      if ((e.type === "session.text.delta" || e.type === "session.text.ended") && data.assistantMessageID && data.ordinal !== undefined) {
        const messageID = data.assistantMessageID
        const ordinal = data.ordinal
        const key = `${messageID}/${ordinal}`
        setStreamText((current) => ({ ...current, [key]: {
          messageID, ordinal,
          text: e.type === "session.text.ended" ? data.text ?? current[key]?.text ?? "" : (current[key]?.text ?? "") + (data.delta ?? ""),
          created: current[key]?.created ?? Date.now(),
        } }))
      }
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

  const items = useMemo(() => {
    const live = [...messages]
    Object.values(streamText).forEach((fragment) => {
      const index = live.findIndex((m) => m.id === fragment.messageID)
      const message = index >= 0 ? live[index] : { id: fragment.messageID, type: "assistant", time: { created: fragment.created }, content: [] }
      // Ordinals identify content parts, including tools and reasoning, in the assistant step.
      const content = [...(message.content ?? [])]
      const persisted = content[fragment.ordinal]
      if (persisted?.type === "text" && persisted.text.length >= fragment.text.length) return
      content[fragment.ordinal] = { type: "text", text: fragment.text }
      const updated = { ...message, content }
      if (index >= 0) live[index] = updated
      else live.unshift(updated)
    })
    return buildItems(live.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0)))
  }, [messages, streamText])

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
    // Content growth and programmatic scrolling also emit scroll events. Only a user's
    // scroll may unlock following; otherwise a streaming update can unlock itself.
    if (!scrolling.current) return
    pinned.current = near
    setAtBottom(near)
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
    if (item.kind === "tools") return <ToolGroup tools={item.tools} onBackground={c ? () => c.background(params.id) : undefined} />
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
      keyboardVerticalOffset={0}
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
          onScrollBeginDrag={() => { scrolling.current = true }}
          onScrollEndDrag={(e) => {
            onScroll(e)
            scrolling.current = false
          }}
          onMomentumScrollBegin={() => { scrolling.current = true }}
          onMomentumScrollEnd={(e) => {
            onScroll(e)
            scrolling.current = false
          }}
          scrollEventThrottle={64}
          onStartReached={older}
          onStartReachedThreshold={0.5}
          maintainVisibleContentPosition={atBottom ? undefined : { minIndexForVisible: 0 }}
          onLayout={() => {
            if (pinned.current) list.current?.scrollToEnd({ animated: false })
          }}
          onContentSizeChange={() => {
            if (pinned.current) list.current?.scrollToEnd({ animated: false })
          }}
          ListHeaderComponent={
            cursor ? <ActivityIndicator style={{ marginVertical: 16 }} color={t.tertiaryLabel} /> : <View style={{ height: 8 }} />
          }
          ListFooterComponent={
            <View style={{ paddingBottom: 12 }}>
              {changes.length > 0 && (
                <View style={{ marginHorizontal: 16, marginVertical: 8, borderRadius: 16, backgroundColor: t.surface, overflow: "hidden" }}>
                  <Text style={[t.font.subhead, { color: t.label, padding: 12 }]}>{changes.length} {changes.length === 1 ? "file changed" : "files changed"}</Text>
                  {changes.map((change) => (
                    <Pressable key={change.file} onPress={() => openFile(change.file)} accessibilityRole="button"
                      accessibilityLabel={`${change.file}, ${change.additions} lines added, ${change.deletions} lines removed`}
                      style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.separator }}>
                      <Ionicons name={change.status === "added" ? "document-outline" : "create-outline"} size={17} color={t.secondaryLabel} />
                      <Text numberOfLines={1} style={[t.font.subhead, { flex: 1, color: t.label }]}>{change.file.split(/[\\/]/).pop()}</Text>
                      <Text style={[t.font.caption, { color: t.status.running }]}>+{change.additions}</Text>
                      <Text style={[t.font.caption, { color: t.status.failed }]}>−{change.deletions}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {running && items[items.length - 1]?.kind !== "thinking" ? <Thinking /> : null}
            </View>
          }
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
            scrolling.current = false
            setAtBottom(true)
            list.current?.scrollToEnd({ animated: false })
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
      {forms.map((form) => <Question key={form.id} form={form} onAnswer={async (answer) => {
        if (!c) throw new Error("Host unavailable")
        await c.answerForm(form.sessionID, form.id, answer)
        setForms((all) => all.filter((f) => f.id !== form.id))
        live.refresh()
      }} />)}

      {c && <SessionControls client={c} sessionID={params.id} directory={controlDirectory} panel={panel} onClose={() => {
        setPanel(undefined)
        c.session(params.id).then((s) => setSelectedModel(s.model)).catch(() => {})
      }} />}
      {activeSubagents.length > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginHorizontal: 16, marginBottom: 8, marginTop: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: t.surface }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginRight: 2 }}>
            <ActivityIndicator size="small" color={t.tint} />
            <Text style={[t.font.footnote, { color: t.secondaryLabel }]}>{activeSubagents.length} subagent{activeSubagents.length === 1 ? "" : "s"} running</Text>
          </View>
          {activeSubagents.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => router.push({ pathname: "/session", params: { host: params.host, id: s.id, title: s.title } })}
              accessibilityRole="button"
              accessibilityLabel={`Open subagent ${s.title}`}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: pressed ? t.surfaceRaised : t.fill.secondary })}
            >
              <Ionicons name="git-branch-outline" size={11} color={t.secondaryLabel} />
              <Text numberOfLines={1} style={[t.font.caption, { color: t.secondaryLabel, maxWidth: 140 }]}>{s.agent ?? s.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Composer running={running} disabled={!c} onSend={send} onStop={stop}
        modelLabel={selectedModel ? `${selectedModel.id.split("/").pop()}${selectedModel.variant ? ` · ${selectedModel.variant}` : ""}` : undefined}
        activeModelLabel={messages.find((m) => m.type === "assistant" && m.model)?.model?.id?.split("/").pop()}
        onModel={() => { setControlDirectory(directory.current); setPanel("model") }}
        onContext={() => setPanel('context')}
      />
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

