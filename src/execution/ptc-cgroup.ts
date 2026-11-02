import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PtcConfig } from "./ptc-config.js";
import { PtcHostError } from "./ptc-host.js";
import type { PtcIsolationState } from "./rpc-protocol.js";

const run = promisify(execFile);
const SESSION_ID_PATTERN = /^[a-f0-9]{16}$/;

export type PtcCgroup = {
  readonly path: string;
  addProcess(pid: number): Promise<void>;
  /** Kills every process in the subtree; used for cancellation and shutdown. */
  kill(): Promise<void>;
  release(): Promise<void>;
};

async function write(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "w" });
}

/**
 * A cgroup v2 subtree per session. The caller adds the bwrap process, so every descendant
 * (the runner and the bash children) is accounted for and can be killed as one unit.
 */
export async function createPtcCgroup(config: PtcConfig, sessionId: string): Promise<PtcCgroup> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new PtcHostError("invalid_request", "sessionId is not a 16-hex identifier", "not_started");
  }
  const root = config.cgroupRoot;
  const path = join(root, sessionId);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(path, { recursive: false, mode: 0o700 });
    await write(join(path, "memory.max"), String(config.cgroupMemoryMaxBytes));
    await write(join(path, "memory.swap.max"), "0");
    await write(join(path, "pids.max"), String(config.cgroupPidsMax));
    await write(join(path, "cpu.max"), config.cgroupCpuMax);
  } catch (error) {
    await rmdir(path).catch(() => undefined);
    throw new PtcHostError(
      "internal",
      `cgroup v2 is not usable at ${root}: ${error instanceof Error ? error.message : "unknown error"}`,
      "not_started",
    );
  }
  return {
    path,
    async addProcess(pid) {
      await write(join(path, "cgroup.procs"), String(pid));
    },
    async kill() {
      try {
        await write(join(path, "cgroup.kill"), "1");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async release() {
      await rmdir(path).catch(() => undefined);
    },
  };
}

async function probeBwrap(config: PtcConfig): Promise<boolean> {
  try {
    await run(config.bwrapPath, ["--version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function probeUserNamespace(): Promise<boolean | null> {
  try {
    const value = await readFile("/proc/sys/user/max_user_namespaces", "utf8");
    return Number(value.trim()) > 0;
  } catch {
    return null;
  }
}

async function probeCgroup(config: PtcConfig): Promise<boolean> {
  const probe = join(config.cgroupRoot, `.probe-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(config.cgroupRoot, { recursive: true, mode: 0o700 });
    await mkdir(probe, { mode: 0o700 });
    await write(join(probe, "pids.max"), "8");
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(probe).catch(() => undefined);
  }
}

async function probeDirectory(path: string, mode: "read" | "write" = "write"): Promise<boolean> {
  try {
    await access(path, mode === "write" ? constants.W_OK : constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type PtcRuntimeProbe = {
  readonly isolation: PtcIsolationState;
  readonly checks: Record<string, boolean | null>;
  readonly cgroupAvailable: boolean;
};

/**
 * Decide the isolation mode once, at startup/preflight. Without bwrap and user namespaces the
 * agent refuses PTC unless the operator explicitly opted into the prlimit-only fallback.
 */
export async function probePtcRuntime(config: PtcConfig): Promise<PtcRuntimeProbe> {
  const [bwrap, userNamespace, cgroup, workspaceRoot] = await Promise.all([
    probeBwrap(config),
    probeUserNamespace(),
    probeCgroup(config),
    probeDirectory(config.workspaceRoot),
  ]);
  const degradedAllowed = config.allowDegraded;
  // bwrap alone is not the isolation contract: resource limits must come from cgroup v2, or the
  // operator must explicitly accept the prlimit-only fallback.
  const useBwrap = bwrap && cgroup;
  if (!useBwrap && !degradedAllowed) {
    return {
      isolation: { mode: "bwrap", bwrap: false, userNamespace: userNamespace === true, cgroup: cgroup ? "v2" : "none", network: "none" },
      checks: {
        bwrap: false,
        userNamespace,
        cgroup,
        workspaceRoot,
        sharedWorkspace: null,
        directTmpRoot: null,
      },
      cgroupAvailable: cgroup,
    };
  }
  let sharedWorkspace: boolean | null = null;
  if (config.sharedWorkspaceMode !== "none" && config.sharedWorkspace !== undefined) {
    sharedWorkspace = await probeDirectory(
      config.sharedWorkspace,
      config.sharedWorkspaceMode === "rw" ? "write" : "read",
    );
  }
  const directTmpRoot = config.directEnabled
    ? await probeDirectory(config.directTmpRoot)
    : null;
  return {
    isolation: useBwrap
      ? {
          mode: "bwrap",
          bwrap: true,
          userNamespace: userNamespace === true,
          cgroup: cgroup ? "v2" : "none",
          network: "none",
        }
      : { mode: "degraded-prlimit", bwrap: false, userNamespace: false, cgroup: "none", network: "host" },
    checks: {
      // In degraded mode bwrap is not a check that can fail; it is simply not used.
      bwrap: useBwrap ? true : null,
      userNamespace: useBwrap ? userNamespace : null,
      cgroup: useBwrap ? cgroup : null,
      workspaceRoot,
      sharedWorkspace,
      directTmpRoot,
      degraded: useBwrap ? null : true,
    },
    cgroupAvailable: useBwrap && cgroup,
  };
}
