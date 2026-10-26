import { useColorScheme } from "react-native"

export type Theme = ReturnType<typeof light>

const systemFont = {
  largeTitle: { fontSize: 34 },
  title1: { fontSize: 28 },
  title2: { fontSize: 22 },
  title3: { fontSize: 20 },
  headline: { fontSize: 17 },
  body: { fontSize: 17 },
  callout: { fontSize: 16 },
  subhead: { fontSize: 15 },
  footnote: { fontSize: 13 },
  caption: { fontSize: 12 },
} as const

const base = {
  space: { xs: 6, s: 10, m: 16, l: 24, xl: 34 },
  radius: { s: 8, m: 12, l: 18 },
  font: systemFont,
}

const light = () => ({
  ...base,
  background: "#F2F2F7",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  separator: "#C6C6C8",
  label: "#1C1C1E",
  secondaryLabel: "#3C3C43",
  tertiaryLabel: "#6E6E73",
  tint: "#007AFF",
  fill: {
    primary: "rgba(120,120,128,0.20)",
    secondary: "rgba(120,120,128,0.16)",
    tertiary: "rgba(118,118,128,0.12)",
  },
  status: {
    running: "#34C759",
    waiting: "#FF9F0A",
    done: "#8E8E93",
    failed: "#FF3B30",
  },
  codeBackground: "#F6F6F8",
})

const dark = () => ({
  ...base,
  background: "#000000",
  surface: "#1C1C1E",
  surfaceRaised: "#2C2C2E",
  separator: "#38383A",
  label: "#FFFFFF",
  secondaryLabel: "#EBEBF5",
  tertiaryLabel: "#98989F",
  tint: "#0A84FF",
  fill: {
    primary: "rgba(120,120,128,0.36)",
    secondary: "rgba(120,120,128,0.32)",
    tertiary: "rgba(118,118,128,0.24)",
  },
  status: {
    running: "#30D158",
    waiting: "#FFD60A",
    done: "#98989D",
    failed: "#FF453A",
  },
  codeBackground: "#1C1C1E",
})

export const useTheme = () => (useColorScheme() === "dark" ? dark() : light())

export const statusLabel = {
  running: "Running",
  waiting: "Needs you",
  done: "Done",
  failed: "Failed",
} as const

export type SessionStatus = keyof typeof statusLabel
