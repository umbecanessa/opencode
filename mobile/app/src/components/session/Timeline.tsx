import Ionicons from "@expo/vector-icons/Ionicons"
import { memo, useState } from "react"
import { ActivityIndicator, Image, LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useTheme } from "../../theme"
import { Markdown } from "../Markdown"

type ToolPart = {
  type: "tool"
  id: string
  name: string
  state: { status: string; input?: Record<string, unknown>; content?: unknown; error?: unknown }
}
type Part = { type: "text"; text: string } | { type: "reasoning"; text?: string } | ToolPart

export type Message = {
  id: string
  type: string
  time?: { created?: number; completed?: number }
  text?: string
  files?: { data: string; mime?: string; name?: string }[]
  content?: Part[]
  outcome?: string
  model?: { id?: string }
}

export type Item =
  | { kind: "user"; key: string; text: string; images: string[]; time?: number }
  | { kind: "text"; key: string; text: string }
  | { kind: "thought"; key: string; text: string }
  | { kind: "thinking"; key: string }
  | { kind: "tools"; key: string; tools: ToolPart[] }
  | { kind: "end"; key: string; outcome: string; time?: number }
  | { kind: "note"; key: string; text: string }

// Messages arrive newest-first; the timeline reads top-to-bottom, so build from the oldest.
export const buildItems = (newestFirst: Message[]): Item[] => {
  const chronological = [...newestFirst].reverse()
  const items: Item[] = []
  const pushTool = (tool: ToolPart) => {
    const last = items[items.length - 1]
    if (last?.kind === "tools") last.tools.push(tool)
    else items.push({ kind: "tools", key: `tools-${tool.id}`, tools: [tool] })
  }
  chronological.forEach((m, mi) => {
    if (m.type === "user") {
      items.push({
        kind: "user",
        key: m.id,
        text: m.text ?? "",
        images: (m.files ?? []).filter((f) => f.mime?.startsWith("image/")).map((f) => `data:${f.mime};base64,${f.data}`),
        time: m.time?.created,
      })
      return
    }
    if (m.type === "idle") {
      items.push({ kind: "end", key: m.id, outcome: m.outcome ?? "succeeded", time: m.time?.created })
      return
    }
    if (m.type === "model-switched") {
      items.push({ kind: "note", key: m.id, text: m.model?.id ? `Switched to ${shortModel(m.model.id)}` : "Model switched" })
      return
    }
    if (m.type !== "assistant") return
    const parts = m.content ?? []
    const streaming = !m.time?.completed && mi === chronological.length - 1
    parts.forEach((p, i) => {
      if (p.type === "tool") return pushTool(p)
      if (p.type === "text" && p.text.trim()) return items.push({ kind: "text", key: `${m.id}-${i}`, text: p.text })
      if (p.type === "reasoning") {
        if (p.text?.trim()) return items.push({ kind: "thought", key: `${m.id}-${i}`, text: p.text })
        if (streaming && i === parts.length - 1) items.push({ kind: "thinking", key: `${m.id}-${i}` })
      }
    })
  })
  return items
}

const shortModel = (id: string) => id.split("/").pop() ?? id

const clock = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""

export const UserBubble = memo(function UserBubble({ item }: { item: Extract<Item, { kind: "user" }> }) {
  const t = useTheme()
  return (
    <View style={styles.userWrap}>
      {item.images.length > 0 && (
        <View style={styles.images}>
          {item.images.map((uri, i) => (
            <Image key={i} source={{ uri }} style={[styles.image, { backgroundColor: t.fill.secondary }]} resizeMode="cover" />
          ))}
        </View>
      )}
      {item.text.length > 0 && (
        <View style={[styles.bubble, { backgroundColor: t.tint }]}>
          <Text style={styles.userText} selectable>
            {item.text}
          </Text>
        </View>
      )}
    </View>
  )
})

export const AssistantText = memo(function AssistantText({ text, onFile }: { text: string; onFile: (path: string) => void }) {
  return (
    <View style={styles.assistant}>
      <Markdown compact onFile={onFile}>
        {text}
      </Markdown>
    </View>
  )
})

export const Thought = ({ text }: { text: string }) => {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  return (
    <Pressable
      onPress={() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        setOpen((o) => !o)
      }}
      style={styles.thought}
      accessibilityRole="button"
      accessibilityLabel={open ? "Hide reasoning" : "Show reasoning"}
    >
      <View style={styles.thoughtHead}>
        <Ionicons name="bulb-outline" size={15} color={t.tertiaryLabel} />
        <Text style={[t.font.footnote, { color: t.tertiaryLabel, fontWeight: "600" }]}>Thought</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={13} color={t.tertiaryLabel} />
      </View>
      {open && <Text style={[t.font.subhead, styles.thoughtBody, { color: t.secondaryLabel }]}>{text.trim()}</Text>}
    </Pressable>
  )
}

