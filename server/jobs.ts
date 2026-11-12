import type { StepName } from "./resume.ts";
import { scrubSecrets } from "./scrub.ts";

export interface JobStatus {
  readonly id: string;
  readonly name: string;
  state: "running" | "complete" | "failed";
  step: StepName | "preflight";
  message?: string;
  report?: string;
  kind?: "provisioned" | "existing";
  readonly startedAt: number;
}

export class JobRegistry {
  private jobs = new Map<string, JobStatus>();
  private byName = new Map<string, JobStatus>();
  private running = new Map<string, Promise<void>>();
  private counter = 0;

  start(name: string, run: (report: (step: StepName) => void) => Promise<void>): { job: JobStatus; existed: boolean } {
    const current = this.byName.get(name);
    if (current && current.state === "running") {
      return { job: current, existed: true };
    }

    const job: JobStatus = {
      id: `pnp-job-${Date.now()}-${++this.counter}`,
      name,
      state: "running",
      step: "preflight",
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.byName.set(name, job);

    const done = run((step) => {
      if (job.state === "running") job.step = step;
    })
      .then(() => {
        if (job.state === "running") job.state = "complete";
      })
      .catch((error: unknown) => {
        job.state = "failed";
        job.message = scrubSecrets(error instanceof Error ? error.message : String(error));
      });

    this.running.set(name, done.finally(() => this.running.delete(name)));
    return { job, existed: false };
  }

  get(id: string): JobStatus | undefined {
    return this.jobs.get(id);
  }

  latestForName(name: string): JobStatus | undefined {
    return this.byName.get(name);
  }

  async settle(name: string): Promise<void> {
    const pending = this.running.get(name);
    if (pending) await pending;
  }
}
