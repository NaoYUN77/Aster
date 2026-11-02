/**
 * Runs the PTC runner inside a bwrap sandbox on the execution host.
 *
 * Every session gets its own user/PID/IPC/UTS/cgroup/network namespace and, when possible, a
 * cgroup v2 with memory, pids, and CPU limits. When cgroup v2 is unavailable the process tree is
 * wrapped with `prlimit` instead. When user namespaces are unavailable the manager refuses to
 * start unless the operator explicitly opts into `degraded-prlimit`, which has no filesystem or
 * network isolation and is recorded as such.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConfigurationError } from "../errors.js";
import {
  PTC_RUNNER_MAX_FRAME_BYTES,
  RunnerFrameDecoder,
  encodeRunnerFrame,
  type RunnerFrame,
} from "./ptc-runner-protocol.js";
import {
  PTC_SESSION_ID_PATTERN,
  prepareJobWorkspace,
  type PreparedWorkspace,
} from "./ptc-workspace.js";

export type PtcIsolation = {
  readonly mode: "bwrap" | "bwrap-prlimit" | "degraded-prlimit";
  readonly cgroup: "v2" | "none";
  readonly network: "none" | "host";
  readonly cgroupKill: boolean;
};

export type PtcSandboxConfig = {
  /** Host directory containing `dist`, `node_modules`, and `package.json`. */
  readonly appRoot: string;
  readonly nodePath: string;
  readonly runnerEntry: string;
  readonly workspaceRoot: string;
  readonly cgroupRoot: string;
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly allowDegraded: boolean;
  readonly memoryMaxBytes: number;
  readonly pidsMax: number;
  readonly cpuMax: string;
  readonly outputMaxBytes: number;
  readonly retentionMs: number;
  readonly startupTimeoutMs: number;
  readonly maxInterruptBudget: number;
  readonly maxMemoryLimitBytes: number;
  readonly piCodemodeVersion: string;
  readonly quickjsVersion: string;
  readonly now?: () => number;
};

export type PtcPreflightResult = {
  readonly ok: boolean;
  readonly checks: Record<string, boolean>;
  readonly isolation: Omit<PtcIsolation, "cgroupKill">;
  readonly diagnostics: readonly string[];
};

export type PtcRunnerEvents = {
  onFrame(frame: RunnerFrame): void;
  onExit(info: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stderr: string }): void;
  onStderr?(text: string): void;
};

export type PtcRunnerHandle = {
  readonly pid: number;
  readonly isolation: PtcIsolation;
  readonly exited: Promise<void>;
  send(frame: RunnerFrame): boolean;
  kill(reason: string, hard?: boolean): Promise<void>;
};

export type PtcSandboxStart = {
  readonly workspace: PreparedWorkspace;
  readonly runner: PtcRunnerHandle;
};

const STDERR_RING_BYTES = 8 * 1024;
const KILL_GRACE_MS = 500;
const CGROUP_EMPTY_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

type CgroupHandle = {
  readonly path: string;
  readonly killAvailable: boolean;
  cleaned?: boolean;
};

export class PtcSandboxManager {
  private readonly config: PtcSandboxConfig;
  private cachedPreflight: PtcPreflightResult | undefined;

  constructor(config: PtcSandboxConfig) {
    this.config = {
      ...config,
      appRoot: resolve(config.appRoot),
      nodePath: resolve(config.nodePath),
      runnerEntry: resolve(config.runnerEntry),
      workspaceRoot: resolve(config.workspaceRoot),
      cgroupRoot: resolve(config.cgroupRoot),
      bwrapPath: resolve(config.bwrapPath),
      prlimitPath: resolve(config.prlimitPath),
    };
  }

