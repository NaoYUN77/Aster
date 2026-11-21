import { readFile } from "node:fs/promises";
import { ConnectorError } from "./errors.js";

/**
 * HTTP access to the Cloudflare secret broker. Requests authenticate with a Cloudflare Access
 * service token, either read from a two-line file (id, secret) or from the two environment values.
 * Nothing in this module logs or includes a secret value: failures carry a stable code only.
 */
export type BrokerClientOptions = {
  readonly baseUrl: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  readonly accessTokenFile?: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
};

type Credentials = { readonly id: string; readonly secret: string };

export class BrokerClient {
  readonly #options: BrokerClientOptions;
  readonly #fetch: typeof fetch;
  #credentials: Credentials | undefined;

  constructor(options: BrokerClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Sends one request to the broker with the Access service token applied. Transport failures and
   * missing credentials are `SECRETS_UNAVAILABLE`; callers map HTTP statuses to their own codes.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const credentials = await this.#accessCredentials();
    const headers = new Headers(init.headers);
    headers.set("CF-Access-Client-Id", credentials.id);
    headers.set("CF-Access-Client-Secret", credentials.secret);
    headers.set("accept", "application/json");
    try {
      return await this.#fetch(`${this.#options.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch {
      throw new ConnectorError("SECRETS_UNAVAILABLE", "connector secret broker is unreachable");
    }
  }

  async #accessCredentials(): Promise<Credentials> {
    if (this.#credentials !== undefined) return this.#credentials;
    const file = this.#options.accessTokenFile;
    let id: string | undefined;
    let secret: string | undefined;
    if (file !== undefined) {
      let text: string;
      try {
        // The path is deliberately absent from the error: it may reveal host layout.
        text = await readFile(file, "utf8");
      } catch {
        throw new ConnectorError("SECRETS_UNAVAILABLE", "Cloudflare Access token file cannot be read");
      }
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
      if (lines.length !== 2) {
        throw new ConnectorError("SECRETS_UNAVAILABLE", "Cloudflare Access token file must contain exactly two lines");
      }
      [id, secret] = lines;
    } else {
      id = this.#options.accessClientId;
      secret = this.#options.accessClientSecret;
    }
    if (id === undefined || id === "" || secret === undefined || secret === "") {
      throw new ConnectorError("SECRETS_UNAVAILABLE", "Cloudflare Access service token is not configured");
    }
    const credentials: Credentials = { id, secret };
    this.#credentials = credentials;
    return credentials;
  }
}
