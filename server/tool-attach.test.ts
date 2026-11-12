import assert from "assert/strict";
import { test } from "node:test";
import { createNewProjectTool, createToolHookControl, type StartProvisionFn } from "./tool-attach.ts";
import { OWNED_LABEL, PARENT_LABEL } from "../shared/labels.ts";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import type { SettingsValues } from "../shared/settings.ts";

function makeRequest(overrides: Record<string, unknown> & { labels: Record<string, string> }): PluginSessionOpenRequest {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    provider: "claude",
    cwd: "/tmp/demo",
    reason: "resume",
    purpose: "interactive",
    title: "Demo",
    tools: [],
    env: {},
    mcpServers: {},
    ...overrides,
  } as PluginSessionOpenRequest;
}

const DEFAULTS: SettingsValues = {
  root: "~/Projects",
  orchestratorProfile: "BMAD Orchestrator",
  builderProfile: "BMAD Build",
  bmadTools: "claude-code,opencode,pi,hermes",
  agentToolEnabled: true,
  escalationDelaySeconds: 120,
};

function hookControl(tool: AgentToolDefinition) {
  let handler: ((payload: { request: PluginSessionOpenRequest }) => Promise<{ tools: AgentToolDefinition[] } | void>) | null = null;
  const server = {
    addHook: (name: string, h: typeof handler) => {
      assert.equal(name, "agent.open.before");
      handler = h;
      return () => {
        handler = null;
      };
    },
  } as never;
  const control = createToolHookControl({
    server,
    tool,
    readInitial: async () => DEFAULTS,
    subscribe: () => () => {},
  });
  return {
    control,
    call: async (request: PluginSessionOpenRequest) => {
      if (!handler) throw new Error("hook not registered");
      return (await handler({ request })) as { tools: AgentToolDefinition[] } | void;
    },
  };
}

test("tool attaches only to a labelled orchestrator without a parent label", async () => {
  const tool = createNewProjectTool((() => ({ jobId: "j", existed: false })) as StartProvisionFn);
  const { control, call } = hookControl(tool);
  await control.start();

  const attached = await call(makeRequest({ labels: { [OWNED_LABEL]: "true" } }));
  assert.equal(attached?.tools.includes(tool), true);

  const forged = await call(makeRequest({ labels: { [OWNED_LABEL]: "true", [PARENT_LABEL]: "some-parent" } }));
  assert.equal(forged, undefined);

  const stranger = await call(makeRequest({ labels: {} }));
  assert.equal(stranger, undefined);
  control.dispose();
});

test("tool execute refuses an agent whose context carries a parent", async () => {
  const starts: unknown[] = [];
  const tool = createNewProjectTool(((input, _paseo) => {
    starts.push(input);
    return { jobId: "j", existed: false };
  }) as StartProvisionFn);

  const topLevel = {
    agent: { id: "a1", workspaceId: "ws-1", parentAgentId: null, provider: "claude", cwd: "/tmp", title: null },
    paseo: {},
  } as never;
  const ok = await tool.execute({ name: "demo" }, topLevel);
  assert.match(ok.text ?? "", /started as j/);
  assert.equal(starts.length, 1);

  const child = {
    agent: { id: "a2", workspaceId: "ws-1", parentAgentId: "a1", provider: "claude", cwd: "/tmp", title: null },
    paseo: {},
  } as never;
  const refused = await tool.execute({ name: "demo" }, child);
  assert.doesNotMatch(refused.text ?? "", /started as/);
  assert.match(refused.text ?? "", /top-level|parent/i);
  assert.equal(starts.length, 1);
});