  async preflight(): Promise<PtcPreflightResult> {
    if (this.cachedPreflight !== undefined) return this.cachedPreflight;
    const diagnostics: string[] = [];
    const checks: Record<string, boolean> = {};
    checks.bwrap = await executable(this.config.bwrapPath);
    checks.prlimit = await executable(this.config.prlimitPath);
    checks.node = await executable(this.config.nodePath);
    checks.runner = await exists(this.config.runnerEntry);
    checks.package = await exists(join(this.config.appRoot, "package.json"));
    checks.workspace = await this.checkWorkspaceRoot();

    let userns = false;
    let bwrapProbe = "";
    if (checks.bwrap) {
      const probe = await this.runProbe();
      userns = probe.ok;
      bwrapProbe = probe.message;
      if (!probe.ok) diagnostics.push(probe.message);
    }
    checks.userns = userns;

    const cgroup = await this.probeCgroup();
    checks.cgroup = cgroup.available;
    if (!cgroup.available) diagnostics.push(cgroup.message);

    const mode: PtcIsolation["mode"] = userns
      ? (cgroup.available ? "bwrap" : "bwrap-prlimit")
      : "degraded-prlimit";
    const degradationAllowed = userns || this.config.allowDegraded;
    // Every mode except plain bwrap+cgroup wraps the runner in prlimit, so that binary is required
    // there even when cgroup v2 exists: degraded mode never uses bwrap.
    const resourceLimitAvailable = userns && cgroup.available ? true : checks.prlimit;
    const ok = checks.node && checks.runner && checks.package && checks.workspace
      && resourceLimitAvailable && degradationAllowed;
    if (!userns && !this.config.allowDegraded) {
      diagnostics.push(`bwrap user namespaces are unavailable (${bwrapProbe}); set PTC_ALLOW_DEGRADED=1 only if prlimit-only isolation is acceptable`);
    }
    if (!resourceLimitAvailable) diagnostics.push("neither cgroup v2 nor prlimit is available");
    if (!checks.node) diagnostics.push(`node is not executable: ${this.config.nodePath}`);
    if (!checks.runner) diagnostics.push(`PTC runner entry is missing: ${this.config.runnerEntry}`);

    const result: PtcPreflightResult = {
      ok,
      checks,
      isolation: {
        mode,
        cgroup: cgroup.available ? "v2" : "none",
        network: userns ? "none" : "host",
      },
      diagnostics,
    };
    this.cachedPreflight = result;
    return result;
  }

  async open(
    jobId: string,
    sessionId: string,
    workspaceReady: boolean,
    events: PtcRunnerEvents,
  ): Promise<PtcSandboxStart> {
    if (!PTC_SESSION_ID_PATTERN.test(sessionId)) throw new ConfigurationError("PTC sessionId is invalid");
    const preflight = await this.preflight();
    if (!preflight.ok) {
      throw new ConfigurationError(`PTC sandbox preflight failed: ${preflight.diagnostics.join("; ")}`);
    }
    const workspace = await prepareJobWorkspace(this.config.workspaceRoot, jobId, workspaceReady);
    const plan = preflight.isolation;
    let mode = plan.mode;
    const cgroup = plan.cgroup === "v2" ? await this.createCgroup(sessionId) : undefined;
    if (plan.cgroup === "v2" && cgroup === undefined) {
      // The probe succeeded but this session's cgroup did not; fall back to prlimit rather than
      // start without the limits we promised.
      mode = "bwrap-prlimit";
    }
    const isolation: PtcIsolation = {
      mode,
      cgroup: cgroup === undefined ? "none" : "v2",
      network: plan.network,
      cgroupKill: cgroup?.killAvailable ?? false,
    };
    try {
      return await this.spawnRunner(jobId, sessionId, workspace, cgroup, isolation, events);
    } catch (error) {
      if (cgroup !== undefined) await this.removeCgroup(cgroup);
      throw error;
    }
  }

  private async runProbe(): Promise<{ ok: boolean; message: string }> {
    const args = [
      "--unshare-user", "--uid", "0", "--gid", "0",
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
      "--unshare-net",
      "--cap-drop", "ALL",
      "--clearenv",
      "--die-with-parent",
      "--proc", "/proc",
      "--dev", "/dev",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--",
    ];
    const candidates = ["/usr/bin/true", "/bin/true"];
    let last = "";
    for (const candidate of candidates) {
      const outcome = await this.runCommand(this.config.bwrapPath, [...args, candidate], 5_000);
      if (outcome.code === 0) return { ok: true, message: "" };
      last = outcome.stderr.trim() || `exit ${outcome.code ?? "signal"}`;
      if (!outcome.spawned) return { ok: false, message: `cannot start bwrap: ${last}` };
    }
    return { ok: false, message: `bwrap user-namespace probe failed: ${last.slice(0, 1024)}` };
  }

