import { useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import type { FormValue, SessionForm } from "../../api/types"
import { useTheme } from "../../theme"

export function Question({ form, onAnswer }: { form: SessionForm; onAnswer: (answer: Record<string, FormValue>) => Promise<void> }) {
  const t = useTheme()
  const [answers, setAnswers] = useState<Record<string, FormValue>>(Object.fromEntries(form.fields.flatMap((f) => f.default === undefined ? [] : [[f.key, f.default]])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const active = form.fields.filter((f) => (f.when ?? []).every((condition) => {
    const value = answers[condition.key]
    if (value === undefined) return false
    const equal = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value
    return condition.op === "eq" ? equal : !equal
  }))
  const submit = async () => {
    const missing = active.find((f) => f.required && (answers[f.key] === undefined || answers[f.key] === "" || (Array.isArray(answers[f.key]) && !(answers[f.key] as string[]).length)))
    if (missing) { setError(`Answer ${missing.title ?? missing.key} before continuing.`); return }
    if (active.some((f) => f.type === "external")) { setError("This form requires an external authentication flow. Complete it on desktop."); return }
    setBusy(true)
    setError("")
    await onAnswer(Object.fromEntries(active.flatMap((f) => answers[f.key] === undefined ? [] : [[f.key, answers[f.key]]])))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    setBusy(false)
  }
  return <View style={{ marginHorizontal: 12, padding: 16, borderRadius: 16, backgroundColor: t.surfaceRaised, marginBottom: 8, maxHeight: 380 }}>
    <Text style={[t.font.headline, { color: t.label, marginBottom: 12 }]}>{form.title}</Text>
    <ScrollView keyboardShouldPersistTaps="handled">
      {active.filter((f) => !f.hidden).map((f) => <View key={f.key} style={{ marginBottom: 16 }}>
        <Text style={[t.font.subhead, { color: t.label, marginBottom: 6 }]}>{f.title ?? f.key}</Text>
        {!!f.description && <Text style={[t.font.caption, { color: t.secondaryLabel, marginBottom: 8 }]}>{f.description}</Text>}
        {f.type === "external" ? <Text style={{ color: t.secondaryLabel }}>Complete this authentication step on desktop.</Text>
          : f.type === "boolean" ? <View style={{ flexDirection: "row", gap: 8 }}>{[true, false].map((value) => <Pressable key={String(value)} disabled={busy} onPress={() => setAnswers((a) => ({ ...a, [f.key]: value }))} style={{ padding: 12, borderRadius: 10, backgroundColor: answers[f.key] === value ? t.tint : t.fill.secondary }}><Text style={{ color: answers[f.key] === value ? "#FFFFFF" : t.label }}>{value ? "Yes" : "No"}</Text></Pressable>)}</View>
          : <>
            {f.options?.map((option) => {
              const value = answers[f.key]
              const selected = Array.isArray(value) ? value.includes(option.value) : value === option.value
              return <Pressable key={option.value} disabled={busy} onPress={() => setAnswers((a) => ({ ...a, [f.key]: f.type === "multiselect" ? selected ? (Array.isArray(value) ? value : []).filter((v) => v !== option.value) : [...(Array.isArray(value) ? value : []), option.value] : option.value }))}
                accessibilityRole="button" accessibilityState={{ selected }} style={{ padding: 12, borderRadius: 10, marginBottom: 6, backgroundColor: selected ? t.tint : t.fill.secondary }}>
                <Text style={{ color: selected ? "#FFFFFF" : t.label }}>{option.label}</Text>
                {!!option.description && <Text style={[t.font.caption, { color: selected ? "#FFFFFF" : t.secondaryLabel }]}>{option.description}</Text>}
              </Pressable>
            })}
            {(!f.options?.length || f.custom) && <TextInput editable={!busy} placeholder={f.placeholder ?? (f.type === "multiselect" ? "Other answers, separated by commas" : "Your answer")} placeholderTextColor={t.tertiaryLabel}
              keyboardType={f.type === "number" || f.type === "integer" ? "numbers-and-punctuation" : "default"}
              value={Array.isArray(answers[f.key]) ? (answers[f.key] as string[]).join(", ") : String(answers[f.key] ?? "")}
              onChangeText={(text) => setAnswers((a) => ({ ...a, [f.key]: f.type === "number" || f.type === "integer" ? text === "" ? "" : Number(text) : f.type === "multiselect" ? text.split(",").map((v) => v.trim()).filter(Boolean) : text }))}
              style={{ padding: 12, color: t.label, borderRadius: 10, backgroundColor: t.fill.secondary }} />}
          </>}
      </View>)}
    </ScrollView>
    {!!error && <Text accessibilityRole="alert" style={{ color: t.status.failed, marginBottom: 8 }}>{error}</Text>}
    <Pressable disabled={busy} onPress={submit} accessibilityRole="button" style={{ minHeight: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: t.tint }}>
      {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={{ color: "#FFFFFF", fontWeight: "600" }}>Submit answers</Text>}
    </Pressable>
  </View>
}
