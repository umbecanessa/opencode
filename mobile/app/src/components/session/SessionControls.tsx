import { useEffect, useState } from "react"
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import type { Client } from "../../api/client"
import { useTheme } from "../../theme"
import { buildItems, UserBubble, AssistantText, Thought, ToolGroup, TurnEnd, Note, Thinking, type Message } from "./Timeline"

export function SessionControls({ client, sessionID, directory, panel, onClose }: {
  client: Client; sessionID: string; directory: string; panel: "model" | "context" | "permissions" | undefined; onClose: () => void
}) {
  const t = useTheme()
  const [models, setModels] = useState<Awaited<ReturnType<Client["models"]>>["data"]>([])
  const [context, setContext] = useState<Message[]>([])
  const [provider, setProvider] = useState<string>()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [rules, setRules] = useState<NonNullable<Awaited<ReturnType<Client["permissions"]>>["permissions"]>>([])
  useEffect(() => {
    if (!panel) return
    let cancelled = false
    const load = panel === "model" ? client.models(directory).then((r) => { if (!cancelled) setModels(r.data) })
      : panel === "permissions" ? client.permissions(sessionID).then((r) => { if (!cancelled) setRules(r.permissions ?? []) })
      : client.context(sessionID).then((r) => { if (!cancelled) setContext(r.data as Message[]) })
    load.catch((e) => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [client, directory, sessionID, panel])
  const choose = async (model: typeof models[number], variant?: string) => {
    setBusy(true)
    await client.switchModel(sessionID, { providerID: model.providerID, modelID: model.modelID, variant })
      .then(onClose).catch((e) => setError(String(e)))
    setBusy(false)
  }
  return <Modal visible={!!panel} presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: t.background, padding: 20, paddingTop: 24 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <Text style={[t.font.headline, { color: t.label }]}>{panel === "model" ? "Model & reasoning" : panel === "permissions" ? "Session permissions" : "Active context"}</Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}><Text style={{ color: t.tint }}>Done</Text></Pressable>
      </View>
      {!!error && <Text style={{ color: t.status.failed }}>{error}</Text>}
      {busy && <ActivityIndicator color={t.tint} />}
      {panel === "model" && <TextInput value={search} onChangeText={setSearch} placeholder="Search all models" placeholderTextColor={t.tertiaryLabel}
        style={{ color: t.label, padding: 14, borderRadius: 12, backgroundColor: t.surface, marginBottom: 12 }} />}
      {panel === "model" && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 16 }} contentContainerStyle={{ gap: 8 }}>
        {[undefined, ...new Set(models.map((m) => m.providerID))].map((id) => <Pressable key={id ?? "all"} onPress={() => setProvider(id)} accessibilityRole="button" accessibilityState={{ selected: provider === id }}
          style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, backgroundColor: provider === id ? t.tint : t.surface }}>
          <Text style={{ color: provider === id ? "#FFFFFF" : t.label }}>{id ?? "All providers"}</Text>
        </Pressable>)}
      </ScrollView>}
      <ScrollView keyboardShouldPersistTaps="handled">
        {panel === "model" ? models.filter((m) => (!provider || m.providerID === provider) && `${m.name} ${m.providerID}`.toLowerCase().includes(search.toLowerCase())).map((m) =>
          <View key={`${m.providerID}/${m.id}`} style={{ backgroundColor: t.surface, borderRadius: 14, paddingHorizontal: 16, marginBottom: 8 }}>
            <Pressable disabled={busy} onPress={() => m.variants.length ? setSelected(`${m.providerID}/${m.id}`) : choose(m)} style={{ paddingVertical: 16 }}>
              <Text style={[t.font.body, { color: t.label }]}>{m.name}</Text>
              <Text style={[t.font.caption, { color: t.secondaryLabel }]}>{m.providerID}</Text>
            </Pressable>
            {selected === `${m.providerID}/${m.id}` && [undefined, ...m.variants.map((v) => v.id)].map((variant) =>
              <Pressable key={variant ?? "default"} disabled={busy} onPress={() => choose(m, variant)} style={{ padding: 14, marginLeft: 12 }}>
                <Text style={{ color: t.tint }}>{variant ?? "Default reasoning"}</Text>
              </Pressable>)}
          </View>) : panel === "permissions" ? <>
            <Text style={[t.font.subhead, { color: t.secondaryLabel, marginBottom: 16 }]}>These are this session’s explicit rules. Other access follows your desktop configuration. Tap a rule’s decision to change it.</Text>
            {!rules.length && <Text style={{ color: t.secondaryLabel }}>No session overrides. Desktop permission defaults apply.</Text>}
            {rules.map((rule, index) => <View key={`${rule.action}/${rule.resource}/${index}`} style={{ padding: 16, borderRadius: 14, backgroundColor: t.surface, marginBottom: 8 }}>
              <Text style={[t.font.body, { color: t.label }]}>{rule.action}</Text>
              <Text style={[t.font.caption, { color: t.secondaryLabel, marginVertical: 8 }]}>{rule.resource}</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(["ask", "allow", "deny"] as const).map((effect) => <Pressable key={effect} disabled={busy} onPress={async () => {
                  const next = rules.map((r, i) => i === index ? { ...r, effect } : r)
                  setBusy(true)
                  await client.setPermissions(sessionID, next).then(() => setRules(next)).catch((e) => setError(String(e)))
                  setBusy(false)
                }} style={{ padding: 12, borderRadius: 10, backgroundColor: rule.effect === effect ? t.tint : t.fill.secondary }}>
                  <Text style={{ color: rule.effect === effect ? "#FFFFFF" : t.label }}>{effect === "ask" ? "Ask" : effect === "allow" ? "Allow" : "Deny"}</Text>
                </Pressable>)}
              </View>
            </View>)}
          </> : <>
            <Text style={[t.font.subhead, { color: t.secondaryLabel, marginBottom: 16 }]}>{context.length} active messages since the latest compaction</Text>
            {buildItems([...context].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))).map((item) => <View key={item.key}>
              {item.kind === "user" ? <UserBubble item={item} /> : item.kind === "text" ? <AssistantText text={item.text} onFile={() => {}} />
                : item.kind === "tools" ? <ToolGroup tools={item.tools} /> : item.kind === "thought" ? <Thought text={item.text} />
                : item.kind === "end" ? <TurnEnd outcome={item.outcome} time={item.time} /> : item.kind === "thinking" ? <Thinking /> : <Note text={item.text} />}
            </View>)}
          </>}
      </ScrollView>
    </View>
  </Modal>
}
