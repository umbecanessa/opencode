import { Stack } from "expo-router"
import { HostsProvider } from "../src/state/hosts"
import { useTheme } from "../src/theme"

export default function RootLayout() {
  const t = useTheme()
  return (
    <HostsProvider>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: t.background },
          headerLargeTitle: true,
          headerTransparent: true,
          headerBlurEffect: "systemChromeMaterial",
          headerTitleStyle: { fontWeight: "700" },
          headerLargeTitleStyle: { fontWeight: "800" },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ presentation: "modal", headerTitleAlign: "center", title: "Add host" }} />
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
        <Stack.Screen name="session" options={{ headerLargeTitle: false, title: "Session" }} />
        <Stack.Screen name="project" options={{ headerLargeTitle: false, title: "Project" }} />
      </Stack>
    </HostsProvider>
  )
}
