import { Redirect } from "expo-router"
import { useHosts } from "../src/state/hosts"

export default function Index() {
  const { hosts, loading } = useHosts()
  if (loading) return null
  return <Redirect href={hosts.length ? "/(tabs)/activity" : "/pair?first=1"} />
}
