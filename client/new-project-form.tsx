import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { provisionStart } from "../shared/contracts";
import { FieldLabel, recallLastName, rememberLastName } from "./ui";
import { openScreen } from "./nav";

type MaybeError = string | null;

export function NewProjectForm({ theme, layout }: PluginScreenProps) {
  const startProvision = useRpc(provisionStart);
  const toast = useToast();
  const [name, setName] = useState(recallLastName());
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<MaybeError>(null);
  const [busy, setBusy] = useState(false);

  const styles = useMemo(
    () => ({
      screen: {
        flexGrow: 1,
        padding: layout.compact ? 16 : 24,
        gap: 4,
        backgroundColor: theme.colors.surface0,
      } as const,
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      } as const,
      goalInput: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        minHeight: 72,
        textAlignVertical: "top" as const,
      } as const,
      button: {
        marginTop: 16,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
        opacity: busy ? 0.6 : 1,
      } as const,
      buttonText: {
        color: theme.colors.accentForeground,
        textAlign: "center" as const,
        fontSize: 15,
      } as const,
      error: { color: theme.colors.statusDanger, fontSize: 13, marginTop: 8 } as const,
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 } as const,
    }),
    [theme, layout.compact, busy],
  );

  async function submit() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A project name is required.");
      return;
    }
    setBusy(true);
    try {
      const trimmedGoal = goal.trim();
      const result = await startProvision(trimmedGoal ? { name: trimmed, goal: trimmedGoal } : { name: trimmed });
      if (result.existed) {
        toast.show(
          `A provisioning job for ${trimmed} is already running; the new goal was not used.`,
          { variant: "warning" },
        );
      }
      rememberLastName(trimmed);
      openScreen({ screenId: "pnp-status", params: { name: trimmed } });
    } catch (rpcError) {
      setError(rpcError instanceof Error ? rpcError.message : String(rpcError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.screen}>
      <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 }}>Provision a new project</Text>
      <Text style={styles.hint}>
        Creates the project directory with git and BMAD, an Orchestrator workspace titled with the project name, and
        starts the orchestrator agent from the configured profile.
      </Text>
      <FieldLabel theme={theme}>Project name</FieldLabel>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="my-project"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FieldLabel theme={theme}>Goal (optional)</FieldLabel>
      <TextInput
        style={styles.goalInput}
        value={goal}
        onChangeText={setGoal}
        placeholder="What should the orchestrator build?"
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Start provisioning" onPress={submit} style={styles.button} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "Starting…" : "Start provisioning"}</Text>
      </Pressable>
    </ScrollView>
  );
}
