import assert from "assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runProvision, toolOnPath, type ExecFn, type ProvisionerSdk } from "./provisioner.ts";
import { MARKER_PATH } from "./validate.ts";

export interface ExecCall {
  file: string;
  args: string[];
  cwd?: string;
  shell?: undefined;
}

export class RecordingExec {
  calls: ExecCall[] = [];
  failOn: string | null = null;
  failWith: Error | null = null;
  spawnedPids: number[] = [];

  exec: ExecFn = async (file, args, options) => {
    this.calls.push({ file, args, cwd: options?.cwd });
    if (options?.onSpawn) {
      const pid = 4200 + this.calls.length;
      this.spawnedPids.push(pid);
      options.onSpawn(pid);
    }
    if (this.failOn && file === this.failOn && this.failWith) throw this.failWith;
    return { stdout: "", stderr: "" };
  };
}

interface WorkspaceAgentCreateInput {
  config: Record<string, unknown>;
  title?: string;
  labels?: Record<string, string>;
  prompt?: string;
}

export class FakeSdk {
  agentProfiles: unknown[] = [
    { name: "BMAD Orchestrator", provider: "claude", model: "opus" },
    { name: "BMAD Build", provider: "opencode", model: "glm" },
  ];
  workspacesCreated: { title: string; source: { kind: string; path: string } }[] = [];
  agentsCreated: (WorkspaceAgentCreateInput & { workspaceId: string; cwd?: string })[] = [];
  agentSends: { agentId: string; text: string }[] = [];
  /** Listing stores: what a `workspaces.list` / owned `agents.list` would return. */
  workspaceStore: { id: string; directory: string; archivingAt: string | null }[] = [];
  agentStore: { id: string; cwd: string; archivedAt: string | null }[] = [];
  private statuses = new Map<string, string>();
  private archived = new Set<string>();

  setAgentStatus(id: string, status: string) {
    this.statuses.set(id, status);
  }

  dropAgent(id: string) {
    this.archived.add(id);
  }

  private workspaceDirectory(id: string): string | null {
    const index = Number(id.replace(/^ws-/, "")) - 1;
    return this.workspacesCreated[index]?.source.path ?? null;
  }

  sdk: ProvisionerSdk = {
    config: {
      get: async () => ({ agentProfiles: this.agentProfiles }),
    },
    workspaces: {
      create: async (input: { title: string; source: { kind: "directory"; path: string } }) => {
        const id = `ws-${this.workspacesCreated.length + 1}`;
        this.workspacesCreated.push(input);
        this.workspaceStore.push({ id, directory: input.source.path, archivingAt: null });
        return { id, agents: { create: async (opts: WorkspaceAgentCreateInput) => {
          const agentId = `agent-${this.agentsCreated.length + 1}`;
          this.agentsCreated.push({ ...opts, workspaceId: id });
          this.agentStore.push({ id: agentId, cwd: input.source.path, archivedAt: null });
          return { id: agentId };
        } } };
      },
      ref: (id: string) => ({
        agents: {
          create: async (opts: WorkspaceAgentCreateInput) => {
            const agentId = `agent-${this.agentsCreated.length + 1}`;
          this.agentsCreated.push({ ...opts, workspaceId: id });
          this.agentStore.push({ id: agentId, cwd: this.workspaceDirectory(id) ?? "", archivedAt: null });
            return { id: agentId };
          },
        },
      }),
      list: async () => ({
        entries: this.workspaceStore.map((entry) => ({
          id: entry.id,
          workspaceDirectory: entry.directory,
          archivingAt: entry.archivingAt,
        })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: {
            status: this.statuses.get(id) ?? "idle",
            archivedAt: this.archived.has(id) ? "2026-01-01T00:00:00Z" : null,
            labels: { "pnp/owned": "true" },
          },
        }),
        send: async (text: string) => {
          this.agentSends.push({ agentId: id, text });
        },
      }),
      list: async (input?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean } }) => {
        const includeArchived = input?.filter?.includeArchived === true;
        return {
          entries: this.agentStore
            .filter((entry) => includeArchived || entry.archivedAt === null)
            .map((entry) => ({ id: entry.id, cwd: entry.cwd, archivedAt: entry.archivedAt })),
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
    },
  };
}

const SETTINGS = {
  root: "",
  orchestratorProfile: "BMAD Orchestrator",
  builderProfile: "BMAD Build",
  bmadTools: "claude-code,opencode,pi,hermes",
  agentToolEnabled: false,
  escalationDelaySeconds: 120,
};

