import Ionicons from "@expo/vector-icons/Ionicons"
import { getImageAsync } from "expo-clipboard"
import { useState } from "react"
import { Modal, Pressable, Text, View } from "react-native"
import { useTheme } from "../../theme"

export function ImagePaste({ onImage }: { onImage: (uri: string) => void }) {
  const t = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const paste = async () => {
    setBusy(true)
    setError("")
    await getImageAsync({ format: "png" }).then((image) => {
      if (!image) {
        setError("No image received. Copy the screenshot and allow paste access if iOS asks.")
        return
      }
      onImage(image.data)
    }).catch(() => setError("Could not read the clipboard. Copy the screenshot and try again."))
    setBusy(false)
  }
  return <View style={{ maxWidth: 160 }}>
    <Pressable onPress={paste} disabled={busy} accessibilityRole="button" accessibilityLabel="Paste image from clipboard"
      style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: "center", alignItems: "center", borderRadius: 22, backgroundColor: t.fill.secondary }}>
      <Text style={[t.font.subhead, { color: t.label }]}>{busy ? "Pasting…" : "Paste image"}</Text>
    </Pressable>
    {!!error && <Text accessibilityRole="alert" style={[t.font.caption, { color: t.status.failed, marginTop: 8 }]}>{error}</Text>}
  </View>
}

export function Attachments({ visible, onClose, onDismiss, onChoose, onImage }: {
  visible: boolean; onClose: () => void; onDismiss: () => void;
  onChoose: (source: "library" | "camera" | "files") => void; onImage: (uri: string) => void
}) {
  const t = useTheme()
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss}>
    <View style={{ flex: 1, justifyContent: "flex-end" }}>
      <Pressable accessibilityLabel="Close attachments" onPress={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.4)" }} />
      <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 40 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <Text style={[t.font.headline, { color: t.label }]}>Add to prompt</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close attachments" style={{ padding: 10 }}>
            <Ionicons name="close" size={22} color={t.secondaryLabel} />
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", gap: 12, marginBottom: 24 }}>
          {([{ source: "library", icon: "images-outline", label: "Photos" }, { source: "camera", icon: "camera-outline", label: "Camera" }, { source: "files", icon: "document-outline", label: "Files" }] as const).map((item) =>
            <Pressable key={item.source} onPress={() => onChoose(item.source)} accessibilityRole="button" style={({ pressed }) => ({ flex: 1, alignItems: "center", paddingVertical: 20, gap: 10, borderRadius: 18, backgroundColor: t.fill.secondary, opacity: pressed ? 0.6 : 1 })}>
              <Ionicons name={item.icon} size={28} color={t.label} />
              <Text style={[t.font.subhead, { color: t.label }]}>{item.label}</Text>
            </Pressable>)}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={[t.font.subhead, { color: t.label }]}>Copied a screenshot?</Text>
            <Text style={[t.font.caption, { color: t.secondaryLabel, marginTop: 4 }]}>Paste it here to attach a preview.</Text>
          </View>
          <ImagePaste onImage={onImage} />
        </View>
      </View>
    </View>
  </Modal>
}
