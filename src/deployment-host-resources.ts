import { spawnSync } from "node:child_process";
import type { DeploymentEnvironment } from "./deployment-environment.js";

/**
 * Read-only host resource check. Docker itself is the authority for what exists on this host;
 * this module only reports conflicts, never creates, renames or removes anything. A missing
 * volume is not repaired here, and an existing production volume is never adopted silently.
 */
export type HostConflictCode =
  | "DOCKER_UNAVAILABLE" | "PROJECT_CONFLICT" | "VOLUME_MISSING" | "VOLUME_EXISTS"
  | "VOLUME_IN_USE" | "NETWORK_NAME_CONFLICT" | "NETWORK_SUBNET_CONFLICT" | "PORT_IN_USE"
  | "HOST_TOO_MANY_NETWORKS";

export class HostResourceError extends Error {
  constructor(readonly code: HostConflictCode) {
    super(code);
    this.name = "HostResourceError";
  }
}

const MAX_NETWORKS = 256;

function run(args: string[], expected = 0): { status: number; stdout: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new HostResourceError("DOCKER_UNAVAILABLE");
  if (result.status !== expected) throw new HostResourceError("DOCKER_UNAVAILABLE");
  return { status: result.status ?? 0, stdout: result.stdout };
}

/** Existence probe: a non-zero status is a normal "not found", not an unusable daemon. */
function exists(args: string[]): boolean {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new HostResourceError("DOCKER_UNAVAILABLE");
  if (result.status === 0) return true;
  // Distinguish "no such object" from a daemon or permission failure.
  const message = `${result.stderr}`;
  if (/no such|not found|does not exist/iu.test(message)) return false;
  throw new HostResourceError("DOCKER_UNAVAILABLE");
}

export interface HostCheckOptions {
  environment: DeploymentEnvironment;
  /** First install requires the target volumes to be absent; an update requires them to exist. */
  volumes: "absent" | "present" | "any";
  /** The management port is published to the host loopback only when the override is used. */
  managementLoopback: boolean;
}

export interface HostCheckResult {
  status: "host-resources-clear";
  environment: DeploymentEnvironment["environment"];
  volumes: "absent" | "present" | "any";
  productionAdmission: "not-evaluated";
}

export function checkHostResources(options: HostCheckOptions): HostCheckResult {
  const environment = options.environment;
  const containers = (runningOnly: boolean) => run(["ps", ...(runningOnly ? [] : ["--all"]),
    "--filter", `label=com.docker.compose.project=${environment.composeProject}`, "--format", "{{.ID}}"]).stdout.trim();
  // A first install owns nothing yet. An update reuses the project's own containers, but they must
  // be stopped: the caller stops writers before preflighting the volumes they are about to replace.
  if (options.volumes === "absent" ? containers(false) !== "" : containers(true) !== "") {
    throw new HostResourceError("PROJECT_CONFLICT");
  }

  const expected = [environment.volumes.app, environment.volumes.broker];
  for (const name of expected) {
    const present = exists(["volume", "inspect", name]);
    if (options.volumes === "absent" && present) throw new HostResourceError("VOLUME_EXISTS");
    if (options.volumes === "present" && !present) throw new HostResourceError("VOLUME_MISSING");
    // Any consumer, including a paused or restarting one, blocks a safe update.
    if (present && run(["ps", "--quiet", "--filter", `volume=${name}`]).stdout.trim() !== "") {
      throw new HostResourceError("VOLUME_IN_USE");
    }
  }

  const networkName = environment.network.name ?? `${environment.composeProject}_vault`;
  if (exists(["network", "inspect", networkName])) {
    // An update reuses the project's own network; a network with this name owned by anything else
    // is a conflict, and an existing network on a different subnet is never re-created in place.
    const owner = run(["network", "inspect", networkName,
      "--format", '{{index .Labels "com.docker.compose.project"}}']).stdout.trim();
    if (owner !== environment.composeProject) throw new HostResourceError("NETWORK_NAME_CONFLICT");
    const subnets = run(["network", "inspect", networkName, "--format", "{{range .IPAM.Config}}{{.Subnet}}\n{{end}}"])
      .stdout.split("\n").filter((subnet) => subnet !== "");
    if (subnets.length !== 1 || subnets[0] !== environment.network.subnet) throw new HostResourceError("NETWORK_SUBNET_CONFLICT");
  }
  // Another project may already own this subnet under a different name; `up` would fail after
  // the operator already stopped production writers, so check before any side effect.
  const networks = run(["network", "ls", "--filter", "driver=bridge", "--format", "{{.Name}}"]).stdout
    .split("\n").filter((name) => name !== "");
  let inspected = 0;
  for (const name of networks) {
    if (name === networkName) continue;
    // Bounded work: each inspected network costs one daemon call, and a host with an unusual
    // number of bridges should be triaged by an operator rather than silently skipped.
    if (inspected++ >= MAX_NETWORKS) throw new HostResourceError("HOST_TOO_MANY_NETWORKS");
    const subnets = run(["network", "inspect", name, "--format", "{{range .IPAM.Config}}{{.Subnet}}\n{{end}}"]).stdout
      .split("\n").filter((subnet) => subnet !== "");
    if (!subnets.includes(environment.network.subnet)) continue;
    const owner = run(["network", "inspect", name,
      "--format", '{{index .Labels "com.docker.compose.project"}}']).stdout.trim();
    // The same project's own network on the expected subnet is fine; anything else owns the range.
    if (owner !== environment.composeProject) throw new HostResourceError("NETWORK_SUBNET_CONFLICT");
  }

  if (options.managementLoopback
    && run(["ps", "--quiet", "--filter", `publish=${environment.broker.managementPort}`]).stdout.trim() !== "") {
    throw new HostResourceError("PORT_IN_USE");
  }

  return { status: "host-resources-clear", environment: environment.environment, volumes: options.volumes, productionAdmission: "not-evaluated" };
}
