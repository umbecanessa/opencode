import AsyncStorage from "@react-native-async-storage/async-storage"
import { Alert, Platform, TurboModuleRegistry } from "react-native"

export const ONESIGNAL_APP_ID = "198438f5-2341-421a-adcf-1891a4e0ba39"
const VERIFIED = "notifications.registration-dialog-shown"

// All SDK access stays here. Old development clients must remain usable before the native rebuild.
export async function initializeNotifications(onOpen?: (host: string, sessionID: string) => void): Promise<() => void> {
  if (Platform.OS !== "ios" || !TurboModuleRegistry.get("OneSignal")) return () => {}
  const { OneSignal, LogLevel } = await import("react-native-onesignal")
  OneSignal.Debug.setLogLevel(LogLevel.Warn)
  OneSignal.initialize(ONESIGNAL_APP_ID)
  const clicked = (event: { notification: { additionalData?: object } }) => {
    const data = event.notification.additionalData as { host?: unknown; sessionID?: unknown } | undefined
    if (typeof data?.host === "string" && typeof data.sessionID === "string" && /^ses_[A-Za-z0-9]+$/.test(data.sessionID)) onOpen?.(data.host, data.sessionID)
  }
  OneSignal.Notifications.addEventListener("click", clicked)
  let disposed = false
  let shown = await AsyncStorage.getItem(VERIFIED) === "true"
  const registered = async (id: string | null | undefined) => {
    if (disposed || shown || !id || id.startsWith("local-")) return
    shown = true
    await AsyncStorage.setItem(VERIFIED, "true")
    if (disposed) return
    Alert.alert("Your OneSignal SDK integration is complete!", "You can now send Push Notifications & In-App Messages through OneSignal. Tap below to enable push notifications.", [
      { text: "Got it", onPress: () => { OneSignal.Notifications.requestPermission(true).catch(() => Alert.alert("Notifications unavailable", "Check notification access for OpenCode Mobile in iPhone Settings.")) } },
    ], { cancelable: false })
  }
  const observer = (subscription: { current: { id?: string | null } }) => { void registered(subscription.current.id) }
  OneSignal.User.pushSubscription.addEventListener("change", observer)
  await OneSignal.User.pushSubscription.getIdAsync().then(registered)
  return () => {
    disposed = true
    OneSignal.User.pushSubscription.removeEventListener("change", observer)
    OneSignal.Notifications.removeEventListener("click", clicked)
  }
}
