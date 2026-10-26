import Ionicons from "@expo/vector-icons/Ionicons"
import { Link, Tabs } from "expo-router"
import { Pressable } from "react-native"
import { useTheme } from "../../src/theme"

const iconColor = (color: unknown) => (typeof color === "string" ? color : undefined)

export default function TabsLayout() {
  const t = useTheme()
  const largeTitles = { headerLargeTitle: true, headerBlurEffect: "systemChromeMaterial" }
  return (
    <Tabs
      screenOptions={{
        ...largeTitles,
        headerTransparent: true,
        tabBarStyle: { backgroundColor: "transparent" },
        tabBarItemStyle: { paddingTop: 6 },
      }}
    >
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "pulse" : "pulse-outline"} size={26} color={iconColor(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "folder" : "folder-outline"} size={26} color={iconColor(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: "Hosts",
          headerRight: () => (
            <Link href="/pair" asChild>
              <Pressable hitSlop={12} style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
                <Ionicons name="add" size={28} color={t.tint} />
              </Pressable>
            </Link>
          ),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "server" : "server-outline"} size={26} color={iconColor(color)} />
          ),
        }}
      />
    </Tabs>
  )
}
