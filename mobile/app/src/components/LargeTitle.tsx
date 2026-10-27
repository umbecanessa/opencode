import { StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../theme"

export const LargeTitle = ({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) => {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 12 }]}>
      <View style={styles.row}>
        <Text style={[t.font.largeTitle, styles.title, { color: t.label }]} numberOfLines={1}>
          {title}
        </Text>
        {action}
      </View>
      {subtitle && <Text style={[t.font.subhead, { color: t.tertiaryLabel }]}>{subtitle}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingBottom: 14, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { fontWeight: "800", letterSpacing: 0.3, flexShrink: 1 },
})
