import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { Client } from "../api/client"
import type { Host, HostID } from "../api/types"

const HOSTS_KEY = "hosts"
// SecureStore keys allow only [A-Za-z0-9.-_]; origins carry ":" as host:port separator.
const tokenKey = (id: HostID) => `token_${id.replace(/[^a-zA-Z0-9._-]/g, "_")}`

type HostsState = {
  hosts: Host[]
  loading: boolean
  client: (id: HostID) => Client | undefined
  addHost: (name: string, link: string) => Promise<void>
  removeHost: (id: HostID) => Promise<void>
}

const HostsContext = createContext<HostsState | undefined>(undefined)

export const HostsProvider = ({ children }: { children: React.ReactNode }) => {
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [tokens, setTokens] = useState<Record<HostID, string>>({})

  useEffect(() => {
    ;(async () => {
      const stored = await AsyncStorage.getItem(HOSTS_KEY)
      const list: Host[] = stored ? JSON.parse(stored) : []
      const entries = await Promise.all(
        list.map(async (h) => [h.id, (await SecureStore.getItemAsync(tokenKey(h.id))) ?? ""] as const),
      )
      setHosts(list)
      setTokens(Object.fromEntries(entries.filter(([, t]) => t)))
      setLoading(false)
    })()
  }, [])

  const persist = async (list: Host[]) => {
    setHosts(list)
    await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(list))
  }

  const value = useMemo<HostsState>(
    () => ({
      hosts,
      loading,
      client: (id) => {
        const host = hosts.find((h) => h.id === id)
        const token = tokens[id]
        return host && token ? new Client(host, token) : undefined
      },
      addHost: async (name, link) => {
        const { origin, token } = await Client.redeem(link)
        const clash = hosts.find((h) => h.origin === origin)
        if (clash) {
          await SecureStore.setItemAsync(tokenKey(clash.id), token)
          setTokens((t) => ({ ...t, [clash.id]: token }))
          return
        }
        const host: Host = { id: origin, name, origin, pairedAt: new Date().toISOString() }
        await SecureStore.setItemAsync(tokenKey(host.id), token)
        setTokens((t) => ({ ...t, [host.id]: token }))
        await persist([...hosts, host])
      },
      removeHost: async (id) => {
        await SecureStore.deleteItemAsync(tokenKey(id))
        setTokens((t) => {
          const { [id]: _drop, ...rest } = t
          return rest
        })
        await persist(hosts.filter((h) => h.id !== id))
      },
    }),
    [hosts, tokens, loading],
  )

  return <HostsContext.Provider value={value}>{children}</HostsContext.Provider>
}

export const useHosts = () => {
  const value = useContext(HostsContext)
  if (!value) throw new Error("useHosts outside HostsProvider")
  return value
}
