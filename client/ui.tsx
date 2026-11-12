import { useEffect, useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { Text } from "react-native";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

let lastName = "";

export function rememberLastName(name: string): void {
  lastName = name;
}

export function recallLastName(): string {
  return lastName;
}

export function FieldLabel({ theme, children }: { theme: PluginTheme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 8 }}>{children}</Text>;
}
