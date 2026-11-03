import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
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
/** A local helper writes one line; anything longer means it is not the helper. */
const ACCOUNTING_TIMEOUT_MS = 5_000;
const ACCOUNTING_MAX_BYTES = 4_096;

export type PtcCgroup = {
  readonly path: string;
  /** Kills every process in the subtree; used for cancellation and shutdown. */
  kill(): Promise<void>;
  release(): Promise<void>;
};

async function write(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", flag: "w" });
}

/**
 * A cgroup v2 subtree per session. The sandbox enters it before it runs (see `spawnInCgroup`), so
 * every descendant (the runner and the bash children) is accounted for and can be killed as one
 * unit.
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

/**
 * The sandbox must enter its cgroup before bwrap unshares the cgroup namespace: afterwards the
 * kernel refuses to migrate the task into a cgroup outside that namespace (`EACCES`/`ENODEV`), and
 * the agent would have started a sandbox it cannot account for or kill. `spawn` has no pre-exec
 * hook, so a short-lived helper moves itself into the cgroup and then `execve`s the sandbox; the
 * PID and its membership carry over to bwrap and every descendant.
 *
 * The helper reports through an extra pipe so a failed move is an execution failure, never a
 * command exit code. `ready` resolves only after the kernel accepted the PID.
 */
const CGROUP_EXEC_HELPER = `
import { closeSync, writeFileSync, writeSync } from "node:fs";
const [path, file, ...args] = process.argv.slice(1);
const report = (line) => {
  try { writeSync(3, line + "\\n"); } catch { process.exit(125); }
};
try {
  writeFileSync(path + "/cgroup.procs", String(process.pid));
} catch (error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  report("error:" + message);
  console.error("aster: cannot move the sandbox into " + path + ": " + message);
  process.exit(125);
}
report("ok");
// The sandbox must not inherit the report channel; closing it also ends the parent's stream.
try { closeSync(3); } catch {}
try {
  // execve takes the array verbatim as argv: without this, the sandbox would lose argv[0] and see
  // its first flag as its program name.
  process.execve(file, [file, ...args], process.env);
} catch (error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  console.error("aster: cannot start " + file + ": " + message);
  process.exit(125);
}
`.trim();

export type AccountedProcess = {
  readonly child: ChildProcess;
  /** Settles when the helper wrote its PID to the cgroup, or rejects with the kernel's reason. */
  readonly ready: Promise<void>;
};

type AccountedStdio = "pipe" | "ignore" | "inherit" | null;

/** The helper is spawned detached, so killing its group also reaches an already-exec'd sandbox. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function spawnInCgroup(
  cgroupPath: string,
  file: string,
  args: readonly string[],
  options: Omit<SpawnOptions, "stdio"> & { readonly stdio: readonly AccountedStdio[] },
): AccountedProcess {
  const child: ChildProcess = spawn(process.execPath, [
    // execve is still experimental in Node 24 and would write a warning to the sandbox's stderr.
    "--no-warnings",
    "--input-type=module",
    "-e",
    CGROUP_EXEC_HELPER,
    // Everything after `--` is the helper's argv; without it Node would parse bwrap's flags.
    "--",
    cgroupPath,
    file,
    ...args,
  ], {
    ...options,
    stdio: [...options.stdio, "pipe"],
  });
  // A spawn failure arrives asynchronously; without a listener it would crash the agent before
  // the caller attaches its own handler. This listener never swallows the event for the caller.
  child.on("error", () => undefined);

  const ready = new Promise<void>((resolve, reject) => {
    const channel = child.stdio[3];
    if (channel === null || channel === undefined || typeof (channel as { on?: unknown }).on !== "function") {
      killTree(child);
      reject(new Error("the sandbox accounting channel is unavailable"));
      return;
    }
    let settled = false;
    let data = "";
    const onData = (chunk: string | Buffer): void => {
      data += chunk.toString();
      if (data.length > ACCOUNTING_MAX_BYTES) {
        finish(new Error("the sandbox accounting channel sent an invalid response"));
        return;
      }
      const newline = data.indexOf("\n");
      if (newline === -1) return;
      const line = data.slice(0, newline);
      if (line === "ok") finish();
      else if (line.startsWith("error:")) finish(new Error(line.slice("error:".length)));
      else finish(new Error("the sandbox accounting channel sent an invalid response"));
    };
    const onEnd = (): void => finish(new Error("the sandbox exited before it entered its cgroup"));
    const onError = (error: Error): void => finish(new Error(`the sandbox accounting channel failed: ${error.message}`));
    const onChildError = (error: Error): void => finish(new Error(`the sandbox could not start: ${error.message}`));
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stream = channel as Readable;
      // Detach only this module's listeners. Node tracks child stdio through listeners of its own;
      // `removeAllListeners()` would drop them and the sandbox's `close` event would never fire.
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      child.off("error", onChildError);
      // Drain to EOF rather than destroying: the helper's exec closes fd 3, so the stream ends by
      // itself and the process stays fully accounted for.
      stream.resume();
      if (error === undefined) resolve();
      else {
        killTree(child);
        reject(error);
      }
    };
    const timer = setTimeout(() => finish(new Error("the sandbox did not enter its cgroup in time")), ACCOUNTING_TIMEOUT_MS);
    timer.unref();
    (channel as Readable).setEncoding("utf8");
    (channel as Readable).on("data", onData);
    (channel as Readable).on("end", onEnd);
    (channel as Readable).on("error", onError);
    child.once("error", onChildError);
  });

  return { child, ready };
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
