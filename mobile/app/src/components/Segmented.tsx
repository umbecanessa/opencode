import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useTheme } from "../theme"

type Props = {
  values: string[]
  selectedIndex?: number
  onChange: (index: number) => void
  tintColor?: string
  style?: object
}

// In Expo Go the native iOS segmented control is unavailable; a guarded require
// keeps the module loadable there and falls back to a JS pill toggle.
const Native = (() => {
  try {
    const loaded = require("@react-native-segmented-control/segmented-control")
    const candidate = loaded?.default ?? loaded
    return candidate ? (candidate as React.ComponentType<any>) : undefined
  } catch {
    return undefined
  }
})()

export default function Segmented({ values, selectedIndex, onChange, style }: Props) {
  const t = useTheme()
  const [internal, setInternal] = useState(0)
  const index = selectedIndex ?? internal

  if (Native)
    return (
      <Native
        values={values}
        selectedIndex={index}
        onChange={(e: { nativeEvent: { selectedSegmentIndex: number } }) => onChange(e.nativeEvent.selectedSegmentIndex)}
        tintColor={t.tint}
        style={style}
      />
    )

  return (
    <View style={[styles.fallback, { backgroundColor: t.fill.secondary }, style]}>
      {values.map((value, i) => (
        <Pressable
          key={value}
          accessibilityRole="tab"
          accessibilityState={{ selected: i === index }}
          onPress={() => {
            setInternal(i)
            onChange(i)
          }}
          style={[styles.segment, { backgroundColor: i === index ? t.surface : "transparent" }]}
        >
          <Text style={[t.font.subhead, { color: i === index ? t.label : t.secondaryLabel, fontWeight: "600" }]} numberOfLines={1}>
            {value}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  fallback: { flexDirection: "row", borderRadius: 9, padding: 2, gap: 2 },
  segment: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 7 },
})
