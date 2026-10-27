import Ionicons from "@expo/vector-icons/Ionicons"
import { Tabs } from "expo-router"
import { useTheme } from "../../src/theme"

const iconColor = (color: unknown) => (typeof color === "string" ? color : undefined)

export default function TabsLayout() {
  const t = useTheme()
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: t.background },
        tabBarActiveTintColor: t.tint,
        tabBarInactiveTintColor: t.tertiaryLabel,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.separator },
        tabBarLabelStyle: { fontWeight: "600" },
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
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "server" : "server-outline"} size={26} color={iconColor(color)} />
          ),
        }}
      />
    </Tabs>
  )
}
