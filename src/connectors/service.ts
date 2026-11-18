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
import type { TokenVault } from "./vault.js";

export type ConnectorServiceOptions = {
  readonly store: ConnectorStore;
  readonly oauth: ConnectorOAuth;
  readonly vault: TokenVault;
  readonly config: ConnectorsConfig;
  readonly ownerId: string;
  readonly dataDir: string;
  readonly hub?: EventHub;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
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
  readonly #vault: TokenVault;
  readonly #config: ConnectorsConfig;
  readonly #ownerId: string;
  readonly #dataDir: string;
  readonly #hub: EventHub | undefined;
  readonly #broker = new CredentialBroker();
  readonly #github: GithubClient;
  readonly #gmail: GmailClient;
  readonly #log: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: ConnectorServiceOptions) {
    this.#store = options.store;
    this.#oauth = options.oauth;
    this.#vault = options.vault;
    this.#config = options.config;
    this.#ownerId = options.ownerId;
    this.#dataDir = options.dataDir;
    this.#hub = options.hub;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#now = options.now ?? (() => new Date());
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

  /**
   * Remove the stored credential and mark the connection revoked. The row (and its slug) stays so
   * the same connection can be authorized again; until then tools of that provider refuse to run.
   * Repeating the call is harmless.
   */
  async disconnect(slug: string): Promise<void> {
    const connection = this.#store.get(this.#ownerId, slug);
    if (connection === undefined) throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
    // Clear the vault first: if the broker is unreachable, keep the local row connected rather
    // than revoking here while a usable token remains in the broker.
    await this.#vault.remove(connection);
    if (!this.#store.disconnect(connection.id)) {
      throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
    }
    this.#changed(this.#store.getById(connection.id) ?? connection);
  }

  async startOAuth(slug: string): Promise<{ readonly url: string }> {
    const connection = this.#store.get(this.#ownerId, slug);
    if (connection === undefined) throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
    if (connection.provider !== "github" && connection.provider !== "gmail") {
      throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
    }
    const started = await this.#oauth.start(connection);
    this.#store.createOAuthSession({
      state: started.state,
      connectionId: connection.id,
      ownerId: connection.ownerId,
      provider: connection.provider,
      codeVerifier: started.codeVerifier,
      redirectUri: started.redirectUri,
      scopes: connection.scopes,
      expiresAt: new Date(this.#now().getTime() + this.#config.oauthStateTtlMs).toISOString(),
    });
    return { url: started.url };
  }

  async completeOAuth(state: string, code: string): Promise<ConnectorConnection> {
    if (state === "" || code === "" || state.length > 512 || code.length > 4_096) {
      throw stateInvalid();
    }
    const session = this.#store.consumeOAuthSession(state);
    if (session === undefined) throw stateInvalid();
    const connection = this.#store.getById(session.connectionId);
    if (connection === undefined || connection.provider !== session.provider) throw stateInvalid();
    try {
      const result = await this.#oauth.exchange(connection, session, code);
      await this.#vault.save(connection, result.token, {
        accountLabel: result.accountLabel,
        scopes: result.scopes,
      });
      const connected = this.#store.setConnected(connection.id, {
        accountLabel: result.accountLabel,
        scopes: result.scopes,
      });
      this.#changed(connected);
      return connected;
    } catch (error) {
      const codeName = error instanceof ConnectorError ? error.code : connectorCode(error);
      this.#store.setStatus(connection.id, "error", codeName);
      this.#store.audit(connection.id, "oauth.exchange_failed", codeName);
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth token exchange failed");
    }
  }

  /** The optional app URL for the OAuth success page; undefined means the page stays put. */
  get oauthReturnUrl(): string | undefined {
    return this.#config.oauthReturnUrl;
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
      token = await this.#vault.accessToken(connection);
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

function stateInvalid(): ConnectorError {
  return new ConnectorError("CONNECTOR_OAUTH_STATE_INVALID", "OAuth state is invalid or has expired");
}
