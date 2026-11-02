import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../errors.js";

export const PTC_JOB_ID_PATTERN = /^ptc-[a-f0-9]{32}$/;
export const PTC_SESSION_ID_PATTERN = /^[a-f0-9]{16}$/;

export class WorkspaceMissingError extends Error {
  override name = "WorkspaceMissingError";
  readonly code = "workspace_missing" as const;
}

export type PreparedWorkspace = {
  /** Host path of the job's persistent workspace. */
  readonly hostPath: string;
  /** Path as seen inside the sandbox. */
  readonly sandboxPath: "/workspace";
  readonly created: boolean;
  readonly reused: boolean;
};

async function ensureDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ConfigurationError(`PTC workspace path is not a real directory: ${path}`);
  }
}

/**
 * Prepares `<workspaceRoot>/<jobId>/workspace` for a PTC job.
 *
 * Replay rule: when the control plane has already committed `workspaceReady`, a missing directory
 * is an error (`workspace_missing`) and is never recreated. Only a first run, or one whose
 * `workspaceReady` was not committed, may create the directory.
 */
export async function prepareJobWorkspace(
  workspaceRoot: string,
  jobId: string,
  workspaceReady: boolean,
): Promise<PreparedWorkspace> {
  if (!PTC_JOB_ID_PATTERN.test(jobId)) throw new ConfigurationError("PTC jobId is invalid");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  const jobDirectory = join(workspaceRoot, jobId);
  const hostPath = join(jobDirectory, "workspace");

  if (workspaceReady) {
    try {
      await ensureDirectory(hostPath);
      return { hostPath: await realpath(hostPath), sandboxPath: "/workspace", created: false, reused: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceMissingError(
          `workspace for ${jobId} is missing although the control plane marked it ready; refusing to recreate it`,
        );
      }
      throw error;
    }
  }

  await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  await ensureDirectory(jobDirectory);
  let created = false;
  try {
    await lstat(hostPath);
    await ensureDirectory(hostPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(hostPath, { recursive: true, mode: 0o700 });
    created = true;
  }
  await chmod(hostPath, 0o700);
  const resolved = await realpath(hostPath);
  if (!resolved.startsWith(`${await realpath(workspaceRoot)}/`)) {
    throw new ConfigurationError("PTC workspace resolves outside the workspace root");
  }
  await mkdir(join(resolved, ".ptc", "outputs"), { recursive: true, mode: 0o700 });
  await chmod(join(resolved, ".ptc"), 0o700);
  await chmod(join(resolved, ".ptc", "outputs"), 0o700);
  return { hostPath: resolved, sandboxPath: "/workspace", created, reused: !created };
}
