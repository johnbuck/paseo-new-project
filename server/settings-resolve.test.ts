import assert from "assert/strict";
import { test } from "node:test";
import { applyDevOverrides, expandHome } from "./settings-resolve.ts";

test("expandHome expands a bare tilde and tilde paths", () => {
  assert.equal(expandHome("~", "/users/base"), "/users/base");
  assert.equal(expandHome("~/", "/users/base"), "/users/base/");
  assert.equal(expandHome("~/Projects", "/users/base"), "/users/base/Projects");
});

test("expandHome leaves absolute and relative paths untouched", () => {
  assert.equal(expandHome("/tmp/x", "/users/base"), "/tmp/x");
  assert.equal(expandHome("relative", "/users/base"), "relative");
  assert.equal(expandHome("~other/x", "/users/base"), "~other/x");
});

test("applyDevOverrides is inactive without the env var", () => {
  const base = defaults();
  const result = applyDevOverrides(base, {});
  assert.deepEqual(result.values, base);
  assert.equal(result.active, false);
});

test("applyDevOverrides merges valid keys from the dev env JSON", () => {
  const result = applyDevOverrides(defaults(), {
    PNP_DEV_SETTINGS: JSON.stringify({ root: "/srv/projects", orchestratorProfile: "Test Profile" }),
  });
  assert.equal(result.active, true);
  assert.equal(result.values.root, "/srv/projects");
  assert.equal(result.values.orchestratorProfile, "Test Profile");
  assert.equal(result.values.builderProfile, "BMAD Build");
  assert.deepEqual(result.keys.sort(), ["orchestratorProfile", "root"]);
});

test("overriding one key keeps every other saved value", () => {
  const saved = { ...defaults(), orchestratorProfile: "Saved Orchestrator", escalationDelaySeconds: 300 };
  const result = applyDevOverrides(saved, {
    PNP_DEV_SETTINGS: JSON.stringify({ root: "/srv/projects" }),
  });
  assert.equal(result.values.root, "/srv/projects");
  assert.equal(result.values.orchestratorProfile, "Saved Orchestrator");
  assert.equal(result.values.escalationDelaySeconds, 300);
  assert.deepEqual(result.keys, ["root"]);
});

test("applyDevOverrides ignores invalid JSON and wrong-typed values", () => {
  const bad = applyDevOverrides(defaults(), { PNP_DEV_SETTINGS: "{not json" });
  assert.equal(bad.active, false);
  assert.deepEqual(bad.values, defaults());

  const wrongTypes = applyDevOverrides(defaults(), {
    PNP_DEV_SETTINGS: JSON.stringify({ root: 42, escalationDelaySeconds: "soon" }),
  });
  assert.equal(wrongTypes.active, false);
  assert.deepEqual(wrongTypes.values, defaults());
});

test("applyDevOverrides only accepts known setting keys", () => {
  const result = applyDevOverrides(defaults(), {
    PNP_DEV_SETTINGS: JSON.stringify({ root: "/srv/projects", unexpected: "x" }),
  });
  assert.equal(result.values.root, "/srv/projects");
  assert.equal(Object.keys(result.values).includes("unexpected"), false);
});

function defaults() {
  return {
    root: "~/Projects",
    orchestratorProfile: "BMAD Orchestrator",
    builderProfile: "BMAD Build",
    bmadTools: "claude-code,opencode,pi,hermes",
    agentToolEnabled: false,
    escalationDelaySeconds: 120,
  };
}
