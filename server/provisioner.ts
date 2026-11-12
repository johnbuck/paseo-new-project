import { access, constants, mkdir as fsMkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SettingsValues } from "../shared/settings.ts";
import { followUpGoalPrompt } from "../shared/prompts.ts";
import { OWNED_LABEL } from "../shared/labels.ts";
import {
  canAdoptCrashGap,
  clearInstallMarker,
  decideOrchestratorInteraction,
  markInstallStarted,
  markStep,
  planResume,
  readMarker,
  writeInitialMarker,
  type Marker,
  type OrchestratorSnapshot,
  type StepName,
} from "./resume.ts";
import { scrubSecrets } from "./scrub.ts";
import { resolveTarget } from "./validate.ts";

export type ExecFn = (
  file: string,
  args: string[],
  options?: { cwd?: string; onSpawn?: (pid: number | undefined) => void },
) => Promise<{ stdout: string; stderr: string }>;

export interface WorkspaceAgentCreateInput {
  config: { provider: string } & Record<string, unknown>;
  title?: string;
  labels?: Record<string, string>;
  prompt?: string;
}

export interface SdkPage {
  limit: number;
  cursor?: string;
}

export interface WorkspaceListEntry {
  id: string;
  workspaceDirectory: string | null;
  archivingAt: string | null;
}

export interface AgentListEntry {
  id: string;
  cwd: string;
  archivedAt: string | null;
}

export interface PageResult<T> {
  entries: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

export interface ProvisionerSdk {
  config: { get(): Promise<{ agentProfiles?: unknown[] }> };
  workspaces: {
    create(input: {
      title: string;
      source: { kind: "directory"; path: string };
    }): Promise<{
      id: string;
      agents: { create(input: WorkspaceAgentCreateInput): Promise<{ id: string }> };
    }>;
    ref(id: string): { agents: { create(input: WorkspaceAgentCreateInput): Promise<{ id: string }> } };
    list(input?: { page?: SdkPage }): Promise<PageResult<WorkspaceListEntry>>;
  };
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: { status: string; archivedAt?: string | null; labels?: Record<string, string> } | null } | null>;
      send(text: string): Promise<void>;
    };
    list(input?: { filter?: { labels?: Record<string, string>; includeArchived?: boolean }; page?: SdkPage }): Promise<PageResult<AgentListEntry>>;
  };
}

