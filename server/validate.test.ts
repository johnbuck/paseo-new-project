import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateName, resolveTarget } from "./validate.ts";

test("validateName accepts plain lowercase names", () => {
  for (const name of ["demo", "a", "abc123", "a-b_c.d", "pnp-test-integ", "0start"]) {
    assert.deepEqual(validateName(name), { ok: true, name });
  }
});

test("validateName rejects empty and whitespace", () => {
  for (const name of ["", " ", "a b"]) {
    const result = validateName(name);
    assert.equal(result.ok, false);
  }
});

test("validateName rejects leading dot, .git, and dot-dot", () => {
  for (const name of [".", ".git", ".hidden", "..", "a..b"]) {
    const result = validateName(name);
    assert.equal(result.ok, false, `expected rejection: ${name}`);
  }
});

test("validateName rejects path separators and traversal", () => {
  for (const name of ["../x", "a/..b", "a/b", "a\\b", ".."]) {
    const result = validateName(name);
    assert.equal(result.ok, false, `expected rejection: ${name}`);
  }
});

test("validateName rejects uppercase, unicode, and shell characters", () => {
  for (const name of ["Demo", "dÉmo", "demo;", "demo$(x)", "demo`x`", "demo x", "-demo", "_demo"]) {
    const result = validateName(name);
    assert.equal(result.ok, false, `expected rejection: ${name}`);
  }
});

test("validateName rejects overlong names", () => {
  assert.equal(validateName("a".repeat(48)).ok, true);
  assert.equal(validateName("a".repeat(49)).ok, false);
});

test("validateName accepts max-length name with all allowed characters", () => {
  const name = "a" + "b0._-".repeat(9) + "z";
  assert.ok(name.length <= 48);
  assert.equal(validateName(name).ok, true);
});

test("resolveTarget rejects relative roots", async () => {
  const result = await resolveTarget("relative/root", "demo");
  assert.equal(result.ok, false);
});

test("resolveTarget resolves fresh and empty targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const fresh = await resolveTarget(root, "demo");
    assert.equal(fresh.ok, true);
    if (fresh.ok) {
      assert.equal(fresh.existing, "none");
      assert.equal(fresh.target, join(root, "demo"));
    }

    await mkdir(join(root, "demo"));
    const empty = await resolveTarget(root, "demo");
    assert.equal(empty.ok, true);
    if (empty.ok) assert.equal(empty.existing, "empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTarget resolves root through a symlink to its real path", async () => {
  const outer = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const realRoot = join(outer, "real-root");
    const linkRoot = join(outer, "link-root");
    await mkdir(realRoot);
    await symlink(realRoot, linkRoot);
    const result = await resolveTarget(linkRoot, "demo");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.root, realRoot);
      assert.equal(result.target, join(realRoot, "demo"));
      assert.equal(result.existing, "none");
    }
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("resolveTarget refuses a target that is a symlink", async () => {
  const outer = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const elsewhere = join(outer, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(outer, "demo"));
    const result = await resolveTarget(outer, "demo");
    assert.equal(result.ok, false);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("resolveTarget refuses a target that is a regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    await writeFile(join(root, "demo"), "x");
    const result = await resolveTarget(root, "demo");
    assert.equal(result.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTarget refuses non-empty dir without marker by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const target = join(root, "demo");
    await mkdir(target);
    await writeFile(join(target, "readme.txt"), "x");
    const result = await resolveTarget(root, "demo");
    assert.equal(result.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTarget classifies a dir with marker as resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const target = join(root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(join(target, ".git", "paseo-new-project.json"), "{}");
    const result = await resolveTarget(root, "demo");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.existing, "marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTarget defers non-empty no-marker dirs to the adoption predicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const target = join(root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });

    const adopted = await resolveTarget(root, "demo", { canAdopt: async () => true });
    assert.equal(adopted.ok, true);
    if (adopted.ok) assert.equal(adopted.existing, "adoptable");

    const refused = await resolveTarget(root, "demo", { canAdopt: async () => false });
    assert.equal(refused.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTarget marker check ignores unrelated content in .git", async () => {
  const root = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const target = join(root, "demo");
    await mkdir(join(target, ".git"), { recursive: true });
    await writeFile(join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
    const result = await resolveTarget(root, "demo");
    assert.equal(result.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveTarget refuses when root does not exist or is a file", async () => {
  const outer = await mkdtemp(join(tmpdir(), "pnp-validate-"));
  try {
    const missing = await resolveTarget(join(outer, "missing-root"), "demo");
    assert.equal(missing.ok, false);

    await writeFile(join(outer, "root-file"), "x");
    const file = await resolveTarget(join(outer, "root-file"), "demo");
    assert.equal(file.ok, false);
    void readdir;
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});
