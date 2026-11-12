import assert from "assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  STEP_ORDER,
  canAdoptCrashGap,
  decideOrchestratorInteraction,
  firstIncompleteStep,
  markStep,
  planResume,
  readMarker,
  writeInitialMarker,
} from "./resume.ts";
import type { ExecFn } from "./provisioner.ts";
import { MARKER_PATH } from "./validate.ts";

async function tempTarget(): Promise<{ root: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), "pnp-resume-"));
  const target = join(root, "demo");
  await mkdir(target);
  return { root, target };
}

/** Fake git: fresh by default; tests flip stdout per argv. */
function fakeGit(answers: { match: string[]; stdout: string }[] = []): ExecFn {
  return async (file, args) => {
    assert.equal(file, "git");
    for (const answer of answers) {
      if (answer.match.every((part) => args.includes(part))) return { stdout: answer.stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

async function gitInitLike(target: string) {
  await mkdir(join(target, ".git"));
}

test("marker round-trips through .git", async () => {
  const { root, target } = await tempTarget();
  try {
    await mkdir(join(target, ".git"), { recursive: true });
    const marker = await writeInitialMarker(target, { mkdir: true });
    assert.equal(marker.steps.mkdir, true);
    const read = await readMarker(target);
    assert.ok(read);
    assert.equal(read.version, 1);
    assert.equal(read.steps.mkdir, true);
    assert.equal(STEP_ORDER.length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readMarker returns null only when the marker is absent", async () => {
  const { root, target } = await tempTarget();
  try {
    assert.equal(await readMarker(target), null);
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(join(target, MARKER_PATH), "not json");
    await assert.rejects(() => readMarker(target));
    // a marker that exists but cannot be read (here: a directory) rejects too
    await rm(join(target, MARKER_PATH));
    await mkdir(join(target, MARKER_PATH));
    await assert.rejects(() => readMarker(target), /cannot be read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markStep preserves earlier steps and persists atomically", async () => {
  const { root, target } = await tempTarget();
  try {
    await mkdir(join(target, ".git"), { recursive: true });
    await writeInitialMarker(target, { mkdir: true });
    const marker = await markStep(target, "git-init");
    assert.equal(marker.steps.mkdir, true);
    assert.equal(marker.steps["git-init"], true);
    const read = await readMarker(target);
    assert.ok(read);
    assert.equal(read.steps["git-init"], true);
    assert.equal(read.steps.mkdir, true);
    const raw = JSON.parse(await readFile(join(target, MARKER_PATH), "utf8"));
    assert.equal(raw.steps["git-init"], true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("firstIncompleteStep walks the ordered list", async () => {
  assert.equal(firstIncompleteStep(null), "mkdir");
  assert.equal(firstIncompleteStep({ version: 1, steps: {} }), "mkdir");
  assert.equal(
    firstIncompleteStep({ version: 1, steps: { mkdir: true, "git-init": true } }),
    "marker",
  );
  assert.equal(firstIncompleteStep({ version: 1, steps: { mkdir: true } }), "git-init");
  const complete = Object.fromEntries(STEP_ORDER.map((step) => [step, true]));
  assert.equal(firstIncompleteStep({ version: 1, steps: complete }), null);
});

test("canAdoptCrashGap adopts a bare git init directory", async () => {
  const { root, target } = await tempTarget();
  try {
    await gitInitLike(target);
    assert.equal(await canAdoptCrashGap(target, fakeGit()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canAdoptCrashGap refuses once a commit exists", async () => {
  const { root, target } = await tempTarget();
  try {
    await gitInitLike(target);
    const git = fakeGit([{ match: ["rev-list"], stdout: "0123456789abcdef\n" }]);
    assert.equal(await canAdoptCrashGap(target, git), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canAdoptCrashGap refuses a configured remote", async () => {
  const { root, target } = await tempTarget();
  try {
    await gitInitLike(target);
    const git = fakeGit([{ match: ["remote"], stdout: "origin\n" }]);
    assert.equal(await canAdoptCrashGap(target, git), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canAdoptCrashGap refuses when git itself fails", async () => {
  const { root, target } = await tempTarget();
  try {
    await gitInitLike(target);
    const failing: ExecFn = async () => {
      throw new Error("not a git repository");
    };
    assert.equal(await canAdoptCrashGap(target, failing), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canAdoptCrashGap refuses extra content beside .git", async () => {
  const { root, target } = await tempTarget();
  try {
    await gitInitLike(target);
    await writeFile(join(target, "readme.txt"), "x");
    assert.equal(await canAdoptCrashGap(target, fakeGit()), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canAdoptCrashGap refuses missing, non-directory, or symlinked .git", async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), "pnp-resume-"));
  try {
    const emptyTarget = join(emptyRoot, "empty");
    await mkdir(emptyTarget);
    assert.equal(await canAdoptCrashGap(emptyTarget, fakeGit()), false);

    const fileTarget = join(emptyRoot, "gitfile");
    await mkdir(fileTarget);
    await writeFile(join(fileTarget, ".git"), "gitdir: elsewhere\n");
    assert.equal(await canAdoptCrashGap(fileTarget, fakeGit()), false);

    const realGit = join(emptyRoot, "real-git");
    const linkTarget = join(emptyRoot, "linked");
    await mkdir(realGit);
    await mkdir(linkTarget);
    await symlink(realGit, join(linkTarget, ".git"));
    assert.equal(await canAdoptCrashGap(linkTarget, fakeGit()), false);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }
});

test("planResume starts fresh for absent or empty targets", () => {
  assert.deepEqual(planResume("none", null), { startAt: "mkdir", backfill: [] });
  assert.deepEqual(planResume("empty", null), { startAt: "mkdir", backfill: [] });
});

test("planResume backfills the crash gap and re-runs git init", () => {
  assert.deepEqual(planResume("adoptable", null), {
    startAt: "git-init",
    backfill: ["mkdir"],
  });
});

test("planResume resumes from the first incomplete step", () => {
  const plan = planResume("marker", { version: 1, steps: { mkdir: true, "git-init": true, marker: true } });
  assert.deepEqual(plan, { startAt: "bmad-install", backfill: [] });
});

test("planResume reports completion when every step is done", () => {
  const complete = Object.fromEntries(STEP_ORDER.map((step) => [step, true]));
  const plan = planResume("marker", { version: 1, steps: complete });
  assert.deepEqual(plan, { startAt: null, backfill: [] });
});

test("decideOrchestratorInteraction never re-prompts a running orchestrator", () => {
  const running = decideOrchestratorInteraction({
    hasGoal: true,
    orchestrator: { status: "running", archivedAt: null },
  });
  assert.equal(running.action, "report");
  assert.match(running.reason, /running/);
});

test("decideOrchestratorInteraction sends the goal to an idle orchestrator once", () => {
  const idle = decideOrchestratorInteraction({
    hasGoal: true,
    orchestrator: { status: "idle", archivedAt: null },
  });
  assert.deepEqual(idle, { action: "send-goal" });
});

test("decideOrchestratorInteraction only reports when no goal was supplied", () => {
  const idleNoGoal = decideOrchestratorInteraction({
    hasGoal: false,
    orchestrator: { status: "idle", archivedAt: null },
  });
  assert.equal(idleNoGoal.action, "report");
  assert.match(idleNoGoal.reason, /no goal/);
});

test("decideOrchestratorInteraction recreates a vanished orchestrator", () => {
  const decision = decideOrchestratorInteraction({ hasGoal: false, orchestrator: undefined });
  assert.deepEqual(decision, { action: "recreate" });
});

test("decideOrchestratorInteraction recreates only an archived orchestrator, by archivedAt", () => {
  const decision = decideOrchestratorInteraction({
    hasGoal: true,
    orchestrator: { status: "closed", archivedAt: "2026-01-01T00:00:00Z" },
  });
  assert.deepEqual(decision, { action: "recreate" });
});

test("decideOrchestratorInteraction reports non-idle live states clearly and never recreates them", () => {
  for (const status of ["initializing", "error", "closed"] as const) {
    const decision = decideOrchestratorInteraction({
      hasGoal: true,
      orchestrator: { status, archivedAt: null },
    });
    assert.equal(decision.action, "report", `status ${status} must report, not recreate`);
    assert.ok(decision.action === "report" && decision.reason.includes(status));
  }
});
