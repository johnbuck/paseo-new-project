import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecFn } from "./provisioner.ts";
import { MARKER_PATH } from "./validate.ts";

export type StepName = "mkdir" | "git-init" | "marker" | "bmad-install" | "workspace" | "orchestrator";

export const STEP_ORDER: StepName[] = ["mkdir", "git-init", "marker", "bmad-install", "workspace", "orchestrator"];

export interface Marker {
  version: 1;
  steps: Partial<Record<StepName, true>>;
  workspaceId?: string;
  orchestratorAgentId?: string;
  /** Present only while a BMAD install is in flight; guards against reruns. */
  install?: { pid: number; startedAt: string };
}

export async function readMarker(target: string): Promise<Marker | null> {
  let raw: string;
  try {
    raw = await readFile(join(target, MARKER_PATH), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Absent is normal; unreadable is not — a silent null here would restart
    // provisioning over an existing setup.
    throw new Error(
      `resume marker exists but cannot be read: ${join(target, MARKER_PATH)} (${code ?? "unknown error"})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`resume marker is not valid JSON: ${join(target, MARKER_PATH)}`);
  }
  const marker = parsed as Marker;
  if (marker.version !== 1 || typeof marker.steps !== "object" || marker.steps === null) {
    throw new Error(`resume marker has an unsupported shape: ${join(target, MARKER_PATH)}`);
  }
  return marker;
}

async function writeMarkerFile(target: string, marker: Marker): Promise<void> {
  const dir = join(target, ".git");
  await mkdir(dir, { recursive: true });
  const finalPath = join(target, MARKER_PATH);
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = join(dir, `.pnp-marker.${unique}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(tmpPath, finalPath);
}

export async function writeInitialMarker(target: string, completed: Partial<Record<StepName, true>>): Promise<Marker> {
  const marker: Marker = { version: 1, steps: { ...completed } };
  await writeMarkerFile(target, marker);
  return marker;
}

export async function markStep(target: string, step: StepName, extra?: Pick<Marker, "workspaceId" | "orchestratorAgentId">): Promise<Marker> {
  const current = (await readMarker(target)) ?? { version: 1, steps: {} };
  const marker: Marker = {
    ...current,
    steps: { ...current.steps, [step]: true },
    ...(extra ?? {}),
  };
  await writeMarkerFile(target, marker);
  return marker;
}

/** Record the running installer's pid so a concurrent rerun can detect it. */
export async function markInstallStarted(target: string, pid: number): Promise<Marker> {
  const current = (await readMarker(target)) ?? { version: 1, steps: {} };
  const marker: Marker = { ...current, install: { pid, startedAt: new Date().toISOString() } };
  await writeMarkerFile(target, marker);
  return marker;
}

/** Clear the in-flight install record after the installer exits. */
export async function clearInstallMarker(target: string): Promise<Marker> {
  const current = (await readMarker(target)) ?? { version: 1, steps: {} };
  const { install: _install, ...rest } = current;
  await writeMarkerFile(target, rest);
  return rest;
}

export function firstIncompleteStep(marker: Marker | null): StepName | null {
  if (!marker) return "mkdir";
  for (const step of STEP_ORDER) {
    if (!marker.steps[step]) return step;
  }
  return null;
}

/**
 * A crash between `git init` and the marker write leaves a directory holding
 * only a freshly initialised `.git`. Such a directory is safe to adopt:
 * exactly one `.git` entry (a real directory, never a symlink), no remotes,
 * and no commits — both asked of git itself rather than parsed from files.
 * A git failure here refuses adoption: the repository state is unknown.
 */
export async function canAdoptCrashGap(target: string, exec: ExecFn): Promise<boolean> {
  const entries = await readdir(target);
  if (entries.length !== 1 || entries[0] !== ".git") return false;

  const gitDir = join(target, ".git");
  const gitStat = await lstat(gitDir).catch(() => null);
  if (!gitStat?.isDirectory() || gitStat.isSymbolicLink()) return false;

  const remotes = await exec("git", ["remote"], { cwd: target }).catch(() => null);
  if (!remotes || remotes.stdout.trim().length > 0) return false;

  const commits = await exec("git", ["rev-list", "-n1", "--all"], { cwd: target }).catch(() => null);
  if (!commits || commits.stdout.trim().length > 0) return false;

  return true;
}

export type ExistingKind = "none" | "empty" | "marker" | "adoptable";

export interface ResumePlan {
  startAt: StepName | null;
  backfill: StepName[];
}

export function planResume(existing: ExistingKind, marker: Marker | null): ResumePlan {
  if (marker) {
    const startAt = firstIncompleteStep(marker);
    return { startAt, backfill: [] };
  }
  if (existing === "adoptable") {
    // The crash gap is a .git that may be half-initialised, so resume re-runs
    // git init (idempotent) rather than trusting the crashed init to be whole.
    return { startAt: "git-init", backfill: ["mkdir"] };
  }
  return { startAt: "mkdir", backfill: [] };
}

/** Real agent snapshot statuses, per the daemon's agent payload. */
export type OrchestratorStatus = "initializing" | "idle" | "running" | "error" | "closed";

export interface OrchestratorSnapshot {
  status: OrchestratorStatus;
  /** ISO timestamp when the agent is archived; null while it is live. */
  archivedAt: string | null;
}

export type OrchestratorDecision =
  | { action: "report"; reason: string }
  | { action: "send-goal" }
  | { action: "recreate" };

export function decideOrchestratorInteraction(input: {
  hasGoal: boolean;
  orchestrator: OrchestratorSnapshot | undefined;
}): OrchestratorDecision {
  // Only a vanished (null snapshot) or archived orchestrator is recreated;
  // every live state is reported so the marker's agent id is never orphaned
  // by a premature second orchestrator.
  if (!input.orchestrator || input.orchestrator.archivedAt !== null) {
    return { action: "recreate" };
  }
  if (input.orchestrator.status === "running") {
    return { action: "report", reason: "orchestrator is running; not re-prompted" };
  }
  if (input.orchestrator.status !== "idle") {
    return { action: "report", reason: `orchestrator is ${input.orchestrator.status}; left untouched` };
  }
  if (!input.hasGoal) {
    return { action: "report", reason: "orchestrator exists and no goal was supplied" };
  }
  return { action: "send-goal" };
}
