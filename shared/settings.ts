import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  root: z.string().min(1).default("~/Projects"),
  orchestratorProfile: z.string().min(1).default("BMAD Orchestrator"),
  builderProfile: z.string().min(1).default("BMAD Build"),
  bmadTools: z.string().min(1).default("claude-code,opencode,pi,hermes"),
  agentToolEnabled: z.boolean().default(false),
  // Capped at 24h: the escalation runs on setTimeout, which overflows past
  // ~2^31 ms and would fire immediately.
  escalationDelaySeconds: z.number().int().min(5).max(86400).default(120),
});

export type SettingsValues = z.output<typeof settingsSchema>;

export const settings = defineSettings({
  id: "pnp-settings",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
