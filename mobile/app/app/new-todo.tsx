import Ionicons from "@expo/vector-icons/Ionicons"
import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useRouter } from "expo-router"
import { relTime } from "../src/time"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

type ProjectPick = { id: string; name: string; dir: string }
type AgentSession = { id: string; title: string; agent?: string; updated: number }

// Add a todo to any project on any host. Picking a project collapses the chip wall and shows the
// project's sessions: tapping one addresses the todo to that session's agent, which is the whole
// point of assignment — the agent finds it when you tell it to check its todos. Leaving nothing
// picked keeps the todo open to anyone working in the project.
export default function NewTodo() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const [hostID, setHostID] = useState<string>()
  const [projects, setProjects] = useState<ProjectPick[]>([])
  const [project, setProject] = useState<ProjectPick>()
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [session, setSession] = useState<AgentSession>()
  const [dir, setDir] = useState("")
  const [text, setText] = useState("")
  const [assignText, setAssignText] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const host = hostID ?? hosts[0]?.id
  const c = host ? client(host) : undefined

  useEffect(() => {
    if (!c) return
    let cancelled = false
    c.projects()
      // Recent projects first, capped: the full set on a busy machine would be an unreadable chip wall.
      .then((list) =>
        !cancelled &&
        setProjects(
          [...list]
            .sort((a, b) => Math.max(b.time?.active ?? 0, b.time?.updated ?? 0) - Math.max(a.time?.active ?? 0, a.time?.updated ?? 0))
            .map((p) => ({ id: p.id, name: p.name || p.canonical?.split(/[\\/]/).pop() || p.id, dir: p.canonical ?? "" }))
            .filter((p) => p.dir)
            .slice(0, 12),
        ),
      )
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [c, hostID])

  const pickProject = (p: ProjectPick) => {
    setProject(p)
    setDir(p.dir)
    setSession(undefined)
    setSessions([])
    setNote("")
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
  }

  const clearProject = () => {
    setProject(undefined)
    setSessions([])
    setSession(undefined)
  }

  const submit = async () => {
    const directory = (project?.dir ?? dir).trim().replace(/[\\/]+$/, "") || (project?.dir ?? dir).trim()
    if (!c || !directory || text.trim() === "" || busy) return
    const assignee = project !== undefined ? (session === undefined ? undefined : (session.agent ?? session.id)) : assignText.trim() || undefined
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

  const ready = text.trim() !== "" && (project !== undefined || dir.trim() !== "") && !busy && !!c

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
                setDir("")
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

        {project === undefined ? (
          <>
            {projects.length > 0 && (
              <>
                <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>PROJECT</Text>
                <View style={styles.chips}>
                  {projects.map((p) => (
                    <Pressable key={p.id} onPress={() => pickProject(p)} accessibilityRole="button" style={[styles.chip, { backgroundColor: t.fill.secondary }]}>
                      <Text style={[t.font.subhead, { color: t.secondaryLabel }]}>{p.name}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}

            <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>PROJECT FOLDER</Text>
            <TextInput
              value={dir}
              onChangeText={setDir}
              placeholder="/home/user/code/my-app  or  C:\\dev\\my-app"
              placeholderTextColor={t.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: t.label, backgroundColor: t.surface }]}
            />

            <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>ASSIGN TO (OPTIONAL)</Text>
            <TextInput
              value={assignText}
              onChangeText={setAssignText}
              placeholder="agent name, session id, or all"
              placeholderTextColor={t.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: t.label, backgroundColor: t.surface }]}
            />
            <Text style={[t.font.caption, { color: t.tertiaryLabel, marginTop: 6 }]}>
              Pick a project chip instead to hand it to one of its agents. Anything unassigned stays open to anyone working in the project.
            </Text>
          </>
        ) : (
          <>
            <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>PROJECT</Text>
            <View style={[styles.selected, { backgroundColor: t.surface, borderColor: t.separator }]}>
              <View style={[styles.icon, { backgroundColor: t.fill.tertiary }]}>
                <Ionicons name="folder" size={16} color={t.tint} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={[t.font.subhead, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
                  {project.name}
                </Text>
                <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1} ellipsizeMode="middle">
                  {project.dir}
                </Text>
              </View>
              <Pressable onPress={clearProject} accessibilityRole="button" accessibilityLabel="Change project" hitSlop={10} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
                <Text style={[t.font.caption, { color: t.tint, fontWeight: "600" }]}>Change</Text>
              </Pressable>
            </View>

            <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>WHO SHOULD WORK ON IT</Text>
            {sessions.length === 0 ? (
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
                          {s.updated > 0 ? `${relTime(s.updated)} ago` : ""}
                        </Text>
                      </View>
                      {s.agent && (
                        <Text style={[t.font.caption, styles.chip, { color: t.tint, backgroundColor: t.fill.tertiary }]} numberOfLines={1}>
                          @{s.agent}
                        </Text>
                      )}
                    </Pressable>
                  )
                })}
              </View>
            )}
            <Text style={[t.font.caption, { color: t.tertiaryLabel, marginTop: 6 }]}>
              {session === undefined
                ? "Nothing picked: open to anyone in the project. Tap a session to hand the task to its agent."
                : `Addressed to ${session.agent === undefined ? "that session" : `@${session.agent}`}. Tap it again to open it back up.`}
            </Text>
          </>
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
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 24, paddingBottom: 40 },
  label: { fontWeight: "600", letterSpacing: 0.4, marginTop: 18, marginBottom: 6 },
  input: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: "hidden" },
  selected: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  list: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  sessionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  note: { marginTop: 14 },
  button: { alignItems: "center", paddingVertical: 15, borderRadius: 14, marginTop: 26 },
})