async function listAllPages<T>(fetchPage: (page: SdkPage) => Promise<PageResult<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await fetchPage({ limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...result.entries);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return out;
}

/** A live (non-archiving) workspace whose directory is exactly the target. */
async function findLiveWorkspaceByDirectory(sdk: ProvisionerSdk, target: string): Promise<string | null> {
  try {
    const entries = await listAllPages((page) => sdk.workspaces.list({ page }));
    const found = entries.find((entry) => entry.workspaceDirectory === target && entry.archivingAt === null);
    return found?.id ?? null;
  } catch {
    return null;
  }
}

/** A live, plugin-owned agent whose cwd is exactly the target. */
async function findLiveOwnedAgentByCwd(sdk: ProvisionerSdk, target: string): Promise<string | null> {
  try {
    const entries = await listAllPages((page) =>
      sdk.agents.list({ filter: { labels: { [OWNED_LABEL]: "true" }, includeArchived: true }, page }),
    );
    const found = entries.find((entry) => entry.cwd === target && entry.archivedAt === null);
    return found?.id ?? null;
  } catch {
    return null;
  }
}

export interface AgentProfile {
  name?: string;
  id?: string;
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown> | null;
}

export async function toolOnPath(tool: string, pathEnv: string): Promise<boolean> {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    try {
      await access(join(dir, tool), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function profileName(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const profile = entry as AgentProfile;
    return profile.name ?? profile.id ?? null;
  }
  return null;
}

export type ProvisionResult =
  | { ok: true; kind: "provisioned" | "existing"; report: string; target: string }
  | { ok: false; step: StepName | "preflight"; error: string; target?: string };

class StepError extends Error {
  readonly step: StepName | "preflight";
  constructor(step: StepName | "preflight", message: string) {
    super(message);
    this.step = step;
  }
}

const STEP_ORDER: StepName[] = ["mkdir", "git-init", "marker", "bmad-install", "workspace", "orchestrator"];
const STEP_INDEX: Record<StepName, number> = { mkdir: 0, "git-init": 1, marker: 2, "bmad-install": 3, workspace: 4, orchestrator: 5 };

/** Pinned BMAD version the provisioner installs; bump this one line to upgrade. */
const BMAD_VERSION = "6.12.4";

export type ProvisionGoalSource = "operator" | "agent";

export interface ProvisionInput {
  name: string;
  goal?: string;
  goalSource?: ProvisionGoalSource;
  settings: SettingsValues;
  exec: ExecFn;
  sdk: ProvisionerSdk;
  pathEnv: string;
  buildPrompt: (input: { builderProfile: string; goal?: string; goalSource: ProvisionGoalSource }) => string;
  onStep?: (step: StepName) => void;
  /** Reports the id of every orchestrator agent this run creates or recreates. */
  onOwnedAgent?: (agentId: string) => void;
}

export async function runProvision(input: ProvisionInput): Promise<ProvisionResult> {
  let target: string | undefined;
  try {
    const outcome = await provision(input, (resolved) => (target = resolved));
    return outcome;
  } catch (error) {
    const step = error instanceof StepError ? error.step : "preflight";
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, step, error: scrubSecrets(raw), target };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours; anything else is dead.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function provision(input: ProvisionInput, captureTarget: (target: string) => void): Promise<ProvisionResult> {
  const { name, goal, goalSource, settings, exec, sdk, pathEnv, buildPrompt } = input;

  if (!(await toolOnPath("git", pathEnv))) {
    throw new StepError("preflight", "git was not found on PATH");
  }
  if (!(await toolOnPath("npx", pathEnv))) {
    throw new StepError("preflight", "npx was not found on PATH");
  }

  const config = await sdk.config.get();
  const profiles = (config.agentProfiles ?? []).map((entry) =>
    typeof entry === "string" ? ({ name: entry } as AgentProfile) : (entry as AgentProfile),
  );
  const orchestratorProfile = profiles.find((profile) => profileName(profile) === settings.orchestratorProfile);
  if (!orchestratorProfile) {
    throw new StepError("preflight", `orchestrator profile not found on this daemon: ${settings.orchestratorProfile}`);
  }
  const builderProfile = profiles.find((profile) => profileName(profile) === settings.builderProfile);
  if (!builderProfile) {
    throw new StepError("preflight", `builder profile not found on this daemon: ${settings.builderProfile}`);
  }

  const resolved = await resolveTarget(settings.root, name, {
    canAdopt: (target) => canAdoptCrashGap(target, exec),
  });
  if (!resolved.ok) throw new StepError("preflight", resolved.error);
  const target = resolved.target;
  captureTarget(target);

  let marker: Marker | null = null;
  if (resolved.existing === "marker") {
    try {
      marker = await readMarker(target);
    } catch (error) {
      // An unreadable or corrupt marker must fail loudly, not restart provisioning.
      throw new StepError("preflight", error instanceof Error ? error.message : String(error));
    }
  }
  const plan = planResume(resolved.existing, marker);

  if (plan.startAt === null && marker) {
    return completeRun({
      target,
      marker,
      goal,
      goalSource: goalSource ?? "operator",
      sdk,
      buildPrompt,
      orchestratorProfileName: settings.orchestratorProfile,
      builderProfileName: settings.builderProfile,
      onOwnedAgent: input.onOwnedAgent,
    });
  }

  if (plan.backfill.length > 0) {
    const backfill = Object.fromEntries(plan.backfill.map((step) => [step, true])) as Partial<Record<StepName, true>>;
    await writeInitialMarker(target, backfill);
  }

  let workspaceId: string | null = marker?.workspaceId ?? null;

  for (const step of STEP_ORDER) {
    if (STEP_INDEX[step] < STEP_INDEX[plan.startAt ?? "orchestrator"]) continue;
    input.onStep?.(step);

    try {
      if (step === "mkdir") {
        // Non-recursive on purpose: the target is expected not to exist. An
        // empty target (crash after mkdir, before the marker) skips creation.
        if (resolved.existing !== "empty") {
          await fsMkdir(target);
        }
        await markStep(target, step);
      } else if (step === "git-init") {
        await exec("git", ["init"], { cwd: target });
        await markStep(target, step);
      } else if (step === "marker") {
        if (!marker) {
          await writeInitialMarker(target, { mkdir: true, "git-init": true });
        }
        await markStep(target, step);
      } else if (step === "bmad-install") {
        // A plugin reload mid-install (or an orphaned installer) must not end
        // with two installers in the same directory: while the recorded
        // installer pid is alive, refuse instead of rerunning.
        const current = await readMarker(target).catch(() => null);
        const install = current?.install;
        if (install && processAlive(install.pid)) {
          throw new StepError(
            step,
            `a previous BMAD install (pid ${install.pid}, started ${install.startedAt}) appears to still be running; wait for it to finish or stop it, then re-run`,
          );
        }
        let installMarkerWrite: Promise<unknown> = Promise.resolve();
        await exec(
          "npx",
          [
            "--yes",
            `bmad-method@${BMAD_VERSION}`,
            "install",
            "--directory",
            target,
            "--modules",
            "bmm",
            "--tools",
            settings.bmadTools,
            "--no-shims",
            "--yes",
          ],
          {
            cwd: target,
            onSpawn: (pid) => {
              if (pid) installMarkerWrite = markInstallStarted(target, pid).catch(() => {});
            },
          },
        );
        await installMarkerWrite;
        await clearInstallMarker(target);
        await markStep(target, step);
      } else if (step === "workspace") {
        if (!workspaceId) {
          // A crash between create and the marker write must not duplicate the
          // workspace: reuse a live workspace already pointing at the target.
          workspaceId = await findLiveWorkspaceByDirectory(sdk, target);
        }
        if (!workspaceId) {
          const workspace = await sdk.workspaces.create({
            title: `${name} Orchestrator`,
            source: { kind: "directory", path: target },
          });
          workspaceId = workspace.id;
        }
        await markStep(target, step, { workspaceId });
      } else if (step === "orchestrator") {
        if (!workspaceId) {
          throw new Error("cannot start the orchestrator without a workspace");
        }
        // Same crash gap for the agent: a live owned agent already sitting in
        // the target directory is reused rather than duplicated.
        let agentId = await findLiveOwnedAgentByCwd(sdk, target);
        if (!agentId) {
          const agent = await createOrchestrator({
            sdk,
            workspaceId,
            orchestratorProfile,
      prompt: buildPrompt({ builderProfile: settings.builderProfile, goal, goalSource: goalSource ?? "operator" }),
          });
          agentId = agent.id;
        }
        input.onOwnedAgent?.(agentId);
        await markStep(target, step, { orchestratorAgentId: agentId });
      }
    } catch (error) {
      if (error instanceof StepError) throw error;
      throw new StepError(step, error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: true, kind: "provisioned", report: `provisioned ${target}`, target };
}

async function createOrchestrator(input: {
  sdk: ProvisionerSdk;
  workspaceId: string;
  orchestratorProfile: AgentProfile;
  prompt: string;
}): Promise<{ id: string }> {
  const profile = input.orchestratorProfile;
  if (!profile.provider) {
    throw new StepError("preflight", `orchestrator profile has no provider: ${profile.name ?? "unnamed"}`);
  }
  // The SDK agent config takes provider and model combined as "provider/model";
  // there is no separate model field.
  const config: WorkspaceAgentCreateInput["config"] = {
    provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
  };
  if (profile.modeId) config.modeId = profile.modeId;
  if (profile.thinkingOptionId) config.thinkingOptionId = profile.thinkingOptionId;
  if (profile.featureValues) config.featureValues = profile.featureValues;

  return input.sdk.workspaces.ref(input.workspaceId).agents.create({
    config,
    labels: { "pnp/owned": "true" },
    prompt: input.prompt,
  });
}

async function completeRun(input: {
  target: string;
  marker: Marker;
  goal?: string;
  goalSource: ProvisionGoalSource;
  sdk: ProvisionerSdk;
  buildPrompt: (input: { builderProfile: string; goal?: string; goalSource: ProvisionGoalSource }) => string;
  orchestratorProfileName: string;
  builderProfileName: string;
  onOwnedAgent?: (agentId: string) => void;
}): Promise<ProvisionResult> {
  const { target, marker, goal, goalSource, sdk } = input;
  const agentId = marker.orchestratorAgentId;
  if (!agentId) {
    throw new StepError("orchestrator", "resume marker is complete but records no orchestrator agent id");
  }

  const refetch = await sdk.agents.ref(agentId).refresh();
  const snapshot = refetch?.agent ?? null;
  let orchestrator: OrchestratorSnapshot | undefined;
  if (snapshot) {
    orchestrator = {
      status: snapshot.status as OrchestratorSnapshot["status"],
      archivedAt: snapshot.archivedAt ?? null,
    };
  }

  const decision = decideOrchestratorInteraction({
    hasGoal: typeof goal === "string" && goal.length > 0,
    orchestrator,
  });

  if (decision.action === "send-goal") {
    await sdk.agents.ref(agentId).send(followUpGoalPrompt(goal as string, goalSource));
    return { ok: true, kind: "existing", report: `goal sent to the existing orchestrator ${agentId}`, target };
  }

  if (decision.action === "recreate") {
    const workspaceId = marker.workspaceId;
    if (!workspaceId) {
      throw new StepError("orchestrator", "orchestrator vanished and the marker records no workspace id");
    }
    const config = await sdk.config.get();
    const profile = (config.agentProfiles ?? []).find((entry) => profileName(entry) === input.orchestratorProfileName);
    if (!profile) {
      throw new StepError("preflight", `orchestrator profile not found on this daemon: ${input.orchestratorProfileName}`);
    }
    const orchestratorProfile =
      typeof profile === "string" ? ({ name: profile } as AgentProfile) : (profile as AgentProfile);
    const agent = await createOrchestrator({
      sdk,
      workspaceId,
      orchestratorProfile,
      prompt: input.buildPrompt({ builderProfile: input.builderProfileName, goal, goalSource: input.goalSource }),
    });
    input.onOwnedAgent?.(agent.id);
    await markStep(target, "orchestrator", { orchestratorAgentId: agent.id });
    return { ok: true, kind: "provisioned", report: `recreated the orchestrator as ${agent.id}`, target };
  }

  return { ok: true, kind: "existing", report: decision.reason, target };
}