interface Harness {
  root: string;
  exec: RecordingExec;
  sdk: FakeSdk;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pnp-prov-"));
  const exec = new RecordingExec();
  const sdk = new FakeSdk();
  return {
    root,
    exec,
    sdk,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function input(h: Harness, overrides: Record<string, unknown> = {}) {
  return {
    name: "demo",
    goal: "build a demo",
    settings: { ...SETTINGS, root: h.root },
    exec: h.exec.exec,
    sdk: h.sdk.sdk,
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
    buildPrompt: ({ goal }: { goal?: string }) => `PROMPT<<${goal ?? "no-goal"}>>`,
    ...overrides,
  };
}

test("toolOnPath finds executables on the injected PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pnp-path-"));
  try {
    await writeFile(join(dir, "fakegit"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(await toolOnPath("fakegit", dir), true);
    assert.equal(await toolOnPath("missing-tool", dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preflight failure for a missing profile creates no directory and runs no commands", async () => {
  const h = await harness();
  try {
    h.sdk.agentProfiles = ["BMAD Orchestrator"];
    const result = await runProvision(input(h));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /builder profile/);
    assert.equal(h.exec.calls.length, 0);
    assert.equal(h.sdk.workspacesCreated.length, 0);
    await assert.rejects(() => readFile(join(h.root, "demo")));
  } finally {
    await h.cleanup();
  }
});

test("preflight failure for missing git on PATH creates no directory", async () => {
  const h = await harness();
  try {
    const result = await runProvision(input(h, { pathEnv: "/nonexistent" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /git/);
    assert.equal(h.exec.calls.length, 0);
    await assert.rejects(() => readFile(join(h.root, "demo")));
  } finally {
    await h.cleanup();
  }
});

test("happy path runs steps in order with argv arrays and completes the marker", async () => {
  const h = await harness();
  try {
    const steps: string[] = [];
    const result = await runProvision(input(h, { onStep: (step: string) => steps.push(step) }));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.deepEqual(steps, ["mkdir", "git-init", "marker", "bmad-install", "workspace", "orchestrator"]);

    const commands = h.exec.calls.map((call: ExecCall) => [call.file, ...call.args]);
    assert.deepEqual(commands[0], ["git", "init"]);
    assert.deepEqual(commands[1], [
      "npx",
      "--yes",
      "bmad-method@6.12.4",
      "install",
      "--directory",
      join(h.root, "demo"),
      "--modules",
      "bmm",
      "--tools",
      "claude-code,opencode,pi,hermes",
      "--no-shims",
      "--yes",
    ]);
    assert.equal(commands.length, 2);
    for (const call of h.exec.calls) {
      assert.equal(typeof call.file, "string");
      assert.ok(Array.isArray(call.args));
      assert.equal(call.shell, undefined);
    }

    assert.equal(h.sdk.workspacesCreated.length, 1);
    assert.deepEqual(h.sdk.workspacesCreated[0].title, "demo Orchestrator");
    assert.equal(h.sdk.workspacesCreated[0].source.path, join(h.root, "demo"));

    assert.equal(h.sdk.agentsCreated.length, 1);
    const created = h.sdk.agentsCreated[0]!;
    assert.equal(created.workspaceId, "ws-1");
    assert.deepEqual(created.labels, { "pnp/owned": "true" });
    assert.equal(created.cwd, undefined);
    assert.match(created.prompt ?? "", /PROMPT<<build a demo>>/);
    assert.equal(created.config.provider, "claude/opus");

    const marker = JSON.parse(await readFile(join(h.root, "demo", MARKER_PATH), "utf8"));
    assert.deepEqual(marker.steps, {
      mkdir: true,
      "git-init": true,
      marker: true,
      "bmad-install": true,
      workspace: true,
      orchestrator: true,
    });
    assert.equal(marker.workspaceId, "ws-1");
    assert.equal(marker.orchestratorAgentId, "agent-1");
  } finally {
    await h.cleanup();
  }
});

test("complete re-run reports the existing orchestrator without new side effects", async () => {
  const h = await harness();
  try {
    await runProvision(input(h));
    h.exec.calls.length = 0;

    const result = await runProvision(input(h, { goal: undefined }));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (result.ok) {
      assert.equal(result.kind, "existing");
      assert.match(result.report, /no goal was supplied|exists/);
    }
    assert.equal(h.exec.calls.length, 0);
    assert.equal(h.sdk.workspacesCreated.length, 1);
    assert.equal(h.sdk.agentsCreated.length, 1);
    assert.equal(h.sdk.agentSends.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("re-run with a running orchestrator reports instead of prompting", async () => {
  const h = await harness();
  try {
    await runProvision(input(h));
    h.sdk.setAgentStatus("agent-1", "running");

    const result = await runProvision(input(h, { goal: "second goal" }));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (result.ok) assert.equal(result.kind, "existing");
    assert.equal(h.sdk.agentSends.length, 0);
    assert.equal(h.sdk.agentsCreated.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("re-run with an idle orchestrator and a new goal sends exactly one prompt", async () => {
  const h = await harness();
  try {
    await runProvision(input(h));
    h.sdk.setAgentStatus("agent-1", "idle");
    h.sdk.agentSends.length = 0;

    const result = await runProvision(input(h, { goal: "follow-up goal" }));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.sdk.agentSends.length, 1);
    assert.equal(h.sdk.agentSends[0].agentId, "agent-1");
    assert.match(h.sdk.agentSends[0].text, /follow-up goal/);
    assert.equal(h.sdk.agentsCreated.length, 1);
    assert.equal(h.sdk.workspacesCreated.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("step failure reports step and message without secret-shaped content", async () => {
  const h = await harness();
  try {
    h.exec.failOn = "npx";
    const leakedToken = ["sk-abc", "def", "123456"].join("");
    h.exec.failWith = new Error(`npx exploded; env contained ${["API_KEY", leakedToken].join("=")}`);
    const result = await runProvision(input(h));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "bmad-install");
      assert.doesNotMatch(result.error, new RegExp(leakedToken));
      assert.match(result.error, /\[redacted\]/);
    }
    assert.equal(h.sdk.workspacesCreated.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("resume skips completed steps and continues from the marker", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(
      join(target, MARKER_PATH),
      JSON.stringify({ version: 1, steps: { mkdir: true, "git-init": true, marker: true, "bmad-install": true } }),
    );

    const result = await runProvision(input(h));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.exec.calls.length, 0);
    assert.equal(h.sdk.workspacesCreated.length, 1);
    assert.equal(h.sdk.agentsCreated.length, 1);

    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.steps.workspace, true);
    assert.equal(marker.steps.orchestrator, true);
  } finally {
    await h.cleanup();
  }
});

test("crash-gap directory is adopted and provisioned", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });

    const result = await runProvision(input(h));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    const files = h.exec.calls.map((c) => c.file);
    // adoption asks git about remotes and commits, then re-runs the idempotent
    // git init before the installer
    assert.deepEqual(files, ["git", "git", "git", "npx"]);
    assert.deepEqual(h.exec.calls[2]?.args, ["init"]);
    assert.equal(h.sdk.workspacesCreated.length, 1);

    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.steps.mkdir, true);
    assert.equal(marker.steps["git-init"], true);
    assert.equal(marker.steps["bmad-install"], true);
  } finally {
    await h.cleanup();
  }
});

test("an existing empty target directory completes the mkdir step without recreating it", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(target);
    const result = await runProvision(input(h));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.steps.mkdir, true);
  } finally {
    await h.cleanup();
  }
});

test("a live installer pid recorded in the marker blocks a rerun", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(
      join(target, MARKER_PATH),
      JSON.stringify({
        version: 1,
        steps: { mkdir: true, "git-init": true, marker: true },
        install: { pid: process.pid, startedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    const result = await runProvision(input(h));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "bmad-install");
      assert.match(result.error, /still be running/);
      assert.match(result.error, new RegExp(`pid ${process.pid}`));
    }
    assert.equal(h.exec.calls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a dead installer pid does not block the install and success clears the record", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = dead.pid;
    await new Promise<void>((resolve) => dead.on("exit", () => resolve()));
    await writeFile(
      join(target, MARKER_PATH),
      JSON.stringify({
        version: 1,
        steps: { mkdir: true, "git-init": true, marker: true },
        install: { pid: deadPid, startedAt: "2026-01-01T00:00:00Z" },
      }),
    );

    const result = await runProvision(input(h));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.exec.calls.filter((c) => c.file === "npx").length, 1);
    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.install, undefined);
    assert.equal(marker.steps["bmad-install"], true);
    assert.ok(h.exec.spawnedPids.length > 0);
  } finally {
    await h.cleanup();
  }
});

test("an unreadable marker fails preflight with a clear message instead of re-provisioning", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    // a directory where the marker file should be makes the read fail loudly
    await mkdir(join(target, MARKER_PATH));
    const result = await runProvision(input(h));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "preflight");
      assert.match(result.error, /marker/i);
      assert.match(result.error, /cannot be read/i);
    }
    assert.equal(h.exec.calls.length, 0);
    assert.equal(h.sdk.workspacesCreated.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("non-empty unmarked directory is refused", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(target);
    await writeFile(join(target, "notes.txt"), "precious");
    const result = await runProvision(input(h));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not empty/);
    assert.equal(h.exec.calls.length, 0);
    assert.deepEqual(await readdir(target), ["notes.txt"]);
  } finally {
    await h.cleanup();
  }
});

test("vanished orchestrator on a complete marker is recreated in the existing workspace", async () => {
  const h = await harness();
  try {
    await runProvision(input(h));
    h.sdk.dropAgent("agent-1");

    const result = await runProvision(input(h, { goal: undefined }));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.sdk.agentsCreated.length, 2);
    assert.equal(h.sdk.agentsCreated[1].workspaceId, "ws-1");
    assert.equal(h.sdk.workspacesCreated.length, 1);

    const marker = JSON.parse(await readFile(join(h.root, "demo", MARKER_PATH), "utf8"));
    assert.equal(marker.orchestratorAgentId, "agent-2");
  } finally {
    await h.cleanup();
  }
});

test("a live non-idle orchestrator is reported, never duplicated, and keeps its marker id", async () => {
  const h = await harness();
  try {
    await runProvision(input(h));
    for (const status of ["running", "initializing", "error", "closed"]) {
      h.sdk.setAgentStatus("agent-1", status);
      const result = await runProvision(input(h, { goal: "try again" }));
      assert.equal(result.ok, true, `${status}: ${result.ok ? "" : result.error}`);
      if (result.ok) {
        assert.equal(result.kind, "existing");
        assert.match(result.report, new RegExp(status));
      }
      assert.equal(h.sdk.agentsCreated.length, 1);
      assert.equal(h.sdk.agentSends.length, 0);
      const marker = JSON.parse(await readFile(join(h.root, "demo", MARKER_PATH), "utf8"));
      assert.equal(marker.orchestratorAgentId, "agent-1");
    }
  } finally {
    await h.cleanup();
  }
});

test("goal text never appears in any command argument", async () => {
  const h = await harness();
  try {
    const tricky = "goal; rm -rf / && $(cat /etc/passwd) `id` \"quoted\"";
    await runProvision(input(h, { goal: tricky }));
    for (const call of h.exec.calls) {
      for (const arg of [call.file, ...call.args]) {
        assert.notEqual(arg, tricky);
        assert.doesNotMatch(arg, /rm -rf/);
      }
    }
    assert.ok((h.sdk.agentsCreated[0]?.prompt ?? "").includes(tricky));
  } finally {
    await h.cleanup();
  }
});

test("crash between workspace create and marker write reuses the workspace", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(
      join(target, MARKER_PATH),
      JSON.stringify({ version: 1, steps: { mkdir: true, "git-init": true, marker: true, "bmad-install": true } }),
    );
    h.sdk.workspaceStore.push({ id: "ws-existing", directory: target, archivingAt: null });

    const result = await runProvision(input(h));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.sdk.workspacesCreated.length, 0);
    assert.equal(h.sdk.agentsCreated.length, 1);
    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.workspaceId, "ws-existing");
    assert.equal(h.sdk.agentsCreated[0].workspaceId, "ws-existing");
  } finally {
    await h.cleanup();
  }
});

