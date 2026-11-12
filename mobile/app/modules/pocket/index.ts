import { requireOptionalNativeModule } from "expo-modules-core"
import { Platform } from "react-native"

// Reads-and-clears the action stashed by the native Toggle Pocket Recording App
// Intent (modules/pocket/ios/PocketModule.swift). Null everywhere the intent does
// not exist (Android, Expo Go).
export function consumePendingIntentAction(): string | null {
  if (Platform.OS !== "ios") return null
  const pocket = requireOptionalNativeModule("Pocket")
  return pocket?.consumePendingIntentAction?.() ?? null
}
