import { useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { Alert } from "react-native"
import { initializeNotifications } from "../notifications"
import { useHosts } from "../state/hosts"

export function NotificationRouting() {
  const router = useRouter()
  const { hosts, loading } = useHosts()
  const [pending, setPending] = useState<{ host: string; sessionID: string }>()
  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined
    initializeNotifications((host, sessionID) => { if (!disposed) setPending({ host, sessionID }) }).then((stop) => {
      if (disposed) stop()
      else cleanup = stop
    }).catch(() => Alert.alert("Push setup unavailable", "Notification registration could not start. Reopen the app to retry."))
    return () => { disposed = true; cleanup?.() }
  }, [])
  useEffect(() => {
    if (loading || !pending) return
    if (!hosts.some((h) => h.id === pending.host)) {
      Alert.alert("Host not paired", "Pair the notification’s execution host from Hosts before opening this session.")
      router.push("/(tabs)/hosts")
      return
    }
    router.push({ pathname: "/session", params: { host: pending.host, id: pending.sessionID } })
  }, [pending, hosts, loading, router])
  return null
}
