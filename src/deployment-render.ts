import { Type } from "typebox";
import { Value } from "typebox/value";
import { ipv4Range, type DeploymentEnvironment } from "./deployment-environment.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

/**
 * Checks a rendered Compose project against the environment description it claims to deploy.
 * Compose interpolation is not trusted: every value is compared after rendering, so a variable
 * that silently did not apply cannot produce a project that differs from the description.
 */
export type RenderFailureCode =
  | "RENDER_INVALID_JSON" | "RENDER_DUPLICATE_KEY" | "RENDER_INVALID_SCHEMA"
  | "RENDER_PROJECT_MISMATCH" | "RENDER_VOLUME_MISMATCH" | "RENDER_NETWORK_MISMATCH"
  | "RENDER_BROKER_ADDRESS_MISMATCH" | "RENDER_MANAGEMENT_PORT_MISMATCH"
  | "RENDER_MANAGEMENT_EXPOSED" | "RENDER_PUBLISHED_PORT" | "RENDER_PRIVATE_DIRECTORY_MISMATCH"
  | "RENDER_SERVICE_MISSING" | "RENDER_BOUNDARY_MISMATCH";

export class DeploymentRenderError extends Error {
  constructor(readonly code: RenderFailureCode) {
    super(code);
    this.name = "DeploymentRenderError";
  }
}

function fail(code: RenderFailureCode): never {
  throw new DeploymentRenderError(code);
}

const PortMapping = Type.Object({
  host_ip: Type.Optional(Type.String()),
  published: Type.Optional(Type.String()),
  target: Type.Optional(Type.Integer()),
  protocol: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
}, { additionalProperties: true });

const Service = Type.Object({
  image: Type.Optional(Type.String()),
  user: Type.Optional(Type.String()),
  network_mode: Type.Optional(Type.String()),
  read_only: Type.Optional(Type.Boolean()),
  entrypoint: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()])),
  command: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()])),
  cap_drop: Type.Optional(Type.Array(Type.String())),
  cap_add: Type.Optional(Type.Array(Type.String())),
  security_opt: Type.Optional(Type.Array(Type.String())),
  ports: Type.Optional(Type.Array(PortMapping)),
  volumes: Type.Optional(Type.Array(Type.Object({
    type: Type.String(),
    source: Type.Optional(Type.String()),
    target: Type.String(),
    read_only: Type.Optional(Type.Boolean()),
  }, { additionalProperties: true }))),
  secrets: Type.Optional(Type.Array(Type.Object({ source: Type.String() }, { additionalProperties: true }))),
  environment: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  networks: Type.Optional(Type.Record(Type.String(), Type.Union([
    Type.Null(),
    Type.Object({ ipv4_address: Type.Optional(Type.String()) }, { additionalProperties: true }),
  ]))),
}, { additionalProperties: true });

const Rendered = Type.Object({
  name: Type.String(),
  services: Type.Record(Type.String(), Service),
  networks: Type.Record(Type.String(), Type.Object({
    name: Type.Optional(Type.String()),
    ipam: Type.Optional(Type.Object({
      config: Type.Optional(Type.Array(Type.Object({ subnet: Type.Optional(Type.String()) }, { additionalProperties: true }))),
    }, { additionalProperties: true })),
  }, { additionalProperties: true })),
  volumes: Type.Record(Type.String(), Type.Object({ name: Type.Optional(Type.String()) }, { additionalProperties: true })),
  secrets: Type.Optional(Type.Record(Type.String(), Type.Object({
    file: Type.Optional(Type.String()),
  }, { additionalProperties: true }))),
}, { additionalProperties: true });

export interface RenderCheckOptions {
  environment: DeploymentEnvironment;
  /** Absolute private directory the deployment will read, or undefined when not yet materialized. */
  privateDirectory?: string;
  /** Compose project name passed with --project-name; defaults to the environment's. */
  projectName: string;
  /** Whether the management loopback override was included. */
  managementLoopback: boolean;
  routerEnabled: boolean;
}

export interface RenderReport {
  status: "render-matches-environment";
  environment: DeploymentEnvironment["environment"];
  composeProject: string;
  productionAdmission: "not-evaluated";
}

