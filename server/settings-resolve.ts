import { homedir } from "node:os";
import type { SettingsValues } from "../shared/settings.ts";
import { settingsSchema } from "../shared/settings.ts";

export const DEV_SETTINGS_ENV = "PNP_DEV_SETTINGS";

export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return joinHome(home, path.slice(2));
  return path;
}

function joinHome(home: string, rest: string): string {
  const separator = home.endsWith("/") ? "" : "/";
  return `${home}${separator}${rest}`;
}

export interface DevOverrideResult {
  values: SettingsValues;
  active: boolean;
  /** Setting keys the raw override JSON actually carries. */
  keys: string[];
}

export function applyDevOverrides(settings: SettingsValues, env: Record<string, string | undefined>): DevOverrideResult {
  const raw = env[DEV_SETTINGS_ENV];
  if (!raw) return { values: settings, active: false, keys: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[paseo-new-project] ${DEV_SETTINGS_ENV} is set but not valid JSON; ignoring it`);
    return { values: settings, active: false, keys: [] };
  }

  const partial = settingsSchema.partial().safeParse(parsed);
  if (!partial.success) {
    console.warn(`[paseo-new-project] ${DEV_SETTINGS_ENV} failed settings validation; ignoring it`);
    return { values: settings, active: false, keys: [] };
  }

  // Zod fills defaults for absent keys inside .partial(), so merging the
  // parsed output would reset every non-overridden saved setting. Merge only
  // the keys the raw JSON actually carries; validation already covered them.
  const rawKeys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed as Record<string, unknown>) : [];
  const shape = settingsSchema.shape as Record<string, unknown>;
  const present = rawKeys.filter((key) => key in shape);
  const picked = Object.fromEntries(present.map((key) => [key, (parsed as Record<string, unknown>)[key]])) as Partial<SettingsValues>;
  return { values: { ...settings, ...picked }, active: true, keys: present };
}
