import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ConnectorError } from "./errors.js";

export const OAUTH_PROVIDERS = [
  "github",
  "gmail",
  "outlook",
  "linear",
  "notion",
  "google_calendar",
  "google_drive",
] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const CONNECTOR_PROVIDERS = [...OAUTH_PROVIDERS, "mcp_stdio"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

/** Providers whose tokens are obtained through a browser OAuth flow (everything except stdio). */
export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}
export type ConnectorStatus = "pending" | "connected" | "error" | "revoked";

export type ConnectorDefinition = {
  readonly provider: ConnectorProvider;
  readonly displayName: string;
  readonly transport: "oauth" | "stdio";
  readonly defaultScopes: readonly string[];
  readonly tools: readonly string[];
};

export type ConnectorConnection = {
  readonly id: string;
  readonly provider: ConnectorProvider;
  readonly slug: string;
  readonly ownerId: string;
  readonly status: ConnectorStatus;
  /** Account label shown in the UI (GitHub login, Gmail address); never a token. */
  readonly accountLabel: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastErrorCode: string | null;
};

export type StoredCredential = {
  readonly ciphertext: string;
  readonly expiresAt: string | null;
};

export type OAuthSession = {
  readonly state: string;
  readonly connectionId: string;
  readonly ownerId: string;
  readonly provider: ConnectorProvider;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;

type DefinitionEntry = ConnectorDefinition & { readonly writeTools: readonly string[] };

/**
 * Read and write tools per provider. Deliberately no delete tools: removing mail, files, events
 * or issues is irreversible and needs its own confirmed flow, not a model-selected call.
 */
const DEFINITIONS: readonly DefinitionEntry[] = [
  {
    provider: "github",
    displayName: "GitHub",
    transport: "oauth",
    defaultScopes: ["read:user", "repo"],
    tools: [
      "connector_github_list_repositories", "connector_github_list_issues", "connector_github_get_issue",
      "connector_github_create_issue", "connector_github_comment_issue", "connector_github_update_issue",
    ],
    writeTools: ["connector_github_create_issue", "connector_github_comment_issue", "connector_github_update_issue"],
  },
  {
    provider: "gmail",
    displayName: "Gmail",
    transport: "oauth",
    // gmail.modify covers archive/read/labels; gmail.send covers sending. Never mail.google.com.
    defaultScopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    tools: [
      "connector_gmail_search_messages", "connector_gmail_get_message",
      "connector_gmail_send_message", "connector_gmail_create_draft", "connector_gmail_modify_labels",
    ],
    writeTools: ["connector_gmail_send_message", "connector_gmail_create_draft", "connector_gmail_modify_labels"],
  },
  {
    provider: "outlook",
    displayName: "Outlook",
    transport: "oauth",
    defaultScopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"],
    tools: [
      "connector_outlook_list_messages", "connector_outlook_search_messages", "connector_outlook_get_message",
      "connector_outlook_send_message", "connector_outlook_reply_message", "connector_outlook_update_message",
    ],
    writeTools: ["connector_outlook_send_message", "connector_outlook_reply_message", "connector_outlook_update_message"],
  },
  {
    provider: "linear",
    displayName: "Linear",
    transport: "oauth",
    defaultScopes: ["read", "write"],
    tools: [
      "connector_linear_list_issues", "connector_linear_search_issues", "connector_linear_get_issue",
      "connector_linear_create_issue", "connector_linear_update_issue", "connector_linear_comment_issue",
    ],
    writeTools: ["connector_linear_create_issue", "connector_linear_update_issue", "connector_linear_comment_issue"],
  },
  {
    provider: "notion",
    displayName: "Notion",
    transport: "oauth",
    // Notion has no OAuth scope parameter; Insert content / Update content are chosen in the
    // integration settings, not in the authorization request.
    defaultScopes: [],
    tools: [
      "connector_notion_search", "connector_notion_get_page",
      "connector_notion_create_page", "connector_notion_append_blocks",
    ],
    writeTools: ["connector_notion_create_page", "connector_notion_append_blocks"],
  },
  {
    provider: "google_calendar",
    displayName: "Google Calendar",
    transport: "oauth",
    defaultScopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"],
    tools: [
      "connector_google_calendar_list_events", "connector_google_calendar_get_event",
      "connector_google_calendar_create_event", "connector_google_calendar_update_event",
    ],
    writeTools: ["connector_google_calendar_create_event", "connector_google_calendar_update_event"],
  },
  {
    provider: "google_drive",
    displayName: "Google Drive",
    transport: "oauth",
    // drive.file only reaches files Aster created or the user explicitly opened with Aster.
    defaultScopes: ["openid", "email", "https://www.googleapis.com/auth/drive.file"],
    tools: [
      "connector_google_drive_search_files", "connector_google_drive_get_file",
      "connector_google_drive_create_file", "connector_google_drive_update_file",
    ],
    writeTools: ["connector_google_drive_create_file", "connector_google_drive_update_file"],
  },
  {
    provider: "mcp_stdio",
    displayName: "Local MCP (stdio)",
    transport: "stdio",
    defaultScopes: [],
    tools: [],
    writeTools: [],
  },
];

const WRITE_TOOLS = new Set(DEFINITIONS.flatMap((definition) => definition.writeTools));

/**
 * Per-connection metadata only: enforcement happens in the tool registry, where
 * `src/connectors/tools.ts` marks exactly these names as `authz: write`.
 */
function writeAuthz(tool: string): "read" | "write" {
  return WRITE_TOOLS.has(tool) ? "write" : "read";
}

type ConnectionRow = {
  id: string;
  provider: string;
  slug: string;
  owner_id: string;
  status: string;
  account_label: string | null;
  scopes: string;
  created_at: string;
  updated_at: string;
  last_error_code: string | null;
};

function connection(row: ConnectionRow): ConnectorConnection {
  return Object.freeze({
    id: row.id,
    provider: row.provider as ConnectorProvider,
    slug: row.slug,
    ownerId: row.owner_id,
    status: row.status as ConnectorStatus,
    accountLabel: row.account_label,
    scopes: parseStringArray(row.scopes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastErrorCode: row.last_error_code,
  });
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Connector state for one owner. A connection is identified by its generated id everywhere, and by
 * `slug` only inside one owner's UI, so two providers (or two accounts of the same provider) can
 * coexist without using a server/tool name as identity. Credentials are opaque ciphertext here.
 */
export class ConnectorStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  #closed = false;

  constructor(path: string, options: { readonly now?: () => Date } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS connector_definitions (
        provider TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('oauth', 'stdio')),
        default_scopes TEXT NOT NULL,
        tools TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        slug TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
        account_label TEXT,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error_code TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        UNIQUE (owner_id, slug)
      );
      CREATE TABLE IF NOT EXISTS credentials (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, kind)
      );
      CREATE TABLE IF NOT EXISTS tool_scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        authz TEXT NOT NULL CHECK (authz IN ('read', 'write')),
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE (connection_id, tool_name)
      );
      CREATE TABLE IF NOT EXISTS oauth_sessions (
        state TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS connector_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT,
        event TEXT NOT NULL,
        code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connections_owner ON connections(owner_id, created_at);
      CREATE INDEX IF NOT EXISTS credentials_connection ON credentials(connection_id);
    `);
    const createdAt = this.#now().toISOString();
    // Upsert, not INSERT OR IGNORE: an existing database must pick up newly added providers (for
    // example outlook/linear) and any corrected tool list without being deleted.
    const insert = this.#db.prepare(`INSERT INTO connector_definitions
      (provider, display_name, transport, default_scopes, tools, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET display_name = excluded.display_name,
        transport = excluded.transport, default_scopes = excluded.default_scopes, tools = excluded.tools`);
    for (const definition of DEFINITIONS) {
      insert.run(
        definition.provider,
        definition.displayName,
        definition.transport,
        JSON.stringify(definition.defaultScopes),
        JSON.stringify(definition.tools),
        createdAt,
      );
    }
    // Existing connections predate newly added tools (for example the write tools) and would
    // otherwise never get a tool_scopes row. Insert missing rows and correct authz without
    // touching `enabled`, so an admin's toggle survives.
    this.syncToolScopes();
  }

  /** Adds rows for tools introduced after a connection was created; safe to run on every boot. */
  private syncToolScopes(): void {
    const rows = this.#db.prepare("SELECT id, provider FROM connections").all() as { id: string; provider: string }[];
    const scope = this.#db.prepare(`INSERT INTO tool_scopes (connection_id, tool_name, authz, enabled)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(connection_id, tool_name) DO UPDATE SET authz = excluded.authz`);
    for (const row of rows) {
      const definition = DEFINITIONS.find((entry) => entry.provider === row.provider);
      if (definition === undefined) continue;
      for (const tool of definition.tools) scope.run(row.id, tool, writeAuthz(tool));
    }
  }

  definitions(): ConnectorDefinition[] {
    const rows = this.#db.prepare("SELECT * FROM connector_definitions ORDER BY provider").all() as {
      provider: string; display_name: string; transport: string; default_scopes: string; tools: string;
    }[];
    return rows.map((row) => ({
      provider: row.provider as ConnectorProvider,
      displayName: row.display_name,
      transport: row.transport as "oauth" | "stdio",
      defaultScopes: parseStringArray(row.default_scopes),
      tools: parseStringArray(row.tools),
    }));
  }

  definition(provider: ConnectorProvider): ConnectorDefinition | undefined {
    return this.definitions().find((entry) => entry.provider === provider);
  }

  list(ownerId: string): ConnectorConnection[] {
    const rows = this.#db.prepare(
      "SELECT * FROM connections WHERE owner_id = ? ORDER BY created_at, id",
    ).all(ownerId) as ConnectionRow[];
    return rows.map(connection);
  }

  get(ownerId: string, slug: string): ConnectorConnection | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM connections WHERE owner_id = ? AND slug = ?",
    ).get(ownerId, slug) as ConnectionRow | undefined;
    return row === undefined ? undefined : connection(row);
  }

  getById(id: string): ConnectorConnection | undefined {
    const row = this.#db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
    return row === undefined ? undefined : connection(row);
  }

  /** Creates a connection row and its tool scopes. Repeating the same slug is not a duplicate. */
  create(input: { readonly ownerId: string; readonly provider: ConnectorProvider; readonly slug: string }): {
    readonly connection: ConnectorConnection;
    readonly created: boolean;
  } {
    if (!SLUG.test(input.slug)) {
      throw new ConnectorError("CONNECTOR_INVALID_SLUG", "slug must be 1-48 characters of lowercase letters, digits, '-' or '_'");
    }
    const definition = this.definition(input.provider);
    if (definition === undefined || input.provider === "mcp_stdio") {
      throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
    }
    return this.transaction(() => {
      const existing = this.get(input.ownerId, input.slug);
      if (existing !== undefined) {
        if (existing.provider !== input.provider) {
          throw new ConnectorError("CONNECTOR_ALREADY_EXISTS", "this slug belongs to another provider");
        }
        return { connection: existing, created: false };
      }
      const id = randomUUID();
      const now = this.#now().toISOString();
      this.#db.prepare(`INSERT INTO connections
        (id, provider, slug, owner_id, status, account_label, scopes, created_at, updated_at, last_error_code)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL)`).run(
        id, input.provider, input.slug, input.ownerId, JSON.stringify(definition.defaultScopes), now, now,
      );
      const scope = this.#db.prepare(
        "INSERT OR IGNORE INTO tool_scopes (connection_id, tool_name, authz, enabled) VALUES (?, ?, ?, 1)",
      );
      for (const tool of definition.tools) scope.run(id, tool, writeAuthz(tool));
      this.audit(id, "connection.created");
      const row = this.#db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow;
      return { connection: connection(row), created: true };
    });
  }

  /** A local stdio connector is enabled immediately but starts with the next process boot. */
  createStdio(input: {
    readonly ownerId: string;
    readonly slug: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }): { readonly connection: ConnectorConnection; readonly created: boolean } {
    if (!SLUG.test(input.slug)) {
      throw new ConnectorError("CONNECTOR_INVALID_SLUG", "slug must be 1-48 characters of lowercase letters, digits, '-' or '_'");
    }
    return this.transaction(() => {
      const existing = this.get(input.ownerId, input.slug);
      if (existing !== undefined) {
        if (existing.provider !== "mcp_stdio") {
          throw new ConnectorError("CONNECTOR_ALREADY_EXISTS", "this slug belongs to another provider");
        }
        return { connection: existing, created: false };
      }
      const id = randomUUID();
      const now = this.#now().toISOString();
      this.#db.prepare(`INSERT INTO connections
        (id, provider, slug, owner_id, status, account_label, scopes, created_at, updated_at, last_error_code, config)
        VALUES (?, 'mcp_stdio', ?, ?, 'connected', ?, '[]', ?, ?, NULL, ?)`).run(
        id, input.slug, input.ownerId, input.command.slice(0, 256), now, now,
        JSON.stringify({ command: input.command, args: [...input.args], cwd: input.cwd }),
      );
      this.audit(id, "stdio.created");
      const row = this.#db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow;
      return { connection: connection(row), created: true };
    });
  }

  stdioConfigs(ownerId: string): { readonly slug: string; readonly command: string; readonly args: readonly string[]; readonly cwd: string }[] {
    const rows = this.#db.prepare(
      "SELECT slug, config FROM connections WHERE owner_id = ? AND provider = 'mcp_stdio' AND status = 'connected'",
    ).all(ownerId) as { slug: string; config: string }[];
    const configs: { slug: string; command: string; args: readonly string[]; cwd: string }[] = [];
    for (const row of rows) {
      try {
        const value = JSON.parse(row.config) as { command?: unknown; args?: unknown; cwd?: unknown };
        if (typeof value.command !== "string" || typeof value.cwd !== "string" || !Array.isArray(value.args)) continue;
        configs.push({
          slug: row.slug,
          command: value.command,
          args: value.args.filter((entry): entry is string => typeof entry === "string"),
          cwd: value.cwd,
        });
      } catch {
        // A malformed row is skipped; it must not prevent the web adapter from starting.
      }
    }
    return configs;
  }

  setConnected(id: string, input: { readonly accountLabel: string; readonly scopes: readonly string[] }): ConnectorConnection {
    return this.transaction(() => {
      const changed = this.#db.prepare(`UPDATE connections SET status = 'connected', account_label = ?,
        scopes = ?, updated_at = ?, last_error_code = NULL WHERE id = ?`).run(
        input.accountLabel.slice(0, 256), JSON.stringify(input.scopes), this.#now().toISOString(), id,
      );
      if (changed.changes !== 1) throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
      this.audit(id, "connection.connected");
      return this.getById(id)!;
    });
  }

  /**
   * Revoke one connection: drop its encrypted credential and mark it `revoked` in one transaction,
   * so a crash cannot leave a row claiming `connected` without a token. Keeps the row and its tool
   * scopes so re-authorizing the same slug works and the audit trail survives.
   */
  disconnect(id: string): boolean {
    return this.transaction(() => {
      const row = this.getById(id);
      if (row === undefined) return false;
      this.#db.prepare("DELETE FROM credentials WHERE connection_id = ?").run(id);
      this.audit(id, "credential.deleted");
      this.#db.prepare(
        "UPDATE connections SET status = 'revoked', last_error_code = NULL, updated_at = ? WHERE id = ?",
      ).run(this.#now().toISOString(), id);
      this.audit(id, "connection.revoked");
      return true;
    });
  }

  setStatus(id: string, status: ConnectorStatus, errorCode?: string): void {
    this.#db.prepare("UPDATE connections SET status = ?, last_error_code = ?, updated_at = ? WHERE id = ?").run(
      status, errorCode ?? null, this.#now().toISOString(), id,
    );
    this.audit(id, `connection.${status}`, errorCode);
  }

  saveCredential(connectionId: string, credential: StoredCredential): void {
    const now = this.#now().toISOString();
    this.#db.prepare(`INSERT INTO credentials (connection_id, kind, ciphertext, expires_at, created_at, updated_at)
      VALUES (?, 'oauth_token', ?, ?, ?, ?)
      ON CONFLICT(connection_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at`).run(
      connectionId, credential.ciphertext, credential.expiresAt, now, now,
    );
    this.audit(connectionId, "credential.saved");
  }

  credential(connectionId: string): StoredCredential | undefined {
    const row = this.#db.prepare(
      "SELECT ciphertext, expires_at FROM credentials WHERE connection_id = ? AND kind = 'oauth_token'",
    ).get(connectionId) as { ciphertext: string; expires_at: string | null } | undefined;
    return row === undefined ? undefined : { ciphertext: row.ciphertext, expiresAt: row.expires_at };
  }

  deleteCredential(connectionId: string): void {
    this.#db.prepare("DELETE FROM credentials WHERE connection_id = ?").run(connectionId);
    this.audit(connectionId, "credential.deleted");
  }

  /** Every OAuth credential still held locally, for the one-shot migration to the broker. */
  credentialRows(): { readonly connection: ConnectorConnection; readonly ciphertext: string }[] {
    const rows = this.#db.prepare(
      `SELECT c.*, cr.ciphertext AS credential_ciphertext
         FROM connections c JOIN credentials cr ON cr.connection_id = c.id AND cr.kind = 'oauth_token'
        ORDER BY c.created_at, c.rowid`,
    ).all() as (ConnectionRow & { credential_ciphertext: string })[];
    return rows.map((row) => ({ connection: connection(row), ciphertext: row.credential_ciphertext }));
  }

  /** Removes a credential after it was copied elsewhere; the connection row and status stay. */
  clearCredential(connectionId: string): boolean {
    const changed = this.#db.prepare("DELETE FROM credentials WHERE connection_id = ?").run(connectionId);
    if (changed.changes > 0) this.audit(connectionId, "credential.migrated");
    return changed.changes > 0;
  }

  createOAuthSession(session: OAuthSession): void {
    this.#db.prepare(`INSERT INTO oauth_sessions
      (state, connection_id, owner_id, provider, code_verifier, redirect_uri, scopes, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.state, session.connectionId, session.ownerId, session.provider, session.codeVerifier,
      session.redirectUri, JSON.stringify(session.scopes), this.#now().toISOString(), session.expiresAt,
    );
    this.audit(session.connectionId, "oauth.session_created");
  }

  /** One-time consumption: a replayed callback (or a second tab) cannot exchange the code again. */
  consumeOAuthSession(state: string): OAuthSession | undefined {
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM oauth_sessions WHERE state = ?").get(state) as {
        state: string; connection_id: string; owner_id: string; provider: string; code_verifier: string;
        redirect_uri: string; scopes: string; expires_at: string; consumed_at: string | null;
      } | undefined;
      if (row === undefined || row.consumed_at !== null) return undefined;
      if (Date.parse(row.expires_at) <= this.#now().getTime()) return undefined;
      this.#db.prepare("UPDATE oauth_sessions SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL").run(
        this.#now().toISOString(), state,
      );
      return {
        state: row.state,
        connectionId: row.connection_id,
        ownerId: row.owner_id,
        provider: row.provider as ConnectorProvider,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
        scopes: parseStringArray(row.scopes),
        expiresAt: row.expires_at,
      };
    });
  }

  audit(connectionId: string | null, event: string, code?: string): void {
    this.#db.prepare(
      "INSERT INTO connector_audit (connection_id, event, code, created_at) VALUES (?, ?, ?, ?)",
    ).run(connectionId, event.slice(0, 96), code === undefined ? null : code.slice(0, 96), this.#now().toISOString());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
