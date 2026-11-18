import { mkdir } from "node:fs/promises";
import type { McpStdioServerConfig } from "../mcp-config.js";
import type { ConnectorsConfig } from "../config.js";
import type { EventHub } from "../http/events.js";
import { CredentialBroker, type CredentialBinding } from "./broker.js";
import { ConnectorError, connectorCode } from "./errors.js";
import { GmailClient } from "./gmail.js";
import { GithubClient } from "./github.js";
import type { ConnectorOAuth } from "./oauth.js";
import { stdioWorkingDirectory, validateStdioConnector } from "./stdio.js";
import type { ConnectorConnection, ConnectorDefinition, ConnectorProvider, ConnectorStore } from "./store.js";

export type ConnectorServiceOptions = {
  readonly store: ConnectorStore;
  readonly oauth: ConnectorOAuth;
  readonly config: ConnectorsConfig;
  readonly ownerId: string;
  readonly dataDir: string;
  readonly hub?: EventHub;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
};

export type ConnectorList = {
  readonly definitions: readonly ConnectorDefinition[];
  readonly connections: readonly ConnectorConnection[];
};

/**
 * Application-level connector operations. HTTP routes and model tools share it, so a connection
 * created by one client is immediately visible to every other client and to the tool surface.
 */
export class ConnectorService {
  readonly #store: ConnectorStore;
  readonly #oauth: ConnectorOAuth;
  readonly #config: ConnectorsConfig;
  readonly #ownerId: string;
  readonly #dataDir: string;
  readonly #hub: EventHub | undefined;
  readonly #broker = new CredentialBroker();
  readonly #github: GithubClient;
  readonly #gmail: GmailClient;
  readonly #log: (line: string) => void;

  constructor(options: ConnectorServiceOptions) {
    this.#store = options.store;
    this.#oauth = options.oauth;
    this.#config = options.config;
    this.#ownerId = options.ownerId;
    this.#dataDir = options.dataDir;
    this.#hub = options.hub;
    this.#log = options.log ?? ((line) => console.error(line));
    const fetchImpl = options.fetch ?? fetch;
    this.#github = new GithubClient({ fetch: fetchImpl, timeoutMs: options.config.httpTimeoutMs });
    this.#gmail = new GmailClient({ fetch: fetchImpl, timeoutMs: options.config.httpTimeoutMs });
  }

  list(): ConnectorList {
    return { definitions: this.#store.definitions(), connections: this.#store.list(this.#ownerId) };
  }

  create(input: {
    readonly provider: unknown;
    readonly slug: unknown;
    readonly command?: unknown;
    readonly args?: unknown;
  }): { readonly connection: ConnectorConnection; readonly created: boolean } {
    if (typeof input.slug !== "string") {
      throw new ConnectorError("CONNECTOR_INVALID_SLUG", "slug must be 1-48 characters of lowercase letters, digits, '-' or '_'");
    }
    let result: { readonly connection: ConnectorConnection; readonly created: boolean };
    if (input.provider === "mcp_stdio") {
      const command = validateStdioConnector({
        command: input.command,
        args: input.args,
        allowlist: this.#config.stdioAllowlist,
      });
      result = this.#store.createStdio({
        ownerId: this.#ownerId,
        slug: input.slug,
        command: command.command,
        args: command.args,
        cwd: stdioWorkingDirectory(this.#dataDir, input.slug),
      });
    } else if (input.provider === "github" || input.provider === "gmail") {
      result = this.#store.create({ ownerId: this.#ownerId, provider: input.provider, slug: input.slug });
    } else {
      throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
    }
    if (result.created) this.#changed(result.connection);
    return result;
  }

