import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { SettingsValues } from "../shared/settings.ts";
import { z } from "zod";
import { OWNED_LABEL, PARENT_LABEL } from "../shared/labels.ts";

/**
 * T9: the new_project agent tool, attached at session open only to
 * plugin-owned orchestrators, and only while the host setting enables it.
 * The agent.open.before hook registration is conditional so a default
 * install/reload never marks open sessions stale.
 */

export interface StartProvisionFn {
  (
    input: { name: string; goal?: string; goalSource: "operator" | "agent" },
    paseo: unknown,
  ): { jobId: string; existed: boolean };
}

export function createNewProjectTool(start: StartProvisionFn): AgentToolDefinition {
  return defineAgentTool({
    name: "new_project",
    title: "New project",
    description:
      "Provision a new project: directory with git and an unattended BMAD install, a registered Paseo project, an Orchestrator workspace titled with the project name, and a started orchestrator agent. Safe to re-run for the same name. Returns a job id; the job keeps running after this call.",
    input: z.object({
      name: z.string().min(1).describe("Project name: lowercase, digits, dot, underscore or dash; starts with a letter or digit"),
      goal: z.string().optional().describe("Optional first goal for the orchestrator"),
    }),
    execute: (input, context) => {
      // A forged owned label must not grant the tool: the executing agent's
      // own context must show it is top-level.
      if (context.agent.parentAgentId !== null) {
        return {
          text: "new_project is limited to top-level orchestrator agents; this agent has a parent and cannot provision projects.",
        };
      }
      const result = start(
        { name: input.name, goal: input.goal, goalSource: "agent" },
        context.paseo,
      );
      return {
        text: [
          `Provision job ${result.existed ? "already running as" : "started as"} ${result.jobId}.`,
          "The job runs in the background and survives this call.",
          "Status reaches the operator through the New project: provision status surface; do not block on it.",
        ].join(" "),
      };
    },
  });
}

export interface ToolHookControl {
  start(): Promise<void>;
  dispose(): void;
}

export interface ToolHookDeps {
  server: PluginServerContext;
  tool: AgentToolDefinition;
  readInitial: () => Promise<SettingsValues>;
  subscribe: (listener: (values: SettingsValues) => void) => () => void;
  log?: (...args: unknown[]) => void;
}

export function createToolHookControl(deps: ToolHookDeps): ToolHookControl {
  const log = deps.log ?? (() => {});
  let disposeHook: (() => void) | null = null;
  let disposed = false;

  const handler = async ({ request }: { request: PluginSessionOpenRequest }) => {
    if (request.labels?.[OWNED_LABEL] !== "true") return;
    // A sub-agent of any agent carries the parent label at open; the owned
    // label alone (forgeable) must not attach the tool to it.
    if (request.labels?.[PARENT_LABEL]) return;
    log(`agent tool offered to owned agent ${request.agentId} at session open`);
    return { ...request, tools: [...request.tools, deps.tool] };
  };

  const register = () => {
    if (disposed || disposeHook) return;
    disposeHook = deps.server.addHook("agent.open.before", handler);
    log("agent tool enabled: agent.open.before registered (open sessions will reopen once, before their next idle prompt)");
  };

  const unregister = () => {
    if (!disposeHook) return;
    disposeHook();
    disposeHook = null;
    log("agent tool disabled: agent.open.before unregistered");
  };

  const applySetting = (enabled: boolean) => {
    if (enabled) register();
    else unregister();
  };

  let unsubscribe: (() => void) | null = deps.subscribe((values) => applySetting(values.agentToolEnabled));

  return {
    async start() {
      try {
        const initial = await deps.readInitial();
        applySetting(initial.agentToolEnabled);
        if (!initial.agentToolEnabled) log("agent tool off at startup: agent.open.before not registered");
      } catch (error) {
        log("agent tool settings read failed; leaving the hook unregistered:", error instanceof Error ? error.message : String(error));
      }
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      unregister();
    },
  };
}
