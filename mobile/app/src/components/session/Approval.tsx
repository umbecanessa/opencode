import Ionicons from "@expo/vector-icons/Ionicons"
import { useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native"
import type { PermissionDecision, PermissionRequest } from "../../api/types"
import { useTheme } from "../../theme"

// Mirrors the desktop's settings.permissions.tool.*.description copy.
const DESCRIPTIONS: Record<string, string> = {
  read: "Reading a file (matches the file path)",
  edit: "Modify files, including edits, writes, and patches",
  glob: "Match files using glob patterns",
  grep: "Search file contents using regular expressions",
  list: "List files within a directory",
  bash: "Run shell commands",
  shell: "Run shell commands",
  task: "Launch sub-agents",
  skill: "Load a skill by name",
  lsp: "Run language server queries",
  todowrite: "Update the todo list",
  webfetch: "Fetch content from a URL",
  websearch: "Search the web",
  external_directory: "Access files outside the project directory",
  doom_loop: "Detect repeated tool calls with identical input",
}

const MAX_RESOURCES = 3

export const ApprovalCard = ({
  request,
  context,
  onDecide,
}: {
  request: PermissionRequest
  context?: string
  onDecide: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>
}) => {
  const t = useTheme()
  const [pending, setPending] = useState<PermissionDecision>()
  const [error, setError] = useState("")
  const description = request.message || DESCRIPTIONS[request.action] || request.action
  const extra = request.resources.length - MAX_RESOURCES

  const decide = async (decision: PermissionDecision) => {
    setPending(decision)
    setError("")
    await onDecide(request, decision).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    setPending(undefined)
  }

  const button = (decision: PermissionDecision, label: string, primary?: boolean) => (
    <Pressable
      onPress={() => decide(decision)}
      disabled={pending !== undefined}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? t.tint : t.fill.secondary,
          opacity: pending !== undefined && pending !== decision ? 0.5 : pressed ? 0.75 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {pending === decision ? (
        <ActivityIndicator size="small" color={primary ? "#FFFFFF" : t.label} />
      ) : (
        <Text
          style={[
            t.font.subhead,
            { fontWeight: "600", color: primary ? "#FFFFFF" : decision === "reject" ? t.status.failed : t.label },
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  )

  return (
    <View
      style={[styles.card, { backgroundColor: t.surfaceRaised, borderColor: t.status.waiting }]}
      accessibilityRole="alert"
    >
      <View style={styles.head}>
        <Ionicons name="hand-left" size={16} color={t.status.waiting} />
        <Text style={[t.font.headline, { color: t.label, fontWeight: "600", flex: 1 }]} numberOfLines={1}>
          Permission required
        </Text>
        <Text style={[t.font.caption, styles.action, { color: t.secondaryLabel, backgroundColor: t.fill.secondary }]}>
          {request.action}
        </Text>
      </View>
      {context && (
        <Text style={[t.font.footnote, { color: t.tertiaryLabel }]} numberOfLines={1}>
          {context}
        </Text>
      )}
      <Text style={[t.font.subhead, { color: t.secondaryLabel }]}>{description}</Text>
      {request.resources.length > 0 && (
        <View style={[styles.resources, { backgroundColor: t.codeBackground }]}>
          {request.resources.slice(0, MAX_RESOURCES).map((r) => (
            <Text key={r} style={[styles.resource, { color: t.label }]} numberOfLines={3} selectable>
              {r}
            </Text>
          ))}
          {extra > 0 && <Text style={[t.font.caption, { color: t.tertiaryLabel }]}>+{extra} more</Text>}
        </View>
      )}
      {error.length > 0 && <Text style={[t.font.footnote, { color: t.status.failed }]}>{error}</Text>}
      <View style={styles.actions}>
        {button("reject", "Deny")}
        {(request.save?.length ?? 0) > 0 && button("always", "Always allow")}
        {button("once", "Allow once", true)}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginBottom: 8, padding: 14, gap: 8, borderRadius: 16, borderWidth: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  action: { fontWeight: "600", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: "hidden" },
  resources: { padding: 10, borderRadius: 10, gap: 4 },
  resource: { fontFamily: "Menlo", fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: "row", gap: 8, marginTop: 2 },
  button: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
})
