import Ionicons from "@expo/vector-icons/Ionicons"
import { useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../../theme"

export const Composer = ({
  running,
  disabled,
  onSend,
  onStop,
}: {
  running: boolean
  disabled?: boolean
  onSend: (text: string) => Promise<void>
  onStop: () => Promise<void>
}) => {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const canSend = text.trim().length > 0 && !busy && !disabled
  const showStop = running && !text.trim()

  const send = async () => {
    if (!canSend) return
    const value = text.trim()
    setBusy(true)
    setText("")
    await onSend(value).catch(() => setText(value))
    setBusy(false)
  }

  const stop = async () => {
    setBusy(true)
    await onStop().catch(() => {})
    setBusy(false)
  }

  return (
    <View
      style={[
        styles.bar,
        { paddingBottom: Math.max(insets.bottom, 10), backgroundColor: t.background, borderTopColor: t.separator },
      ]}
    >
      <View style={[styles.field, { backgroundColor: t.surface, borderColor: t.separator }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={running ? "Steer the agent…" : "Message the agent"}
          placeholderTextColor={t.tertiaryLabel}
          multiline
          editable={!disabled}
          style={[styles.input, { color: t.label }]}
          accessibilityLabel="Message"
        />
        <Pressable
          onPress={showStop ? stop : send}
          disabled={showStop ? busy : !canSend}
          hitSlop={8}
          style={({ pressed }) => [
            styles.action,
            {
              backgroundColor: showStop ? t.label : canSend ? t.tint : t.fill.primary,
              opacity: pressed ? 0.75 : 1,
              transform: [{ scale: pressed ? 0.92 : 1 }],
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={showStop ? "Stop the agent" : "Send message"}
        >
          {busy ? (
            <ActivityIndicator size="small" color={showStop ? t.background : "#FFFFFF"} />
          ) : showStop ? (
            <Ionicons name="stop" size={14} color={t.background} />
          ) : (
            <Ionicons name="arrow-up" size={19} color={canSend ? "#FFFFFF" : t.tertiaryLabel} />
          )}
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  field: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 16,
    paddingRight: 5,
    paddingVertical: 5,
    minHeight: 44,
  },
  input: { flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 132, paddingTop: 7, paddingBottom: 7, marginRight: 8 },
  action: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
})