export const Thinking = () => {
  const t = useTheme()
  return (
    <View style={[styles.thought, styles.thoughtHead]}>
      <ActivityIndicator size="small" color={t.tertiaryLabel} />
      <Text style={[t.font.footnote, { color: t.tertiaryLabel, fontWeight: "600" }]}>Thinking…</Text>
    </View>
  )
}

const TOOLS: Record<string, { icon: keyof typeof Ionicons.glyphMap; verb: string }> = {
  shell: { icon: "terminal-outline", verb: "Ran" },
  bash: { icon: "terminal-outline", verb: "Ran" },
  read: { icon: "document-text-outline", verb: "Read" },
  edit: { icon: "create-outline", verb: "Edited" },
  write: { icon: "document-outline", verb: "Wrote" },
  grep: { icon: "search-outline", verb: "Searched" },
  glob: { icon: "folder-open-outline", verb: "Found" },
  skill: { icon: "sparkles-outline", verb: "Loaded skill" },
  webfetch: { icon: "globe-outline", verb: "Fetched" },
  websearch: { icon: "globe-outline", verb: "Searched web" },
  subagent: { icon: "git-branch-outline", verb: "Delegated" },
  task: { icon: "git-branch-outline", verb: "Delegated" },
  question: { icon: "help-circle-outline", verb: "Asked" },
  execute: { icon: "code-slash-outline", verb: "Executed" },
}

const toolDetail = (tool: ToolPart) => {
  const input = tool.state.input ?? {}
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined)
  const command = pick("command")
  if (command) return command.split("\n").find((l) => l.trim())?.trim() ?? command
  const path = pick("path") ?? pick("filePath")
  const pattern = pick("pattern") ?? pick("query")
  if (pattern) return path ? `${pattern} in ${basename(path)}` : pattern
  if (path) return basename(path)
  return pick("url") ?? pick("id") ?? pick("description") ?? pick("name") ?? ""
}

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p

const toolOutput = (tool: ToolPart) => {
  const c = tool.state.content ?? tool.state.error
  if (typeof c === "string") return c
  if (Array.isArray(c))
    return c
      .map((x) => (x && typeof x === "object" && "text" in x && typeof x.text === "string" ? x.text : ""))
      .filter(Boolean)
      .join("\n")
  return ""
}

const toolInput = (tool: ToolPart) => {
  const input = tool.state.input ?? {}
  const command = input.command
  if (typeof command === "string") return command
  return JSON.stringify(input, null, 2)
}

