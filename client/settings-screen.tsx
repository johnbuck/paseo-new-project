import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { settings, type SettingsValues } from "../shared/settings";
import { FieldLabel } from "./ui";

type MaybeError = string | null;
type DelayText = string | null;

interface ProfileOption {
  id: string;
  name: string;
}

export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const settingsState = useSettings(settings);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [draft, setDraft] = useState<SettingsValues | null>(null);
  const [savedAt, setSavedAt] = useState<MaybeError>(null);
  const [delayText, setDelayText] = useState<DelayText>(null);

  useEffect(() => {
    let cancelled = false;
    paseo
      .config.get()
      .then((result) => {
        if (cancelled) return;
        const entries = (result.config.agentProfiles ?? []) as unknown[];
        setProfiles(
          entries
            .map((entry) =>
              typeof entry === "string"
                ? { id: entry, name: entry }
                : { id: String((entry as { id?: string }).id ?? (entry as { name?: string }).name ?? ""), name: String((entry as { name?: string }).name ?? (entry as { id?: string }).id ?? "") },
            )
            .filter((option) => option.name.length > 0),
        );
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  useEffect(() => {
    if (settingsState.status === "ready") {
      setDraft({ ...settingsState.values });
      setDelayText(String(settingsState.values.escalationDelaySeconds));
    }
  }, [settingsState.status, settingsState.status === "ready" ? settingsState.values : null, settingsState.status === "ready" ? settingsState.revision : null]);

  const styles = useMemo(
    () => ({
      screen: {
        flexGrow: 1,
        padding: layout.compact ? 16 : 24,
        gap: 6,
        backgroundColor: theme.colors.surface0,
      } as const,
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 } as const,
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      } as const,
      optionRow: { flexDirection: "row" as const, gap: 8, alignItems: "center", paddingVertical: 4 } as const,
      optionText: { color: theme.colors.foreground, fontSize: 14 } as const,
      badge: { fontSize: 14, width: 20, textAlign: "center" as const } as const,
      button: {
        marginTop: 16,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
      } as const,
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const, fontSize: 15 } as const,
      note: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 } as const,
      error: { color: theme.colors.statusDanger, fontSize: 13, marginTop: 8 } as const,
      ok: { color: theme.colors.statusSuccess, fontSize: 13, marginTop: 8 } as const,
      section: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600", marginTop: 14 } as const,
    }),
    [theme, layout.compact],
  );

  if (settingsState.status !== "ready" || !draft) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>New project settings</Text>
        <Text style={styles.note}>
          {settingsState.status === "loading"
            ? "Loading settings…"
            : settingsState.status === "error" || settingsState.status === "invalid"
              ? settingsState.error
              : ""}
        </Text>
      </View>
    );
  }

  const revision = settingsState.status === "ready" ? settingsState.revision : "";

  const update = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  async function save() {
    if (!draft) return;
    const clamped = {
      ...draft,
      // Clamp whatever partial text is in the field into the valid range.
      escalationDelaySeconds: Math.min(Math.max(draft.escalationDelaySeconds, 5), 86400),
    };
    setDelayText(String(clamped.escalationDelaySeconds));
    const ok = await settingsState.save(clamped, revision);
    if (ok) setSavedAt(new Date().toISOString());
  }

  function renderProfilePicker(key: "orchestratorProfile" | "builderProfile", label: string) {
    const current = draft;
    return (
      <View key={key}>
        <Text style={styles.section}>{label}</Text>
        {profiles.length === 0 || !current ? (
          <Text style={styles.note}>No agent profiles found on this daemon.</Text>
        ) : (
          profiles.map((profile) => {
            const selected = current[key] === profile.name;
            return (
              <Pressable
                key={profile.id}
                accessibilityRole="button"
                accessibilityLabel={`Use ${profile.name} for ${label}`}
                style={styles.optionRow}
                onPress={() => update(key, profile.name)}
              >
                <Text style={{ ...styles.badge, color: selected ? theme.colors.accent : theme.colors.foregroundMuted }}>
                  {selected ? "●" : "○"}
                </Text>
                <Text style={styles.optionText}>{profile.name}</Text>
              </Pressable>
            );
          })
        )}
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.screen}>
      <Text style={styles.title}>New project settings</Text>

      <Text style={styles.section}>Project root</Text>
      <TextInput
        style={styles.input}
        value={draft.root}
        onChangeText={(value) => update("root", value)}
        placeholder="~/Projects"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.note}>Absolute path or ~ prefix. New projects are created inside it.</Text>

      {renderProfilePicker("orchestratorProfile", "Orchestrator profile")}
      {renderProfilePicker("builderProfile", "Builder profile")}

      <Text style={styles.section}>BMAD tools</Text>
      <TextInput
        style={styles.input}
        value={draft.bmadTools}
        onChangeText={(value) => update("bmadTools", value)}
        placeholder="claude-code,opencode,pi,hermes"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.note}>Comma-separated tool IDs passed to the BMAD installer.</Text>

      <Text style={styles.section}>Agent tool</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Toggle the new_project agent tool"
        style={styles.optionRow}
        onPress={() => update("agentToolEnabled", !draft.agentToolEnabled)}
      >
        <Text style={{ ...styles.badge, color: draft.agentToolEnabled ? theme.colors.accent : theme.colors.foregroundMuted }}>
          {draft.agentToolEnabled ? "☑" : "☐"}
        </Text>
        <Text style={styles.optionText}>Attach the new_project agent tool to orchestrators</Text>
      </Pressable>
      <Text style={styles.note}>
        Off by default. While it is on, every plugin start, stop or reload reopens open agent sessions once, before
        their next prompt; switching this toggle does the same. The tool is offered only to plugin-owned orchestrators.
      </Text>

      <Text style={styles.section}>Escalation delay (seconds)</Text>
      <TextInput
        style={styles.input}
        value={delayText ?? String(draft.escalationDelaySeconds)}
        onChangeText={(value) => {
          // Keep the raw text while typing; an emptied or partial field must
          // not snap the input back to a placeholder value mid-edit.
          setDelayText(value);
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) update("escalationDelaySeconds", parsed);
        }}
        onBlur={() => {
          const parsed = Number.parseInt(delayText ?? "", 10);
          const next = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 5), 86400) : draft.escalationDelaySeconds;
          setDelayText(String(next));
        }}
        keyboardType="number-pad"
      />
      <Text style={styles.note}>
        How long a plugin-owned sub-agent permission request may stay pending before its orchestrator gets one
        reminder. Minimum 5.
      </Text>

      {settingsState.saveError ? <Text style={styles.error}>{settingsState.saveError}</Text> : null}
      {savedAt && !settingsState.saving ? <Text style={styles.ok}>Saved {savedAt}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Save settings" style={styles.button} onPress={save} disabled={settingsState.saving}>
        <Text style={styles.buttonText}>{settingsState.saving ? "Saving…" : "Save"}</Text>
      </Pressable>
    </ScrollView>
  );
}
