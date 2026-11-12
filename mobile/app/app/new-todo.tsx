import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useRouter } from "expo-router"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

// Add a todo to any project on any host, even one with no todos yet (the tab's per-group "+"
// only reaches projects that already have rows). Projects come from the host's project list;
// a path not in that list (a not-yet-visited directory) can be typed directly.
export default function NewTodo() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const [hostID, setHostID] = useState<string>()
  const [projects, setProjects] = useState<{ name: string; dir: string }[]>([])
  const [dir, setDir] = useState("")
  const [text, setText] = useState("")
  const [assignee, setAssignee] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const host = hostID ?? hosts[0]?.id
  const c = host ? client(host) : undefined

  useEffect(() => {
    if (!c) return
    let cancelled = false
    c.projects()
      .then((list) =>
        !cancelled &&
        setProjects(
          list
            .map((p) => ({ name: p.name || p.canonical?.split(/[\\/]/).pop() || p.id, dir: p.canonical ?? "" }))
            .filter((p) => p.dir),
        ),
      )
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [c, hostID])

  const submit = async () => {
    const directory = dir.trim().replace(/[\\/]+$/, "") || dir.trim()
    if (!c || !directory || text.trim() === "" || busy) return
    setBusy(true)
    setNote("")
    try {
      await c.todoAdd(directory, text.trim(), assignee.trim() === "" ? undefined : assignee.trim())
      router.back()
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const ready = text.trim() !== "" && dir.trim() !== "" && !busy && !!c

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

        {projects.length > 0 && (
          <>
            <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>PROJECT</Text>
            <View style={styles.chips}>
              {projects.map((p) => (
                <Pressable
                  key={p.dir}
                  onPress={() => setDir(p.dir)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: dir === p.dir }}
                  style={[styles.chip, { backgroundColor: dir === p.dir ? t.tint : t.fill.secondary }]}
                >
                  <Text style={[t.font.subhead, { color: dir === p.dir ? "#FFFFFF" : t.secondaryLabel }]}>{p.name}</Text>
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
          value={assignee}
          onChangeText={setAssignee}
          placeholder="agent name, session id, or all"
          placeholderTextColor={t.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: t.label, backgroundColor: t.surface }]}
        />
        <Text style={[t.font.caption, { color: t.tertiaryLabel, marginTop: 6 }]}>
          Leave empty to leave it open to anyone working in the project. Agents see their own and unassigned items when they check their todos.
        </Text>

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
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  note: { marginTop: 14 },
  button: { alignItems: "center", paddingVertical: 15, borderRadius: 14, marginTop: 26 },
})
