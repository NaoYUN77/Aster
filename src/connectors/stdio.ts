import { basename, isAbsolute, relative, resolve } from "node:path";
import { ConnectorError } from "./errors.js";

const COMMAND = /^[A-Za-z0-9._/-]{1,256}$/;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 1_024;

export type StdioConnectorConfig = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
};

/**
 * Local MCP servers are the highest-risk connector type: they run a host binary. The host allows
 * only commands named in `CONNECTOR_STDIO_ALLOWLIST`, never passes the command through a shell,
 * forces `inheritEnv=false` in the MCP transport, and confines the working directory to this
 * connector's directory under DATA_DIR.
 */
export function validateStdioConnector(input: {
  readonly command: unknown;
  readonly args?: unknown;
  readonly allowlist: readonly string[];
}): StdioConnectorConfig {
  if (typeof input.command !== "string" || !COMMAND.test(input.command)) {
    throw new ConnectorError("CONNECTOR_STDIO_NOT_ALLOWED", "this local connector command is not allowed");
  }
  const command = input.command;
  // An absolute command must match the allowlist exactly. A bare name matches an allowlist entry by
  // basename, but a relative path never does: `../../bin/node` must not inherit `/usr/bin/node`.
  const allowed = isAbsolute(command)
    ? input.allowlist.includes(command)
    : !command.includes("/") && input.allowlist.some((entry) => entry === command || basename(entry) === command);
  if (!allowed) {
    throw new ConnectorError("CONNECTOR_STDIO_NOT_ALLOWED", "this local connector command is not allowed");
  }
  if (input.args !== undefined && !Array.isArray(input.args)) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "stdio args must be an array of strings");
  }
  const args = (input.args ?? []).map((value) => {
    if (typeof value !== "string" || value.includes("\0") || value.length > MAX_ARG_CHARS) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "stdio args must be strings without NUL bytes");
    }
    return value;
  });
  if (args.length > MAX_ARGS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `stdio args must contain at most ${MAX_ARGS} entries`);
  }
  return { command, args };
}

/** Resolves a connector's private working directory and refuses traversal outside `root`. */
export function stdioWorkingDirectory(root: string, slug: string): string {
  const base = resolve(root, "connectors", "stdio", slug);
  const rel = relative(resolve(root), base);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ConnectorError("CONNECTOR_INVALID_SLUG", "slug must not escape the connector directory");
  }
  return base;
}
