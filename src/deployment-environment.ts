import { isIP } from "node:net";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BoundedFileError, readBoundedFile } from "./bounded-file.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

/**
 * One deployment environment's public, non-secret resource identity.
 *
 * The authority for every value is this file: Compose, `network.sh` and the router read the same
 * validated description, so a subnet change cannot land in only one of them. Host-private material
 * (credentials, CA, owner file) is referenced by path and never described here.
 */
const EnvironmentName = Type.Union([Type.Literal("test"), Type.Literal("production")]);
// Docker project names are lowercase alphanumerics plus inner separators.
const ProjectName = Type.String({ minLength: 2, maxLength: 63, pattern: "^[a-z0-9][a-z0-9_-]*$" });
const VolumeName = Type.String({ minLength: 2, maxLength: 63, pattern: "^[a-z0-9][a-z0-9_.-]*$" });
const NetworkName = Type.String({ minLength: 2, maxLength: 63, pattern: "^[a-z0-9][a-z0-9_.-]*$" });
// Absolute host path with no `..` segment; a relative path would depend on the caller's cwd.
const PrivateDirectory = Type.String({ minLength: 2, maxLength: 512, pattern: "^(?:/|[A-Za-z]:[\\\\/])(?!.*(?:^|/)\\.\\.(?:/|$)).+$" });
const Ip = Type.String({ minLength: 7, maxLength: 45 });
const Port = Type.Integer({ minimum: 1, maximum: 65535 });

