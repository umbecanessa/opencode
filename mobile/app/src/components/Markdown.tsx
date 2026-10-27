import { useMemo } from "react"
import { Linking, StyleSheet, Text } from "react-native"
import MarkdownDisplay, { type RenderRules } from "react-native-markdown-display"
import { extractFiles } from "../api/files"
import { useTheme } from "../theme"

export const Markdown = ({ children, onFile, compact }: { children: string; onFile?: (path: string) => void; compact?: boolean }) => {
  const t = useTheme()

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: { color: t.label, fontSize: 16, lineHeight: compact ? 23 : 25 },
        paragraph: { marginTop: 0, marginBottom: compact ? 10 : 12 },
        heading1: { color: t.label, fontSize: compact ? 21 : 26, fontWeight: "700", marginTop: 14, marginBottom: 8 },
        heading2: { color: t.label, fontSize: compact ? 19 : 21, fontWeight: "700", marginTop: 12, marginBottom: 6 },
        heading3: { color: t.label, fontSize: 17, fontWeight: "700", marginTop: 10, marginBottom: 4 },
        strong: { fontWeight: "700" },
        bullet_list: { marginBottom: 10 },
        ordered_list: { marginBottom: 10 },
        list_item: { marginBottom: 4 },
        code_block: {
          backgroundColor: t.codeBackground,
          color: t.label,
          padding: 12,
          borderRadius: 10,
          borderWidth: 0,
          fontSize: 13,
          lineHeight: 19,
          fontFamily: "Menlo",
          marginBottom: 10,
        },
        fence: {
          backgroundColor: t.codeBackground,
          color: t.label,
          padding: 12,
          borderRadius: 10,
          borderWidth: 0,
          fontSize: 13,
          lineHeight: 19,
          fontFamily: "Menlo",
          marginBottom: 10,
        },
        code_inline: {
          backgroundColor: t.fill.tertiary,
          color: t.label,
          fontFamily: "Menlo",
          fontSize: 14,
          borderRadius: 4,
          borderWidth: 0,
          paddingHorizontal: 3,
        },
        link: { color: t.tint, textDecorationLine: "none" },
        blockquote: { borderLeftColor: t.separator, borderLeftWidth: 1, backgroundColor: "transparent", paddingLeft: 12, marginLeft: 0 },
        hr: { backgroundColor: t.separator, height: StyleSheet.hairlineWidth, marginVertical: 14 },
        table: { borderColor: t.separator, borderRadius: 8, marginBottom: 10 },
        th: { borderColor: t.separator, padding: 6 },
        td: { borderColor: t.separator, padding: 6 },
      }),
    [t, compact],
  )

  const rules = useMemo<RenderRules | undefined>(() => {
    if (!onFile) return undefined
    const fileStyle = { color: t.tint }
    return {
      text: (node, _children, _parent, s, inherited = {}) => (
        <Text key={node.key} style={[inherited, s.text]}>
          {extractFiles(node.content).map((seg, i) =>
            seg.file ? (
              <Text key={i} style={fileStyle} onPress={() => onFile(seg.text)} suppressHighlighting={false}>
                {seg.text}
              </Text>
            ) : (
              seg.text
            ),
          )}
        </Text>
      ),
      code_inline: (node, _children, _parent, s, inherited = {}) => {
        const isFile = extractFiles(node.content).some((seg) => seg.file && seg.text === node.content.trim())
        return (
          <Text
            key={node.key}
            style={[inherited, s.code_inline, isFile && fileStyle]}
            onPress={isFile ? () => onFile(node.content.trim()) : undefined}
          >
            {node.content}
          </Text>
        )
      },
    }
  }, [onFile, t])

  return (
    <MarkdownDisplay
      style={styles}
      rules={rules}
      onLinkPress={(url) => {
        Linking.openURL(url).catch(() => {})
        return false
      }}
    >
      {children}
    </MarkdownDisplay>
  )
}