  /**
   * Stdio connectors for the MCP host. The allowlist is re-checked on every boot, so removing a
   * command disables an existing row instead of trusting what was valid when it was created.
   */
  async stdioServers(): Promise<McpStdioServerConfig[]> {
    const MAX_STDIO_SERVERS = 4;
    const configs = this.#store.stdioConfigs(this.#ownerId);
    if (configs.length > MAX_STDIO_SERVERS) {
      this.#log(`Stdio connectors limited to ${MAX_STDIO_SERVERS}; ${configs.length - MAX_STDIO_SERVERS} not started`);
    }
    const used = new Set<string>();
    const servers: McpStdioServerConfig[] = [];
    for (const config of configs.slice(0, MAX_STDIO_SERVERS)) {
      try {
        const command = validateStdioConnector({
          command: config.command,
          args: config.args,
          allowlist: this.#config.stdioAllowlist,
        });
        const cwd = stdioWorkingDirectory(this.#dataDir, config.slug);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        let name = `conn_${config.slug}`.slice(0, 24);
        for (let suffix = 2; used.has(name); suffix += 1) {
          name = `conn_${config.slug}`.slice(0, 22) + `_${suffix}`;
        }
        used.add(name);
        servers.push({
          name,
          transport: "stdio",
          command: command.command,
          args: [...command.args],
          cwd,
          env: {},
          inheritEnv: false,
          timeoutMs: 60_000,
          connectTimeoutMs: 10_000,
        });
      } catch (error) {
        this.#log(`Stdio connector ${config.slug} skipped (${connectorCode(error)})`);
      }
    }
    return servers;
  }

  async startOAuth(slug: string): Promise<{ readonly url: string }> {
    const connection = this.#store.get(this.#ownerId, slug);
    if (connection === undefined) throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
    if (connection.provider !== "github" && connection.provider !== "gmail") {
      throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
    }
    return this.#oauth.start(connection);
  }

  async completeOAuth(state: string, code: string): Promise<ConnectorConnection> {
    const connection = await this.#oauth.complete(state, code);
    this.#changed(connection);
    return connection;
  }

  async listRepositories(input: { readonly connection?: string; readonly perPage?: number }, binding: CredentialBinding) {
    return this.#withConnection("github", input.connection, binding, "connector_github_list_repositories",
      (connection, token) => this.#github.listRepositories(token, { ...(input.perPage === undefined ? {} : { perPage: input.perPage }) }));
  }

  async listIssues(
    input: { readonly connection?: string; readonly repo: string; readonly state?: string; readonly perPage?: number },
    binding: CredentialBinding,
  ) {
    return this.#withConnection("github", input.connection, binding, "connector_github_list_issues",
      (connection, token) => this.#github.listIssues(token, input.repo, {
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
      }));
  }

  async getIssue(
    input: { readonly connection?: string; readonly repo: string; readonly number: number },
    binding: CredentialBinding,
  ) {
    return this.#withConnection("github", input.connection, binding, "connector_github_get_issue",
      (connection, token) => this.#github.getIssue(token, input.repo, input.number));
  }

  async searchMessages(
    input: { readonly connection?: string; readonly query?: string; readonly maxResults?: number },
    binding: CredentialBinding,
  ) {
    return this.#withConnection("gmail", input.connection, binding, "connector_gmail_search_messages",
      (connection, token) => this.#gmail.searchMessages(token, input.query ?? "", {
        ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
      }));
  }

  async getMessage(input: { readonly connection?: string; readonly id: string }, binding: CredentialBinding) {
    return this.#withConnection("gmail", input.connection, binding, "connector_gmail_get_message",
      (connection, token) => this.#gmail.getMessage(token, input.id));
  }

  close(): void {
    this.#broker.revokeAll();
  }

  async #withConnection<T>(
    provider: "github" | "gmail",
    slug: string | undefined,
    binding: CredentialBinding,
    tool: string,
    call: (connection: ConnectorConnection, token: string) => Promise<T>,
  ): Promise<T> {
    const connection = this.#pick(provider, slug);
    if (connection.status !== "connected") {
      this.#requestCredential(connection, tool, binding);
      throw new ConnectorError("CONNECTOR_NOT_CONNECTED", "connector is not authorized yet");
    }
    let token: string;
    try {
      token = await this.#oauth.accessToken(connection);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONNECTOR_NOT_CONNECTED") {
        this.#requestCredential(connection, tool, binding);
      }
      throw error;
    }
    // The capability is consumed immediately; the token exists only as the local `token` value and
    // as the upstream request's Authorization header.
    const capability = this.#broker.issue({ ...binding, connectionId: connection.id, tool }, token, this.#config.leaseTtlMs);
    const leased = this.#broker.consume(capability, { ...binding, connectionId: connection.id, tool });
    try {
      return await call(connection, leased);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONNECTOR_AUTH_EXPIRED") {
        this.#store.setStatus(connection.id, "error", "CONNECTOR_AUTH_EXPIRED");
        this.#changed(this.#store.getById(connection.id) ?? connection);
        this.#requestCredential(connection, tool, binding);
      }
      throw error;
    }
  }

  #pick(provider: "github" | "gmail", slug: string | undefined): ConnectorConnection {
    const connections = this.#store.list(this.#ownerId).filter((entry) => entry.provider === provider);
    if (slug !== undefined && slug !== "") {
      const found = connections.find((entry) => entry.slug === slug);
      if (found === undefined) throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
      return found;
    }
    if (connections.length === 0) {
      throw new ConnectorError("CONNECTOR_NOT_FOUND", "no connector of this provider exists");
    }
    if (connections.length > 1) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "multiple connectors match; pass connection=<slug>");
    }
    return connections[0]!;
  }

  #requestCredential(connection: ConnectorConnection, tool: string, binding: CredentialBinding): void {
    // No secret and no capability: only enough for the UI to offer the server-side OAuth flow.
    this.#hub?.broadcast("credential.request", {
      connectionId: connection.id,
      provider: connection.provider,
      slug: connection.slug,
      tool,
      requestId: binding.requestId,
    });
  }

  #changed(connection: ConnectorConnection): void {
    this.#hub?.broadcast("connector.changed", {
      connection: {
        id: connection.id,
        provider: connection.provider,
        slug: connection.slug,
        status: connection.status,
        accountLabel: connection.accountLabel,
        scopes: connection.scopes,
      },
    });
  }
}
