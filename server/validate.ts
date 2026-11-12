import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MARKER_BASENAME = "paseo-new-project.json";
export const MARKER_PATH = join(".git", MARKER_BASENAME);
export const MAX_NAME_LENGTH = 48;

export type ValidateNameResult = { ok: true; name: string } | { ok: false; error: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validateName(name: string): ValidateNameResult {
  if (name.length === 0) return { ok: false, error: "name is empty" };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name is longer than ${MAX_NAME_LENGTH} characters` };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: "name must start with a lowercase letter or digit and contain only a-z, 0-9, '.', '_', '-'" };
  }
  if (name.startsWith(".")) return { ok: false, error: "name must not start with a dot" };
  if (name.includes("..")) return { ok: false, error: "name must not contain '..'" };
  if (name === ".git") return { ok: false, error: "name must not be '.git'" };
  return { ok: true, name };
}

export type ResolveTargetResult =
  | { ok: true; root: string; target: string; existing: "none" | "empty" | "marker" | "adoptable" }
  | { ok: false; error: string };

export interface ResolveTargetOptions {
  canAdopt?: (target: string) => Promise<boolean>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function hasMarker(target: string): Promise<boolean> {
  return exists(join(target, MARKER_PATH));
}

export async function resolveTarget(root: string, name: string, options: ResolveTargetOptions = {}): Promise<ResolveTargetResult> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  if (!isAbsolute(root)) return { ok: false, error: `root must be an absolute path: ${root}` };

  let realRoot: string;
  try {
    realRoot = await realpath(resolve(root));
  } catch {
    return { ok: false, error: `root does not exist or cannot be resolved: ${root}` };
  }

  let rootStat;
  try {
    rootStat = await stat(realRoot);
  } catch {
    return { ok: false, error: `root is not accessible: ${root}` };
  }
  if (!rootStat.isDirectory()) return { ok: false, error: `root is not a directory: ${root}` };

  const target = join(realRoot, name);
  if (dirname(target) !== realRoot) {
    return { ok: false, error: "resolved target does not sit directly inside the root" };
  }

  let targetStat;
  try {
    targetStat = await lstat(target);
  } catch {
    return { ok: true, root: realRoot, target, existing: "none" };
  }

  if (targetStat.isSymbolicLink()) {
    return { ok: false, error: `target exists and is a symlink: ${target}` };
  }
  if (!targetStat.isDirectory()) {
    return { ok: false, error: `target exists and is not a directory: ${target}` };
  }

  const entries = await readdir(target);
  if (entries.length === 0) {
    return { ok: true, root: realRoot, target, existing: "empty" };
  }

  if (await hasMarker(target)) {
    return { ok: true, root: realRoot, target, existing: "marker" };
  }

  const canAdopt = options.canAdopt ?? (async () => false);
  if (await canAdopt(target)) {
    return { ok: true, root: realRoot, target, existing: "adoptable" };
  }

  return { ok: false, error: `target directory is not empty and has no resume marker: ${target}` };
}
