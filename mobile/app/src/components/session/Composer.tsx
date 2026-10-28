import Ionicons from "@expo/vector-icons/Ionicons"
import { useEffect, useState } from "react"
import { ActivityIndicator, Alert, Image, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { PromptFile } from "../../api/types"
import { useTheme } from "../../theme"
import { useDictation } from "../../voice"

const MAX_FILES = 6

export const Composer = ({
  running,
  disabled,
  onSend,
  onStop,
  onModel,
  onContext,
  onPermissions,
}: {
  running: boolean
  disabled?: boolean
  onSend: (text: string, files: PromptFile[]) => Promise<void>
  onStop: () => Promise<void>
  onModel?: () => void
  onContext?: () => void
  onPermissions?: () => void
}) => {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<PromptFile[]>([])
  const [note, setNote] = useState("")
  const [keyboard, setKeyboard] = useState(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true))
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  const voice = useDictation(setText)
  const canSend = (text.trim().length > 0 || files.length > 0) && !busy && !disabled
  const showStop = running && !text.trim() && !voice.listening && files.length === 0

  const pickFiles = async () => {
    const { getDocumentAsync } = await import("expo-document-picker")
    const { File } = await import("expo-file-system")
    const result = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return
    const added = await Promise.all(result.assets.slice(0, MAX_FILES - files.length).map(async (asset) => {
      const file = new File(asset.uri)
      if (file.size > 20_000_000) throw new Error(`${asset.name} exceeds the 20 MB attachment limit.`)
      return { uri: `data:${asset.mimeType || "application/octet-stream"};base64,${await file.base64()}`, name: asset.name }
    }))
    setFiles((current) => [...current, ...added].slice(0, MAX_FILES))
  }

  const attachments = () => Alert.alert("Add to prompt", undefined, [
    { text: "Paste screenshot", onPress: () => pasteImage().catch((e) => setNote(String(e))) },
    { text: "Photos & screenshots", onPress: () => pick("library").catch((e) => setNote(String(e))) },
    { text: "Take a photo", onPress: () => pick("camera").catch((e) => setNote(String(e))) },
    { text: "Choose files", onPress: () => pickFiles().catch((e) => setNote(String(e))) },
    { text: "Cancel", style: "cancel" },
  ])

  const pasteImage = async () => {
    const { getImageAsync } = await import("expo-clipboard")
    const image = await getImageAsync({ format: "png" })
    if (!image) {
      setNote("No image was pasted. Copy a screenshot first and allow paste access if prompted.")
      return
    }
    setFiles((current) => [...current, { uri: image.data, name: `screenshot-${Date.now()}.png` }].slice(0, MAX_FILES))
    setNote("")
  }

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
        { paddingBottom: keyboard ? 6 : Math.max(insets.bottom, 10), backgroundColor: t.background, borderTopColor: t.separator },
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
              {f.uri.startsWith("data:image/") ? <Image source={{ uri: f.uri }} style={styles.thumb} /> : (
                <View style={[styles.thumb, { padding: 5, justifyContent: "center" }]}>
                  <Ionicons name="document-text-outline" size={20} color={t.label} />
                  <Text numberOfLines={1} style={{ color: t.label, fontSize: 10 }}>{f.name}</Text>
                </View>
              )}
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
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={voice.listening ? "Listening…" : running ? "Steer the agent…" : "Message the agent"}
          placeholderTextColor={t.tertiaryLabel}
          multiline
          editable={!disabled && !busy}
          style={[styles.input, { color: t.label, minHeight: focused ? 68 : 40 }]}
          accessibilityLabel="Message"
        />
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4 }}>
          <Pressable onPress={attachments} disabled={disabled || busy} accessibilityRole="button" accessibilityLabel="Add photos, camera photo, or files" style={styles.mic}>
            <Ionicons name="add" size={27} color={t.label} />
          </Pressable>
          <Pressable onPress={onPermissions} accessibilityRole="button" accessibilityLabel="Session permissions" style={styles.mic}>
            <Ionicons name="shield-checkmark-outline" size={21} color={t.secondaryLabel} />
          </Pressable>
          <Pressable onPress={onModel} accessibilityRole="button" accessibilityLabel="Select model and reasoning" style={{ padding: 10 }}>
            <Text style={{ color: t.secondaryLabel, fontSize: 13 }}>Model</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onContext} accessibilityRole="button" accessibilityLabel="View session context" style={styles.mic}>
            <Ionicons name="speedometer-outline" size={20} color={t.secondaryLabel} />
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
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  field: {
    flexDirection: "column",
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 5,
    paddingRight: 5,
    paddingVertical: 5,
    minHeight: 44,
  },
  input: { fontSize: 16, lineHeight: 22, maxHeight: 132, paddingTop: 12, paddingBottom: 10, marginLeft: 12, marginRight: 12 },
  mic: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
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
