import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { provisionStatus } from "../shared/contracts";
import { recallLastName, rememberLastName } from "./ui";

type MaybeError = string | null;

const STEP_LIST = [
  { id: "preflight", label: "Preflight checks" },
  { id: "mkdir", label: "Create directory" },
  { id: "git-init", label: "git init" },
  { id: "marker", label: "Write resume marker" },
  { id: "bmad-install", label: "Install BMAD" },
  { id: "workspace", label: "Create Orchestrator workspace" },
  { id: "orchestrator", label: "Start orchestrator agent" },
] as const;

type StepId = (typeof STEP_LIST)[number]["id"];

interface StatusShape {
  jobId: string;
  name: string;
  state: "running" | "complete" | "failed";
  step: string;
  message?: string;
  report?: string;
  kind?: "provisioned" | "existing";
}

const POLL_INTERVAL_MS = 1000;
const RETRY_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 5;

export function ProvisionStatusScreen({ theme, layout, params }: PluginScreenProps) {
  const fetchStatus = useRpc(provisionStatus);
  const toast = useToast();
  const [name, setName] = useState(
    typeof params.name === "string" && params.name ? params.name : recallLastName(),
  );
  const [activeName, setActiveName] = useState(
    typeof params.name === "string" && params.name ? params.name : "",
  );
  const [lookupNonce, setLookupNonce] = useState(0);
  const [status, setStatus] = useState<StatusShape | null>(null);
  const [error, setError] = useState<MaybeError>(null);
  const lastSeenState = useRef<StatusShape["state"] | null>(null);

  useEffect(() => {
    if (!activeName) return;
    let cancelled = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const result = (await fetchStatus({ name: activeName })) as StatusShape;
        if (cancelled) return;
        consecutiveFailures = 0;
        setError(null);
        setStatus(result);
        const previous = lastSeenState.current;
        lastSeenState.current = result.state;
        if (result.state === "complete" && previous === "running") {
          toast.show(result.report ?? `Provision for ${result.name} completed`, { variant: "success" });
        } else if (result.state === "failed" && previous === "running") {
          toast.error(`Provision for ${result.name} failed at ${result.step}: ${result.message ?? "unknown error"}`);
        }
        if (result.state === "running") timer = setTimeout(poll, POLL_INTERVAL_MS) as unknown as number;
      } catch (pollError) {
        if (cancelled) return;
        // A transient failure keeps the last status on screen and retries; a
        // persistently missing job stops polling after a few attempts.
        consecutiveFailures += 1;
        setError(pollError instanceof Error ? pollError.message : String(pollError));
        if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
          timer = setTimeout(poll, RETRY_INTERVAL_MS) as unknown as number;
        }
      }
    };
    lastSeenState.current = null;
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeName, lookupNonce, fetchStatus, toast]);

  const styles = useMemo(
    () => ({
      screen: {
        flexGrow: 1,
        padding: layout.compact ? 16 : 24,
        gap: 10,
        backgroundColor: theme.colors.surface0,
      } as const,
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        flex: 1,
      } as const,
      lookupRow: { flexDirection: "row" as const, gap: 8, alignItems: "center" } as const,
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      } as const,
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 } as const,
      stepRow: { flexDirection: "row" as const, gap: 8, alignItems: "center" } as const,
      stepText: { color: theme.colors.foreground, fontSize: 14 } as const,
      stepPending: { color: theme.colors.foregroundMuted, fontSize: 14 } as const,
      badge: { fontSize: 14, width: 20, textAlign: "center" as const } as const,
      report: { color: theme.colors.foreground, fontSize: 14 } as const,
      error: { color: theme.colors.statusDanger, fontSize: 13 } as const,
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 } as const,
    }),
    [theme, layout.compact],
  );

  function stepVisual(step: StepId, status: StatusShape | null): "done" | "current" | "pending" {
    if (!status) return "pending";
    const index = STEP_LIST.findIndex((entry) => entry.id === step);
    if (status.state === "complete") return "done";
    if (status.state === "failed") {
      const failedIndex = STEP_LIST.findIndex((entry) => entry.id === status.step);
      return index < failedIndex ? "done" : index === failedIndex ? "current" : "pending";
    }
    const currentIndex = STEP_LIST.findIndex((entry) => entry.id === status.step);
    return index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
  }

  function badgeColor(visual: "done" | "current" | "pending"): string {
    if (visual === "done") return theme.colors.statusSuccess;
    if (visual === "current") return theme.colors.accent;
    return theme.colors.foregroundMuted;
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.screen}>
      <Text style={styles.title}>Provision status</Text>
      {params.notice ? (
        <Text style={styles.error}>
          A provisioning job for {params.name ?? "this project"} is already running; the goal in that request was not
          used.
        </Text>
      ) : null}
      <View style={styles.lookupRow}>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="project name"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Look up status"
          style={styles.button}
          onPress={() => {
            const trimmed = name.trim();
            rememberLastName(trimmed);
            // Keep the current panel visible until the new lookup answers;
            // the nonce re-runs polling even for the same name.
            setActiveName(trimmed);
            setLookupNonce((nonce) => nonce + 1);
          }}
        >
          <Text style={styles.buttonText}>Look up</Text>
        </Pressable>
      </View>
      {status ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.report}>
            {status.name} — {status.state}
            {status.kind ? ` (${status.kind})` : ""}
          </Text>
          {STEP_LIST.map((step) => {
            const visual = stepVisual(step.id, status);
            return (
              <View key={step.id} style={styles.stepRow}>
                <Text style={{ ...styles.badge, color: badgeColor(visual) }}>
                  {visual === "done" ? "✓" : visual === "current" ? "›" : "·"}
                </Text>
                <Text style={visual === "pending" ? styles.stepPending : styles.stepText}>{step.label}</Text>
              </View>
            );
          })}
          {status.state === "failed" && status.message ? (
            <Text style={styles.error}>
              Failed at {status.step}: {status.message}
            </Text>
          ) : null}
          {status.state === "complete" && status.report ? <Text style={styles.report}>{status.report}</Text> : null}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}
