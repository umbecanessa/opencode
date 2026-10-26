import { useRouter } from "expo-router"
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import { useHosts } from "../../src/state/hosts"
import { useLive } from "../../src/state/live"
import { useTheme } from "../../src/theme"

export default function Hosts() {
  const t = useTheme()
  const router = useRouter()
  const { hosts, removeHost } = useHosts()
  const live = useLive()

  return (
    <FlatList
      contentContainerStyle={{ paddingTop: 120, paddingBottom: 120 }}
      data={hosts}
      keyExtractor={(h) => h.id}
      ListEmptyComponent={
        <Text style={[t.font.body, styles.empty, { color: t.tertiaryLabel }]}>
          No hosts paired yet. Add one from the button below.
        </Text>
      }
      renderItem={({ item }) => (
        <View style={[styles.row, { borderBottomColor: t.separator }]}>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={[t.font.title3, { color: t.label, fontWeight: "600" }]}>{item.name}</Text>
              <View
                style={[
                  styles.online,
                  { backgroundColor: live.online[item.id] ? t.status.running : t.status.failed },
                ]}
              />
            </View>
            <Text style={[t.font.footnote, { color: t.tertiaryLabel }]} numberOfLines={1}>
              {item.origin.replace(/^https?:\/\//, "")}
            </Text>
          </View>
          <Pressable
            onPress={() =>
              Alert.alert("Remove host", `Forget ${item.name}? You will need a new pairing link to reconnect.`, [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: () => removeHost(item.id) },
              ])
            }
            hitSlop={12}
          >
            <Text style={[t.font.subhead, { color: t.status.failed, fontWeight: "600" }]}>Remove</Text>
          </Pressable>
        </View>
      )}
    />
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 2 },
  online: { width: 8, height: 8, borderRadius: 4 },
  empty: { textAlign: "center", marginTop: 60 },
})
