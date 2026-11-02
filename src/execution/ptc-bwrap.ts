import { dirname } from "node:path";
import type { PtcConfig } from "./ptc-config.js";

/** Read-only roots a normal command needs; missing ones are skipped so a minimal image still works. */
const READ_ONLY_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives"] as const;

/** Environment the runner process needs; the sandbox gets nothing else from the host. */
export function runnerEnvironment(config: PtcConfig, workspacePath: string): Record<string, string> {
  return {
    PTC_RUNNER_WORKSPACE: workspacePath,
    PTC_RUNNER_SHELL: "/bin/bash",
    PTC_RUNNER_OUTPUT_MAX_BYTES: String(config.nestedOutputMaxBytes),
    PTC_RUNNER_OUTPUT_MAX_LINES: String(config.nestedOutputMaxLines),
    PTC_RUNNER_OUTPUT_BYTES_PER_SECOND: String(config.outputBytesPerSecond),
    PTC_RUNNER_SPILL_MAX_BYTES: String(config.spillMaxBytes),
    PTC_RUNNER_JOB_RETENTION_MS: String(config.jobRetentionHours * 3_600_000),
  };
}

/**
 * bwrap argv for one job. Every sharing flag is explicit: no `--unshare-all`, no whole-root
 * read-only bind, and no network. The workspace is the only writable persistent mount; `/tmp` is
 * a private tmpfs, so it can never hold state that a replay would miss.
 */
export function buildBwrapArgv(config: PtcConfig, hostWorkspace: string): string[] {
  const argv = [
    config.bwrapPath,
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--no-new-privs",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  for (const root of READ_ONLY_ROOTS) argv.push("--ro-bind-try", root, root);
  // The runner entry and its dependencies must be visible read-only at the same path.
  argv.push("--ro-bind-try", config.appRoot, config.appRoot);
  const nodeDirectory = dirname(process.execPath);
  if (nodeDirectory !== "/usr" && nodeDirectory !== "/usr/bin" && nodeDirectory !== "/bin") {
    argv.push("--ro-bind-try", nodeDirectory, nodeDirectory);
  }
  if (config.sharedWorkspaceMode === "ro" && config.sharedWorkspace !== undefined) {
    argv.push("--ro-bind-try", config.sharedWorkspace, "/shared");
  }
  argv.push(
    "--bind", hostWorkspace, "/workspace",
    "--chdir", "/workspace",
    "--clearenv",
    "--setenv", "HOME", "/workspace",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", config.nodePath,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PTC_INSIDE_SANDBOX", "1",
  );
  for (const [name, value] of Object.entries(runnerEnvironment(config, "/workspace"))) {
    argv.push("--setenv", name, value);
  }
  argv.push(...nodeCommand(config));
  return argv;
}

/**
 * Explicitly allowed degraded mode: no namespaces, only rlimits. It is never selected silently;
 * `PTC_ALLOW_DEGRADED=1` and a failed bwrap probe are both required.
 */
export function buildDegradedArgv(config: PtcConfig, _hostWorkspace: string): string[] {
  return [
    "prlimit",
    `--as=${config.cgroupMemoryMaxBytes}`,
    `--nproc=${config.cgroupPidsMax}`,
    "--fsize=67108864",
    "--",
    ...nodeCommand(config),
  ];
}

function nodeCommand(config: PtcConfig): string[] {
  const args = [process.execPath];
  // In development the entry is TypeScript; the deployment artifact is JavaScript.
  if (config.runnerEntry.endsWith(".ts")) args.push("--import", "tsx");
  args.push(config.runnerEntry);
  return args;
}
