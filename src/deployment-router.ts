import { isIP } from "node:net";
import type { DeploymentEnvironment } from "./deployment-environment.js";
import { parseStrictJson, StrictJsonError } from "./strict-json.js";

/**
 * Checks the router configuration a deployment will actually mount. The router's own `check`
 * command validates the file at start; this offline check only proves the upstream endpoint
 * agrees with the environment description, so a subnet change cannot leave the router pointing
 * at an address that no longer exists.
 */
export type RouterConfigFailureCode =
  | "ROUTER_INVALID_JSON" | "ROUTER_DUPLICATE_KEY" | "ROUTER_UPSTREAM_MISMATCH"
  | "ROUTER_LISTEN_NOT_LOOPBACK" | "ROUTER_PORT_MISMATCH";

export class RouterConfigError extends Error {
  constructor(readonly code: RouterConfigFailureCode) {
    super(code);
    this.name = "RouterConfigError";
  }
}

function fail(code: RouterConfigFailureCode): never {
  throw new RouterConfigError(code);
}

function loopbackHost(authority: unknown): boolean {
  if (typeof authority !== "string") return false;
  const separator = authority.lastIndexOf(":");
  if (separator <= 0) return false;
  const host = authority.slice(0, separator);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function portOf(authority: unknown): number | undefined {
  if (typeof authority !== "string") return undefined;
  const port = Number(authority.slice(authority.lastIndexOf(":") + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export interface RouterCheckOptions {
  environment: DeploymentEnvironment;
  /** Broker proxy port inside the vault network; defaults to the documented 14322. */
  brokerPort: number;
}

export function checkRouterConfig(bytes: Uint8Array, options: RouterCheckOptions): {
  status: "router-config-matches-environment";
  productionAdmission: "not-evaluated";
} {
  let value: unknown;
  try {
    value = parseStrictJson(bytes, 256 * 1024);
  } catch (error) {
    return fail(error instanceof StrictJsonError && error.code === "DUPLICATE_KEY" ? "ROUTER_DUPLICATE_KEY" : "ROUTER_INVALID_JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("ROUTER_INVALID_JSON");
  const config = value as Record<string, unknown>;
  if (!loopbackHost(config.listen)) fail("ROUTER_LISTEN_NOT_LOOPBACK");
  if (config.health_listen !== undefined && !loopbackHost(config.health_listen)) fail("ROUTER_LISTEN_NOT_LOOPBACK");
  if (portOf(config.listen) !== 14323) fail("ROUTER_PORT_MISMATCH");
  const upstream = config.upstream_proxy;
  if (typeof upstream !== "string") fail("ROUTER_UPSTREAM_MISMATCH");
  const separator = upstream.lastIndexOf(":");
  const host = separator > 0 ? upstream.slice(0, separator) : "";
  if (isIP(host) !== 4 || host !== options.environment.network.brokerAddress) fail("ROUTER_UPSTREAM_MISMATCH");
  if (portOf(upstream) !== options.brokerPort) fail("ROUTER_UPSTREAM_MISMATCH");
  return { status: "router-config-matches-environment", productionAdmission: "not-evaluated" };
}
