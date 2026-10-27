import Ionicons from "@expo/vector-icons/Ionicons"
import { useRouter } from "expo-router"
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { LargeTitle } from "../../src/components/LargeTitle"
import { useHosts } from "../../src/state/hosts"
import { useLive } from "../../src/state/live"
import { useTheme } from "../../src/theme"

export default function Hosts() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, removeHost } = useHosts()
  const live = useLive()

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <LargeTitle
        title="Hosts"
        subtitle={hosts.length ? `${hosts.length} paired machine${hosts.length === 1 ? "" : "s"}` : undefined}
      />

      {hosts.length > 0 && (
        <View style={[styles.card, { backgroundColor: t.surface }]}>
          {hosts.map((item, i) => {
            const online = live.online[item.id]
            return (
              <View
                key={item.id}
                style={[
                  styles.row,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.separator },
                ]}
              >
                <View style={[styles.icon, { backgroundColor: t.fill.tertiary }]}>
                  <Ionicons name="desktop-outline" size={20} color={t.tint} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[t.font.headline, { color: t.label, fontWeight: "600" }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.meta}>
                    <View style={[styles.dot, { backgroundColor: online ? t.status.running : t.status.failed }]} />
                    <Text style={[t.font.footnote, { color: t.tertiaryLabel }]} numberOfLines={1}>
                      {online ? "Online" : "Unreachable"} · {item.origin.replace(/^https?:\/\//, "")}
                    </Text>
                  </View>
                </View>
                <Pressable
                  hitSlop={12}
                  onPress={() =>
                    Alert.alert("Remove host", `Forget ${item.name}? You will need a new pairing link to reconnect.`, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Remove", style: "destructive", onPress: () => removeHost(item.id) },
                    ])
                  }
                >
                  <Ionicons name="trash-outline" size={20} color={t.status.failed} />
                </Pressable>
              </View>
            )
          })}
        </View>
      )}

      {hosts.length === 0 && (
        <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
          No machines paired yet. Pair one to see its projects and sessions here.
        </Text>
      )}

      <Pressable
        onPress={() => router.push("/pair")}
        style={({ pressed }) => [
          styles.add,
          { backgroundColor: t.surface, opacity: pressed ? 0.7 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        ]}
      >
        <Ionicons name="add-circle" size={22} color={t.tint} />
        <Text style={[t.font.headline, { color: t.tint, fontWeight: "600" }]}>Pair a machine</Text>
      </Pressable>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, borderRadius: 14, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  empty: { textAlign: "center", marginHorizontal: 32, marginTop: 40, marginBottom: 8 },
  add: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 14,
  },
})
