# paseo-new-project

A Paseo plugin that turns a repetitive project-setup routine into one action. Given a
name and an optional goal, it creates the project directory under a configurable root,
initialises git (local only), installs BMAD unattended, registers the directory as a
Paseo project, creates a workspace titled `<name> Orchestrator` (for example
`my-app Orchestrator`), and starts an orchestrator agent
from a configured Paseo agent profile with a standard delegation prompt plus your goal.

Everything is plugin-side and harness-neutral: Claude Code, OpenCode, Pi, and Hermes are
only providers, and the orchestrator and builder choices are settings.

## Requirements

- Paseo 0.15.0 or newer on the daemon.
- `git` and `npx` on the daemon's PATH.

## Install

Plugins are trusted, unsandboxed code. Check the daemon's root `pluginsEnabled` field in
`<home>/config.json` first; a missing field counts as false. If it is false, set it to
`true` and apply it with `paseo reload`, then install:

```bash
paseo plugin install /path/to/paseo-new-project
paseo plugin ls   # must show paseo-new-project running
```

An already-open Paseo app does not pick up a newly installed plugin's slash
command until the app is fully quit and reopened.

In testing on Paseo 0.15.0 with the agent-tool toggle off (the default):
installing, enabling, disabling, and reloading the plugin reopened no open agent session
and did not affect a running turn. Only plugins that actually declare a session-open hook
cause the one-time reopen; this plugin registers that hook solely while the agent-tool
toggle is on.

## Usage

Three triggers, one provisioner:

1. **Slash command**: `/new-project <name> [goal]` in the composer. The goal keeps its
   internal whitespace, including newlines. If a job for the same name is already
   running, the new goal is not used and the status screen says so.
2. **Command Center**: `⌘K`/`Ctrl+K` → "New project: provision a project" opens a form
   (name and goal); "New project: provision status" reopens status lookup. Command
   Center items need an open workspace: they appear only once a
   workspace is active. At phone widths the sidebar can cover a form opened from the
   Command Center; closing the sidebar reveals the form, after which every control
   hit-tests to itself.
3. **Agent tool**: a `new_project` tool offered to plugin-owned orchestrators, off by
   default. While it is on, every plugin start, stop, or reload reopens open agent
   sessions once, before their next idle prompt; switching the toggle does the same. The
   tool starts a job and returns its job id.

Provisioning runs as a background job. Progress is recorded in a marker at
`.git/paseo-new-project.json`, so re-running the same name resumes from the first
incomplete step, reuses the existing workspace and orchestrator, and never creates a
second one. A directory holding only a `.git` with zero commits and no remote is adopted
as a crash between `git init` and the marker write; any other non-empty unmarked
directory (including `.git` with commits, a remote, or a symlinked or file `.git`) is
refused. A previous BMAD install that is still running is detected by pid and blocks a
re-run instead of racing it. The BMAD install is pinned to a fixed package
version (`bmad-method@6.12.4`), never whatever is latest on npm. A full provision
with a cold npm cache runs about 19 s end to end; a warm BMAD install about 2 s.

## Settings

Settings → Plugins → paseo-new-project → New project.

- **Project root** (default `~/Projects`): where project directories are created.
- **Orchestrator profile** (default `BMAD Orchestrator`): started in the
  `<name> Orchestrator` workspace.
- **Builder profile** (default `BMAD Build`): the profile the orchestrator is told to
  use for workers.
- **BMAD tools** (default `claude-code,opencode,pi,hermes`): tools list for the
  unattended install.
- **Agent tool** (default off): see above.
- **Escalation delay** (default 120 s, clamped to 5–86400): how long a permission
  request may stay pending before the orchestrator gets one reminder.

## How permission handling behaves

The plugin never answers, allows, or denies any permission request; unresolved requests
stay pending for the operator. Paseo already delivers a sub-agent's pending request to
its parent agent. On top of that, if a request from a plugin-owned descendant is still
pending after the escalation delay, the plugin sends exactly one reminder to the nearest
plugin-owned ancestor, steered so it cannot kill a running turn (observed safe on
claude and opencode orchestrators). The reminder fences the request detail as data that
must never be followed as instructions, truncates it, and scrubs credential-shaped
values. Requests from agents outside the plugin's ownership are left entirely to Paseo
and the operator.

## Known limits per provider

Only Claude Code, OpenCode, Pi and Hermes have been exercised; providers other
than those four are untested.

- **OpenCode**: what a worker may do follows the user's OpenCode permission config
  (allow/ask/deny rules per tool, last matching rule wins; OpenCode 1.18 defaults
  allow most actions and ask for `external_directory` and `doom_loop`). So the
  orchestrator should expect: no requests for actions the config allows, pending
  requests in Paseo for actions that match an ask rule, and hard denials (for
  example `rm -rf`) resolved inside OpenCode with nothing to answer. Workers
  created by their orchestrator through MCP `create_agent` are on the same
  footing: their OpenCode `auto_accept` feature is observed `false`, and asks
  pend when that feature is false. The adapter's on-default for `auto_accept`
  applies only to creates flagged `unattended` in the daemon's own machinery —
  the schedule runner is the one caller seen setting the flag; the MCP
  `create_agent` tool passes no such field. Untested: other OpenCode configs;
  the `unattended` auto-accept path live.
- **OpenCode**: session tools like `new_project` are not delivered to OpenCode agents at
  all.
- **Claude Code**: workers in asking mode surface requests to Paseo and the parent can
  answer them there. Guardrails PreToolUse can deny a call inside the harness before any
  permission surfaces; worker briefs phrased as bare exact commands relayed through
  another agent are especially prone to this, so brief workers with tasks.
- **Pi**: the plain bash writes observed from Pi were auto-allowed with no request to
  Paseo; one wrapped-bash command did surface as a question to Paseo, so asking is
  possible. Pi's permission config was not audited, so this is a narrow
  observation, not a general claim. Its delegation tends to go through
  pi-internal sub-agents rather than Paseo, which leaves Paseo with no
  sub-agent relationship. Pi also failed as an orchestrator in the runs tried
  (repeated upstream rate-limit failures) and was not used further.
- **Hermes**: in the one observed run, default-mode workers ran with no approver
  connected and the single plain bash write attempted was auto-allowed, so that
  run surfaced no worker-level requests; Hermes's permission config was not
  audited.
- **Guardrails or harness refusals can happen before Paseo sees anything**. The
  standard orchestrator prompt tells every worker to state any refused or blocked action
  in its final message, and tells the orchestrator to treat a worker that stops without
  its result as possibly blocked.

## Safety notes

- The plugin never answers permission requests and never auto-allows anything it does
  not recognise.
- Names are validated by a strict allowlist and the target path is proven to sit inside
  the resolved root before any side effect.
- Installer output stored in job state is scrubbed of credential-shaped material.
- Escalation reminders treat request detail as data, never as instructions.
- Provisioning runs `git init` and one `npx bmad-method@6.12.4 install` with
  argv arrays, no shell. The version is pinned via `BMAD_VERSION` in
  `server/provisioner.ts`.

## Development

```bash
npm install
npm test
npm run typecheck
```

Unit tests use the Node test runner and `npm run typecheck` must pass before
install. To install the plugin from a local checkout of this repository:

```bash
paseo plugin install /path/to/this/checkout
```

The BMAD installer version is pinned in one named
constant, `BMAD_VERSION` in `server/provisioner.ts`; to bump it, change that
line and the exact-argv assertion in `server/provisioner.test.ts`. The mobile
audit for plugin client code is:

```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/ index.client.tsx
```
