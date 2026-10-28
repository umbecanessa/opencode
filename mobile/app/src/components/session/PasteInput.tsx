import { requireNativeView, requireOptionalNativeModule } from "expo"
import type { PasteEventPayload } from "expo-paste-input"
import type { ReactNode } from "react"
import { View, type ViewProps } from "react-native"

// Keep the current dev client usable until the native paste module is installed.
const NativePaste = requireOptionalNativeModule("ExpoPasteInput")
  ? requireNativeView<ViewProps & { onPaste: (event: { nativeEvent: PasteEventPayload }) => void; children: ReactNode }>("ExpoPasteInput")
  : undefined

export function PasteInput({ children, onImages, onError }: {
  children: ReactNode; onImages: (uris: string[]) => void; onError: () => void
}) {
  if (!NativePaste) return <View>{children}</View>
  return <NativePaste onPaste={({ nativeEvent }) => {
    if (nativeEvent.type === "images") onImages(nativeEvent.uris)
    if (nativeEvent.type === "unsupported") onError()
    // Native text paste already inserts text; do not insert it a second time.
  }}>{children}</NativePaste>
}