export const EnvironmentSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("aster.deployment-environment"),
  environment: EnvironmentName,
  composeProject: ProjectName,
  volumes: Type.Object({
    app: VolumeName,
    broker: VolumeName,
  }, { additionalProperties: false }),
  network: Type.Object({
    // Omitted means Compose derives the name from the project, which is already environment-unique.
    name: Type.Optional(NetworkName),
    // Any CIDR shape passes the schema; an address family or prefix the host cannot use is
    // reported as unsupported rather than as a malformed description.
    subnet: Type.String({ pattern: "^(?:\\d{1,3}(?:\\.\\d{1,3}){3}|[0-9A-Fa-f:.]+)/\\d{1,3}$" }),
    // Fixed broker address inside the subnet; the firewall and router both hardcode this role.
    brokerAddress: Ip,
  }, { additionalProperties: false }),
  broker: Type.Object({
    managementPort: Port,
  }, { additionalProperties: false }),
  privateDirectory: PrivateDirectory,
  // Host-private paths are relative to privateDirectory so one environment cannot alias another.
  privateFiles: Type.Object({
    vaultEnv: Type.String({ minLength: 1, maxLength: 255 }),
    appEnv: Type.String({ minLength: 1, maxLength: 255 }),
    appRouterEnv: Type.String({ minLength: 1, maxLength: 255 }),
    apiPolicy: Type.String({ minLength: 1, maxLength: 255 }),
    ca: Type.String({ minLength: 1, maxLength: 255 }),
    telegramOwnerId: Type.String({ minLength: 1, maxLength: 255 }),
    routerDirectory: Type.String({ minLength: 1, maxLength: 255 }),
  }, { additionalProperties: false }),
  // The numeric Telegram bot user ID is an identifier, not a credential. Declaring it lets the
  // offline check reject two environments that consume the same bot; the live check (Stage A2)
  // confirms the deployed token actually resolves to this ID.
  identity: Type.Object({
    botId: Type.String({ minLength: 1, maxLength: 20, pattern: "^[1-9]\\d*$" }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type DeploymentEnvironment = Static<typeof EnvironmentSchema>;

export type EnvironmentFailureCode =
  | "ENVIRONMENT_TOO_LARGE" | "ENVIRONMENT_INVALID_JSON" | "ENVIRONMENT_DUPLICATE_KEY"
  | "ENVIRONMENT_INVALID_SCHEMA" | "ENVIRONMENT_UNREADABLE" | "ENVIRONMENT_NOT_REGULAR_FILE"
  | "ENVIRONMENT_UNSUPPORTED_NETWORK" | "ENVIRONMENT_RESOURCE_OVERLAP";

export class EnvironmentError extends Error {
  constructor(readonly code: EnvironmentFailureCode) {
    super(code);
    this.name = "EnvironmentError";
  }
}

function fail(code: EnvironmentFailureCode): never {
  throw new EnvironmentError(code);
}

function ipv4Parts(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

export interface Ipv4Range { start: number; end: number }

/** An IPv4 subnet that can hold a broker address, as a closed integer range. */
export function ipv4Range(subnet: string): Ipv4Range | undefined {
  const [address, bits] = subnet.split("/");
  const parts = ipv4Parts(address ?? "");
  if (!parts || bits === undefined || !/^\d{1,2}$/u.test(bits)) return undefined;
  // A /31 or /32 has no usable interior address, so it can never host the broker role.
  const prefix = Number(bits);
  if (prefix < 8 || prefix > 30) return undefined;
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(value / size) * size;
  return { start, end: start + size - 1 };
}

function rangesOverlap(a: Ipv4Range, b: Ipv4Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function insideRange(address: string, range: Ipv4Range): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  return value >= range.start && value <= range.end;
}

/** Reject a description whose own values cannot be used together, before any side effect. */
function validate(environment: DeploymentEnvironment): DeploymentEnvironment {
  const range = ipv4Range(environment.network.subnet);
  // Only IPv4 subnets are supported: the firewall rules and broker address are IPv4 literals.
  if (!range) fail("ENVIRONMENT_UNSUPPORTED_NETWORK");
  if (!insideRange(environment.network.brokerAddress, range)) fail("ENVIRONMENT_INVALID_SCHEMA");
  // Reserve the network and broadcast addresses; a broker on either cannot be dialed reliably.
  const parts = ipv4Parts(environment.network.brokerAddress)!;
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  if (value === range.start || value === range.end) fail("ENVIRONMENT_INVALID_SCHEMA");
  // One volume cannot back two roles: the app and broker have different owners and layouts.
  if (environment.volumes.app === environment.volumes.broker) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  const paths = Object.values(environment.privateFiles);
  if (new Set(paths).size !== paths.length) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  return environment;
}

export function parseEnvironment(bytes: Uint8Array): DeploymentEnvironment {
  let value: unknown;
  try {
    value = parseStrictJson(bytes, 64 * 1024);
  } catch (error) {
    return fail(error instanceof StrictJsonError && error.code === "TOO_LARGE" ? "ENVIRONMENT_TOO_LARGE"
      : error instanceof StrictJsonError && error.code === "DUPLICATE_KEY" ? "ENVIRONMENT_DUPLICATE_KEY"
      : "ENVIRONMENT_INVALID_JSON");
  }
  if (!Value.Check(EnvironmentSchema, value)) fail("ENVIRONMENT_INVALID_SCHEMA");
  return validate(value);
}

export async function readEnvironment(path: string): Promise<DeploymentEnvironment> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, 64 * 1024);
  } catch (error) {
    if (!(error instanceof BoundedFileError)) throw error;
    return fail(error.code === "UNREADABLE" ? "ENVIRONMENT_UNREADABLE"
      : error.code === "NOT_REGULAR_FILE" ? "ENVIRONMENT_NOT_REGULAR_FILE" : "ENVIRONMENT_TOO_LARGE");
  }
  return parseEnvironment(bytes);
}

/**
 * Reject descriptions that would collide on one host. Environments are separate Compose projects,
 * so the same service names are expected; identity comes from projects, volumes, subnets, the
 * broker's host port, private directories and the bot the environment consumes.
 */
export function assertDistinctEnvironments(first: DeploymentEnvironment, second: DeploymentEnvironment): void {
  if (first.environment === second.environment) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.composeProject === second.composeProject) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  const firstRange = ipv4Range(first.network.subnet)!;
  const secondRange = ipv4Range(second.network.subnet)!;
  if (rangesOverlap(firstRange, secondRange)) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.network.name !== undefined && first.network.name === second.network.name) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.network.brokerAddress === second.network.brokerAddress) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.volumes.app === second.volumes.app || first.volumes.broker === second.volumes.broker) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.broker.managementPort === second.broker.managementPort) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  if (first.privateDirectory === second.privateDirectory) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  // Relative files must not resolve to the same host path through aliased directories.
  if (first.privateDirectory.startsWith(`${second.privateDirectory}/`)
    || second.privateDirectory.startsWith(`${first.privateDirectory}/`)) fail("ENVIRONMENT_RESOURCE_OVERLAP");
  // The same bot cannot serve two environments: long polling would split updates between them.
  if (first.identity.botId === second.identity.botId) fail("ENVIRONMENT_RESOURCE_OVERLAP");
}
