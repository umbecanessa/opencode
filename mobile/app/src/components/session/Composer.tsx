import Ionicons from "@expo/vector-icons/Ionicons"
import { useState } from "react"
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { PromptFile } from "../../api/types"
import { useTheme } from "../../theme"
import { useDictation, voiceLanguages } from "../../voice"

const MAX_FILES = 6

export const Composer = ({
  running,
  disabled,
  onSend,
  onStop,
}: {
  running: boolean
  disabled?: boolean
  onSend: (text: string, files: PromptFile[]) => Promise<void>
  onStop: () => Promise<void>
}) => {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<PromptFile[]>([])
  const [note, setNote] = useState("")
  const voice = useDictation(setText)
  const canSend = (text.trim().length > 0 || files.length > 0) && !busy && !disabled
  const showStop = running && !text.trim() && !voice.listening && files.length === 0

  const pick = async (source: "library" | "camera") => {
    setNote("")
    // Loaded lazily: the module throws at import on native builds that predate it, which would blank the screen.
    let ImagePicker: typeof import("expo-image-picker")
    try {
      ImagePicker = await import("expo-image-picker")
    } catch {
      setNote("Installing attachments needs a newer app build on this phone.")
      return
    }
    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) {
      setNote(source === "camera" ? "Allow camera access in Settings to take a photo." : "Allow photo library access in Settings.")
      return
    }
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            base64: true,
            quality: 0.8,
            allowsMultipleSelection: true,
            selectionLimit: MAX_FILES,
          })
    if (result.canceled) return
    const added = result.assets
      .filter((a) => a.base64)
      .map((a) => ({
        uri: `data:${a.mimeType ?? "image/jpeg"};base64,${a.base64}`,
        name: a.fileName ?? `photo-${Date.now()}.jpg`,
      }))
    setFiles((current) => [...current, ...added].slice(0, MAX_FILES))
  }

  const send = async () => {
    if (!canSend) return
    if (voice.listening) voice.stop()
    const value = text.trim()
    const attachments = files
    setBusy(true)
    setText("")
    setFiles([])
    await onSend(value, attachments).catch(() => {
      setText(value)
      setFiles(attachments)
    })
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
      {(note.length > 0 || voice.error.length > 0) && (
        <Text style={[t.font.footnote, styles.voiceError, { color: t.status.failed }]} numberOfLines={2}>
          {note || voice.error}
        </Text>
      )}
      {files.length > 0 && (
        <View style={styles.thumbs}>
          {files.map((f, i) => (
            <View key={f.uri.slice(0, 64) + i} style={[styles.thumbWrap, { borderColor: t.separator }]}>
              <Image source={{ uri: f.uri }} style={styles.thumb} />
              <Pressable
                onPress={() => setFiles((current) => current.filter((_, j) => j !== i))}
                hitSlop={6}
                style={[styles.thumbRemove, { backgroundColor: t.surfaceRaised }]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${f.name ?? "attachment"}`}
              >
                <Ionicons name="close" size={12} color={t.label} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View
        style={[
          styles.field,
          { backgroundColor: t.surface, borderColor: voice.listening ? t.status.failed : t.separator },
        ]}
      >
        <Pressable
          onPress={() => pick("library")}
          onLongPress={() => pick("camera")}
          delayLongPress={400}
          hitSlop={8}
          style={({ pressed }) => [styles.mic, { opacity: pressed ? 0.6 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel="Add a photo or screenshot"
          accessibilityHint="Long-press to use the camera"
        >
          <Ionicons name="add-circle-outline" size={21} color={t.secondaryLabel} />
        </Pressable>
        {voice.available && (
          <Pressable
            onPress={() => (voice.listening ? voice.stop() : voice.start(text))}
            hitSlop={8}
            style={({ pressed }) => [
              styles.mic,
              { backgroundColor: voice.listening ? t.status.failed : "transparent", opacity: pressed ? 0.7 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={voice.listening ? "Stop dictation" : "Dictate a message"}
          >
            <Ionicons name={voice.listening ? "mic" : "mic-outline"} size={20} color={voice.listening ? "#FFFFFF" : t.secondaryLabel} />
          </Pressable>
        )}
        {voice.listening && voiceLanguages.length > 1 && (
          <Pressable
            onPress={() => voice.switchLanguage(text)}
            hitSlop={8}
            style={[styles.lang, { backgroundColor: t.fill.secondary }]}
            accessibilityRole="button"
            accessibilityLabel={`Dictation language ${voice.lang}. Tap to switch.`}
          >
            <Text style={[t.font.caption, { color: t.label, fontWeight: "700" }]}>{voice.lang.slice(0, 2).toUpperCase()}</Text>
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={voice.listening ? "Listening…" : running ? "Steer the agent…" : "Message the agent"}
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
    paddingLeft: 5,
    paddingRight: 5,
    paddingVertical: 5,
    minHeight: 44,
  },
  input: { flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 132, paddingTop: 7, paddingBottom: 7, marginLeft: 8, marginRight: 8 },
  mic: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  thumbs: { flexDirection: "row", gap: 8, paddingHorizontal: 6, paddingBottom: 8 },
  thumbWrap: { width: 56, height: 56, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  thumb: { width: "100%", height: "100%" },
  thumbRemove: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  lang: { height: 26, minWidth: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", marginLeft: 4, marginBottom: 4, paddingHorizontal: 5 },
  voiceError: { paddingHorizontal: 8, paddingBottom: 6 },
  action: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
})
