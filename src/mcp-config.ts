import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { agentVaultEnabled, isVaultPlaceholder, VAULT_PROXY_VARIABLES, vaultPlaceholder } from "./agent-vault.js";

const MAX_SERVERS = 8;
const MAX_STDIO_SERVERS = 4;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONNECT_TIMEOUT_MS = 120_000;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Fetch rejects a header value outside ByteString (and any control character); catch it here instead of
// failing the connection later, where the error would only surface as a generic connect failure.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const VAULT_REFERENCE = /\$\{vault:([^}]+)\}/g;
const CREDENTIAL_ENV = /(?:TOKEN|PASSWORD|PASSWD|SECRET|API_?KEY|USERNAME|USER_NAME|AUTHORIZATION|CREDENTIAL)/i;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

export type McpAuthConfig = {
  readonly type: "oauth";
  readonly scope?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectPort: number;
  readonly authorizationServerMetadataUrl?: string;
};

export type McpStdioServerConfig = {
  readonly name: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: boolean;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
};

export type McpHttpServerConfig = {
  readonly name: string;
  readonly transport: "http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly auth?: McpAuthConfig;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export type McpFileConfig = { readonly servers: readonly McpServerConfig[] };
export type McpConfigReadResult = {
  readonly config?: McpFileConfig;
  readonly warnings: readonly string[];
  readonly error?: string;
};

/**
 * Read and validate the optional MCP configuration. A missing default file means the feature is
 * off; an explicitly configured path must exist. `${NAME}` reads configuration from the environment;
 * `${vault:KEY}` produces a non-secret placeholder for server-side credential injection.
 */
export async function readMcpConfig(
  path: string,
  explicit: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfigReadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return { warnings: [] };
    return { warnings: [], error: `MCP config file cannot be read: ${path}` };
  }
  let raw: unknown;
  try {
    // Editors on Windows write a UTF-8 BOM; JSON.parse rejects it even though the text is valid JSON.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { warnings: [], error: `MCP config is not valid JSON: ${path}` };
  }
  return validateMcpConfig(raw, env);
}

/** Validate already-parsed JSON. Per-server problems become warnings; a file-level problem is the `error`. */
export function validateMcpConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): McpConfigReadResult {
  try {
    return collectServers(raw, env);
  } catch (error) {
    return {
      warnings: [],
      error: error instanceof McpConfigError ? error.message : "MCP config is invalid",
    };
  }
}

function collectServers(raw: unknown, env: NodeJS.ProcessEnv): McpConfigReadResult {
  if (!isRecord(raw)) throw new McpConfigError("MCP config must be a JSON object");
  const unknownRoot = Object.keys(raw).filter((key) => key !== "servers");
  if (unknownRoot.length > 0) throw new McpConfigError(`Unknown MCP config key: ${unknownRoot[0]}`);
  if (!Array.isArray(raw.servers)) throw new McpConfigError("MCP config must contain a servers array");

  const warnings: string[] = [];
  const servers: McpServerConfig[] = [];
  const names = new Set<string>();
  let stdioCount = 0;
  // Over-count is a per-entry problem: skipping the extra servers keeps the rest usable, as the
  // per-entry errors below do. Only the runtime's resources are bounded, not the file.
  const limit = Math.min(raw.servers.length, MAX_SERVERS);
  if (raw.servers.length > MAX_SERVERS) {
    const ignored = raw.servers.length - MAX_SERVERS;
    warnings.push(`at most ${MAX_SERVERS} servers are allowed; ${ignored} ${ignored === 1 ? "entry" : "entries"} ignored`);
  }

  for (let index = 0; index < limit; index++) {
    try {
      const server = parseServer(raw.servers[index], env);
      if (names.has(server.name)) {
        warnings.push(`servers[${index}]: duplicate server name ${server.name} ignored`);
        continue;
      }
      if (server.transport === "stdio") {
        if (stdioCount >= MAX_STDIO_SERVERS) {
          warnings.push(`servers[${index}]: at most ${MAX_STDIO_SERVERS} stdio servers are allowed; ignored`);
          continue;
        }
        stdioCount++;
      }
      names.add(server.name);
      servers.push(server);
    } catch (error) {
      const message = error instanceof McpConfigError ? error.message : "invalid server entry";
      warnings.push(`servers[${index}]: ${message}`);
    }
  }

  return { config: { servers }, warnings };
}