const clip = (s: string, lines = 40) => {
  const all = s.split("\n")
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines` : s
}

const ToolRow = ({ tool, first }: { tool: ToolPart; first: boolean }) => {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const meta = TOOLS[tool.name] ?? { icon: "construct-outline" as const, verb: tool.name }
  const status = tool.state.status
  const failed = status === "error" || status === "failed"
  const running = status === "running" || status === "pending"
  const detail = toolDetail(tool)
  const output = open ? toolOutput(tool) : ""
  return (
    <View style={!first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.separator }}>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
          setOpen((o) => !o)
        }}
        style={({ pressed }) => [styles.toolRow, pressed && { backgroundColor: t.fill.tertiary }]}
        accessibilityRole="button"
        accessibilityLabel={`${meta.verb} ${detail}`}
        accessibilityHint={open ? "Hides details" : "Shows input and output"}
      >
        <Ionicons name={meta.icon} size={17} color={failed ? t.status.failed : t.secondaryLabel} style={styles.toolIcon} />
        <Text style={[t.font.subhead, styles.toolText]} numberOfLines={1}>
          <Text style={{ color: t.label, fontWeight: "600" }}>{meta.verb} </Text>
          <Text style={{ color: t.tertiaryLabel, fontFamily: tool.name === "shell" || tool.name === "bash" ? "Menlo" : undefined }}>
            {detail}
          </Text>
        </Text>
        {running && <ActivityIndicator size="small" color={t.tertiaryLabel} />}
        {failed && <Ionicons name="alert-circle" size={17} color={t.status.failed} />}
      </Pressable>
      {open && (
        <View style={styles.toolDetail}>
          <Text style={[t.font.caption, styles.toolLabel, { color: t.tertiaryLabel }]}>INPUT</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: t.codeBackground }]}>
            <Text style={[styles.codeText, { color: t.label }]} selectable>
              {clip(toolInput(tool), 30)}
            </Text>
          </ScrollView>
          {output.length > 0 && (
            <>
              <Text style={[t.font.caption, styles.toolLabel, { color: failed ? t.status.failed : t.tertiaryLabel }]}>
                {failed ? "ERROR" : "OUTPUT"}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: t.codeBackground }]}>
                <Text style={[styles.codeText, { color: t.secondaryLabel }]} selectable>
                  {clip(output)}
                </Text>
              </ScrollView>
            </>
          )}
        </View>
      )}
    </View>
  )
}

const COLLAPSE_AFTER = 4

export const ToolGroup = ({ tools }: { tools: ToolPart[] }) => {
  const t = useTheme()
  const [expanded, setExpanded] = useState(false)
  const hidden = expanded ? 0 : Math.max(0, tools.length - COLLAPSE_AFTER)
  const visible = tools.slice(hidden)
  return (
    <View style={[styles.toolCard, { backgroundColor: t.surface }]}>
      {hidden > 0 && (
        <Pressable
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
            setExpanded(true)
          }}
          style={({ pressed }) => [styles.toolRow, pressed && { backgroundColor: t.fill.tertiary }]}
          accessibilityRole="button"
        >
          <Ionicons name="layers-outline" size={17} color={t.tint} style={styles.toolIcon} />
          <Text style={[t.font.subhead, { color: t.tint, fontWeight: "600", flex: 1 }]}>
            {hidden} earlier step{hidden === 1 ? "" : "s"}
          </Text>
          <Ionicons name="chevron-down" size={14} color={t.tint} />
        </Pressable>
      )}
      {visible.map((tool, i) => (
        <ToolRow key={tool.id} tool={tool} first={i === 0 && hidden === 0} />
      ))}
    </View>
  )
}

export const TurnEnd = ({ outcome, time }: { outcome: string; time?: number }) => {
  const t = useTheme()
  const ok = outcome === "succeeded"
  const label = ok ? "Done" : outcome === "interrupted" || outcome === "cancelled" ? "Stopped" : "Failed"
  const color = ok ? t.tertiaryLabel : label === "Stopped" ? t.status.waiting : t.status.failed
  return (
    <View style={styles.end} accessibilityRole="text">
      <View style={[styles.endRule, { backgroundColor: t.separator }]} />
      <View style={styles.endLabel}>
        <Ionicons name={ok ? "checkmark-circle" : label === "Stopped" ? "stop-circle" : "close-circle"} size={13} color={color} />
        <Text style={[t.font.caption, { color, fontWeight: "600" }]}>
          {label}
          {time ? ` · ${clock(time)}` : ""}
        </Text>
      </View>
      <View style={[styles.endRule, { backgroundColor: t.separator }]} />
    </View>
  )
}

export const Note = ({ text }: { text: string }) => {
  const t = useTheme()
  return <Text style={[t.font.caption, styles.note, { color: t.tertiaryLabel }]}>{text}</Text>
}

const styles = StyleSheet.create({
  userWrap: { alignItems: "flex-end", paddingHorizontal: 16, marginTop: 18, marginBottom: 14, gap: 6 },
  images: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, maxWidth: "86%" },
  image: { width: 132, height: 176, borderRadius: 14 },
  bubble: { maxWidth: "86%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderBottomRightRadius: 6 },
  userText: { color: "#FFFFFF", fontSize: 16, lineHeight: 22 },
  assistant: { paddingHorizontal: 18, marginVertical: 4 },
  thought: { paddingHorizontal: 18, paddingVertical: 6 },
  thoughtHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  thoughtBody: { marginTop: 6, fontStyle: "italic", lineHeight: 21 },
  toolCard: { marginHorizontal: 16, marginVertical: 6, borderRadius: 14, overflow: "hidden" },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, minHeight: 44, paddingVertical: 10 },
  toolIcon: { width: 20, textAlign: "center" },
  toolText: { flex: 1 },
  toolDetail: { paddingHorizontal: 12, paddingBottom: 12, gap: 6 },
  toolLabel: { fontWeight: "700", letterSpacing: 0.6, marginTop: 4 },
  code: { borderRadius: 8, maxHeight: 280 },
  codeText: { fontFamily: "Menlo", fontSize: 12, lineHeight: 17, padding: 10 },
  end: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 24, marginTop: 14, marginBottom: 6 },
  endRule: { flex: 1, height: StyleSheet.hairlineWidth },
  endLabel: { flexDirection: "row", alignItems: "center", gap: 4 },
  note: { textAlign: "center", marginVertical: 10 },
})
