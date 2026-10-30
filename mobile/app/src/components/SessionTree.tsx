import Ionicons from "@expo/vector-icons/Ionicons"
import { Pressable, StyleSheet, Text, View } from "react-native"
import type { Session } from "../api/types"
import { familyStatus, statusOf, type Live } from "../state/live"
import type { Family } from "../state/tree"
import { statusLabel, useTheme } from "../theme"
import { Row } from "./Rows"

export type TreeItem =
  | { kind: "parent"; key: string; family: Family; open: boolean }
  | { kind: "child"; key: string; session: Session; last: boolean }

export const flattenFamilies = (families: Family[], open: Set<string>): TreeItem[] =>
  families.flatMap((family) => {
    const key = `${family.session.host}/${family.session.id}`
    const isOpen = open.has(key)
    return [
      { kind: "parent" as const, key, family, open: isOpen },
      ...(isOpen
        ? family.children.map((session, i) => ({
            kind: "child" as const,
            key: `${session.host}/${session.id}`,
            session,
            last: i === family.children.length - 1,
          }))
        : []),
    ]
  })

export const TreeRow = ({
  item,
  first,
  last,
  hostName,
  live,
  showDirectory,
  onOpen,
  onToggle,
}: {
  item: TreeItem
  first: boolean
  last: boolean
  hostName: string
  live: Live
  showDirectory?: boolean
  onOpen: (session: Session) => void
  onToggle: (key: string) => void
}) => {
  const t = useTheme()
  if (item.kind === "child") return <ChildRow session={item.session} branchEnd={item.last} last={last} live={live} onOpen={onOpen} />
  const { session, children } = item.family
  const status = familyStatus(live, session.host, [session.id, ...children.map((c) => c.id)])
  // The chip tracks live activity, like the desktop's background-activity affordance: it counts subagents that
  // are running or waiting, and an idle family carries no chip once collapsed.
  const active = children.filter((c) => statusOf(live, c.host, c.id) !== "done")
  return (
    <Row
      first={first}
      last={last && !item.open}
      title={session.title}
      hostName={hostName}
      status={status}
      detail={showDirectory ? session.location?.directory?.split(/[\\/]/).pop() : undefined}
      onPress={() => onOpen(session)}
      accessory={
        (active.length > 0 || item.open) && (
          <Pressable
            onPress={() => onToggle(item.key)}
            hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            style={({ pressed }) => [styles.pill, { backgroundColor: item.open ? t.tint : t.fill.secondary, opacity: pressed ? 0.7 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={`${item.open ? "Hide" : "Show"} ${active.length || children.length} subagent${(active.length || children.length) === 1 ? "" : "s"}`}
          >
            <Ionicons name="git-branch-outline" size={11} color={item.open ? "#FFFFFF" : t.secondaryLabel} />
            <Text style={[t.font.caption, { color: item.open ? "#FFFFFF" : t.secondaryLabel, fontWeight: "600" }]}>
              {active.length || children.length}
            </Text>
            <Ionicons name={item.open ? "chevron-up" : "chevron-down"} size={11} color={item.open ? "#FFFFFF" : t.secondaryLabel} />
          </Pressable>
        )
      }
    />
  )
}

const ChildRow = ({
  session,
  branchEnd,
  last,
  live,
  onOpen,
}: {
  session: Session
  branchEnd: boolean
  last: boolean
  live: Live
  onOpen: (session: Session) => void
}) => {
  const t = useTheme()
  const status = statusOf(live, session.host, session.id)
  return (
    <Pressable
      onPress={() => onOpen(session)}
      style={({ pressed }) => [
        styles.child,
        { backgroundColor: pressed ? t.surfaceRaised : t.surface },
        last && styles.last,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Subagent ${session.agent ?? ""}: ${session.title}, ${statusLabel[status]}`}
    >
      <View style={styles.branch}>
        <View style={[styles.branchLine, { backgroundColor: t.separator, bottom: branchEnd ? "50%" : 0 }]} />
        <View style={[styles.branchTick, { backgroundColor: t.separator }]} />
      </View>
      <Ionicons name="git-branch-outline" size={15} color={status === "done" ? t.tertiaryLabel : t.status[status]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.font.subhead, { color: t.secondaryLabel, fontWeight: "500" }]} numberOfLines={1}>
          {session.title}
        </Text>
        <View style={styles.meta}>
          {session.agent && (
            <Text style={[t.font.caption, styles.agent, { color: t.tertiaryLabel, borderColor: t.separator }]}>{session.agent}</Text>
          )}
          {status !== "done" && (
            <Text style={[t.font.caption, { color: t.status[status], fontWeight: "600" }]}>{statusLabel[status]}</Text>
          )}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={14} color={t.tertiaryLabel} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  child: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    paddingLeft: 46,
    paddingRight: 14,
    paddingVertical: 9,
    minHeight: 48,
  },
  last: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  // Sits under the parent row's status dot (14pt padding + half of its 34pt badge).
  branch: { position: "absolute", left: 31, top: 0, bottom: 0, width: 12 },
  branchLine: { position: "absolute", left: 0, top: 0, width: StyleSheet.hairlineWidth * 2 },
  branchTick: { position: "absolute", left: 0, top: "50%", width: 10, height: StyleSheet.hairlineWidth * 2 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  agent: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 5, overflow: "hidden", textTransform: "lowercase" },
})