function parseServer(value: unknown, env: NodeJS.ProcessEnv): McpServerConfig {
  if (!isRecord(value)) throw new McpConfigError("server must be an object");
  const name = value.name;
  if (typeof name !== "string" || !SERVER_NAME.test(name)) {
    throw new McpConfigError("name must match [A-Za-z0-9][A-Za-z0-9_-]{0,23}");
  }
  const brokered = agentVaultEnabled(env);
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new McpConfigError(`${name}: transport must be "stdio" or "http"`);
  }

  const allowed = transport === "stdio"
    ? new Set(["name", "transport", "command", "args", "cwd", "env", "inheritEnv", "timeoutMs", "connectTimeoutMs"])
    : new Set(["name", "transport", "url", "headers", "auth", "timeoutMs", "connectTimeoutMs"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new McpConfigError(`${name}: unknown key ${unknown}`);

  const timeoutMs = readTimeout(value.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, `${name}.timeoutMs`);
  const connectTimeoutMs = readTimeout(
    value.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    MAX_CONNECT_TIMEOUT_MS,
    `${name}.connectTimeoutMs`,
  );

  if (transport === "stdio") {
    const command = value.command;
    if (typeof command !== "string" || !command.trim()) throw new McpConfigError(`${name}: command must be a non-empty string`);
    const args = readStringArray(value.args, `${name}.args`).map((arg) => resolveReferences(arg, env, `${name}.args`));
    const cwd = value.cwd;
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new McpConfigError(`${name}: cwd must be an absolute path`);
      const info = isDirectory(cwd);
      if (!info) throw new McpConfigError(`${name}: cwd is not an existing directory`);
    }
    const envEntries = readStringRecord(value.env, `${name}.env`);
    const resolvedEnv: Record<string, string> = {};
    for (const [key, entry] of Object.entries(envEntries)) {
      if (!ENV_KEY.test(key)) throw new McpConfigError(`${name}: invalid environment variable name ${key}`);
      const resolved = resolveReferences(entry, env, `${name}.env.${key}`);
      if (brokered) {
        if ((VAULT_PROXY_VARIABLES as readonly string[]).includes(key) || /^(?:https?_proxy|no_proxy|all_proxy|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|AGENT_VAULT_.*|INFISICAL_.*)$/i.test(key)) {
          throw new McpConfigError(`${name}: env.${key} is controlled by the host in Agent Vault mode`);
        }
        if (CREDENTIAL_ENV.test(key) && !isVaultPlaceholder(resolved)) {
          throw new McpConfigError(`${name}: env.${key} must use a vault reference in Agent Vault mode`);
        }
      }
      resolvedEnv[key] = resolved;
    }
    if (value.inheritEnv !== undefined && typeof value.inheritEnv !== "boolean") {
      throw new McpConfigError(`${name}: inheritEnv must be a boolean`);
    }
    if (brokered && value.inheritEnv === true) {
      throw new McpConfigError(`${name}: inheritEnv is not allowed in Agent Vault mode`);
    }
    return {
      name,
      transport,
      command,
      args,
      ...(typeof cwd === "string" ? { cwd } : {}),
      env: resolvedEnv,
      inheritEnv: value.inheritEnv ?? false,
      timeoutMs,
      connectTimeoutMs,
    };
  }

  if (typeof value.url !== "string" || !isSafeHttpUrl(value.url)) {
    throw new McpConfigError(`${name}: url must be an https URL (http is allowed only on loopback)`);
  }
  if (brokered && new URL(value.url).search) {
    throw new McpConfigError(`${name}: query strings are not allowed in MCP URLs in Agent Vault mode`);
  }
  const headers = readStringRecord(value.headers, `${name}.headers`);
  const resolvedHeaders: Record<string, string> = {};
  for (const [key, entry] of Object.entries(headers)) {
    if (!HEADER_NAME.test(key)) throw new McpConfigError(`${name}: invalid header name ${key}`);
    // Validate the resolved value: an environment variable can carry the newline or non-Latin-1 character.
    const resolved = resolveReferences(entry, env, `${name}.headers.${key}`);
    if (!HEADER_VALUE.test(resolved)) throw new McpConfigError(`${name}: header ${key} contains a character not allowed in an HTTP header`);
    if (brokered && !["accept", "content-type", "x-client"].includes(key.toLowerCase())
      && !isVaultPlaceholder(resolved) && !/^Bearer __vault_[A-Z][A-Z0-9_]*__$/.test(resolved)) {
      throw new McpConfigError(`${name}: header ${key} must use a vault reference or be injected by Agent Vault`);
    }
    resolvedHeaders[key] = resolved;
  }
  const auth = value.auth === undefined ? undefined : parseAuth(value.auth, name, env);
  return {
    name,
    transport,
    url: value.url,
    headers: resolvedHeaders,
    ...(auth ? { auth } : {}),
    timeoutMs,
    connectTimeoutMs,
  };
}

