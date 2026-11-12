import Ionicons from "@expo/vector-icons/Ionicons"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { agoText } from "../src/time"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

type ProjectPick = { id: string; name: string; dir: string }
type AgentSession = { id: string; title: string; agent?: string; updated: number }

const basename = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir

// Add a todo to any project on any host. The layout is always the drill-in: pick a project
// (pre-selected when opened from a project's own +), and its agent sessions appear right there;
// tapping one addresses the todo to that agent, which is what "check your todos" then finds.
// The project list itself is a bottom-sliding page so any count of projects stays a clean list.
export default function NewTodo() {
  const t = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hosts, client } = useHosts()
  const params = useLocalSearchParams<{ host?: string; projectID?: string; projectName?: string; projectDir?: string }>()
  const [hostID, setHostID] = useState<string>()
  const [projects, setProjects] = useState<ProjectPick[]>([])
  const [project, setProject] = useState<ProjectPick>()
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [session, setSession] = useState<AgentSession>()
  const [text, setText] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetQuery, setSheetQuery] = useState("")
  const [sheetPath, setSheetPath] = useState("")
  // Opened from a project screen, that machine wins until the user taps a different chip.
  const host = hostID ?? (params.host !== undefined && hosts.some((h) => h.id === params.host) ? params.host : hosts[0]?.id)
  const c = host ? client(host) : undefined

  useEffect(() => {
    if (!c) return
    let cancelled = false
    c.projects()
      .then((list) =>
        !cancelled &&
        setProjects(
          [...list]
            .sort((a, b) => Math.max(b.time?.active ?? 0, b.time?.updated ?? 0) - Math.max(a.time?.active ?? 0, a.time?.updated ?? 0))
            .map((p) => ({ id: p.id, name: p.name || p.canonical?.split(/[\\/]/).pop() || p.id, dir: p.canonical ?? "" }))
            .filter((p) => p.dir),
        ),
      )
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [c])

  const pickProject = useCallback(
    (p: ProjectPick) => {
      setProject(p)
      setSession(undefined)
      setSessions([])
      setNote("")
      setSheetOpen(false)
      if (p.id === "") return
      c?.sessions(`project=${encodeURIComponent(p.id)}&limit=8&order=desc`)
        .then((page) =>
          setSessions(
            page.data.map((raw) => {
              const s = raw as { id: string; title?: string; agent?: string; time?: { updated?: number } }
              return { id: s.id, title: s.title || "Session", agent: s.agent, updated: s.time?.updated ?? 0 }
            }),
          ),
        )
        .catch(() => setSessions([]))
    },
    [c],
  )

  // Pre-select the project the screen was opened from, once its host's project list is in.
  const adopted = useRef(false)
  useEffect(() => {
    if (adopted.current || params.projectID === undefined || projects.length === 0) return
    adopted.current = true
    const found = projects.find((p) => p.id === params.projectID)
    pickProject(found ?? { id: params.projectID, name: params.projectName ?? params.projectID, dir: params.projectDir ?? "" })
  }, [projects, params.projectID, params.projectName, params.projectDir, pickProject])

  const clearProject = () => {
    setProject(undefined)
    setSessions([])
    setSession(undefined)
  }

  const submit = async () => {
    const directory = (project?.dir ?? "").trim().replace(/[\\/]+$/, "") || (project?.dir ?? "").trim()
    if (!c || !directory || text.trim() === "" || busy) return
    const assignee = project === undefined || project.id === "" || session === undefined ? undefined : (session.agent ?? session.id)
    setBusy(true)
    setNote("")
    try {
      await c.todoAdd(directory, text.trim(), assignee)
      router.back()
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const ready = text.trim() !== "" && (project?.dir ?? "") !== "" && !busy && !!c
  const query = sheetQuery.trim().toLowerCase()
  const sheetHits = projects.filter((p) => query === "" || p.name.toLowerCase().includes(query) || p.dir.toLowerCase().includes(query))

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.background }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>TASK</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="What needs doing?"
          placeholderTextColor={t.tertiaryLabel}
          style={[styles.input, { color: t.label, backgroundColor: t.surface }]}
          multiline
          autoFocus
        />

        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>MACHINE</Text>
        <View style={styles.chips}>
          {hosts.map((h) => (
            <Pressable
              key={h.id}
              onPress={() => {
                if (h.id === host) return
                setHostID(h.id)
                clearProject()
                setProjects([])
                setNote("")
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: h.id === host }}
              style={[styles.chip, { backgroundColor: h.id === host ? t.tint : t.fill.secondary, opacity: h.id === host ? 1 : 0.85 }]}
            >
              <Text style={[t.font.subhead, { color: h.id === host ? "#FFFFFF" : t.secondaryLabel, fontWeight: "600" }]}>{h.name}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>PROJECT</Text>
        <Pressable
          onPress={() => {
            setSheetQuery("")
            setSheetPath("")
            setSheetOpen(true)
          }}
          accessibilityRole="button"
          accessibilityLabel={project === undefined ? "Select project" : `Change project: ${project.name}`}
          style={({ pressed }) => [styles.selected, { backgroundColor: t.surface, borderColor: t.separator, opacity: pressed ? 0.85 : 1 }]}
        >
          <View style={[styles.icon, { backgroundColor: project === undefined ? t.fill.secondary : t.fill.tertiary }]}>
            <Ionicons name={project === undefined ? "folder-outline" : "folder"} size={16} color={project === undefined ? t.tertiaryLabel : t.tint} />
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            {project === undefined ? (
              <Text style={[t.font.subhead, { color: t.secondaryLabel, fontWeight: "600" }]}>Select project…</Text>
            ) : (
              <>
                <Text style={[t.font.subhead, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
                  {project.name}
                </Text>
                {project.dir !== "" && (
                  <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1} ellipsizeMode="middle">
                    {project.dir}
                  </Text>
                )}
              </>
            )}
          </View>
          <Ionicons name={project === undefined ? "chevron-forward" : "swap-horizontal"} size={18} color={t.tertiaryLabel} />
        </Pressable>

        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>WHO SHOULD WORK ON IT</Text>
        {project === undefined ? (
          <Text style={[t.font.caption, { color: t.tertiaryLabel }]}>Select a project to pick the agent that will work on it.</Text>
        ) : sessions.length === 0 ? (
          <Text style={[t.font.caption, { color: t.tertiaryLabel }]}>
            No recent sessions here — the todo goes to the project itself, and any agent working in it will see it.
          </Text>
        ) : (
          <View style={[styles.list, { backgroundColor: t.surface, borderColor: t.separator }]}>
            {sessions.map((s, i) => {
              const picked = session?.id === s.id
              return (
                <Pressable
                  key={s.id}
                  onPress={() => setSession(picked ? undefined : s)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: picked }}
                  style={({ pressed }) => [
                    styles.sessionRow,
                    {
                      borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: t.separator,
                      backgroundColor: picked ? t.fill.tertiary : pressed ? t.surfaceRaised : "transparent",
                    },
                  ]}
                >
                  <Ionicons name={picked ? "checkmark-circle" : "ellipse-outline"} size={20} color={picked ? t.tint : t.tertiaryLabel} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={[t.font.subhead, { color: t.label }]} numberOfLines={1}>
                      {s.title}
                    </Text>
                    <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1}>
                      {s.updated > 0 ? agoText(s.updated) : ""}
                    </Text>
                  </View>
                  {s.agent && (
                    <Text style={[t.font.caption, styles.tag, { color: t.tint, backgroundColor: t.fill.tertiary }]} numberOfLines={1}>
                      @{s.agent}
                    </Text>
                  )}
                </Pressable>
              )
            })}
          </View>
        )}
        {project !== undefined && sessions.length > 0 && (
          <Text style={[t.font.caption, { color: t.tertiaryLabel, marginTop: 6 }]}>
            {session === undefined
              ? "Nothing picked: open to anyone in the project. Tap a session to hand the task to its agent."
              : `Addressed to ${session.agent === undefined ? "that session" : `@${session.agent}`}. Tap it again to open it back up.`}
          </Text>
        )}

        {!!note && <Text accessibilityRole="alert" style={[t.font.footnote, styles.note, { color: t.status.failed }]}>{note}</Text>}

        <Pressable
          onPress={submit}
          disabled={!ready}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: ready ? t.tint : t.fill.primary,
              opacity: pressed ? 0.8 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text style={[t.font.headline, { color: ready ? "#FFFFFF" : t.secondaryLabel, fontWeight: "600" }]}>
            {busy ? "Adding…" : "Add todo"}
          </Text>
        </Pressable>
      </ScrollView>

      <Modal visible={sheetOpen} animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <View style={{ flex: 1, backgroundColor: t.background, paddingTop: insets.top + 8 }}>
          <View style={styles.sheetBar}>
            <Text style={[t.font.title3, { color: t.label, fontWeight: "700", flex: 1 }]} numberOfLines={1}>
              Select project
            </Text>
            <Pressable onPress={() => setSheetOpen(false)} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
              <Ionicons name="close-circle" size={22} color={t.tertiaryLabel} />
            </Pressable>
          </View>
          <View style={[styles.sheetSearch, { backgroundColor: t.surface, borderColor: t.separator }]}>
            <Ionicons name="search" size={15} color={t.tertiaryLabel} />
            <TextInput
              value={sheetQuery}
              onChangeText={setSheetQuery}
              placeholder="Search projects and folders"
              placeholderTextColor={t.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              style={[t.font.subhead, styles.searchInput, { color: t.label }]}
            />
          </View>
          <FlatList
            keyboardShouldPersistTaps="handled"
            data={sheetHits}
            keyExtractor={(p) => p.id}
            style={{ flex: 1 }}
            ListEmptyComponent={
              projects.length === 0 ? (
                <Text style={[t.font.caption, styles.sheetEmpty, { color: t.tertiaryLabel }]}>
                  No projects seen on this machine yet — use a folder path below, or start a chat in the folder first.
                </Text>
              ) : (
                <Text style={[t.font.caption, styles.sheetEmpty, { color: t.tertiaryLabel }]}>Nothing matches that search.</Text>
              )
            }
            renderItem={({ item }) => {
              const current = project?.id === item.id
              return (
                <Pressable
                  onPress={() => pickProject(item)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: current }}
                  style={({ pressed }) => [styles.sheetRow, { backgroundColor: pressed ? t.surfaceRaised : "transparent" }]}
                >
                  <Ionicons name={current ? "checkmark-circle" : "folder"} size={18} color={current ? t.tint : t.tertiaryLabel} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={[t.font.subhead, { color: t.label }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1} ellipsizeMode="middle">
                      {item.dir}
                    </Text>
                  </View>
                </Pressable>
              )
            }}
            ListFooterComponent={
              <View style={[styles.folderRow, { borderTopColor: t.separator, paddingBottom: insets.bottom + 12 }]}>
                <TextInput
                  value={sheetPath}
                  onChangeText={setSheetPath}
                  placeholder="…or any folder path on this machine"
                  placeholderTextColor={t.tertiaryLabel}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[t.font.subhead, styles.folderInput, { color: t.label, backgroundColor: t.surface, borderColor: t.separator }]}
                />
                <Pressable
                  onPress={() => {
                    const dir = sheetPath.trim()
                    if (dir === "") return
                    pickProject({ id: "", name: basename(dir), dir })
                  }}
                  accessibilityRole="button"
                  disabled={sheetPath.trim() === ""}
                  style={({ pressed }) => [styles.folderGo, { backgroundColor: sheetPath.trim() === "" ? t.fill.primary : t.tint, opacity: pressed ? 0.8 : 1 }]}
                >
                  <Text style={[t.font.caption, { color: sheetPath.trim() === "" ? t.tertiaryLabel : "#FFFFFF", fontWeight: "700" }]}>Use</Text>
                </Pressable>
              </View>
            }
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 24, paddingBottom: 40 },
  label: { fontWeight: "600", letterSpacing: 0.4, marginTop: 18, marginBottom: 6 },
  input: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: "hidden" },
  selected: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  list: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  sessionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  note: { marginTop: 14 },
  button: { alignItems: "center", paddingVertical: 15, borderRadius: 14, marginTop: 26 },
  sheetBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 10 },
  sheetSearch: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, paddingVertical: 2 },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 11 },
  sheetEmpty: { textAlign: "center", marginHorizontal: 24, marginTop: 28, lineHeight: 19 },
  folderRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  folderInput: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  folderGo: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10 },
})
