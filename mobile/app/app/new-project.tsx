import Ionicons from "@expo/vector-icons/Ionicons"
import { useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { joinPath } from "../src/api/files"
import type { FileEntry } from "../src/api/types"
import { useHosts } from "../src/state/hosts"
import { useTheme } from "../src/theme"

// A project is born when a session starts in a directory, so "new project" is a directory picker
// that opens the first chat there. Browsing uses the same fs list the file viewer uses; hosts whose
// paths the server will not list fall back to a plain typed path.
export default function NewProject() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, client } = useHosts()
  const [hostID, setHostID] = useState<string>()
  const [dir, setDir] = useState("")
  const [projects, setProjects] = useState<{ name: string; dir: string }[]>([])
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const host = hostID ?? hosts[0]?.id
  const c = host ? client(host) : undefined

  // Switching machines resets the browse state; the initial pass over the default host fetches projects once.
  useEffect(() => {
    if (!c) return
    let cancelled = false
    c.projects()
      .then((list) => !cancelled && setProjects(list.map((p) => ({ name: p.name || p.canonical?.split(/[\\/]/).pop() || p.id, dir: p.canonical ?? "" })).filter((p) => p.dir)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [c, hostID])

  const browse = (path: string) => {
    if (!c) return
    setDir(path)
    setEntries([])
    c.fsList({ directory: path }, "")
      .then((r) => setEntries(r.data.filter((e) => e.type === "directory")))
      .catch(() => setNote("This machine will not list that path — type the folder path instead."))
  }

  const start = async () => {
    const directory = dir.trim().replace(/[\\/]+$/, "") || dir.trim()
    if (!c || !directory || busy) return
    setBusy(true)
    setNote("")
    try {
      const session = await c.createSession(directory)
      router.replace({ pathname: "/session", params: { host, id: session.id, title: session.title ?? "New chat" } })
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.background }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.wrap}>
        <Text style={[t.font.title2, { color: t.label, fontWeight: "700" }]}>New project</Text>
        <Text style={[t.font.callout, { color: t.secondaryLabel, marginBottom: t.space.l }]}>
          Pick a machine and a folder. The first chat you send there becomes the project.
        </Text>

        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>MACHINE</Text>
        <View style={styles.chips}>
          {hosts.map((h) => (
            <Pressable
              key={h.id}
              onPress={() => {
                if (h.id === host) return
                setHostID(h.id)
                setDir("")
                setEntries([])
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

        <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>FOLDER PATH</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={dir}
            onChangeText={(v) => { setDir(v); setEntries([]) }}
            placeholder="/home/user/code/my-app  or  C:\\dev\\my-app"
            placeholderTextColor={t.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { flex: 1, color: t.label, backgroundColor: t.surface }]}
          />
          <Pressable
            onPress={() => (browsing ? setBrowsing(false) : (setBrowsing(true), browse(dir.trim() || ".")))}
            accessibilityRole="button"
            accessibilityLabel="Browse folders"
            style={({ pressed }) => [styles.iconButton, { backgroundColor: browsing ? t.tint : t.fill.secondary, opacity: pressed ? 0.8 : 1 }]}
          >
            <Ionicons name="folder-outline" size={20} color={browsing ? "#FFFFFF" : t.secondaryLabel} />
          </Pressable>
        </View>

        {browsing && (
          <View style={[styles.browser, { backgroundColor: t.surface, borderColor: t.separator }]}>
            <View style={styles.browserBar}>
              <Pressable
                onPress={() => {
                  const parent = dir.trim().replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).join("/")
                  browse(parent.includes("/") || parent.includes(":") ? parent : ".")
                }}
                accessibilityRole="button"
                accessibilityLabel="Up one folder"
                style={styles.browserUp}
              >
                <Ionicons name="arrow-up-outline" size={16} color={t.secondaryLabel} />
              </Pressable>
              <Text style={[t.font.caption, { color: t.tertiaryLabel, flex: 1 }]} numberOfLines={1} ellipsizeMode="head">
                {dir.trim() || "."}
              </Text>
            </View>
            {entries.map((e) => (
              <Pressable
                key={e.path}
                onPress={() => browse(joinPath(dir.trim(), e.path))}
                accessibilityRole="button"
                style={({ pressed }) => [styles.browserRow, { borderTopColor: t.separator, backgroundColor: pressed ? t.surfaceRaised : "transparent" }]}
              >
                <Ionicons name="folder-outline" size={16} color={t.tint} />
                <Text style={[t.font.subhead, { color: t.label, flex: 1 }]} numberOfLines={1}>{e.path}</Text>
                <Ionicons name="chevron-forward" size={14} color={t.tertiaryLabel} />
              </Pressable>
            ))}
          </View>
        )}

        {projects.length > 0 && (
          <>
            <Text style={[t.font.footnote, styles.label, { color: t.tertiaryLabel }]}>EXISTING PROJECT FOLDERS</Text>
            <View style={styles.chips}>
              {projects.map((p) => (
                <Pressable key={p.dir} onPress={() => setDir(p.dir)} accessibilityRole="button" style={[styles.chip, { backgroundColor: t.fill.secondary }]}>
                  <Text style={[t.font.subhead, { color: t.secondaryLabel }]}>{p.name}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {!!note && <Text accessibilityRole="alert" style={[t.font.footnote, styles.note, { color: t.status.failed }]}>{note}</Text>}

        <Pressable
          onPress={start}
          disabled={busy || !dir.trim() || !c}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: dir.trim() && !busy ? t.tint : t.fill.primary,
              opacity: pressed ? 0.8 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text style={[t.font.headline, { color: dir.trim() && !busy ? "#FFFFFF" : t.secondaryLabel, fontWeight: "600" }]}>
            {busy ? "Starting…" : "Start project"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 28, paddingBottom: 40 },
  label: { fontWeight: "600", letterSpacing: 0.4, marginTop: 18, marginBottom: 6 },
  input: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, fontSize: 16 },
  iconButton: { width: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  browser: { marginTop: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  browserBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  browserUp: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(120,120,128,0.15)" },
  browserRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth },
  note: { marginTop: 14 },
  button: { alignItems: "center", paddingVertical: 15, borderRadius: 14, marginTop: 22 },
})