test("crash between agent create and marker write reuses the orchestrator", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(
      join(target, MARKER_PATH),
      JSON.stringify({ version: 1, steps: { mkdir: true, "git-init": true, marker: true, "bmad-install": true, workspace: true }, workspaceId: "ws-1" }),
    );
    h.sdk.agentStore.push({ id: "agent-existing", cwd: target, archivedAt: null });
    const owned: string[] = [];

    const result = await runProvision(input(h, { onOwnedAgent: (id: string) => owned.push(id) }));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.sdk.agentsCreated.length, 0);
    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.orchestratorAgentId, "agent-existing");
    assert.deepEqual(owned, ["agent-existing"]);
  } finally {
    await h.cleanup();
  }
});

test("archived workspace or agent for the target is not reused", async () => {
  const h = await harness();
  try {
    const target = join(h.root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(
      join(target, MARKER_PATH),
      JSON.stringify({ version: 1, steps: { mkdir: true, "git-init": true, marker: true, "bmad-install": true } }),
    );
    h.sdk.workspaceStore.push({ id: "ws-dead", directory: target, archivingAt: "2026-01-01T00:00:00Z" });
    h.sdk.agentStore.push({ id: "agent-dead", cwd: target, archivedAt: "2026-01-01T00:00:00Z" });

    const result = await runProvision(input(h));
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(h.sdk.workspacesCreated.length, 1);
    assert.equal(h.sdk.agentsCreated.length, 1);
    const marker = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(marker.workspaceId, "ws-1");
    assert.equal(marker.orchestratorAgentId, "agent-1");
  } finally {
    await h.cleanup();
  }
});
