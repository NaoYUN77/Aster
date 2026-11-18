import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrokerClient } from "./broker-client.js";
import { ConnectorError } from "./errors.js";

/**
 * The smallest useful secret source: one read-only file per secret inside a directory. It is
 * deliberately not backed by environment variables, the repository, the database or logs. A
 * missing or unreadable file is a named configuration error, never an empty fallback.
 *
 * The interface stays this small so a future Cloudflare Secret Store can replace it without
 * changing the connector/OAuth code.
 */
export type SecretProvider = {
  read(name: string): Promise<Buffer>;
  readOptional(name: string): Promise<Buffer | undefined>;
  readText(name: string): Promise<string>;
  masterKey(): Promise<Buffer>;
};

const SECRET_NAME = /^[a-z0-9_]{1,64}$/;

export class FileSecretProvider implements SecretProvider {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async read(name: string): Promise<Buffer> {
    assertSecretName(name);
    try {
      const value = await readFile(join(this.#directory, name));
      if (value.length === 0) {
        throw new ConnectorError("CONNECTOR_SECRET_MISSING", `required connector secret is empty: ${name}`);
      }
      return value;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ConnectorError("CONNECTOR_SECRET_MISSING", `required connector secret file is missing: ${name}`);
      }
      // The path and the underlying message are not included: only the logical secret name is safe.
      throw new ConnectorError("CONNECTOR_SECRET_UNREADABLE", `required connector secret file cannot be read: ${name}`);
    }
  }

  async readOptional(name: string): Promise<Buffer | undefined> {
    assertSecretName(name);
    try {
      return await this.read(name);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONNECTOR_SECRET_MISSING") return undefined;
      throw error;
    }
  }

  /** Reads a text secret and trims only the trailing newline an editor or Docker secret adds. */
  async readText(name: string): Promise<string> {
    return (await this.read(name)).toString("utf8").trim();
  }

  /**
   * The AES-256-GCM key. Accepted encodings are 64 hex characters, base64/base64url for 32 bytes,
   * or exactly 32 raw bytes. Anything else is a startup/connect error; the value is never echoed.
   */
  async masterKey(): Promise<Buffer> {
    return parseMasterKeyBytes(await this.read("credential_master_key"));
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export type CfSecretProviderOptions = {
  readonly client: BrokerClient;
  /** Injectable clock for the five-minute cache. */
  readonly now?: () => number;
};

/**
 * Reads the same logical secret names from the Cloudflare broker. Reads are cached in memory for
 * five minutes, and every failure is `SECRETS_UNAVAILABLE` — there is deliberately no fallback to
 * local files or environment values, so a broker outage fails closed instead of using stale keys.
 * Error messages name the logical secret at most; values are never logged or returned in errors.
 */
export class CfSecretProvider implements SecretProvider {
  readonly #client: BrokerClient;
  readonly #now: () => number;
  readonly #cache = new Map<string, { readonly value: Buffer; readonly expiresAt: number }>();

  constructor(options: CfSecretProviderOptions) {
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
  }

  async read(name: string): Promise<Buffer> {
    assertSecretName(name);
    const cached = this.#cache.get(name);
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now) return Buffer.from(cached.value);

    const response = await this.#client.request(`/v1/secrets/${encodeURIComponent(name)}`);
    if (!response.ok) throw unavailable(name);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable(name);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw unavailable(name);
    const record = body as Record<string, unknown>;
    if (record.name !== name || typeof record.value !== "string") throw unavailable(name);
    if (record.value === "") {
      throw new ConnectorError("CONNECTOR_SECRET_MISSING", `required connector secret is empty: ${name}`);
    }
    const value = Buffer.from(record.value, "utf8");
    this.#cache.set(name, { value, expiresAt: now + CACHE_TTL_MS });
    return Buffer.from(value);
  }

  async readOptional(name: string): Promise<Buffer | undefined> {
    try {
      return await this.read(name);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONNECTOR_SECRET_MISSING") return undefined;
      throw error;
    }
  }

  /** Trims only the trailing newline a secret may carry; the value itself is never echoed. */
  async readText(name: string): Promise<string> {
    return (await this.read(name)).toString("utf8").trim();
  }

  async masterKey(): Promise<Buffer> {
    return parseMasterKeyBytes(await this.read("credential_master_key"));
  }
}

/** Shared by both providers so the key encoding rules cannot drift. */
export function parseMasterKeyBytes(raw: Buffer): Buffer {
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_=-]{43,44}$/.test(text)) {
    const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === 32) return decoded;
  }
  if (raw.length === 32) return Buffer.from(raw);
  throw new ConnectorError("CONNECTOR_MASTER_KEY_INVALID", "credential_master_key must encode exactly 32 bytes");
}

function unavailable(name: string): ConnectorError {
  return new ConnectorError("SECRETS_UNAVAILABLE", `connector secret is unavailable: ${name}`);
}

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new ConnectorError("CONNECTOR_SECRET_MISSING", "connector secret name is invalid");
  }
}
