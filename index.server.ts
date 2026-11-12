import type { PluginServerContext } from "@getpaseo/plugin/server";
import { debugSettings, provisionStart, provisionStatus } from "./shared/contracts";
import { settings, type SettingsValues } from "./shared/settings";
import { createProvisionService, loadResolvedSettings } from "./server/provision-service.ts";
import { applyDevOverrides, DEV_SETTINGS_ENV } from "./server/settings-resolve.ts";
import { Escalation, Ownership, SeedController } from "./server/ownership.ts";
import { createNewProjectTool, createToolHookControl } from "./server/tool-attach.ts";

const log = (...args: unknown[]) => console.log("[paseo-new-project]", ...args);

export default function contribute(server: PluginServerContext) {
  const pluginSettings = server.registerSettings(settings);

  void pluginSettings.read().then((state) => {
    if (state.status === "ready") {
      const override = applyDevOverrides(state.values, process.env);
      if (override.active) {
        // One startup warning so an active dev override can never silently
        // diverge from what the settings screen shows.
        log(
          `WARNING: ${DEV_SETTINGS_ENV} override is active; runtime settings diverge from the settings screen for keys: ${override.keys.join(", ")}`,
        );
      }
    }
    log(
      "settings read:",
      JSON.stringify(
        state.status === "ready" ? { status: state.status, values: state.values } : { status: state.status, error: state.error },
      ),
    );
  });

  server.handle(debugSettings, async () => {
    const state = await pluginSettings.read();
    if (state.status !== "ready") {
      throw new Error(`settings not ready: ${state.error}`);
    }
    const override = applyDevOverrides(state.values, process.env);
    return {
      status: state.status,
      revision: state.revision,
      values: state.values,
      devOverride: { active: override.active, keys: override.keys },
    };
  });

  const loadSettings = async () => {
    const state = await pluginSettings.read();
    if (state.status !== "ready") {
      throw new Error(`settings not ready: ${state.error}`);
    }
    return state.values;
  };

  // T6: ownership + delayed escalation. The plugin never answers requests.
  const ownership = new Ownership();
  let sendToAgent: (agentId: string, text: string) => Promise<void> = async () => {
    throw new Error("no paseo connection yet");
  };
  const escalation = new Escalation({
    ownership,
    schedule: (delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      return () => clearTimeout(timer);
    },
    send: async (agentId, text) => {
      await sendToAgent(agentId, text);
    },
    log,
  });

  // The provisioner reports every orchestrator id it creates so ownership is
  // registered immediately; agent.create.after carries no labels to key on.
  const provision = createProvisionService(loadSettings, {
    onOwnedAgent: (agentId) => {
      ownership.registerOwned(agentId);
      log(`orchestrator agent ${agentId} registered as plugin-owned`);
    },
  });

  server.handle(provisionStart, async (input, context) => {
    return provision.start(input, { paseo: context.paseo });
  });

  server.handle(provisionStatus, async (query) => {
    const job = provision.status(query);
    if (!job) throw new Error(`no provision job found for ${query.jobId ?? query.name ?? "(nothing)"}`);
    return {
      jobId: job.id,
      name: job.name,
      state: job.state,
      step: job.step,
      message: job.message,
      report: job.report,
      kind: job.kind,
    };
  });

  let currentPaseo: import("@getpaseo/client").PaseoApi | null = null;
  const seed = new SeedController({
    ownership,
    list: async (options) => {
      const paseo = currentPaseo;
      if (!paseo) throw new Error("no paseo connection yet");
      const result = await paseo.agents.list(options);
      return {
        entries: result.entries.map((entry) => ({ id: entry.agent.id, labels: entry.agent.labels ?? null })),
        pageInfo: result.pageInfo,
      };
    },
    log,
  });

  const ensureSeeded = async (paseo: import("@getpaseo/client").PaseoApi) => {
    currentPaseo = paseo;
    // Steer rather than interrupt: a busy orchestrator keeps its current turn.
    sendToAgent = (agentId, text) => paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    try {
      await seed.ensureSeeded();
    } catch (error) {
      // A failed seed is retried by the next hook; hooks still run with the
      // ownership known so far.
      log("ownership seeding failed:", error instanceof Error ? error.message : String(error));
    }
  };

  const disposers: (() => void)[] = [];
  disposers.push(
    server.addHook("agent.create.after", async (payload, context) => {
      await ensureSeeded(context.paseo);
      ownership.onAgentCreate(payload.agent);
    }),
  );

  disposers.push(
    server.addHook("agent.permission.before", async (payload, context) => {
      await ensureSeeded(context.paseo);
      // Hook agents carry no labels; the parent link arrives here instead.
      ownership.noteParentLink(payload.agent.id, payload.agent.parentAgentId);
      let delayMs = 120_000;
      try {
        const resolved = await loadResolvedSettings(loadSettings);
        delayMs = resolved.escalationDelaySeconds * 1000;
      } catch {
        // keep the default delay if settings are unreadable
      }
      // Defensive clamp: setTimeout misbehaves beyond its 32-bit range.
      delayMs = Math.min(Math.max(delayMs, 5_000), 2_147_483_000);
      const target = escalation.onPermissionBefore(payload.agent.id, payload.request, delayMs);
      if (target === null) {
        log(`permission request ${payload.request.id} from ${payload.agent.id}: no plugin-owned ancestor, leaving it to Paseo and the operator`);
      } else {
        log(`permission request ${payload.request.id} from ${payload.agent.id}: escalation armed for ${target} in ${Math.round(delayMs / 1000)}s`);
      }
    }),
  );

  disposers.push(
    server.addHook("agent.permission.after", async (payload) => {
      log(`permission request ${payload.requestId} resolved (${payload.resolution?.behavior ?? "unknown"}); escalation cleared if armed`);
      escalation.onPermissionAfter(payload.requestId);
    }),
  );

  disposers.push(
    server.addHook("agent.close.after", async (payload) => {
      escalation.onAgentClose(payload.agent.id);
    }),
  );

  // Archiving does not reliably fire agent.close.after; clear timers here too.
  disposers.push(
    server.addHook("agent.archive.after", async (payload) => {
      escalation.onAgentClose(payload.agent.id);
    }),
  );

  // T9: the new_project agent tool, registered only while the setting is on.
  const tool = createNewProjectTool((input, paseo) =>
    provision.start(input, { paseo: paseo as never }),
  );
  const toolControl = createToolHookControl({
    server,
    tool,
    readInitial: loadSettings,
    subscribe: (listener) =>
      pluginSettings.subscribe((state) => {
        if (state.status === "ready") listener(state.values as SettingsValues);
      }),
    log,
  });
  void toolControl.start();

  return () => {
    toolControl.dispose();
    escalation.cleanup();
    for (const dispose of disposers) dispose();
  };
}
