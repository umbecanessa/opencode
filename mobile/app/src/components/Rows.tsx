import { Pressable, StyleSheet, Text, View } from "react-native"
import { useTheme } from "../theme"
import { statusLabel, type SessionStatus } from "../theme"

export const StatusDot = ({ status }: { status: SessionStatus }) => {
  const t = useTheme()
  return (
    <View style={[styles.dotWrap, { backgroundColor: t.fill.secondary }]}>
      <View style={[styles.dot, { backgroundColor: t.status[status] }]} />
      {status === "running" && <View style={[styles.pulse, { backgroundColor: t.status.running }]} />}
    </View>
  )
}

export const StatusText = ({ status }: { status: SessionStatus }) => {
  const t = useTheme()
  return (
    <Text style={[t.font.footnote, { color: t.status[status], fontWeight: "600" }]}>{statusLabel[status]}</Text>
  )
}

export const HostTag = ({ name }: { name: string }) => {
  const t = useTheme()
  return (
    <Text
      style={[
        t.font.caption,
        {
          color: t.tertiaryLabel,
          fontWeight: "600",
          backgroundColor: t.fill.secondary,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 6,
          overflow: "hidden",
        },
      ]}
    >
      {name.toUpperCase()}
    </Text>
  )
}

export const Row = ({
  title,
  status,
  hostName,
  detail,
  onPress,
}: {
  title: string
  status?: SessionStatus
  hostName: string
  detail?: string
  onPress: () => void
}) => {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: t.surface,
          borderBottomColor: t.separator,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      {status && <StatusDot status={status} />}
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.meta}>
          <HostTag name={hostName} />
          {detail && (
            <Text style={[t.font.caption, { color: t.tertiaryLabel }]} numberOfLines={1}>
              {detail}
            </Text>
          )}
        </View>
      </View>
      {status && <StatusText status={status} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  dotWrap: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", marginRight: 12 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  pulse: { position: "absolute", width: 9, height: 9, borderRadius: 5, opacity: 0.5 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
})