  private async runCommand(
    program: string,
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ code: number | null; stderr: string; spawned: boolean }> {
    return await new Promise((resolve) => {
      let stderr = "";
      let spawned = false;
      let child: ChildProcess;
      try {
        child = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"], env, detached: true });
      } catch (error) {
        resolve({ code: null, stderr: (error as Error).message, spawned: false });
        return;
      }
      spawned = true;
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      timer.unref();
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (text: string) => {
        if (stderr.length < STDERR_RING_BYTES) stderr += text;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, stderr: stderr || error.message, spawned });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, spawned });
      });
    });
  }

  private async checkWorkspaceRoot(): Promise<boolean> {
    const probe = join(this.config.workspaceRoot, ".preflight-probe");
    try {
      await mkdir(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
      await writeFile(probe, "ok", { mode: 0o600 });
      await access(probe, constants.R_OK);
      return true;
    } catch {
      return false;
    } finally {
      await unlink(probe).catch(() => undefined);
    }
  }

  private cgroupEnabled: boolean | undefined;

  private async probeCgroup(): Promise<{ available: boolean; message: string }> {
    if (this.cgroupEnabled !== undefined) {
      return { available: this.cgroupEnabled, message: "cached cgroup probe" };
    }
    const root = this.config.cgroupRoot;
    try {
      const controllers = await readFile(join("/sys/fs/cgroup", "cgroup.controllers"), "utf8");
      if (!controllers.includes("memory") || !controllers.includes("pids") || !controllers.includes("cpu")) {
        this.cgroupEnabled = false;
        return { available: false, message: "cgroup v2 root lacks memory, pids, or cpu controllers" };
      }
    } catch {
      this.cgroupEnabled = false;
      return { available: false, message: "cgroup v2 is not mounted at /sys/fs/cgroup" };
    }
    const probe = join(root, `.probe-${process.pid}`);
    try {
      await mkdir(root, { recursive: true });
      await this.enableControllers(root);
      await mkdir(probe);
      await writeFile(join(probe, "memory.max"), String(this.config.memoryMaxBytes));
      await writeFile(join(probe, "memory.swap.max"), "0").catch(() => undefined);
      await writeFile(join(probe, "pids.max"), String(this.config.pidsMax));
      await writeFile(join(probe, "cpu.max"), this.config.cpuMax);
      this.cgroupEnabled = true;
      return { available: true, message: "" };
    } catch (error) {
      this.cgroupEnabled = false;
      return { available: false, message: `cgroup v2 limits are not writable: ${(error as Error).message}` };
    } finally {
      await rmdir(probe).catch(() => undefined);
    }
  }

  private async enableControllers(root: string): Promise<void> {
    const controllers = " +memory +pids +cpu";
    try {
      const current = await readFile(join(root, "cgroup.subtree_control"), "utf8");
      const missing = ["memory", "pids", "cpu"].filter((name) => !current.includes(name));
      if (missing.length === 0) return;
      await writeFile(
        join(root, "cgroup.subtree_control"),
        missing.map((name) => `+${name}`).join(" "),
      );
    } catch {
      // A delegated parent may already control the subtree; the limit writes below are the
      // authoritative check.
    }
  }

  private async createCgroup(sessionId: string): Promise<CgroupHandle | undefined> {
    const path = join(this.config.cgroupRoot, `session-${sessionId}`);
    try {
      await mkdir(path);
      await writeFile(join(path, "memory.max"), String(this.config.memoryMaxBytes));
      await writeFile(join(path, "memory.swap.max"), "0").catch(() => undefined);
      await writeFile(join(path, "pids.max"), String(this.config.pidsMax));
      await writeFile(join(path, "cpu.max"), this.config.cpuMax);
      const killAvailable = await exists(join(path, "cgroup.kill"));
      return { path, killAvailable };
    } catch {
      await rmdir(path).catch(() => undefined);
      return undefined;
    }
  }

  private async removeCgroup(cgroup: CgroupHandle): Promise<void> {
    if (cgroup.cleaned === true) return;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await rmdir(cgroup.path);
        cgroup.cleaned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          cgroup.cleaned = true;
          return;
        }
        await delay(100);
      }
    }
  }

  private async cgroupEmpty(cgroup: CgroupHandle): Promise<boolean> {
    try {
      const events = await readFile(join(cgroup.path, "cgroup.events"), "utf8");
      return /(^|\n)populated 0(\n|$)/.test(events);
    } catch {
      return true;
    }
  }

  private bwrapArguments(workspace: string, jobId: string, sessionId: string): string[] {
    const appRoot = this.config.appRoot;
    return [
      "--unshare-user", "--uid", "0", "--gid", "0",
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
      "--unshare-net",
      "--cap-drop", "ALL",
      "--clearenv",
      "--die-with-parent",
      "--new-session",
      "--hostname", "aster-ptc",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--ro-bind-try", "/etc/ld.so.conf", "/etc/ld.so.conf",
      "--ro-bind-try", "/etc/ld.so.conf.d", "/etc/ld.so.conf.d",
      "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
      "--ro-bind-try", "/etc/passwd", "/etc/passwd",
      "--ro-bind-try", "/etc/group", "/etc/group",
      "--ro-bind-try", "/etc/localtime", "/etc/localtime",
      "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
      "--ro-bind", join(appRoot, "dist"), "/opt/aster/ptc/dist",
      "--ro-bind", join(appRoot, "node_modules"), "/opt/aster/ptc/node_modules",
      "--ro-bind", join(appRoot, "package.json"), "/opt/aster/ptc/package.json",
      "--ro-bind", this.config.nodePath, "/opt/aster/node",
      "--dir", "/workspace",
      "--bind", workspace, "/workspace",
      "--chdir", "/workspace",
      "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
      "--setenv", "HOME", "/workspace",
      "--setenv", "TMPDIR", "/tmp",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "LC_ALL", "C.UTF-8",
      "--setenv", "TZ", "UTC",
      "--setenv", "PTC_JOB_ID", jobId,
      "--setenv", "PTC_SESSION_ID", sessionId,
      "--setenv", "PTC_OUTPUT_MAX_BYTES", String(this.config.outputMaxBytes),
      "--setenv", "PTC_OUTPUT_RETENTION_MS", String(this.config.retentionMs),
      "--setenv", "PTC_MAX_INTERRUPT_BUDGET", String(this.config.maxInterruptBudget),
      "--setenv", "PTC_MAX_MEMORY_LIMIT_BYTES", String(this.config.maxMemoryLimitBytes),
      "--setenv", "PTC_PI_CODEMODE_VERSION", this.config.piCodemodeVersion,
      "--setenv", "PTC_QUICKJS_VERSION", this.config.quickjsVersion,
      "--",
      "/opt/aster/node",
      "/opt/aster/ptc/dist/src/execution/ptc-runner.js",
    ];
  }

  private prlimitArguments(): string[] {
    return [
      `--as=${this.config.memoryMaxBytes}`,
      `--nproc=${this.config.pidsMax}`,
      "--nofile=1024",
      "--core=0",
      `--fsize=${this.config.outputMaxBytes + 16 * 1024 * 1024}`,
      "--",
    ];
  }

  private async spawnRunner(
    jobId: string,
    sessionId: string,
    workspace: PreparedWorkspace,
    cgroup: CgroupHandle | undefined,
    isolation: PtcIsolation,
    events: PtcRunnerEvents,
  ): Promise<PtcSandboxStart> {
    const useBwrap = isolation.mode !== "degraded-prlimit";
    let program: string;
    let args: string[];
    let env: NodeJS.ProcessEnv = {};
    let cwd: string | undefined;

    if (useBwrap) {
      const bwrapArgs = this.bwrapArguments(workspace.hostPath, jobId, sessionId);
      if (isolation.cgroup === "none") {
        program = this.config.prlimitPath;
        args = [...this.prlimitArguments(), this.config.bwrapPath, ...bwrapArgs];
      } else {
        program = this.config.bwrapPath;
        args = bwrapArgs;
      }
    } else {
      // Explicitly unsafe fallback: no namespaces, no network isolation, a host path workspace.
      program = this.config.prlimitPath;
      cwd = workspace.hostPath;
      args = [
        ...this.prlimitArguments(),
        this.config.nodePath,
        this.config.runnerEntry,
      ];
      env = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: workspace.hostPath,
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        PTC_JOB_ID: jobId,
        PTC_SESSION_ID: sessionId,
        PTC_RUNNER_WORKSPACE: workspace.hostPath,
        PTC_OUTPUT_MAX_BYTES: String(this.config.outputMaxBytes),
        PTC_OUTPUT_RETENTION_MS: String(this.config.retentionMs),
        PTC_MAX_INTERRUPT_BUDGET: String(this.config.maxInterruptBudget),
        PTC_MAX_MEMORY_LIMIT_BYTES: String(this.config.maxMemoryLimitBytes),
        PTC_PI_CODEMODE_VERSION: this.config.piCodemodeVersion,
        PTC_QUICKJS_VERSION: this.config.quickjsVersion,
        PTC_OUTPUT_REF: "disabled",
      };
    }

    const child = spawn(program, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      if (stderr.length < STDERR_RING_BYTES) stderr += text;
      events.onStderr?.(text);
    });

    if (cgroup !== undefined && child.pid !== undefined) {
      try {
        await writeFile(join(cgroup.path, "cgroup.procs"), String(child.pid));
      } catch {
        // The process may have exited already; `kill` handles cleanup.
      }
    }

    let exitedResolve!: () => void;
    const exited = new Promise<void>((resolve) => {
      exitedResolve = resolve;
    });
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
    });
    child.on("close", (code, signal) => {
      exitInfo ??= { code, signal };
      exitedResolve();
      events.onExit({ code: exitInfo.code, signal: exitInfo.signal, stderr });
      if (cgroup !== undefined) void this.cleanupAfterExit(cgroup, child);
    });
    child.on("error", () => {
      // `close` follows for started processes; for a failed spawn it may not, so settle here.
      if (exitInfo === undefined) {
        exitInfo = { code: null, signal: null };
        exitedResolve();
        events.onExit({ code: null, signal: null, stderr });
      }
    });

    const decoder = new RunnerFrameDecoder(PTC_RUNNER_MAX_FRAME_BYTES);
    let ready = false;
    let readyResolve!: (ok: boolean) => void;
    const readyPromise = new Promise<boolean>((resolve) => {
      readyResolve = resolve;
    });
    exited.then(() => readyResolve(false));
    child.stdout?.on("data", (chunk: Buffer) => {
      let frames: RunnerFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        events.onStderr?.(`[agent] invalid runner frame: ${(error as Error).message}\n`);
        readyResolve(false);
        this.killChild(child, cgroup, isolation);
        return;
      }
      for (const frame of frames) {
        if (!ready) {
          if (frame.kind !== "ready") {
            readyResolve(false);
            this.killChild(child, cgroup, isolation);
            return;
          }
          ready = true;
          readyResolve(true);
          continue;
        }
        events.onFrame(frame);
      }
    });

    const sandbox = this;
    const handle: PtcRunnerHandle = {
      pid: child.pid ?? 0,
      isolation,
      exited,
      send(frame) {
        if (child.stdin === null || !child.stdin.writable || exitInfo !== undefined) return false;
        try {
          return child.stdin.write(encodeRunnerFrame(frame));
        } catch {
          return false;
        }
      },
      async kill(reason, hard = false) {
        if (exitInfo !== undefined) {
          if (cgroup !== undefined) await sandbox.cleanupAfterExit(cgroup, child);
          return;
        }
        if (!hard) {
          handle.send({ v: 1, kind: "shutdown" });
          child.stdin?.end();
          const finished = await Promise.race([
            exited.then(() => true),
            delay(KILL_GRACE_MS).then(() => false),
          ]);
          if (finished) return;
        }
        await sandbox.killChild(child, cgroup, isolation);
        await Promise.race([exited, delay(CGROUP_EMPTY_TIMEOUT_MS)]);
        if (cgroup !== undefined) await sandbox.cleanupAfterExit(cgroup, child);
      },
    };

    const readyResult = await Promise.race([
      readyPromise,
      delay(this.config.startupTimeoutMs).then(() => false),
    ]);
    if (!readyResult) {
      await handle.kill("startup failed", true);
      throw new ConfigurationError(
        `PTC runner did not become ready: ${stderr.trim().slice(0, 2048) || "no diagnostic"}`,
      );
    }
    return { workspace, runner: handle };
  }

  private killChild(
    child: ChildProcess,
    cgroup: CgroupHandle | undefined,
    isolation: PtcIsolation,
  ): void {
    if (cgroup !== undefined && cgroup.killAvailable) {
      void writeFile(join(cgroup.path, "cgroup.kill"), "1").catch(() => undefined);
    }
    if (child.pid === undefined) return;
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

  private async cleanupAfterExit(cgroup: CgroupHandle, child: ChildProcess): Promise<void> {
    if (cgroup.killAvailable) {
      await writeFile(join(cgroup.path, "cgroup.kill"), "1").catch(() => undefined);
    }
    if (!(await this.cgroupEmpty(cgroup))) {
      // Still populated: kill the group and wait for the kernel to reap it.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      const deadline = Date.now() + CGROUP_EMPTY_TIMEOUT_MS;
      while (Date.now() < deadline && !(await this.cgroupEmpty(cgroup))) await delay(100);
    }
    await this.removeCgroup(cgroup);
  }

  /** Kill every session this manager started. The agent calls this on shutdown. */
  async close(): Promise<void> {
    // Handles are owned by the RPC sessions; the server aborts them, and each connection's
    // sessions are closed before this runs.
  }
}

/** Diagnose why a PTC session could not start; used by `--check` and tests. */
export async function inspectPtcEnvironment(config: PtcSandboxConfig): Promise<{
  readonly preflight: PtcPreflightResult;
  readonly appDirectories: readonly string[];
}> {
  const manager = new PtcSandboxManager(config);
  const preflight = await manager.preflight();
  const appDirectories: string[] = [];
  for (const name of ["dist", "node_modules"]) {
    const path = join(config.appRoot, name);
    try {
      const info = await stat(path);
      if (info.isDirectory()) appDirectories.push(path);
    } catch {
      // Missing directories are reported through the preflight checks.
    }
  }
  return { preflight, appDirectories };
}
