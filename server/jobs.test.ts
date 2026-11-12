import assert from "assert/strict";
import { test } from "node:test";
import { JobRegistry } from "./jobs.ts";

test("JobRegistry returns a job id immediately and tracks completion", async () => {
  const registry = new JobRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { job, existed } = registry.start("demo", async (report) => {
    report("git-init");
    await gate;
  });
  assert.equal(existed, false);
  assert.match(job.id, /^pnp-job-/);
  assert.equal(job.state, "running");
  assert.equal(job.step, "git-init");
  assert.equal(registry.get(job.id), job);

  release();
  await registry.settle("demo");
  assert.equal(job.state, "complete");
});

test("JobRegistry reuses the running job for the same name", async () => {
  const registry = new JobRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = registry.start("demo", async () => {
    await gate;
  });
  const second = registry.start("demo", async () => {
    throw new Error("must not run");
  });
  assert.equal(second.existed, true);
  assert.equal(second.job.id, first.job.id);

  release();
  await registry.settle("demo");
});

test("JobRegistry allows a new job after the previous one completed", async () => {
  const registry = new JobRegistry();
  registry.start("demo", async () => {});
  await registry.settle("demo");
  const second = registry.start("demo", async () => {});
  assert.equal(second.existed, false);
  await registry.settle("demo");
});

test("JobRegistry records step failures with a scrubbed message", async () => {
  const registry = new JobRegistry();
  registry.start("demo", async (report) => {
    report("bmad-install");
    throw new Error("installer failed: token sk-live-abc123 leaked");
  });
  await registry.settle("demo");
  const job = registry.latestForName("demo");
  assert.ok(job);
  assert.equal(job.state, "failed");
  assert.equal(job.step, "bmad-install");
  assert.doesNotMatch(job.message ?? "", /sk-live-abc123/);
  assert.match(job.message ?? "", /\[redacted\]/);
});

test("JobRegistry settle tolerates unknown names", async () => {
  const registry = new JobRegistry();
  await registry.settle("never-started");
  assert.equal(registry.latestForName("never-started"), undefined);
});