/** Normalize a Compose-reported host path so Windows and POSIX separators compare equally. */
function hostPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function checkRenderedProject(bytes: Uint8Array, options: RenderCheckOptions): RenderReport {
  let config: unknown;
  try {
    config = parseStrictJson(bytes, 4 * 1024 * 1024);
  } catch (error) {
    return fail(error instanceof StrictJsonError && error.code === "DUPLICATE_KEY" ? "RENDER_DUPLICATE_KEY" : "RENDER_INVALID_JSON");
  }
  if (!Value.Check(Rendered, config)) fail("RENDER_INVALID_SCHEMA");
  const environment = options.environment;
  if (config.name !== options.projectName || config.name !== environment.composeProject) fail("RENDER_PROJECT_MISMATCH");

  const expectedVolumes = { "personal-agent-data": environment.volumes.app, "agent-vault-data": environment.volumes.broker };
  // An extra volume is a deployment resource the description does not name, so it is rejected.
  if (Object.keys(config.volumes).sort().join() !== Object.keys(expectedVolumes).sort().join()) fail("RENDER_VOLUME_MISMATCH");
  for (const [key, name] of Object.entries(expectedVolumes)) {
    const volume = config.volumes[key];
    if (!volume) fail("RENDER_VOLUME_MISMATCH");
    // Compose derives "<project>_<key>" when a name is not set; only the explicit name is acceptable.
    if (volume.name !== name) fail("RENDER_VOLUME_MISMATCH");
  }

  if (Object.keys(config.networks).join() !== "vault") fail("RENDER_NETWORK_MISMATCH");
  const network = config.networks.vault;
  if (!network) fail("RENDER_NETWORK_MISMATCH");
  if (environment.network.name !== undefined && network.name !== environment.network.name) fail("RENDER_NETWORK_MISMATCH");
  if (environment.network.name === undefined && network.name !== undefined
    && network.name !== `${options.projectName}_vault`) fail("RENDER_NETWORK_MISMATCH");
  const subnets = (network.ipam?.config ?? []).map((entry) => entry.subnet).filter((value): value is string => value !== undefined);
  if (subnets.length !== 1 || subnets[0] !== environment.network.subnet) fail("RENDER_NETWORK_MISMATCH");

  const broker = config.services["agent-vault"];
  const app = config.services["personal-agent"];
  const toolNetwork = config.services["tool-network"];
  if (!broker || !app || !toolNetwork) fail("RENDER_SERVICE_MISSING");
  if (options.routerEnabled !== (config.services["egress-router"] !== undefined)) fail("RENDER_SERVICE_MISSING");
  if (broker.networks?.vault?.ipv4_address !== environment.network.brokerAddress) fail("RENDER_BROKER_ADDRESS_MISMATCH");
  if (!ipv4Range(environment.network.subnet) || broker.networks?.vault?.ipv4_address === undefined) fail("RENDER_BROKER_ADDRESS_MISMATCH");

  // Management port: listening is internal; publishing it is an explicit, loopback-only opt-in.
  const management = String(environment.broker.managementPort);
  const entrypoint = JSON.stringify([broker.entrypoint ?? "", broker.command ?? ""]);
  if (!entrypoint.includes(`--port ${management}`)) fail("RENDER_MANAGEMENT_PORT_MISMATCH");
  const published = (broker.ports ?? []).filter((port) => String(port.target) === management);
  if (!options.managementLoopback) {
    if ((broker.ports ?? []).length > 0) fail("RENDER_MANAGEMENT_EXPOSED");
  } else if (published.length !== 1 || published[0]!.host_ip !== "127.0.0.1" || published[0]!.published !== management) {
    fail("RENDER_MANAGEMENT_EXPOSED");
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (name === "agent-vault" && options.managementLoopback) continue;
    if ((service.ports ?? []).length > 0) fail("RENDER_PUBLISHED_PORT");
  }

  if (options.privateDirectory !== undefined) {
    const expected = hostPath(options.privateDirectory);
    const files = options.environment.privateFiles;
    // Each host-private file is mounted from the exact relative path the description names, so a
    // template edit that points a secret at the wrong file fails instead of reading a neighbour.
    const source = (relative: string) => `${expected}/${relative}`;
    const mountedFrom = (service: { volumes?: Array<{ source?: string; target: string }> }, target: string, relative: string) => {
      const mounts = (service.volumes ?? []).filter((volume) => volume.target === target);
      return mounts.length === 1 && mounts[0]!.source !== undefined && hostPath(mounts[0]!.source) === source(relative);
    };
    if (!mountedFrom(app, "/etc/agent-vault/ca.pem", files.ca)) fail("RENDER_PRIVATE_DIRECTORY_MISMATCH");
    if (!mountedFrom(broker, "/etc/aster-vault/api-policy.yaml", files.apiPolicy)) fail("RENDER_PRIVATE_DIRECTORY_MISMATCH");
    if (hostPath(config.secrets?.["telegram-owner-id"]?.file ?? "") !== source(files.telegramOwnerId)) fail("RENDER_PRIVATE_DIRECTORY_MISMATCH");
    // No other bind may reach into the private directory through an unlisted path.
    const listed = new Set([files.ca, files.apiPolicy, files.routerDirectory].map(source));
    for (const service of Object.values(config.services)) {
      for (const volume of service.volumes ?? []) {
        if (volume.type !== "bind" || volume.source === undefined) continue;
        const path = hostPath(volume.source);
        if ((path === expected || path.startsWith(`${expected}/`)) && !listed.has(path)) fail("RENDER_PRIVATE_DIRECTORY_MISMATCH");
      }
    }
    if (options.routerEnabled && !mountedFrom(config.services["egress-router"]!, "/etc/aster-router", files.routerDirectory)) {
      fail("RENDER_PRIVATE_DIRECTORY_MISMATCH");
    }
  }

  // Boundaries that a per-environment override must not weaken.
  if (app.user !== "1000:1000" || app.network_mode !== "service:tool-network" || app.read_only !== true) fail("RENDER_BOUNDARY_MISMATCH");
  if (!app.cap_drop?.includes("ALL")) fail("RENDER_BOUNDARY_MISMATCH");
  if (toolNetwork.read_only !== true || !toolNetwork.cap_add?.includes("NET_ADMIN") || !toolNetwork.cap_drop?.includes("ALL")) {
    fail("RENDER_BOUNDARY_MISMATCH");
  }
  if (broker.read_only !== undefined || !broker.cap_drop?.includes("ALL")) fail("RENDER_BOUNDARY_MISMATCH");
  if (options.routerEnabled) {
    const router = config.services["egress-router"]!;
    if (router.user !== "1001:1001" || router.network_mode !== "service:tool-network"
      || router.read_only !== true || !router.cap_drop?.includes("ALL")) fail("RENDER_BOUNDARY_MISMATCH");
  }
  if (toolNetwork.environment?.ASTER_BROKER_ADDRESS !== environment.network.brokerAddress) fail("RENDER_BOUNDARY_MISMATCH");

  return {
    status: "render-matches-environment",
    environment: environment.environment,
    composeProject: config.name,
    productionAdmission: "not-evaluated",
  };
}