function parseAuth(value: unknown, serverName: string, env: NodeJS.ProcessEnv): McpAuthConfig {
  if (!isRecord(value)) throw new McpConfigError(`${serverName}: auth must be an object`);
  const allowed = new Set(["type", "scope", "clientId", "clientSecret", "redirectPort", "authorizationServerMetadataUrl"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new McpConfigError(`${serverName}: unknown auth key ${unknown}`);
  if (value.type !== "oauth") throw new McpConfigError(`${serverName}: auth.type must be "oauth"`);
  const scope = optionalString(value.scope, `${serverName}.auth.scope`);
  const clientId = optionalString(value.clientId, `${serverName}.auth.clientId`);
  const clientSecret = optionalString(value.clientSecret, `${serverName}.auth.clientSecret`);
  const redirectPort = value.redirectPort ?? 8_765;
  if (typeof redirectPort !== "number" || !Number.isInteger(redirectPort) || redirectPort < 1_024 || redirectPort > 65_535) {
    throw new McpConfigError(`${serverName}: auth.redirectPort must be an integer between 1024 and 65535`);
  }
  const metadata = optionalString(value.authorizationServerMetadataUrl, `${serverName}.auth.authorizationServerMetadataUrl`);
  if (metadata !== undefined && !isSafeHttpUrl(metadata)) {
    throw new McpConfigError(`${serverName}: auth.authorizationServerMetadataUrl must be an https URL`);
  }
  return {
    type: "oauth",
    ...(scope !== undefined ? { scope } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret: resolveReferences(clientSecret, env, `${serverName}.auth.clientSecret`) } : {}),
    redirectPort,
    ...(metadata !== undefined ? { authorizationServerMetadataUrl: metadata } : {}),
  };
}

/** Vault references stay non-secret; a disabled broker must never send them upstream directly. */
export function resolveReferences(value: string, env: NodeJS.ProcessEnv, field: string): string {
  const referenced = value.replace(VAULT_REFERENCE, (_match, key: string) => {
    if (!agentVaultEnabled(env)) throw new McpConfigError(`${field} requires AGENT_VAULT_ENABLED=1`);
    try {
      return vaultPlaceholder(key);
    } catch {
      throw new McpConfigError(`${field} contains an invalid Agent Vault credential key`);
    }
  });
  if (referenced.includes("${vault:")) throw new McpConfigError(`${field} contains an invalid Agent Vault reference`);
  return referenced.replace(ENV_REFERENCE, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new McpConfigError(`${field} references missing environment variable ${name}`);
    return resolved;
  });
}

function readTimeout(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < MIN_TIMEOUT_MS || (value as number) > max) {
    throw new McpConfigError(`${field} must be an integer between ${MIN_TIMEOUT_MS} and ${max}`);
  }
  return value as number;
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new McpConfigError(`${field} must be an array of strings`);
  }
  return value as string[];
}

function readStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new McpConfigError(`${field} must be an object of strings`);
  }
  return value as Record<string, string>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new McpConfigError(`${field} must be a string`);
  return value;
}

function isSafeHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
