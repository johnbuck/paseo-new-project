import { execFile } from "node:child_process";
import type { ExecFn } from "./provisioner.ts";

const EXEC_TIMEOUT_MS = 10 * 60 * 1000;
// A noisy npx install can exceed execFile's 1 MiB default buffer and kill an
// otherwise healthy install; 32 MiB gives verbose installs headroom.
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

export const shellFreeExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd: options?.cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    options?.onSpawn?.(child.pid);
  });
