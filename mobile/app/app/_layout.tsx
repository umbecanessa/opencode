import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { View, useColorScheme } from "react-native"
import { HostsProvider } from "../src/state/hosts"
import { useTheme } from "../src/theme"
import { initializeNotifications } from "../src/notifications"

export default function RootLayout() {
  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined
    initializeNotifications().then((stop) => {
      if (disposed) stop()
      else cleanup = stop
    }).catch(() => {})
    return () => { disposed = true; cleanup?.() }
  }, [])
  const t = useTheme()
  const dark = useColorScheme() === "dark"
  const base = dark ? DarkTheme : DefaultTheme
  return (
    <ThemeProvider
      value={{
        ...base,
        colors: {
          ...base.colors,
          primary: t.tint,
          background: t.background,
          card: t.surface,
          text: t.label,
          border: t.separator,
        },
      }}
    >
      <StatusBar style={dark ? "light" : "dark"} />
      <HostsProvider>
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: t.background },
            headerTitleStyle: { fontWeight: "700" },
            headerBackButtonDisplayMode: "minimal",
            // Opaque header: the iOS default blur can render transparent behind custom two-line titles.
            headerBackground: () => <View style={{ flex: 1, backgroundColor: t.background }} />,
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="pair" options={{ presentation: "modal", title: "Add host" }} />
          <Stack.Screen
            name="file"
            options={{
              presentation: "modal",
              headerShown: false,
              sheetAllowedDetents: [0.65, 0.95],
              sheetInitialDetentIndex: 0,
              sheetGrabberVisible: true,
              sheetCornerRadius: 18,
            }}
          />
          <Stack.Screen name="session" options={{ title: "Session" }} />
          <Stack.Screen name="project" options={{ title: "Project" }} />
        </Stack>
      </HostsProvider>
    </ThemeProvider>
  )
}
