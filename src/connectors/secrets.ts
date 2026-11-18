import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
    const raw = await this.read("credential_master_key");
    const text = raw.toString("utf8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
    if (/^[A-Za-z0-9+/_=-]{43,44}$/.test(text)) {
      const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (decoded.length === 32) return decoded;
    }
    if (raw.length === 32) return Buffer.from(raw);
    throw new ConnectorError("CONNECTOR_MASTER_KEY_INVALID", "credential_master_key must encode exactly 32 bytes");
  }
}

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new ConnectorError("CONNECTOR_SECRET_MISSING", "connector secret name is invalid");
  }
}
