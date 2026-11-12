import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { settingsSchema } from "./settings";

export const debugSettings = defineRpc({
  name: "debug.settings",
  input: z.object({}),
  output: z.object({
    status: z.string(),
    revision: z.string(),
    values: settingsSchema,
    devOverride: z.object({
      active: z.boolean(),
      keys: z.array(z.string()),
    }),
  }),
});

export const provisionStart = defineRpc({
  name: "provision.start",
  input: z.object({
    name: z.string().min(1),
    goal: z.string().optional(),
  }),
  output: z.object({
    jobId: z.string(),
    existed: z.boolean(),
  }),
});

export const provisionStatus = defineRpc({
  name: "provision.status",
  input: z.object({
    jobId: z.string().optional(),
    name: z.string().optional(),
  }),
  output: z.object({
    jobId: z.string(),
    name: z.string(),
    state: z.enum(["running", "complete", "failed"]),
    step: z.string(),
    message: z.string().optional(),
    report: z.string().optional(),
    kind: z.enum(["provisioned", "existing"]).optional(),
  }),
});
