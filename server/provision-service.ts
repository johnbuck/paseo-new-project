import { orchestratorPrompt } from "../shared/prompts.ts";
import type { SettingsValues } from "../shared/settings.ts";
import type { PaseoApi } from "@getpaseo/client";
import { JobRegistry, type JobStatus } from "./jobs.ts";
import { shellFreeExec } from "./exec.ts";
import { runProvision, type ProvisionerSdk } from "./provisioner.ts";
import { applyDevOverrides, expandHome } from "./settings-resolve.ts";

export function adaptSdk(paseo: PaseoApi): ProvisionerSdk {
  return {
    config: {
      get: async () => {
        const result = await paseo.config.get();
        return { agentProfiles: result.config.agentProfiles };
      },
    },
    workspaces: {
      create: (input) => paseo.workspaces.create(input),
      ref: (id) => paseo.workspaces.ref(id),
      list: async (input) => {
        const result = await paseo.workspaces.list(input);
        return {
          entries: result.entries.map((workspace) => ({
            id: workspace.id,
            workspaceDirectory: workspace.workspaceDirectory ?? null,
            archivingAt: workspace.archivingAt ?? null,
          })),
          pageInfo: result.pageInfo,
        };
      },
    },
    agents: {
      ref: (id) => paseo.agents.ref(id),
      list: async (input) => {
        const result = await paseo.agents.list(input as never);
        return {
          entries: result.entries.map((entry) => ({
            id: entry.agent.id,
            cwd: entry.agent.cwd,
            archivedAt: entry.agent.archivedAt ?? null,
          })),
          pageInfo: result.pageInfo,
        };
      },
    },
  };
}

export interface ProvisionStartInput {
  name: string;
  goal?: string;
  /** "agent" only when the request came through the new_project agent tool. */
  goalSource?: "operator" | "agent";
}

export interface ProvisionService {
  start(input: ProvisionStartInput, deps: { paseo: PaseoApi }): { jobId: string; existed: boolean };
  status(query: { jobId?: string; name?: string }): JobStatus | undefined;
}

export interface ProvisionServiceHooks {
  /** Called with the agent id whenever the provisioner creates or recreates an orchestrator. */
  onOwnedAgent?: (agentId: string) => void;
}

export function createProvisionService(
  loadSettings: () => Promise<SettingsValues>,
  hooks: ProvisionServiceHooks = {},
): ProvisionService {
  const registry = new JobRegistry();

  return {
    start(input, deps) {
      const sdk = adaptSdk(deps.paseo);
      const { job, existed } = registry.start(input.name, async (report) => {
        const settings = await loadResolvedSettings(loadSettings);
        report("mkdir");
        const result = await runProvision({
          name: input.name,
          goal: input.goal,
          goalSource: input.goalSource ?? "operator",
          settings,
          exec: shellFreeExec,
          sdk,
          pathEnv: process.env.PATH ?? "",
          buildPrompt: ({ builderProfile, goal, goalSource }) =>
            orchestratorPrompt({ builderProfile, goal, goalSource }),
          onStep: report,
          onOwnedAgent: hooks.onOwnedAgent,
        });
        if (result.ok) {
          job.step = result.kind === "existing" ? "orchestrator" : job.step;
          job.report = result.report;
          job.kind = result.kind;
        } else {
          job.step = result.step;
          job.message = result.error;
          throw new Error(result.error);
        }
      });
      return { jobId: job.id, existed };
    },
    status(query) {
      if (query.jobId) return registry.get(query.jobId);
      if (query.name) return registry.latestForName(query.name);
      return undefined;
    },
  };
}

export async function loadResolvedSettings(loadSettings: () => Promise<SettingsValues>): Promise<SettingsValues> {
  const base = await loadSettings();
  const overridden = applyDevOverrides(base, process.env);
  if (overridden.active) {
    console.log(`[paseo-new-project] dev settings override active for keys: ${Object.keys(diff(base, overridden.values)).join(", ")}`);
  }
  return { ...overridden.values, root: expandHome(overridden.values.root) };
}

function diff(base: SettingsValues, overridden: SettingsValues): Partial<SettingsValues> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(overridden) as (keyof SettingsValues)[]) {
    if (base[key] !== overridden[key]) changed[key] = overridden[key];
  }
  return changed as Partial<SettingsValues>;
}
