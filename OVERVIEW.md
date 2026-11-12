# paseo-new-project

Provisions a new project in one action: it creates the project folder under a
configured root, initialises git, installs BMAD unattended, registers the
directory as a Paseo project, creates a workspace titled
`<name> Orchestrator` (for example `my-app Orchestrator`), and starts an
orchestrator agent from a configured Paseo agent profile with a standard
delegation prompt plus your goal.

## How it works

Provisioning runs as a background job on the daemon. Progress is recorded in a
marker inside the project's `.git` directory, so re-running the same name
resumes from the first incomplete step instead of duplicating work. The BMAD
install is pinned to a fixed package version (`bmad-method@6.12.4`), never
whatever is latest on npm; the version lives in one constant, `BMAD_VERSION`
in `server/provisioner.ts`. The plugin
never answers permission requests itself: Paseo already delivers a sub-agent's
pending request to its parent agent, and the plugin only adds an optional
delayed reminder to the orchestrator if a request is still pending.

## Setup

Requires Paseo 0.15.0 or newer. `git` and `npx` must be on the daemon's PATH.
The default project root is `~/Projects` (change it in settings). The
orchestrator and builder agents come from your Paseo agent profiles; the
defaults are `BMAD Orchestrator` and `BMAD Build`.

## Capabilities and settings

- Project root: where new project directories are created.
- Orchestrator profile: the agent profile used to start the orchestrator.
- Builder profile: the profile the orchestrator is told to use for workers.
- BMAD tools: the tools list passed to the unattended BMAD install.
- Escalation delay: seconds a permission request stays unanswered before the
  plugin reminds the orchestrator once.
- Agent tool (default off): exposes a `new_project` tool to plugin-owned
  orchestrators. While it is on, every plugin start, stop, or reload reopens
  open agent sessions once, before their next idle prompt; switching the toggle
  does the same.

The plugin never allows or denies permission requests and never prints or
stores secrets.

## Known limits

Permission surfacing depends on the worker harness and, for OpenCode, on the
user's OpenCode permission config: actions the config allows surface nothing,
ask-rule matches pend in Paseo, and hard denials are resolved inside OpenCode
(`auto_accept` is observed `false` for MCP-created workers; the adapter's
on-default applies only to daemon-internal unattended creates such as schedule
runs). Pi and Hermes auto-allowed the few plain bash writes observed; neither
config was audited, and Pi failed as an orchestrator in the runs tried, so it
is not recommended for that role. Guardrails or harness
refusals can happen before Paseo sees anything, so workers must report
refusals themselves. The `new_project` agent tool is not delivered to OpenCode
agents. Command Center items need an open workspace, and at phone widths the
sidebar can cover a form opened from the Command Center until it is closed.
Only Claude Code, OpenCode, Pi and Hermes have been exercised; providers other
than those four are untested.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests are unit tests for the server modules, written for the Node test runner
(`node --test`, Node 26 native TypeScript). Run `npm test` and
`npm run typecheck` before installing (`paseo plugin install /path/to/this/checkout`).
The BMAD installer version is pinned
via `BMAD_VERSION` in `server/provisioner.ts`; bump that one line (and the
exact-argv test) to upgrade.
